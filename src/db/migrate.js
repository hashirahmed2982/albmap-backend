const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../config/env');

/**
 * Runs schema.sql as a single multi-statement script. This is intentionally
 * simple (no migration-versioning framework) since the schema is still
 * actively evolving — reach for a real migration tool (Knex, Prisma Migrate,
 * db-migrate) once the schema stabilizes and you need incremental,
 * reversible changes instead of "re-apply the whole file."
 */
async function migrate() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');

  const connection = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    multipleStatements: true,
  });

  try {
    console.log('Running schema.sql...');
    await connection.query(schemaSql);
    console.log('✅ Migration complete');
  } finally {
    await connection.end();
  }
}

migrate().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
