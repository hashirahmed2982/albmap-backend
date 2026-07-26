const mysql = require('mysql2/promise');
const env = require('./env');

/**
 * A single shared connection pool for the whole app. Every module imports
 * this rather than creating its own connection — connection pooling is
 * what makes concurrent requests not fall over under load.
 */
const pool = mysql.createPool({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database: env.db.database,
  connectionLimit: env.db.connectionLimit,
  waitForConnections: true,
  queueLimit: 0,
  dateStrings: true,
});

async function testConnection() {
  const connection = await pool.getConnection();
  try {
    await connection.ping();
    console.log('✅ MySQL connection established');
  } finally {
    connection.release();
  }
}

module.exports = { pool, testConnection };
