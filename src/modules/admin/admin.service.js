const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { stringify } = require('csv-stringify/sync');
const { pool } = require('../../config/db');
const ApiError = require('../../utils/ApiError');
const businessService = require('../businesses/business.service');
const eventService = require('../events/event.service');
const categoryService = require('../categories/category.service');
const notificationService = require('../notifications/notification.service');
const contentService = require('../content/content.service');
const emailService = require('../notifications/email');
const businessImportService = require('./business-import.service');

// ---------------- Dashboard ----------------

async function getDashboardStats() {
  const [[userStats]] = await pool.query(
    `SELECT COUNT(*) AS total_users,
            SUM(CASE WHEN created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) THEN 1 ELSE 0 END) AS new_this_month
     FROM users WHERE role = 'business'`,
  );
  const [[businessStats]] = await pool.query(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
            SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected
     FROM businesses`,
  );
  const [[eventStats]] = await pool.query('SELECT COUNT(*) AS total FROM events WHERE is_active = 1');

  const [topCategories] = await pool.query(
    `SELECT category, COUNT(*) AS count FROM businesses
     WHERE status = 'approved'
     GROUP BY category ORDER BY count DESC LIMIT 5`,
  );

  const [recentActivity] = await pool.query(
    `SELECT bsh.id, bsh.new_status, bsh.created_at, b.name AS business_name
     FROM business_status_history bsh
     JOIN businesses b ON b.id = bsh.business_id
     ORDER BY bsh.created_at DESC LIMIT 10`,
  );

  // mysql2 returns SUM()/COUNT() results as strings for BIGINT-typed
  // aggregates (to avoid silent precision loss on huge numbers) — cast
  // explicitly so API consumers (mobile, website, admin portal) always get
  // real JSON numbers, not a mix of numbers and numeric strings.
  return {
    totalUsers: Number(userStats.total_users),
    newUsersThisMonth: Number(userStats.new_this_month),
    totalBusinesses: Number(businessStats.total),
    pendingBusinesses: Number(businessStats.pending),
    approvedBusinesses: Number(businessStats.approved),
    rejectedBusinesses: Number(businessStats.rejected),
    totalEvents: Number(eventStats.total),
    topCategories: topCategories.map((c) => ({ category: c.category, count: Number(c.count) })),
    recentActivity: recentActivity.map((a) => ({
      id: a.id,
      businessName: a.business_name,
      newStatus: a.new_status,
      createdAt: a.created_at,
    })),
  };
}

// ---------------- Business approval ----------------

/** Shared by every admin list endpoint (businesses/users/events) — clamps
 * page/limit to sane bounds and computes the SQL OFFSET once so each
 * caller doesn't repeat the same parsing. */
function pageParams(page, limit, defaultLimit = 20) {
  const pageLimit = Math.min(Math.max(parseInt(limit, 10) || defaultLimit, 1), 100);
  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  return { pageNum, pageLimit, offset: (pageNum - 1) * pageLimit };
}

function paginationMeta(pageNum, pageLimit, total) {
  return { page: pageNum, limit: pageLimit, total, totalPages: Math.max(Math.ceil(total / pageLimit), 1) };
}

/**
 * Turns a client-supplied `sortBy` into a real `ORDER BY` clause without
 * ever interpolating a client string directly into SQL — `columnMap`'s
 * keys are the only sort values ever accepted (anything else, or
 * omitted, falls back to `defaultKey`), and its values are the actual
 * column expressions. `sortOrder` is similarly constrained to exactly
 * 'asc'/'desc', falling back to `defaultDirection` for anything else.
 */
function resolveSort(sortBy, sortOrder, columnMap, defaultKey, defaultDirection = 'DESC') {
  const key = Object.prototype.hasOwnProperty.call(columnMap, sortBy) ? sortBy : defaultKey;
  const direction = sortOrder === 'asc' ? 'ASC' : sortOrder === 'desc' ? 'DESC' : defaultDirection;
  return `${columnMap[key]} ${direction}`;
}

const BUSINESS_SORT_COLUMNS = { name: 'b.name', createdAt: 'b.created_at' };

/**
 * Pending Review is just "All Businesses filtered to status=pending",
 * oldest-first by default (handle the longest-waiting submissions first)
 * instead of All Businesses' newest-first-by-default — everything else
 * (search, date range, sorting, pagination) is identical, so this is a
 * thin wrapper instead of a separate query. An explicit sortBy/sortOrder
 * from the admin portal (clicking a column header) still overrides the
 * default either way.
 */
async function getPendingBusinesses(params = {}) {
  return getAllBusinesses({
    ...params,
    status: 'pending',
    // Spreading params first and overriding after (rather than the
    // reverse) matters here — the controller always passes sortBy/
    // sortOrder through, as `undefined` when absent from the query
    // string, and `undefined` would silently clobber a default placed
    // before the spread.
    sortBy: params.sortBy || 'createdAt',
    sortOrder: params.sortOrder || 'asc',
  });
}

async function getAllBusinesses({ status, search, dateFrom, dateTo, page, limit, sortBy, sortOrder } = {}) {
  const { pageNum, pageLimit, offset } = pageParams(page, limit);

  let sql = `
    SELECT SQL_CALC_FOUND_ROWS b.*, owner.name AS owner_name, owner.email AS owner_email, owner.phone AS owner_phone,
           owner.account_status AS owner_account_status, reviewer.name AS reviewer_name
    FROM businesses b
    JOIN users owner ON owner.id = b.owner_id
    LEFT JOIN users reviewer ON reviewer.id = b.reviewed_by
    WHERE 1=1
  `;
  const params = [];
  if (status) {
    sql += ' AND b.status = ?';
    params.push(status);
  }
  if (search) {
    sql += ' AND b.name LIKE ?';
    params.push(`%${search}%`);
  }
  // dateFrom/dateTo arrive as exact "YYYY-MM-DD HH:MM:SS" UTC boundaries,
  // already converted client-side from the admin's own local calendar-day
  // selection (see admin1's lib/dates.ts localDateRangeToUtcBounds) —
  // created_at is stored as a naive UTC datetime (no zone marker), so
  // comparing it against a bare "YYYY-MM-DD" directly here would silently
  // use MySQL's own notion of midnight for that date (i.e. UTC midnight),
  // not the admin's local midnight. That mismatch was the actual bug:
  // "today" in the picker could exclude/include a few hours of businesses
  // near midnight depending on the admin's own timezone offset. dateTo is
  // already the exclusive upper bound (local midnight of the day AFTER
  // the picked end date, in UTC) — no DATE_ADD needed here anymore.
  if (dateFrom) {
    sql += ' AND b.created_at >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND b.created_at < ?';
    params.push(dateTo);
  }
  sql += ` ORDER BY ${resolveSort(sortBy, sortOrder, BUSINESS_SORT_COLUMNS, 'createdAt')} LIMIT ? OFFSET ?`;
  params.push(pageLimit, offset);

  const [rows] = await pool.query(sql, params);
  const [[{ total }]] = await pool.query('SELECT FOUND_ROWS() AS total');

  return {
    data: rows.map(businessService.toAdminBusiness),
    pagination: paginationMeta(pageNum, pageLimit, total),
  };
}

async function reviewBusiness(businessId, adminId, decision, reason) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw ApiError.badRequest('decision must be "approved" or "rejected"');
  }
  // A rejection with no explanation leaves the owner with nothing
  // actionable to fix — the route-level validator (admin.routes.js)
  // already enforces this from the request body, but this is the real
  // authority: never trust that every caller of this function went
  // through that route.
  if (decision === 'rejected' && !reason?.trim()) {
    throw ApiError.badRequest('A rejection reason is required');
  }

  const [rows] = await pool.query(
    `SELECT b.*, owner.account_status AS owner_account_status, owner.email AS owner_email
     FROM businesses b
     JOIN users owner ON owner.id = b.owner_id
     WHERE b.id = ?`,
    [businessId],
  );
  const business = rows[0];
  if (!business) throw ApiError.notFound('Business not found');
  if (business.status !== 'pending') {
    throw ApiError.conflict(`Business is already ${business.status}, not pending`);
  }
  // Blocks approval only — rejecting a business from an incomplete
  // account is still fine (there's nothing to protect the owner from by
  // waiting on that). This is what business-import.service.js's whole
  // invite mechanism exists to enforce: a business linked to an account
  // nobody has actually proven they control yet can't go live, no matter
  // what an admin clicks.
  if (decision === 'approved' && business.owner_account_status === 'invited') {
    throw ApiError.forbidden(
      `Cannot approve — the business owner hasn't activated their account yet. ` +
        `An invitation was sent to ${business.owner_email}; they need to set a password before this can be approved.`,
    );
  }

  const trimmedReason = decision === 'rejected' ? reason.trim() : null;

  await pool.query(
    `UPDATE businesses
     SET status = ?, rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW()
     WHERE id = ?`,
    [decision, trimmedReason, adminId, businessId],
  );

  await pool.query(
    `INSERT INTO business_status_history (id, business_id, old_status, new_status, reason, changed_by)
     VALUES (?, ?, 'pending', ?, ?, ?)`,
    [uuidv4(), businessId, decision, trimmedReason, adminId],
  );

  await notificationService.notifyBusinessStatusChange(businessId, business.owner_id, decision, trimmedReason);

  const updated = await businessService.getBusinessById(businessId);

  // Fire-and-forget — same reasoning as everywhere else email gets sent
  // from this codebase (submitBusiness, forgotPassword, ...): a slow or
  // failed send should never delay or break the actual review response,
  // and sendEmail() already catches its own errors internally.
  const [ownerRows] = await pool.query('SELECT name, email FROM users WHERE id = ?', [business.owner_id]);
  const owner = ownerRows[0];
  if (owner) {
    if (decision === 'approved') {
      emailService.sendBusinessApprovedEmail(owner, updated);
    } else {
      emailService.sendBusinessRejectedEmail(owner, updated, trimmedReason);
    }
  }

  return updated;
}

