const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const env = require('../config/env');

/**
 * Columns added to an already-existing table after its CREATE TABLE
 * statement in schema.sql was first written. `CREATE TABLE IF NOT EXISTS`
 * is a no-op on a database that already has the table, so editing that
 * CREATE TABLE's column list alone never applies to an already-deployed
 * database — every such column needs an entry here too, applied via
 * ensureColumn() below.
 *
 * This used to be a block of `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
 * statements at the bottom of schema.sql, but that syntax requires MySQL
 * 8.0.29+ and hard-failed the entire migration (ER_PARSE_ERROR) on older
 * MySQL/MariaDB servers — since schema.sql runs as one multi-statement
 * query, a single unsupported statement took the whole file down with it.
 * Checking information_schema.COLUMNS in JS and issuing a plain `ALTER
 * TABLE ... ADD COLUMN ...` (no IF NOT EXISTS) works on every
 * MySQL/MariaDB version.
 */
const COLUMNS_TO_ENSURE = [
  {
    table: 'users',
    column: 'account_status',
    ddl: "ALTER TABLE users ADD COLUMN account_status ENUM('active', 'invited') NOT NULL DEFAULT 'active'",
  },
  {
    table: 'businesses',
    column: 'website',
    ddl: 'ALTER TABLE businesses ADD COLUMN website VARCHAR(500) NULL',
  },
];

async function ensureColumn(connection, database, { table, column, ddl }) {
  const [rows] = await connection.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [database, table, column],
  );
  if (rows.length > 0) return;
  console.log(`Adding missing column ${table}.${column}...`);
  await connection.query(ddl);
}

/**
 * Runs schema.sql as a single multi-statement script, then applies any
 * columns added to an existing table since its CREATE TABLE was written
 * (see COLUMNS_TO_ENSURE above). This is intentionally simple (no
 * migration-versioning framework) since the schema is still actively
 * evolving — reach for a real migration tool (Knex, Prisma Migrate,
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

    console.log('Checking for columns missing from existing tables...');
    for (const entry of COLUMNS_TO_ENSURE) {
      await ensureColumn(connection, env.db.database, entry);
    }

    console.log('✅ Migration complete');
  } finally {
    await connection.end();
  }
}

migrate().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exit(1);
});
