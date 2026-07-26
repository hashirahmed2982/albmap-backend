const app = require('./app');
const env = require('./config/env');
const { testConnection } = require('./config/db');
const { cleanupExpiredTokens } = require('./db/cleanup-tokens');

const TOKEN_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function start() {
  try {
    await testConnection();
  } catch (err) {
    console.error('❌ Could not connect to MySQL. Check your .env DB_* settings.');
    console.error(err.message);
    process.exit(1);
  }

  app.listen(env.port, () => {
    console.log(`🚀 AlbMap API listening on http://localhost:${env.port}`);
    console.log(`   Environment: ${env.nodeEnv}`);
    console.log(`   Mobile app baseUrl should point to: http://localhost:${env.port}/v1`);
  });

  // Convenience for simple/single-instance deployments — see
  // db/cleanup-tokens.js's doc comment for why a real cron job is
  // preferable for production. This just means expired refresh tokens
  // don't accumulate forever as long as the process stays running.
  setInterval(() => {
    cleanupExpiredTokens()
      .then((count) => {
        if (count > 0) console.log(`🧹 Cleaned up ${count} expired refresh tokens`);
      })
      .catch((err) => console.error('Token cleanup failed:', err.message));
  }, TOKEN_CLEANUP_INTERVAL_MS);
}

start();
