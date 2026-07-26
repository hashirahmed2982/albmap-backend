const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../config/db');
const ApiError = require('../../utils/ApiError');

function toPublicReview(row) {
  return {
    id: row.id,
    businessId: row.business_id,
    userId: row.user_id,
    userName: row.user_name || null,
    rating: row.rating,
    comment: row.comment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Recalculates business.rating_avg/rating_count from the reviews table —
 * this is the one place that ever writes to those two columns, keeping
 * them a denormalized cache rather than a second source of truth that
 * could drift from the actual reviews.
 */
async function recalculateBusinessRating(connection, businessId) {
  const [[{ avgRating, count }]] = await connection.query(
    'SELECT AVG(rating) AS avgRating, COUNT(*) AS count FROM reviews WHERE business_id = ?',
    [businessId],
  );
  await connection.query(
    'UPDATE businesses SET rating_avg = ?, rating_count = ? WHERE id = ?',
    [avgRating ? Number(avgRating).toFixed(1) : 0, count, businessId],
  );
}

async function getBusinessReviews(businessId, { page = 1, limit = 20 } = {}) {
  const pageLimit = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
  const offset = (Math.max(parseInt(page, 10) || 1, 1) - 1) * pageLimit;

  const [rows] = await pool.query(
    `SELECT r.*, u.name AS user_name FROM reviews r
     JOIN users u ON u.id = r.user_id
     WHERE r.business_id = ?
     ORDER BY r.created_at DESC
     LIMIT ? OFFSET ?`,
    [businessId, pageLimit, offset],
  );
  return rows.map(toPublicReview);
}

/**
 * Create-or-update semantics: a user can only ever have one review per
 * business (enforced by the DB's unique key), so submitting again just
 * updates their existing review rather than erroring — matches how most
 * real review UIs behave ("edit your review" rather than "you already
 * reviewed this").
 */
async function submitReview(businessId, userId, { rating, comment }) {
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    throw ApiError.badRequest('Rating must be an integer between 1 and 5');
  }

  const [businessRows] = await pool.query('SELECT status FROM businesses WHERE id = ?', [businessId]);
  if (businessRows.length === 0) throw ApiError.notFound('Business not found');
  if (businessRows[0].status !== 'approved') {
    throw ApiError.forbidden('Cannot review a business that is not approved');
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const id = uuidv4();
    await connection.query(
      `INSERT INTO reviews (id, business_id, user_id, rating, comment)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE rating = VALUES(rating), comment = VALUES(comment)`,
      [id, businessId, userId, rating, comment || null],
    );
    await recalculateBusinessRating(connection, businessId);

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  const [rows] = await pool.query(
    `SELECT r.*, u.name AS user_name FROM reviews r
     JOIN users u ON u.id = r.user_id
     WHERE r.business_id = ? AND r.user_id = ?`,
    [businessId, userId],
  );
  return toPublicReview(rows[0]);
}

async function deleteReview(businessId, userId) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const [result] = await connection.query(
      'DELETE FROM reviews WHERE business_id = ? AND user_id = ?',
      [businessId, userId],
    );
    if (result.affectedRows === 0) {
      throw ApiError.notFound('Review not found');
    }
    await recalculateBusinessRating(connection, businessId);

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = { getBusinessReviews, submitReview, deleteReview };
