const { pool } = require('../../config/db');
const ApiError = require('../../utils/ApiError');

const EVENT_COLUMN_MAP = {
  profileView: 'profile_clicks',
  websiteClick: 'website_clicks',
  callClick: 'call_clicks',
};

const EVENT_DAILY_TYPE_MAP = {
  profileView: 'profile_view',
  websiteClick: 'website_click',
  callClick: 'call_click',
};

/**
 * Matches the mobile app's AnalyticsEventType enum exactly (see
 * lib/features/dashboard/domain/entities/business_analytics_entity.dart).
 * Increments both the aggregate counter (fast dashboard reads) and today's
 * daily bucket (feeds the 7-day chart).
 */
async function recordEvent(businessId, type) {
  const column = EVENT_COLUMN_MAP[type];
  const dailyType = EVENT_DAILY_TYPE_MAP[type];
  if (!column) {
    throw ApiError.badRequest(`Unknown analytics event type: ${type}`);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.query(
      `INSERT INTO business_analytics (business_id, ${column})
       VALUES (?, 1)
       ON DUPLICATE KEY UPDATE ${column} = ${column} + 1`,
      [businessId],
    );

    await connection.query(
      `INSERT INTO business_analytics_daily (business_id, event_date, event_type, count)
       VALUES (?, CURDATE(), ?, 1)
       ON DUPLICATE KEY UPDATE count = count + 1`,
      [businessId, dailyType],
    );

    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

async function getBusinessAnalytics(businessId) {
  const [aggRows] = await pool.query(
    'SELECT * FROM business_analytics WHERE business_id = ? LIMIT 1',
    [businessId],
  );

  const agg = aggRows[0] || {
    profile_clicks: 0,
    website_clicks: 0,
    call_clicks: 0,
    favorite_count: 0,
  };

  const [dailyRows] = await pool.query(
    `SELECT event_date, SUM(count) AS total
     FROM business_analytics_daily
     WHERE business_id = ? AND event_type = 'profile_view'
       AND event_date >= DATE_SUB(CURDATE(), INTERVAL 6 DAY)
     GROUP BY event_date
     ORDER BY event_date ASC`,
    [businessId],
  );

  // Fill in the full 7-day range even for days with zero activity, so the
  // mobile app's bar chart always renders exactly 7 bars.
  const last7Days = [];
  const dailyMap = new Map(dailyRows.map((r) => [r.event_date, Number(r.total)]));
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    last7Days.push(dailyMap.get(key) || 0);
  }

  return {
    businessId,
    profileClicks: agg.profile_clicks,
    websiteClicks: agg.website_clicks,
    callClicks: agg.call_clicks,
    favoriteCount: agg.favorite_count,
    last7DaysProfileClicks: last7Days,
  };
}

/**
 * Called from the favorites toggle endpoint (or directly if you add one) to
 * keep the aggregate favorite_count in sync. Mobile app currently manages
 * favorites entirely client-side (Hive), so this is here for when/if you
 * add server-side favorites for the website/admin portal to share state.
 */
async function adjustFavoriteCount(businessId, delta) {
  await pool.query(
    `INSERT INTO business_analytics (business_id, favorite_count)
     VALUES (?, GREATEST(?, 0))
     ON DUPLICATE KEY UPDATE favorite_count = GREATEST(favorite_count + ?, 0)`,
    [businessId, delta, delta],
  );
}

module.exports = { recordEvent, getBusinessAnalytics, adjustFavoriteCount };
