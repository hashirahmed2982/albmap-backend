const { pool } = require('../config/db');

/**
 * Deletes refresh tokens that are no longer useful to keep around:
 * expired more than 7 days ago, or revoked more than 7 days ago. The
 * 7-day grace period (rather than deleting the instant they expire/get
 * revoked) leaves a short window for security auditing ("was this token
 * used after it should have been revoked?") without letting the table
 * grow forever — every login writes a new row here, and until this
 * existed, nothing ever removed old ones.
 *
 * Two ways to run this:
 *   1. As a real cron job (recommended for production):
 *        node src/db/cleanup-tokens.js
 *      scheduled via your OS's cron, a hosting platform's scheduled job
 *      feature, or a process manager — once a day is plenty.
 *   2. Automatically every 24h while the server process is running (see
 *      the setInterval call in server.js) — convenient for simple/single-
 *      instance deployments, but won't run if the server's been down for
 *      a while, and running the same query from every instance if you
 *      ever scale to multiple server processes is wasteful (harmless,
 *      just redundant). Prefer option 1 for a real production deployment.
 */
async function cleanupExpiredTokens() {
  const [result] = await pool.query(
    `DELETE FROM refresh_tokens
     WHERE (expires_at < DATE_SUB(NOW(), INTERVAL 7 DAY))
        OR (revoked_at IS NOT NULL AND revoked_at < DATE_SUB(NOW(), INTERVAL 7 DAY))`,
  );
  return result.affectedRows;
}

if (require.main === module) {
  cleanupExpiredTokens()
    .then((count) => {
      console.log(`✅ Cleaned up ${count} expired/revoked refresh tokens`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('❌ Token cleanup failed:', err);
      process.exit(1);
    });
}

module.exports = { cleanupExpiredTokens };
