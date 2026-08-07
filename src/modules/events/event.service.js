const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../config/db');
const ApiError = require('../../utils/ApiError');

const MAX_EVENTS_PER_BUSINESS_PER_DAY = 5;

function toPublicEvent(row) {
  return {
    id: row.id,
    businessId: row.business_id,
    businessName: row.business_name || null,
    name: row.name,
    description: row.description,
    category: row.category,
    startTime: row.start_time,
    endTime: row.end_time,
    imageUrl: row.image_url,
    // Only present when the query that produced `row` joined
    // event_interests (see getEvents/getEventById below) — absent
    // elsewhere (e.g. the admin event mapper), hence the `?? 0`/`!!`
    // rather than assuming these columns always exist.
    interestCount: row.interest_count != null ? Number(row.interest_count) : 0,
    isInterested: !!row.is_interested,
  };
}

/**
 * MySQL's DATETIME columns don't accept ISO 8601's 'T'/'Z' separators
 * directly (e.g. "2026-08-01T14:00:00Z" fails with "Incorrect datetime
 * value"). The Flutter app sends ISO 8601 (DateTime.toIso8601String()),
 * so convert it to MySQL's "YYYY-MM-DD HH:MM:SS" format here rather than
 * pushing this conversion requirement onto every caller.
 */
function toMysqlDatetime(isoString) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    throw ApiError.badRequest(`Invalid date/time value: ${isoString}`);
  }
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

async function getEvents({ category, businessId, from, to, page, limit, userId }) {
  const pageLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const offset = (pageNum - 1) * pageLimit;

  // `user_id = ?` against a NULL/undefined userId (an anonymous/guest
  // caller — this route uses optionalAuth, not requireAuth) never
  // matches in SQL, so isInterested correctly comes back false without
  // needing a separate branch for the unauthenticated case.
  let sql = `
    SELECT SQL_CALC_FOUND_ROWS e.*, b.name AS business_name,
           (SELECT COUNT(*) FROM event_interests ei WHERE ei.event_id = e.id) AS interest_count,
           EXISTS(
             SELECT 1 FROM event_interests ei2 WHERE ei2.event_id = e.id AND ei2.user_id = ?
           ) AS is_interested
    FROM events e
    JOIN businesses b ON b.id = e.business_id
    WHERE e.is_active = 1 AND b.status = 'approved'
  `;
  const params = [userId || null];

  if (category) {
    sql += ' AND e.category = ?';
    params.push(category);
  }
  if (businessId) {
    sql += ' AND e.business_id = ?';
    params.push(businessId);
  }
  if (from) {
    sql += ' AND e.start_time >= ?';
    params.push(toMysqlDatetime(from));
  }
  if (to) {
    sql += ' AND e.start_time <= ?';
    params.push(toMysqlDatetime(to));
  }

  sql += ' ORDER BY e.start_time ASC LIMIT ? OFFSET ?';
  params.push(pageLimit, offset);

  const [rows] = await pool.query(sql, params);
  const [[{ total }]] = await pool.query('SELECT FOUND_ROWS() AS total');

  return {
    events: rows.map(toPublicEvent),
    pagination: { page: pageNum, limit: pageLimit, total, totalPages: Math.ceil(total / pageLimit) },
  };
}

async function getEventById(id, userId) {
  const [rows] = await pool.query(
    `SELECT e.*, b.name AS business_name,
            (SELECT COUNT(*) FROM event_interests ei WHERE ei.event_id = e.id) AS interest_count,
            EXISTS(
              SELECT 1 FROM event_interests ei2 WHERE ei2.event_id = e.id AND ei2.user_id = ?
            ) AS is_interested
     FROM events e
     JOIN businesses b ON b.id = e.business_id
     WHERE e.id = ? LIMIT 1`,
    [userId || null, id],
  );
  if (rows.length === 0) throw ApiError.notFound('Event not found');
  return toPublicEvent(rows[0]);
}

/**
 * "I'm interested" / RSVP toggle — idempotent in both directions, same
 * as favorites: marking interest twice or removing it when it was never
 * set isn't an error, just a no-op.
 */
async function addInterest(userId, eventId) {
  const [eventRows] = await pool.query('SELECT id FROM events WHERE id = ?', [eventId]);
  if (eventRows.length === 0) throw ApiError.notFound('Event not found');

  const [existing] = await pool.query(
    'SELECT id FROM event_interests WHERE user_id = ? AND event_id = ?',
    [userId, eventId],
  );
  if (existing.length > 0) return;

  await pool.query(
    'INSERT INTO event_interests (id, user_id, event_id) VALUES (?, ?, ?)',
    [uuidv4(), userId, eventId],
  );
}

async function removeInterest(userId, eventId) {
  await pool.query('DELETE FROM event_interests WHERE user_id = ? AND event_id = ?', [userId, eventId]);
}

/**
 * Ownership is enforced here, not just trusted from the client: the caller
 * must own the business they're attaching this event to. Also enforces a
 * simple flood-prevention cap — without any moderation queue for events
 * (unlike businesses, which go through admin approval), a compromised or
 * bad-faith account with one approved business could otherwise publish an
 * unlimited number of events instantly. This isn't full pre-publish
 * moderation (that's a larger feature — a review queue, notifications to
 * admins, etc.) but it bounds the blast radius of abuse to a handful of
 * events per business per day, which an admin can then review/remove via
 * the existing Events moderation screen.
 */
async function createEvent(userId, data) {
  const [businessRows] = await pool.query('SELECT owner_id, status FROM businesses WHERE id = ?', [
    data.businessId,
  ]);
  const business = businessRows[0];
  if (!business) throw ApiError.notFound('Business not found');
  if (business.owner_id !== userId) {
    throw ApiError.forbidden('You can only create events for your own businesses');
  }
  if (business.status !== 'approved') {
    throw ApiError.forbidden('Only approved businesses can create events');
  }

  const [[{ recentCount }]] = await pool.query(
    `SELECT COUNT(*) AS recentCount FROM events
     WHERE business_id = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)`,
    [data.businessId],
  );
  if (recentCount >= MAX_EVENTS_PER_BUSINESS_PER_DAY) {
    throw ApiError.badRequest(
      `This business has already created ${MAX_EVENTS_PER_BUSINESS_PER_DAY} events in the last 24 hours. Please try again later.`,
    );
  }

  const id = uuidv4();
  await pool.query(
    `INSERT INTO events (id, business_id, name, description, category, start_time, end_time, image_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      data.businessId,
      data.name,
      data.description || null,
      data.category || 'General',
      toMysqlDatetime(data.startTime),
      toMysqlDatetime(data.endTime),
      data.imageUrl || null,
    ],
  );

  return getEventById(id);
}

/**
 * Everything toPublicEvent has, plus what an admin needs to moderate
 * effectively: whether it's currently active, when it was created, and
 * who owns the business behind it (name/email — an admin investigating a
 * problem event needs to know who to potentially follow up with, not
 * just an opaque business_id).
 */
function toAdminEvent(row) {
  return {
    ...toPublicEvent(row),
    isActive: !!row.is_active,
    ownerName: row.owner_name || null,
    ownerEmail: row.owner_email || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  getEvents,
  getEventById,
  createEvent,
  addInterest,
  removeInterest,
  toPublicEvent,
  toAdminEvent,
};