async function deactivateBusiness(businessId, isActive, adminId, reason) {
  // Deactivating (not reactivating) requires an explanation — the same
  // reasoning as a rejection: the owner needs something actionable, not
  // just "your listing disappeared." Reactivating needs no reason; it's
  // undoing a problem, not creating one to explain.
  if (!isActive && !reason?.trim()) {
    throw ApiError.badRequest('A deactivation reason is required');
  }

  const [existingRows] = await pool.query('SELECT * FROM businesses WHERE id = ?', [businessId]);
  const existing = existingRows[0];
  if (!existing) throw ApiError.notFound('Business not found');

  // No-op if it's already in the requested state — avoids a spurious
  // "reactivated" email (and a pointless history row) from, say, two
  // admin tabs both submitting a stale "Deactivate" click.
  const wasActive = !!existing.is_active;
  if (wasActive === isActive) {
    return businessService.getBusinessById(businessId);
  }

  const trimmedReason = isActive ? null : reason.trim();

  await pool.query('UPDATE businesses SET is_active = ?, deactivation_reason = ? WHERE id = ?', [
    isActive ? 1 : 0,
    trimmedReason,
    businessId,
  ]);

  await pool.query(
    `INSERT INTO business_status_history (id, business_id, old_status, new_status, reason, changed_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      uuidv4(),
      businessId,
      existing.status,
      existing.status,
      isActive ? 'Reactivated by admin' : trimmedReason,
      adminId || null,
    ],
  );

  const updated = await businessService.getBusinessById(businessId);

  const [ownerRows] = await pool.query('SELECT name, email FROM users WHERE id = ?', [existing.owner_id]);
  const owner = ownerRows[0];
  if (owner) {
    if (isActive) {
      emailService.sendBusinessReactivatedEmail(owner, updated);
    } else {
      emailService.sendBusinessDeactivatedEmail(owner, updated, trimmedReason);
    }
  }

  return updated;
}

// ---------------- User management ----------------

const USER_SORT_COLUMNS = { name: 'name', createdAt: 'created_at' };

async function getAllUsers({ search, dateFrom, dateTo, page, limit, sortBy, sortOrder } = {}) {
  const { pageNum, pageLimit, offset } = pageParams(page, limit);

  let sql = `SELECT SQL_CALC_FOUND_ROWS id, email, name, phone, role, is_active, deactivation_reason, account_status, created_at FROM users WHERE role = 'business'`;
  const params = [];
  if (search) {
    sql += ' AND (name LIKE ? OR email LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  // See getAllBusinesses' comment above — dateFrom/dateTo are already
  // precise UTC boundaries computed client-side from the admin's local
  // calendar-day selection, not bare dates.
  if (dateFrom) {
    sql += ' AND created_at >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND created_at < ?';
    params.push(dateTo);
  }
  sql += ` ORDER BY ${resolveSort(sortBy, sortOrder, USER_SORT_COLUMNS, 'createdAt')} LIMIT ? OFFSET ?`;
  params.push(pageLimit, offset);

  const [rows] = await pool.query(sql, params);
  const [[{ total }]] = await pool.query('SELECT FOUND_ROWS() AS total');

  return {
    data: rows.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      phone: u.phone,
      role: u.role,
      isActive: !!u.is_active,
      deactivationReason: u.deactivation_reason || null,
      accountStatus: u.account_status,
      createdAt: u.created_at,
    })),
    pagination: paginationMeta(pageNum, pageLimit, total),
  };
}

/**
 * Every business user, unpaginated and unfiltered — a full export is
 * meant to be a complete snapshot, not "whatever the admin's current
 * table filters happened to be" (see importBusinessesFromCsv for the
 * companion import direction). csv-stringify handles quoting fields that
 * contain commas/quotes/newlines correctly, which a hand-rolled
 * `.join(',')` would get wrong on a real name or note.
 */
async function exportUsersToCsv() {
  const [rows] = await pool.query(
    `SELECT id, email, name, phone, is_active, deactivation_reason, account_status, created_at
     FROM users WHERE role = 'business' ORDER BY created_at DESC`,
  );

  const records = rows.map((u) => ({
    ID: u.id,
    Name: u.name,
    Email: u.email,
    Phone: u.phone || '',
    Status: u.is_active ? 'active' : 'banned',
    'Deactivation Reason': u.deactivation_reason || '',
    // 'invited' means this account was created by a CSV business import
    // and the owner hasn't set a password yet — see users.account_status
    // in schema.sql.
    'Account Status': u.account_status,
    'Joined': new Date(u.created_at).toISOString(),
  }));

  return stringify(records, { header: true });
}

async function setUserActive(userId, isActive, reason) {
  // Same reasoning as deactivateBusiness: banning needs a reason a
  // banned user can actually be told (see auth.service.js's login(),
  // which now surfaces it); reactivating doesn't.
  if (!isActive && !reason?.trim()) {
    throw ApiError.badRequest('A deactivation reason is required');
  }

  const [existingRows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
  const existing = existingRows[0];
  if (!existing) throw ApiError.notFound('User not found');

  // No-op if already in the requested state — same "avoid a spurious
  // duplicate email" reasoning as deactivateBusiness.
  const wasActive = !!existing.is_active;
  if (wasActive === isActive) return;

  const trimmedReason = isActive ? null : reason.trim();

  await pool.query('UPDATE users SET is_active = ?, deactivation_reason = ? WHERE id = ?', [
    isActive ? 1 : 0,
    trimmedReason,
    userId,
  ]);

  if (isActive) {
    emailService.sendUserReactivatedEmail(existing);
  } else {
    emailService.sendUserBannedEmail(existing, trimmedReason);
  }
}

// ---------------- Event moderation ----------------

const EVENT_SORT_COLUMNS = { name: 'e.name', startTime: 'e.start_time' };

async function getAllEvents({ search, dateFrom, dateTo, page, limit, sortBy, sortOrder } = {}) {
  const { pageNum, pageLimit, offset } = pageParams(page, limit);

  let sql = `
    SELECT SQL_CALC_FOUND_ROWS e.*, b.name AS business_name, owner.name AS owner_name, owner.email AS owner_email
    FROM events e
    JOIN businesses b ON b.id = e.business_id
    JOIN users owner ON owner.id = b.owner_id
    WHERE 1=1
  `;
  const params = [];
  if (search) {
    sql += ' AND (e.name LIKE ? OR b.name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  // Filters by when the event *happens* (start_time), not when it was
  // submitted — the table's own "Starts"/"Ends" columns are what an
  // admin actually orients by here, unlike businesses/users where
  // "submitted/joined on" (created_at) is the meaningful date.
  // Same UTC-boundary contract as getAllBusinesses/getAllUsers above.
  if (dateFrom) {
    sql += ' AND e.start_time >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND e.start_time < ?';
    params.push(dateTo);
  }
  sql += ` ORDER BY ${resolveSort(sortBy, sortOrder, EVENT_SORT_COLUMNS, 'startTime')} LIMIT ? OFFSET ?`;
  params.push(pageLimit, offset);

  const [rows] = await pool.query(sql, params);
  const [[{ total }]] = await pool.query('SELECT FOUND_ROWS() AS total');

  // toAdminEvent() maps snake_case DB columns to the camelCase shape the
  // admin portal expects (businessName, startTime, etc), plus the extra
  // admin-only context (isActive, createdAt, owner identity) — this was
  // the original reported bug: this function used to return raw unmapped
  // rows, so event.businessName and event.startTime were both `undefined`
  // (rendering as a blank Business column and "Invalid Date").
  return {
    data: rows.map(eventService.toAdminEvent),
    pagination: paginationMeta(pageNum, pageLimit, total),
  };
}

async function setEventActive(eventId, isActive) {
  const [result] = await pool.query('UPDATE events SET is_active = ? WHERE id = ?', [
    isActive ? 1 : 0,
    eventId,
  ]);
  if (result.affectedRows === 0) throw ApiError.notFound('Event not found');
}

// ---------------- Admin account management ----------------
// Fixes the "single seeded admin, no way to add another" gap — before
// this, the only admin account was whatever npm run db:seed created, with
// zero in-app way to add a second one or remove access from a departing
// admin without touching the database directly.

async function getAllAdmins() {
  const [rows] = await pool.query(
    `SELECT id, email, name, is_active, created_at FROM users WHERE role = 'admin' ORDER BY created_at ASC`,
  );
  return rows.map((a) => ({
    id: a.id,
    email: a.email,
    name: a.name,
    isActive: !!a.is_active,
    createdAt: a.created_at,
  }));
}

async function createAdmin({ email, password, name }) {
  const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
  if (existing.length > 0) {
    throw ApiError.conflict('An account with this email already exists');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const id = uuidv4();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, name, role, is_email_verified, is_active)
     VALUES (?, ?, ?, ?, 'admin', 1, 1)`,
    [id, email, passwordHash, name],
  );

  return { id, email, name, isActive: true };
}

