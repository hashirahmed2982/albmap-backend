-- Migration: per-user notification delete
--
-- Only needed if your database already exists from before this change —
-- a fresh install via `npm run db:migrate` already creates this table and
-- does NOT need this file.
--
-- Run with: mysql -u <user> -p <database> < src/db/migrate-notification-deletes.sql
--
-- Adds a way for a user to remove a notification from their own feed
-- without touching the underlying row (which is shared — a broadcast is
-- the exact same row for every recipient, so a hard DELETE would remove
-- it from everyone's feed at once). Mirrors notification_reads exactly,
-- just for "hidden" instead of "read".

SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS notification_deletes (
  id              VARCHAR(36) NOT NULL PRIMARY KEY,
  notification_id VARCHAR(36) NOT NULL,
  user_id         VARCHAR(36) NOT NULL,
  deleted_at      DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_delete_per_user_notification (notification_id, user_id),
  INDEX idx_deletes_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
