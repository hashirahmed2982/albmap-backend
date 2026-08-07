-- Migration: admin-editable site content (About Us, social links, Privacy
-- Policy, Terms & Conditions)
--
-- Only needed if your database already exists from before this change —
-- a fresh install via `npm run db:migrate` already creates this table and
-- does NOT need this file.
--
-- Run with: mysql -u <user> -p <database> < src/db/migrate-site-content.sql
--
-- After this, run `npm run db:seed` (safe to re-run — it uses INSERT
-- IGNORE, so it only fills in rows that don't exist yet and never
-- overwrites content an admin has already edited) to populate the four
-- rows with the same copy that was previously hardcoded, so nothing goes
-- blank on either client until an admin actually changes something.

SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS site_content (
  `key`       VARCHAR(40)  NOT NULL PRIMARY KEY,
  data        JSON         NOT NULL,
  updated_by  VARCHAR(36)  NULL,
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
