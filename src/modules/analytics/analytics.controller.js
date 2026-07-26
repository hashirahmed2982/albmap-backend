const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');
const { pool } = require('../../config/db');
const analyticsService = require('./analytics.service');

/**
 * Analytics are private to the business owner (and admins) — this is
 * competitively sensitive data, not something any logged-in user should
 * be able to pull for a competitor's listing just by guessing an id.
 */
const getBusinessAnalytics = asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT owner_id FROM businesses WHERE id = ?', [req.params.id]);
  const business = rows[0];
  if (!business) throw ApiError.notFound('Business not found');

  const isOwner = business.owner_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  if (!isOwner && !isAdmin) {
    throw ApiError.forbidden('You do not have access to this business\'s analytics');
  }

  const analytics = await analyticsService.getBusinessAnalytics(req.params.id);
  res.json(analytics);
});

/**
 * Intentionally never throws to the client even on failure — analytics
 * recording is best-effort and should never surface an error to whoever's
 * just viewing a business or tapping Call/Directions. See
 * lib/features/dashboard/presentation/providers/analytics_providers.dart's
 * recordAnalyticsEvent() on the mobile side, which is fire-and-forget too.
 */
const recordEvent = asyncHandler(async (req, res) => {
  try {
    await analyticsService.recordEvent(req.params.id, req.body.type);
  } catch (err) {
    console.error('Analytics recording failed (non-fatal):', err.message);
  }
  res.status(204).send();
});

module.exports = { getBusinessAnalytics, recordEvent };
