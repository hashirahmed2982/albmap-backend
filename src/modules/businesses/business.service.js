const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../config/db');
const ApiError = require('../../utils/ApiError');

/**
 * Builds a single display-friendly line from the structured address
 * fields — "Street, Postal Code City, Country" (the common European/
 * international convention) — for anywhere a UI wants one line rather
 * than four separate fields (map pins, list cards, share text, etc).
 * The structured fields themselves remain the source of truth; this is
 * purely a rendering convenience computed on the way out, never stored.
 */
function formatAddress(row) {
  const parts = [row.street_address, `${row.postal_code} ${row.city}`.trim(), row.country].filter(Boolean);
  return parts.join(', ');
}

function toPublicBusiness(row) {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    description: row.description,
    category: row.category,
    streetAddress: row.street_address,
    city: row.city,
    postalCode: row.postal_code,
    country: row.country,
    formattedAddress: formatAddress(row),
    latitude: Number(row.latitude),
    longitude: row.longitude !== null ? Number(row.longitude) : null,
    phone: row.phone,
    whatsappNumber: row.whatsapp_number,
    logoUrl: row.logo_url,
    openingHours: row.opening_hours || {},
    tags: row.tags || [],
    status: row.status,
    rating: row.rating_count > 0 ? Number(row.rating_avg) : null,
    ratingCount: row.rating_count ?? 0,
  };
}

// Fields that materially change what a business claims to be — editing any
// of these on an already-approved listing puts it back into the pending
// queue for re-review. Cosmetic/operational fields (phone, hours, tags,
// logo, description) don't require re-review since they can't be used to
// misrepresent what the business fundamentally is or where it's located.
const SENSITIVE_FIELDS = [
  'name', 'category', 'street_address', 'city', 'postal_code', 'country', 'latitude', 'longitude',
];

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function normalizePagination(page, limit) {
  const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const normalizedPage = Math.max(parseInt(page, 10) || 1, 1);
  return { limit: normalizedLimit, offset: (normalizedPage - 1) * normalizedLimit, page: normalizedPage };
}

/**
 * Public discovery feed — approved + active businesses only. Paginated:
 * without this, GET /businesses returns every matching row with no LIMIT
 * at all, which is fine at a handful of seed businesses but becomes a
 * multi-megabyte, unbounded query the moment there's real data volume.
 */
async function getBusinesses({ category, sortBy = 'distance', userLat, userLng, radiusKm, page, limit }) {
  const { limit: pageLimit, offset, page: pageNum } = normalizePagination(page, limit);

  let sql = `SELECT SQL_CALC_FOUND_ROWS * FROM businesses WHERE status = 'approved' AND is_active = 1`;
  const params = [];

  if (category) {
    sql += ' AND category = ?';
    params.push(category);
  }

  if (sortBy === 'popularity') {
    sql += ' ORDER BY rating_avg DESC, rating_count DESC';
  }

  // Distance sort/radius-filter happen in application code (need Haversine,
  // not expressible as a simple ORDER BY) — so those two cases fetch
  // without a SQL LIMIT and paginate the post-computed array instead.
  // Fine at real-world city scale (thousands, not millions, of rows);
  // revisit with a spatial index (MySQL's ST_Distance_Sphere or a
  // dedicated search service) if this table grows far beyond that.
  const needsAppSidePagination = userLat != null && userLng != null;
  if (!needsAppSidePagination) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(pageLimit, offset);
  }

  const [rows] = await pool.query(sql, params);
  let businesses = rows.map(toPublicBusiness);
  let total;

  if (needsAppSidePagination) {
    businesses = businesses.map((b) => ({
      ...b,
      _distanceKm: haversineKm(userLat, userLng, b.latitude, b.longitude),
    }));

    if (radiusKm != null) {
      businesses = businesses.filter((b) => b._distanceKm <= radiusKm);
    }
    if (sortBy === 'distance') {
      businesses.sort((a, b) => a._distanceKm - b._distanceKm);
    }
    businesses = businesses.map(({ _distanceKm, ...rest }) => rest);

    total = businesses.length;
    businesses = businesses.slice(offset, offset + pageLimit);
  } else {
    const [[{ total: foundTotal }]] = await pool.query('SELECT FOUND_ROWS() AS total');
    total = foundTotal;
  }

  return {
    businesses,
    pagination: { page: pageNum, limit: pageLimit, total, totalPages: Math.ceil(total / pageLimit) },
  };
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getBusinessById(id) {
  const [rows] = await pool.query('SELECT * FROM businesses WHERE id = ? LIMIT 1', [id]);
  if (rows.length === 0) throw ApiError.notFound('Business not found');
  return toPublicBusiness(rows[0]);
}

