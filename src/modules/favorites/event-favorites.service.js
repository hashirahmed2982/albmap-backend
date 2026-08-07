const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../config/db');
const ApiError = require('../../utils/ApiError');
const eventService = require('../events/event.service');

/**
 * Event favorites, mirroring favorites.service.js's business favorites —
 * kept in their own table/module (event_favorites, not a nullable
 * event_id on `favorites`) rather than merged into it; see the schema.sql
 * comment on event_favorites for why. Previously event favorites only
 * ever lived in the mobile app's local Hive cache, gone on reinstall or a
 * new device — this is what makes them survive both, same as business
 * favorites already did.
 */
async function addFavorite(userId, eventId) {
  const [eventRows] = await pool.query('SELECT id FROM events WHERE id = ?', [eventId]);
  if (eventRows.length === 0) throw ApiError.notFound('Event not found');

  const [existing] = await pool.query(
    'SELECT id FROM event_favorites WHERE user_id = ? AND event_id = ?',
    [userId, eventId],
  );
  if (existing.length > 0) return; // already favorited — idempotent, not an error

  await pool.query(
    'INSERT INTO event_favorites (id, user_id, event_id) VALUES (?, ?, ?)',
    [uuidv4(), userId, eventId],
  );
}

async function removeFavorite(userId, eventId) {
  await pool.query('DELETE FROM event_favorites WHERE user_id = ? AND event_id = ?', [userId, eventId]);
}

/**
 * Full event objects, same reasoning as favorites.service.js's
 * getMyFavorites: sparing the mobile app's Favorites screen a second
 * round-trip per favorited event.
 */
async function getMyFavorites(userId) {
  const [rows] = await pool.query(
    `SELECT e.*, b.name AS business_name FROM event_favorites f
     JOIN events e ON e.id = f.event_id
     JOIN businesses b ON b.id = e.business_id
     WHERE f.user_id = ?
     ORDER BY f.created_at DESC`,
    [userId],
  );
  return rows.map(eventService.toPublicEvent);
}

module.exports = { addFavorite, removeFavorite, getMyFavorites };