/**
 * Refuses to let an admin delete themselves (avoids accidentally locking
 * yourself out) or delete the last remaining admin account (avoids
 * locking EVERYONE out of the admin portal with no way back in short of
 * a direct database edit).
 */
async function deleteAdmin(adminIdToDelete, requestingAdminId) {
  if (adminIdToDelete === requestingAdminId) {
    throw ApiError.badRequest('You cannot remove your own admin account');
  }

  const [[{ adminCount }]] = await pool.query(
    `SELECT COUNT(*) AS adminCount FROM users WHERE role = 'admin'`,
  );
  if (adminCount <= 1) {
    throw ApiError.badRequest('Cannot remove the last remaining admin account');
  }

  const [result] = await pool.query('DELETE FROM users WHERE id = ? AND role = "admin"', [
    adminIdToDelete,
  ]);
  if (result.affectedRows === 0) throw ApiError.notFound('Admin account not found');
}

module.exports = {
  getDashboardStats,
  getPendingBusinesses,
  getAllBusinesses,
  reviewBusiness,
  deactivateBusiness,
  getAllUsers,
  exportUsersToCsv,
  setUserActive,
  // Business CSV import — same thin-delegation pattern as categories/
  // notifications/content above.
  importBusinessesFromCsv: businessImportService.importBusinessesFromCsv,
  getAllEvents,
  setEventActive,
  getAllAdmins,
  createAdmin,
  deleteAdmin,
  // Categories — thin delegation to categoryService, kept here so
  // admin.routes.js's single requireAuth+requireRole('admin') gate covers
  // these too, same as every other admin-only resource.
  getAllCategories: categoryService.getAdminCategories,
  createCategory: categoryService.createCategory,
  updateCategory: categoryService.updateCategory,
  deleteCategory: categoryService.deleteCategory,
  // Notifications — same thin-delegation pattern as categories above.
  getPendingBroadcasts: notificationService.getPendingBroadcasts,
  getAllBroadcasts: notificationService.getAllBroadcasts,
  reviewBroadcast: notificationService.reviewBroadcast,
  // Site content (About Us, social links, Privacy Policy, Terms &
  // Conditions) — same thin-delegation pattern. Reading it isn't
  // admin-only (see the public /content route), only writing is.
  updateContent: contentService.updateContent,
};
