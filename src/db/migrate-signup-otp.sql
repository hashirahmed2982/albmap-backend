-- Migration: OTP email verification before signup completes
--
-- Only needed if your database already exists from before this change —
-- a fresh install via `npm run db:migrate` already creates this table and
-- does NOT need this file.
--
-- Run with: mysql -u <user> -p <database> < src/db/migrate-signup-otp.sql

SET FOREIGN_KEY_CHECKS = 0;

CREATE TABLE IF NOT EXISTS signup_otps (
  id            VARCHAR(36)  NOT NULL PRIMARY KEY,
  email         VARCHAR(255) NOT NULL,
  otp_hash      VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  name          VARCHAR(150) NOT NULL,
  attempts      INT          NOT NULL DEFAULT 0,
  expires_at    DATETIME     NOT NULL,
  created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_signup_otps_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET FOREIGN_KEY_CHECKS = 1;
