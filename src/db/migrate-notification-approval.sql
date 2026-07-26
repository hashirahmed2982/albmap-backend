-- Migration: notification approval workflow
--
-- Only needed if your database already exists from before this change —
-- a fresh install via `npm run db:migrate` already has the new column
-- layout and does NOT need this file.
--
-- Run with: mysql -u <user> -p <database> < src/db/migrate-notification-approval.sql
--
-- Any notifications already in your table (from the old immediate-
-- delivery behavior) are marked 'approved' so they don't retroactively
-- disappear from anyone's feed — this migration only changes behavior
-- for NEW broadcasts going forward.
-- Existing business_approved/business_rejected rows are backfilled with
-- the relevant business's owner as target_user_id — without this, they'd
-- default to NULL ("visible to everyone") and leak a personal notice to
-- every user instead of just the business owner it was actually meant for.

SET FOREIGN_KEY_CHECKS = 0;

ALTER TABLE notifications ADD COLUMN status ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'approved' AFTER sent_by;
ALTER TABLE notifications ADD COLUMN target_user_id VARCHAR(36) NULL AFTER sent_by;
ALTER TABLE notifications ADD CONSTRAINT fk_notifications_target_user FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD INDEX idx_notifications_target_user (target_user_id);
ALTER TABLE notifications ADD COLUMN rejection_reason VARCHAR(500) NULL AFTER status;
ALTER TABLE notifications ADD COLUMN reviewed_by VARCHAR(36) NULL AFTER rejection_reason;
ALTER TABLE notifications ADD COLUMN reviewed_at DATETIME NULL AFTER reviewed_by;
ALTER TABLE notifications ADD CONSTRAINT fk_notifications_reviewed_by FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE notifications ADD INDEX idx_notifications_status (status);

-- New default for the column going forward is 'pending' (business-owner
-- broadcasts now require approval) — but existing rows just got
-- backfilled as 'approved' above, so this only affects rows inserted
-- from now on.
ALTER TABLE notifications ALTER COLUMN status SET DEFAULT 'pending';

-- Backfill: existing personal notices get their owning business's owner
-- as target_user_id, so they stay private to that one user after this
-- migration instead of defaulting to NULL ("visible to everyone").
UPDATE notifications n
JOIN businesses b ON b.id = n.business_id
SET n.target_user_id = b.owner_id
WHERE n.type IN ('business_approved', 'business_rejected') AND n.target_user_id IS NULL;

CREATE TABLE IF NOT EXISTS notification_reads (
  id              VARCHAR(36) NOT NULL PRIMARY KEY,
  notification_id VARCHAR(36) NOT NULL,
  user_id         VARCHAR(36) NOT NULL,
  read_at         DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_read_per_user_notification (notification_id, user_id),
  INDEX idx_reads_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
