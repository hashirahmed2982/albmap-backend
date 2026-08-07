-- AlbMap MySQL schema
-- Run via: npm run db:migrate  (or pipe this file into mysql directly)
-- Charset/collation chosen for full emoji + multi-language (Albanian/Italian/English) support.

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- users — business users and guests are NOT stored here as rows; "guest" is
-- a client-side-only concept (see mobile app's continueAsGuest()). Only
-- registered accounts (business users) and admins live in the database.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            VARCHAR(36)   NOT NULL PRIMARY KEY,
  email         VARCHAR(255)  NOT NULL UNIQUE,
  password_hash VARCHAR(255)  NULL,          -- NULL for social-login-only accounts
  name          VARCHAR(150)  NOT NULL,
  phone         VARCHAR(30)   NULL,
  profile_image_url VARCHAR(500) NULL,
  role          ENUM('business', 'admin') NOT NULL DEFAULT 'business',
  auth_provider ENUM('password', 'google', 'facebook') NOT NULL DEFAULT 'password',
  -- The provider's own stable unique ID (Google's `sub` claim, Facebook's
  -- `id` field) — NOT the same as our own `id` above. Used to find the
  -- same account again on a repeat social login without relying on email
  -- matching alone, since email addresses can be unverified or (rarely)
  -- reused across different provider accounts.
  provider_user_id VARCHAR(255) NULL,
  is_email_verified TINYINT(1) NOT NULL DEFAULT 0,
  is_active     TINYINT(1) NOT NULL DEFAULT 1,
  fcm_token     VARCHAR(255)  NULL,           -- current device's push token, latest wins
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_users_role (role),
  INDEX idx_users_provider (auth_provider, provider_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- password_reset_tokens — short-lived tokens for the forgot-password flow.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          VARCHAR(36)  NOT NULL PRIMARY KEY,
  user_id     VARCHAR(36)  NOT NULL,
  token_hash  VARCHAR(255) NOT NULL,
  expires_at  DATETIME     NOT NULL,
  used_at     DATETIME     NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_reset_tokens_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- refresh_tokens — one row per issued refresh token, so tokens can be
-- revoked individually (logout, password change) instead of trusting a
-- stateless JWT forever until expiry.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          VARCHAR(36)  NOT NULL PRIMARY KEY,
  user_id     VARCHAR(36)  NOT NULL,
  token_hash  VARCHAR(255) NOT NULL,
  expires_at  DATETIME     NOT NULL,
  revoked_at  DATETIME     NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_refresh_tokens_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- categories — business categories, seeded via seed.sql. Kept as a table
-- (not a hardcoded enum) so an admin can add new ones without a migration.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id          INT          NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(100) NOT NULL UNIQUE,
  icon_name   VARCHAR(100) NULL,   -- maps to a Flutter IconData name client-side
  sort_order  INT          NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- businesses — the approval workflow lives entirely in `status`.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS businesses (
  id            VARCHAR(36)   NOT NULL PRIMARY KEY,
  owner_id      VARCHAR(36)   NOT NULL,
  name          VARCHAR(200)  NOT NULL,
  description   TEXT          NULL,
  category      VARCHAR(100)  NOT NULL,
  street_address VARCHAR(255) NOT NULL,
  city          VARCHAR(100)  NOT NULL,
  postal_code   VARCHAR(20)   NOT NULL,
  country       VARCHAR(100)  NOT NULL DEFAULT 'Albania',
  latitude      DECIMAL(10, 7) NOT NULL,
  longitude     DECIMAL(10, 7) NOT NULL,
  phone         VARCHAR(30)   NULL,
  whatsapp_number VARCHAR(30) NULL,   -- distinct from `phone` — a business may take calls on one line and WhatsApp on another
  logo_url      VARCHAR(500)  NULL,
  opening_hours JSON          NULL,   -- {"Mon-Fri": "09:00-18:00", ...}
  tags          JSON          NULL,   -- ["coffee", "wifi"]
  status        ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  rejection_reason VARCHAR(500) NULL,
  rating_avg    DECIMAL(2, 1) NOT NULL DEFAULT 0.0,
  rating_count  INT           NOT NULL DEFAULT 0,
  is_active     TINYINT(1)    NOT NULL DEFAULT 1,   -- admin can deactivate without deleting
  reviewed_by   VARCHAR(36)   NULL,
  reviewed_at   DATETIME      NULL,
  created_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_businesses_owner (owner_id),
  INDEX idx_businesses_status (status),
  INDEX idx_businesses_category (category),
  INDEX idx_businesses_location (latitude, longitude)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- business_status_history — audit trail of every approval/rejection, so an
-- admin (or the business owner) can see the full history, not just the
-- current status. Populated automatically by the admin approve/reject
-- endpoints (see modules/admin).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_status_history (
  id            VARCHAR(36)  NOT NULL PRIMARY KEY,
  business_id   VARCHAR(36)  NOT NULL,
  old_status    VARCHAR(20)  NULL,
  new_status    VARCHAR(20)  NOT NULL,
  reason        VARCHAR(500) NULL,
  changed_by    VARCHAR(36)  NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (changed_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_status_history_business (business_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- business_analytics — one row per business, aggregate counters. Fast to
-- read for the Dashboard; incremented on every recorded event.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_analytics (
  business_id     VARCHAR(36) NOT NULL PRIMARY KEY,
  profile_clicks  INT NOT NULL DEFAULT 0,
  website_clicks  INT NOT NULL DEFAULT 0,
  call_clicks     INT NOT NULL DEFAULT 0,
  favorite_count  INT NOT NULL DEFAULT 0,

  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- business_analytics_daily — per-day breakdown, feeds the Dashboard's
-- "last 7 days" chart. One row per business per day per event type.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_analytics_daily (
  id            BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
  business_id   VARCHAR(36)  NOT NULL,
  event_date    DATE         NOT NULL,
  event_type    ENUM('profile_view', 'website_click', 'call_click') NOT NULL,
  count         INT          NOT NULL DEFAULT 0,

  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  UNIQUE KEY uq_business_day_type (business_id, event_date, event_type),
  INDEX idx_analytics_daily_business_date (business_id, event_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- events
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id            VARCHAR(36)  NOT NULL PRIMARY KEY,
  business_id   VARCHAR(36)  NOT NULL,
  name          VARCHAR(200) NOT NULL,
  description   TEXT         NULL,
  category      VARCHAR(100) NOT NULL DEFAULT 'General',
  start_time    DATETIME     NOT NULL,
  end_time      DATETIME     NOT NULL,
  image_url     VARCHAR(500) NULL,
  is_active     TINYINT(1)   NOT NULL DEFAULT 1,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  INDEX idx_events_business (business_id),
  INDEX idx_events_start_time (start_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- notifications — broadcast messages from a business owner (or the system,
-- e.g. approval/rejection notices) to end users. Real fan-out to individual
-- devices happens via FCM (see modules/notifications/fcm.js); this table is
-- the durable record + backs the mobile app's Alerts tab if you later add a
-- GET /notifications endpoint for cross-device sync (currently the mobile
-- app stores received notifications locally only).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id            VARCHAR(36)  NOT NULL PRIMARY KEY,
  business_id   VARCHAR(36)  NULL,     -- NULL for system-wide/admin notices
  type          ENUM('business_offer', 'business_approved', 'business_rejected', 'event_reminder', 'general')
                NOT NULL DEFAULT 'general',
  title         VARCHAR(150) NOT NULL,
  body          VARCHAR(500) NOT NULL,
  related_id    VARCHAR(36)  NULL,     -- business or event id, for deep-linking
  sent_by       VARCHAR(36)  NULL,
  -- NULL = broadcast to every user (a business_offer once approved).
  -- Non-NULL = visible ONLY to this one user (e.g. "your business was
  -- approved" — a personal notice, not something every other user should
  -- ever see). Without this column, every approved notification of any
  -- kind was visible to every user regardless of who it was actually
  -- meant for — a real privacy bug caught by testing this exact flow
  -- end-to-end rather than just reading the code.
  target_user_id VARCHAR(36) NULL,
  -- Approval workflow, mirroring how business submissions work: a business
  -- owner's broadcast starts pending and isn't delivered to anyone until
  -- an admin approves it. System-generated notices (business_approved/
  -- business_rejected, sent automatically by the admin review flow, not
  -- by a business owner) skip this — they're inserted as already-approved
  -- since there's no user-submitted content to moderate.
  status        ENUM('pending', 'approved', 'rejected') NOT NULL DEFAULT 'pending',
  rejection_reason VARCHAR(500) NULL,
  reviewed_by   VARCHAR(36)  NULL,
  reviewed_at   DATETIME     NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (sent_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_notifications_business (business_id),
  INDEX idx_notifications_status (status),
  INDEX idx_notifications_target_user (target_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- notification_reads — per-user read tracking for the shared, approved
-- notification feed. A row's existence means that user has read that
-- notification; absence means unread. This is what backs the in-app
-- Notifications screen's unread badge and "mark all read" action, synced
-- from the server now instead of being purely on-device.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- notification_deletes — per-user "hide from my feed" tracking, mirroring
-- notification_reads. Notifications are shared rows (a broadcast is the
-- same row for every recipient), so a user "deleting" one can never mean
-- removing the row itself — that would delete it out from under every
-- other recipient too. A row's existence here means that one user no
-- longer sees that notification in GET /notifications; the underlying
-- notification (and everyone else's copy of it) is untouched.
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- reviews — one review per user per business (enforced by unique key).
-- business.rating_avg/rating_count are recalculated from this table
-- whenever a review is added/updated/deleted (see review.service.js) —
-- this table is the source of truth, those columns are a denormalized
-- cache for fast reads on the business list/details endpoints.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reviews (
  id            VARCHAR(36)  NOT NULL PRIMARY KEY,
  business_id   VARCHAR(36)  NOT NULL,
  user_id       VARCHAR(36)  NOT NULL,
  rating        TINYINT      NOT NULL,  -- 1-5, enforced by CHECK below
  comment       VARCHAR(1000) NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_review_per_user_business (business_id, user_id),
  CONSTRAINT chk_rating_range CHECK (rating BETWEEN 1 AND 5),
  INDEX idx_reviews_business (business_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- favorites — server-side sync so a favorite survives reinstalls/device
-- switches and business_analytics.favorite_count reflects reality. The
-- mobile app's Hive cache remains for instant offline UI, but this table
-- is now the durable source of truth (see favorites.service.js).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS favorites (
  id            VARCHAR(36)  NOT NULL PRIMARY KEY,
  user_id       VARCHAR(36)  NOT NULL,
  business_id   VARCHAR(36)  NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (business_id) REFERENCES businesses(id) ON DELETE CASCADE,
  UNIQUE KEY uq_favorite_per_user_business (user_id, business_id),
  INDEX idx_favorites_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- event_favorites — same "survives reinstall/device switch" reasoning as
-- `favorites`, for events. Kept as its own table rather than adding a
-- nullable event_id column to `favorites`: that would make every row
-- ambiguous about whether it's a business or event favorite, and would
-- mean relaxing `favorites`' existing NOT NULL business_id / its FK and
-- unique-key shape, which nothing else needs touched for. Previously
-- event favorites only ever lived in the mobile app's local Hive cache —
-- gone on reinstall or a new device, unlike business favorites.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_favorites (
  id            VARCHAR(36)  NOT NULL PRIMARY KEY,
  user_id       VARCHAR(36)  NOT NULL,
  event_id      VARCHAR(36)  NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  UNIQUE KEY uq_event_favorite_per_user_event (user_id, event_id),
  INDEX idx_event_favorites_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------------
-- event_interests — the "I'm interested" / RSVP signal a user can toggle
-- on an event, shown as an interest count on the mobile app. Unlike
-- businesses.rating_avg/rating_count, the count is NOT denormalized onto
-- `events` here — event listings are paginated and never sorted/filtered
-- by interest count, so a per-request COUNT(*) join is simple and fast
-- enough without taking on reviews/favorites' recalculate-on-every-write
-- complexity for a number nothing queries by.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_interests (
  id            VARCHAR(36)  NOT NULL PRIMARY KEY,
  user_id       VARCHAR(36)  NOT NULL,
  event_id      VARCHAR(36)  NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE,
  UNIQUE KEY uq_event_interest_per_user_event (user_id, event_id),
  INDEX idx_event_interests_event (event_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
