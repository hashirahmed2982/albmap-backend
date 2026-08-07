const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { pool } = require('../../config/db');
const ApiError = require('../../utils/ApiError');
const businessService = require('../businesses/business.service');
const eventService = require('../events/event.service');
const categoryService = require('../categories/category.service');
const notificationService = require('../notifications/notification.service');
const contentService = require('../content/content.service');

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
 * Pending Review is just "All Businesses filtered to status=pending",
 * oldest-first (handle the longest-waiting submissions first) instead of
 * All Businesses' newest-first — everything else (search, date range,
 * pagination) is identical, so this is a thin wrapper instead of a
 * separate query.
 */
async function getPendingBusinesses(params = {}) {
  return getAllBusinesses({ ...params, status: 'pending', order: 'ASC' });
}

async function getAllBusinesses({ status, search, dateFrom, dateTo, page, limit, order } = {}) {
  const { pageNum, pageLimit, offset } = pageParams(page, limit);

  let sql = `
    SELECT SQL_CALC_FOUND_ROWS b.*, owner.name AS owner_name, owner.email AS owner_email, owner.phone AS owner_phone,
           reviewer.name AS reviewer_name
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
  // dateTo is a plain "YYYY-MM-DD" from the admin portal's date picker —
  // treated as inclusive of the whole day (< the next day), not just
  // midnight, or picking a range that includes today would silently
  // exclude everything submitted today.
  if (dateFrom) {
    sql += ' AND b.created_at >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND b.created_at < DATE_ADD(?, INTERVAL 1 DAY)';
    params.push(dateTo);
  }
  sql += ` ORDER BY b.created_at ${order === 'ASC' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`;
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

  const [rows] = await pool.query('SELECT * FROM businesses WHERE id = ?', [businessId]);
  const business = rows[0];
  if (!business) throw ApiError.notFound('Business not found');
  if (business.status !== 'pending') {
    throw ApiError.conflict(`Business is already ${business.status}, not pending`);
  }

  await pool.query(
    `UPDATE businesses
     SET status = ?, rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW()
     WHERE id = ?`,
    [decision, decision === 'rejected' ? reason || null : null, adminId, businessId],
  );

  await pool.query(
    `INSERT INTO business_status_history (id, business_id, old_status, new_status, reason, changed_by)
     VALUES (?, ?, 'pending', ?, ?, ?)`,
    [uuidv4(), businessId, decision, reason || null, adminId],
  );

  await notificationService.notifyBusinessStatusChange(businessId, business.owner_id, decision, reason);

  return businessService.getBusinessById(businessId);
}

async function deactivateBusiness(businessId, isActive) {
  const [result] = await pool.query('UPDATE businesses SET is_active = ? WHERE id = ?', [
    isActive ? 1 : 0,
    businessId,
  ]);
  if (result.affectedRows === 0) throw ApiError.notFound('Business not found');
  return businessService.getBusinessById(businessId);
}

// ---------------- User management ----------------

async function getAllUsers({ search, dateFrom, dateTo, page, limit } = {}) {
  const { pageNum, pageLimit, offset } = pageParams(page, limit);

  let sql = `SELECT SQL_CALC_FOUND_ROWS id, email, name, phone, role, is_active, created_at FROM users WHERE role = 'business'`;
  const params = [];
  if (search) {
    sql += ' AND (name LIKE ? OR email LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  if (dateFrom) {
    sql += ' AND created_at >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND created_at < DATE_ADD(?, INTERVAL 1 DAY)';
    params.push(dateTo);
  }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
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
      createdAt: u.created_at,
    })),
    pagination: paginationMeta(pageNum, pageLimit, total),
  };
}

async function setUserActive(userId, isActive) {
  const [result] = await pool.query('UPDATE users SET is_active = ? WHERE id = ?', [
    isActive ? 1 : 0,
    userId,
  ]);
  if (result.affectedRows === 0) throw ApiError.notFound('User not found');
}

// ---------------- Event moderation ----------------

async function getAllEvents({ search, dateFrom, dateTo, page, limit } = {}) {
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
  if (dateFrom) {
    sql += ' AND e.start_time >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    sql += ' AND e.start_time < DATE_ADD(?, INTERVAL 1 DAY)';
    params.push(dateTo);
  }
  sql += ' ORDER BY e.start_time DESC LIMIT ? OFFSET ?';
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
  setUserActive,
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
