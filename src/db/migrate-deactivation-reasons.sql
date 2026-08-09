-- Migration: mandatory reasons for business rejection/deactivation and
-- user account bans, visible to the affected owner/user
--
-- Only needed if your database already exists from before this change —
-- a fresh install via `npm run db:migrate` already creates these columns
-- and does NOT need this file.
--
-- Run with: mysql -u <user> -p <database> < src/db/migrate-deactivation-reasons.sql

SET FOREIGN_KEY_CHECKS = 0;

ALTER TABLE businesses ADD COLUMN deactivation_reason VARCHAR(500) NULL AFTER is_active;
ALTER TABLE users ADD COLUMN deactivation_reason VARCHAR(500) NULL AFTER is_active;

SET FOREIGN_KEY_CHECKS = 1;
