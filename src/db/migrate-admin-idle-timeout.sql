-- Migration: admin portal 15-minute hard idle timeout
--
-- Only needed if your database already exists from before this change —
-- a fresh install via `npm run db:migrate` already creates this column and
-- does NOT need this file.
--
-- Run with: mysql -u <user> -p <database> < src/db/migrate-admin-idle-timeout.sql
--
-- last_active_at is updated on every authenticated request from an admin
-- (middleware/auth.js's requireAuth) and checked in auth.service.js's
-- refresh() — if more than 15 minutes have passed since an admin's last
-- request, the refresh token is revoked and they're forced to log back
-- in, even if they never touched the "log out" button and even if the
-- browser was closed the whole time. Business/mobile/website users are
-- untouched by this column — it's only ever read/written for role='admin'.

SET FOREIGN_KEY_CHECKS = 0;

ALTER TABLE users ADD COLUMN last_active_at DATETIME NULL AFTER fcm_token;

SET FOREIGN_KEY_CHECKS = 1;
