const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../config/db');
const ApiError = require('../../utils/ApiError');
const { sendToTopic, ALL_USERS_TOPIC } = require('./fcm');
const emailService = require('./email');

function toPublicNotification(row) {
  return {
    id: row.id,
    businessId: row.business_id,
    businessName: row.business_name || null,
    type: row.type,
    title: row.title,
    body: row.body,
    relatedId: row.related_id,
    createdAt: row.created_at,
    isRead: !!row.is_read,
  };
}

function toAdminNotification(row) {
  return {
    id: row.id,
    businessId: row.business_id,
    businessName: row.business_name || null,
    type: row.type,
    title: row.title,
    body: row.body,
    relatedId: row.related_id,
    status: row.status,
    rejectionReason: row.rejection_reason,
    senderName: row.sender_name || null,
    senderEmail: row.sender_email || null,
    reviewedByName: row.reviewer_name || null,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

/**
 * Business owner submits a broadcast — this used to deliver immediately
 * (see the old broadcastFromBusiness); now it only creates a *pending*
 * record. Nothing is sent to any device, and nothing appears in anyone's
 * notification feed, until an admin approves it (see approveNotification
 * below). This is the actual fix for "any business owner can push
 * whatever they want straight to every user" — there's now a moderation
 * gate in between, matching how business listings themselves work.
 */
async function submitBroadcast(userId, businessId, { title, body }) {
  const [rows] = await pool.query('SELECT owner_id, name, status FROM businesses WHERE id = ?', [
    businessId,
  ]);
  const business = rows[0];
  if (!business) throw ApiError.notFound('Business not found');
  if (business.owner_id !== userId) {
    throw ApiError.forbidden('You can only send notifications for your own businesses');
  }
  if (business.status !== 'approved') {
    throw ApiError.forbidden('Only approved businesses can send notifications');
  }

  const id = uuidv4();
  await pool.query(
    `INSERT INTO notifications (id, business_id, type, title, body, related_id, sent_by, status)
     VALUES (?, ?, 'business_offer', ?, ?, ?, ?, 'pending')`,
    [id, businessId, title, body, businessId, userId],
  );

  return { id, status: 'pending' };
}

/**
 * Sent automatically by the admin business-review flow (see
 * modules/admin/admin.service.js) — not user-submitted content, so this
 * skips the approval queue entirely (status is inserted as 'approved'
 * directly) and delivers straight to the specific owner, not everyone.
 */
async function notifyBusinessStatusChange(businessId, ownerId, status, reason) {
  const isApproved = status === 'approved';
  const title = isApproved ? 'Your business was approved! 🎉' : 'Update on your business listing';
  const body = isApproved
    ? 'Your business is now live on AlbMap and visible to everyone.'
    : `Your submission was not approved.${reason ? ` Reason: ${reason}` : ''}`;

  const id = uuidv4();
  await pool.query(
    `INSERT INTO notifications (id, business_id, type, title, body, related_id, target_user_id, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'approved')`,
    [id, businessId, isApproved ? 'business_approved' : 'business_rejected', title, body, businessId, ownerId],
  );

  // Direct-to-user delivery (not topic-based) since this only concerns the
  // owner, not every registered user.
  const [userRows] = await pool.query('SELECT fcm_token FROM users WHERE id = ?', [ownerId]);
  const fcmToken = userRows[0]?.fcm_token;
  if (fcmToken) {
    await sendToTopic(`user_${ownerId}`, { title, body, data: { type: 'business_status', businessId } });
  }
}

// ---------------- Admin review queue ----------------

async function getPendingBroadcasts() {
  const [rows] = await pool.query(
    `SELECT n.*, b.name AS business_name, sender.name AS sender_name, sender.email AS sender_email
     FROM notifications n
     JOIN businesses b ON b.id = n.business_id
     JOIN users sender ON sender.id = n.sent_by
     WHERE n.status = 'pending'
     ORDER BY n.created_at ASC`,
  );
  return rows.map(toAdminNotification);
}

async function getAllBroadcasts({ status } = {}) {
  let sql = `
    SELECT n.*, b.name AS business_name, sender.name AS sender_name, sender.email AS sender_email,
           reviewer.name AS reviewer_name
    FROM notifications n
    JOIN businesses b ON b.id = n.business_id
    JOIN users sender ON sender.id = n.sent_by
    LEFT JOIN users reviewer ON reviewer.id = n.reviewed_by
    WHERE n.sent_by IS NOT NULL
  `;
  const params = [];
  if (status) {
    sql += ' AND n.status = ?';
    params.push(status);
  }
  sql += ' ORDER BY n.created_at DESC';
  const [rows] = await pool.query(sql, params);
  return rows.map(toAdminNotification);
}

/**
 * The moment of actual delivery: approving a pending broadcast is what
 * triggers the real FCM send to every registered device (the global
 * ALL_USERS_TOPIC, not a per-business topic — this notification is meant
 * to reach everyone, matching "shooted on every registered user device").
 * The notification also becomes visible in every user's in-app
 * Notifications screen from this point on (see getFeedForUser below,
 * which only ever returns status='approved' rows).
 */
async function reviewBroadcast(notificationId, adminId, decision, reason) {
  if (!['approved', 'rejected'].includes(decision)) {
    throw ApiError.badRequest('decision must be "approved" or "rejected"');
  }

  const [rows] = await pool.query('SELECT * FROM notifications WHERE id = ?', [notificationId]);
  const notification = rows[0];
  if (!notification) throw ApiError.notFound('Notification not found');
  if (notification.status !== 'pending') {
    throw ApiError.conflict(`Notification is already ${notification.status}, not pending`);
  }

  await pool.query(
    `UPDATE notifications
     SET status = ?, rejection_reason = ?, reviewed_by = ?, reviewed_at = NOW()
     WHERE id = ?`,
    [decision, decision === 'rejected' ? reason || null : null, adminId, notificationId],
  );

  let delivery = { delivered: false, reason: 'Not approved' };
  if (decision === 'approved') {
    delivery = await sendToTopic(ALL_USERS_TOPIC, {
      title: notification.title,
      body: notification.body,
      data: { type: 'business_offer', businessId: notification.business_id, notificationId },
    });
  }

  // Fire-and-forget — same reasoning as everywhere else email gets sent
  // from this codebase (see admin.service.js's reviewBusiness): a slow or
  // failed send should never delay or break the actual review response,
  // and sendEmail() already catches its own errors internally. The push
  // above (or lack of one, on rejection) only ever reaches the *submitter*
  // if their device happens to be registered and the app is running — an
  // owner who submitted this from a device they're not currently using,
  // or who primarily uses the website, would otherwise never learn what
  // happened to their own submission.
  const [senderRows] = await pool.query('SELECT name, email FROM users WHERE id = ?', [notification.sent_by]);
  const sender = senderRows[0];
  if (sender) {
    if (decision === 'approved') {
      emailService.sendNotificationApprovedEmail(sender, notification);
    } else {
      emailService.sendNotificationRejectedEmail(sender, notification, reason);
    }
  }

  return { id: notificationId, status: decision, delivery };
}

// ---------------- User-facing feed ----------------

/**
 * Every approved broadcast/system notice, with isRead computed per the
 * requesting user via a LEFT JOIN against notification_reads — this is
 * what the in-app Notifications screen fetches, replacing the old
 * purely-local (device-only, never synced) Hive-backed list. Pending and
 * rejected broadcasts never appear here — only approved ones are visible
 * to end users at all. Anything this user has deleted (notification_deletes)
 * is excluded the same way — permanently, from their feed only.
 */
async function getFeedForUser(userId, { page = 1, limit = 30 } = {}) {
  const pageLimit = Math.min(Math.max(parseInt(limit, 10) || 30, 1), 100);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * pageLimit;

  // target_user_id IS NULL means "broadcast to everyone" (an approved
  // business_offer); target_user_id = ? means "only this specific user"
  // (a personal business_approved/business_rejected notice). Without this
  // second condition, every user would see every other business owner's
  // private approval/rejection notices too.
  const [rows] = await pool.query(
    `SELECT SQL_CALC_FOUND_ROWS n.*, b.name AS business_name,
            (r.id IS NOT NULL) AS is_read
     FROM notifications n
     LEFT JOIN businesses b ON b.id = n.business_id
     LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
     LEFT JOIN notification_deletes d ON d.notification_id = n.id AND d.user_id = ?
     WHERE n.status = 'approved' AND (n.target_user_id IS NULL OR n.target_user_id = ?) AND d.id IS NULL
     ORDER BY n.created_at DESC
     LIMIT ? OFFSET ?`,
    [userId, userId, userId, pageLimit, offset],
  );
  const [[{ total }]] = await pool.query('SELECT FOUND_ROWS() AS total');
  const [[{ unreadCount }]] = await pool.query(
    `SELECT COUNT(*) AS unreadCount FROM notifications n
     LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = ?
     LEFT JOIN notification_deletes d ON d.notification_id = n.id AND d.user_id = ?
     WHERE n.status = 'approved' AND (n.target_user_id IS NULL OR n.target_user_id = ?)
       AND r.id IS NULL AND d.id IS NULL`,
    [userId, userId, userId],
  );

  return {
    notifications: rows.map(toPublicNotification),
    unreadCount: Number(unreadCount),
    pagination: { page, limit: pageLimit, total, totalPages: Math.ceil(total / pageLimit) },
  };
}

async function markAsRead(notificationId, userId) {
  await pool.query(
    `INSERT INTO notification_reads (id, notification_id, user_id)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE read_at = read_at`, // idempotent — already-read stays as-is
    [uuidv4(), notificationId, userId],
  );
}

async function markAllAsRead(userId) {
  const [visibleRows] = await pool.query(
    `SELECT id FROM notifications
     WHERE status = 'approved' AND (target_user_id IS NULL OR target_user_id = ?)`,
    [userId],
  );
  if (visibleRows.length === 0) return;

  const values = visibleRows.map((r) => [uuidv4(), r.id, userId]);
  await pool.query(
    `INSERT IGNORE INTO notification_reads (id, notification_id, user_id) VALUES ?`,
    [values],
  );
}

/**
 * Removes one notification from just this user's feed. Notifications are
 * shared rows (a broadcast is the exact same row every recipient sees), so
 * this can never be a real DELETE FROM notifications — that would remove
 * it from everyone at once. Instead it records a per-user "hide" the same
 * way markAsRead records a per-user "read" (see notification_deletes,
 * mirroring notification_reads). getFeedForUser excludes anything hidden
 * this way, permanently, for that user.
 *
 * 404s if the notification doesn't exist or was never visible to this
 * user in the first place (wrong target_user_id, or still pending/
 * rejected) — same visibility rule getFeedForUser enforces, so a user
 * can't probe for/hide notifications that were never theirs to see.
 */
async function deleteNotification(notificationId, userId) {
  const [rows] = await pool.query(
    `SELECT id FROM notifications
     WHERE id = ? AND status = 'approved' AND (target_user_id IS NULL OR target_user_id = ?)`,
    [notificationId, userId],
  );
  if (!rows[0]) throw ApiError.notFound('Notification not found');

  await pool.query(
    `INSERT INTO notification_deletes (id, notification_id, user_id)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE deleted_at = deleted_at`, // idempotent — already-hidden stays as-is
    [uuidv4(), notificationId, userId],
  );
}

/** "Clear all" — hides every notification currently visible to this user. */
async function deleteAllNotifications(userId) {
  const [visibleRows] = await pool.query(
    `SELECT n.id FROM notifications n
     LEFT JOIN notification_deletes d ON d.notification_id = n.id AND d.user_id = ?
     WHERE n.status = 'approved' AND (n.target_user_id IS NULL OR n.target_user_id = ?) AND d.id IS NULL`,
    [userId, userId],
  );
  if (visibleRows.length === 0) return;

  const values = visibleRows.map((r) => [uuidv4(), r.id, userId]);
  await pool.query(
    `INSERT IGNORE INTO notification_deletes (id, notification_id, user_id) VALUES ?`,
    [values],
  );
}

module.exports = {
  submitBroadcast,
  notifyBusinessStatusChange,
  getPendingBroadcasts,
  getAllBroadcasts,
  reviewBroadcast,
  getFeedForUser,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteAllNotifications,
};
