const asyncHandler = require('../../utils/asyncHandler');
const notificationService = require('./notification.service');
const { pool } = require('../../config/db');

const submitBroadcast = asyncHandler(async (req, res) => {
  const { title, body } = req.body;
  const result = await notificationService.submitBroadcast(req.user.id, req.params.id, { title, body });
  res.status(201).json(result);
});

/**
 * Registers/updates the current device's FCM token. Call this from the
 * mobile app on startup and whenever Firebase reports a token refresh
 * (FirebaseMessaging.instance.onTokenRefresh). Last write wins — this
 * schema supports one active token per user (single most-recent device);
 * extend to a separate user_devices table if you need multi-device
 * delivery to the same account.
 */
const updateFcmToken = asyncHandler(async (req, res) => {
  const { fcmToken } = req.body;
  await pool.query('UPDATE users SET fcm_token = ? WHERE id = ?', [fcmToken, req.user.id]);
  res.status(204).send();
});

const getFeed = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const { notifications, unreadCount, pagination } = await notificationService.getFeedForUser(
    req.user.id,
    { page, limit },
  );
  res.json({ data: notifications, unreadCount, pagination });
});

const markAsRead = asyncHandler(async (req, res) => {
  await notificationService.markAsRead(req.params.id, req.user.id);
  res.status(204).send();
});

const markAllAsRead = asyncHandler(async (req, res) => {
  await notificationService.markAllAsRead(req.user.id);
  res.status(204).send();
});

const deleteNotification = asyncHandler(async (req, res) => {
  await notificationService.deleteNotification(req.params.id, req.user.id);
  res.status(204).send();
});

const deleteAllNotifications = asyncHandler(async (req, res) => {
  await notificationService.deleteAllNotifications(req.user.id);
  res.status(204).send();
});

module.exports = {
  submitBroadcast,
  updateFcmToken,
  getFeed,
  markAsRead,
  markAllAsRead,
  deleteNotification,
  deleteAllNotifications,
};