/**
 * Expanded beyond name-only: also matches category and tags, so searching
 * "coffee" surfaces a business tagged "coffee" even if that word isn't in
 * its name. Still a plain LIKE (no fuzzy/typo tolerance) — acceptable for
 * now, but a real relevance-ranked search (MySQL FULLTEXT index, or an
 * external service like Meilisearch/Algolia/Elasticsearch) is the right
 * next step once search quality becomes a real user complaint rather than
 * a theoretical gap.
 */
async function searchBusinesses(query, { page, limit }) {
  const { limit: pageLimit, offset, page: pageNum } = normalizePagination(page, limit);
  const likeQuery = `%${query}%`;

  const [rows] = await pool.query(
    `SELECT SQL_CALC_FOUND_ROWS * FROM businesses
     WHERE status = 'approved' AND is_active = 1
       AND (name LIKE ? OR category LIKE ? OR JSON_SEARCH(tags, 'one', ?) IS NOT NULL)
     ORDER BY name ASC
     LIMIT ? OFFSET ?`,
    [likeQuery, likeQuery, likeQuery, pageLimit, offset],
  );
  const [[{ total }]] = await pool.query('SELECT FOUND_ROWS() AS total');

  return {
    businesses: rows.map(toPublicBusiness),
    pagination: { page: pageNum, limit: pageLimit, total, totalPages: Math.ceil(total / pageLimit) },
  };
}

/**
 * Every business owned by a given user, regardless of approval status.
 * Unlike getBusinesses(), this intentionally includes pending/rejected —
 * an owner needs to see the full picture of their own submissions.
 * Ownership is enforced by the caller (controller checks req.user.id).
 * Not paginated — an individual owner's business count is never going to
 * be large enough to need it.
 */
async function getMyBusinesses(ownerId) {
  const [rows] = await pool.query(
    'SELECT * FROM businesses WHERE owner_id = ? ORDER BY created_at DESC',
    [ownerId],
  );
  return rows.map(toPublicBusiness);
}

/**
 * Lightweight duplicate check: same (case-insensitive) name within
 * ~150 meters of the submitted coordinates, among approved or
 * still-pending businesses (rejected ones don't block a resubmission).
 * This is a soft warning, not a hard block — real businesses do
 * occasionally share a name with something nearby (e.g. a chain), so the
 * caller can pass `confirmDuplicate: true` to submit anyway once they've
 * seen the warning.
 */
async function findPotentialDuplicate(name, latitude, longitude) {
  const [rows] = await pool.query(
    `SELECT id, name, street_address, city, postal_code, country, latitude, longitude FROM businesses
     WHERE LOWER(name) = LOWER(?) AND status IN ('approved', 'pending')`,
    [name],
  );

  for (const row of rows) {
    const distanceKm = haversineKm(latitude, longitude, Number(row.latitude), Number(row.longitude));
    if (distanceKm <= 0.15) {
      return {
        id: row.id,
        name: row.name,
        address: formatAddress(row),
        distanceMeters: Math.round(distanceKm * 1000),
      };
    }
  }
  return null;
}

