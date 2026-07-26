const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../config/db');
const ApiError = require('../../utils/ApiError');
const businessService = require('../businesses/business.service');
const analyticsService = require('../analytics/analytics.service');

/**
 * Server-side favorites, so a favorite survives a reinstall or a device
 * switch, and business_analytics.favorite_count reflects real usage
 * instead of being permanently stuck at whatever the DB default is (this
 * is the fix for adjustFavoriteCount() previously existing but never being
 * called from anywhere).
 */
async function addFavorite(userId, businessId) {
  const [businessRows] = await pool.query('SELECT id FROM businesses WHERE id = ?', [businessId]);
  if (businessRows.length === 0) throw ApiError.notFound('Business not found');

  const [existing] = await pool.query(
    'SELECT id FROM favorites WHERE user_id = ? AND business_id = ?',
    [userId, businessId],
  );
  if (existing.length > 0) return; // already favorited — idempotent, not an error

  await pool.query(
    'INSERT INTO favorites (id, user_id, business_id) VALUES (?, ?, ?)',
    [uuidv4(), userId, businessId],
  );
  await analyticsService.adjustFavoriteCount(businessId, 1);
}

async function removeFavorite(userId, businessId) {
  const [result] = await pool.query(
    'DELETE FROM favorites WHERE user_id = ? AND business_id = ?',
    [userId, businessId],
  );
  if (result.affectedRows > 0) {
    await analyticsService.adjustFavoriteCount(businessId, -1);
  }
}

/**
 * Returns full business objects (not just ids) — this is what the mobile
 * app's Favorites screen actually needs to render, sparing it a second
 * round-trip per favorited business.
 */
async function getMyFavorites(userId) {
  const [rows] = await pool.query(
    `SELECT b.* FROM favorites f
     JOIN businesses b ON b.id = f.business_id
     WHERE f.user_id = ?
     ORDER BY f.created_at DESC`,
    [userId],
  );
  return rows.map(businessService.toPublicBusiness);
}

async function isFavorite(userId, businessId) {
  const [rows] = await pool.query(
    'SELECT id FROM favorites WHERE user_id = ? AND business_id = ?',
    [userId, businessId],
  );
  return rows.length > 0;
}

module.exports = { addFavorite, removeFavorite, getMyFavorites, isFavorite };