async function submitBusiness(ownerId, data) {
  if (!data.confirmDuplicate) {
    const duplicate = await findPotentialDuplicate(data.name, data.latitude, data.longitude);
    if (duplicate) {
      const error = ApiError.conflict(
        `A business named "${duplicate.name}" already exists ${duplicate.distanceMeters}m away. ` +
          'Submit again with confirmDuplicate: true if this is a different business.',
      );
      error.duplicate = duplicate;
      throw error;
    }
  }

  const id = uuidv4();
  await pool.query(
    `INSERT INTO businesses
      (id, owner_id, name, description, category, street_address, city, postal_code, country,
       latitude, longitude, phone, whatsapp_number, logo_url, opening_hours, tags, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      id,
      ownerId,
      data.name,
      data.description || null,
      data.category,
      data.streetAddress,
      data.city,
      data.postalCode,
      data.country || 'Albania',
      data.latitude,
      data.longitude,
      data.phone || null,
      data.whatsappNumber || null,
      data.logoUrl || null,
      JSON.stringify(data.openingHours || {}),
      JSON.stringify(data.tags || []),
    ],
  );

  await pool.query(
    `INSERT INTO business_status_history (id, business_id, old_status, new_status, changed_by)
     VALUES (?, ?, NULL, 'pending', ?)`,
    [uuidv4(), id, ownerId],
  );

  await pool.query(
    'INSERT INTO business_analytics (business_id) VALUES (?)',
    [id],
  );

  return getBusinessById(id);
}

/**
 * Owner-only update to their own business's editable fields. Never allows
 * changing `status` directly — that's exclusively the admin approve/reject
 * flow (see modules/admin). BUT: if the business is currently 'approved'
 * and the edit touches a SENSITIVE_FIELDS entry (name/category/address
 * components/coordinates), this flips it back to 'pending' and logs the
 * transition — an approved listing can't be silently turned into
 * something else without going through review again. Non-sensitive edits
 * (phone, whatsapp, hours, tags, logo, description) never affect status.
 */
async function updateOwnBusiness(businessId, ownerId, data) {
  const [existingRows] = await pool.query('SELECT * FROM businesses WHERE id = ?', [businessId]);
  const existing = existingRows[0];
  if (!existing) throw ApiError.notFound('Business not found');
  if (existing.owner_id !== ownerId) {
    throw ApiError.forbidden('You do not own this business');
  }

  const fieldMap = {
    name: 'name',
    description: 'description',
    category: 'category',
    streetAddress: 'street_address',
    city: 'city',
    postalCode: 'postal_code',
    country: 'country',
    latitude: 'latitude',
    longitude: 'longitude',
    phone: 'phone',
    whatsappNumber: 'whatsapp_number',
    logoUrl: 'logo_url',
  };
  const updates = [];
  const params = [];
  let touchesSensitiveField = false;

  for (const [camelCase, column] of Object.entries(fieldMap)) {
    if (data[camelCase] !== undefined) {
      updates.push(`${column} = ?`);
      params.push(data[camelCase]);
      if (SENSITIVE_FIELDS.includes(column)) touchesSensitiveField = true;
    }
  }
  if (data.openingHours !== undefined) {
    updates.push('opening_hours = ?');
    params.push(JSON.stringify(data.openingHours));
  }
  if (data.tags !== undefined) {
    updates.push('tags = ?');
    params.push(JSON.stringify(data.tags));
  }

  const shouldResetToPending = existing.status === 'approved' && touchesSensitiveField;
  if (shouldResetToPending) {
    updates.push('status = ?');
    params.push('pending');
  }

  if (updates.length === 0) return toPublicBusiness(existing);

  params.push(businessId);
  await pool.query(`UPDATE businesses SET ${updates.join(', ')} WHERE id = ?`, params);

  if (shouldResetToPending) {
    await pool.query(
      `INSERT INTO business_status_history (id, business_id, old_status, new_status, reason, changed_by)
       VALUES (?, ?, 'approved', 'pending', 'Edited after approval — re-review required', ?)`,
      [uuidv4(), businessId, ownerId],
    );
  }

  return getBusinessById(businessId);
}

/**
 * Everything toPublicBusiness has, plus the fields an admin needs to
 * actually make an informed approve/reject decision: who owns it (name/
 * email/phone, not just an opaque owner_id), when it was submitted, its
 * full review history (who reviewed it, when, and why it was rejected if
 * it was), and whether it's currently active. None of this is exposed
 * publicly — a business's own audit trail isn't public information — so
 * this requires the caller's query to JOIN in owner/reviewer names (see
 * admin.service.js's getPendingBusinesses/getAllBusinesses).
 */
function toAdminBusiness(row) {
  return {
    ...toPublicBusiness(row),
    isActive: !!row.is_active,
    rejectionReason: row.rejection_reason,
    ownerName: row.owner_name || null,
    ownerEmail: row.owner_email || null,
    ownerPhone: row.owner_phone || null,
    reviewedBy: row.reviewed_by || null,
    reviewedByName: row.reviewer_name || null,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = {
  getBusinesses,
  getBusinessById,
  searchBusinesses,
  getMyBusinesses,
  submitBusiness,
  updateOwnBusiness,
  findPotentialDuplicate,
  toPublicBusiness,
  toAdminBusiness,
};
