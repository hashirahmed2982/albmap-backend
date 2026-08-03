-- Migration: social login provider ID tracking
--
-- Only needed if your database already exists from before this change —
-- a fresh install via `npm run db:migrate` already has this column.
--
-- Run with: mysql -u <user> -p <database> < src/db/migrate-social-login.sql

ALTER TABLE users ADD COLUMN provider_user_id VARCHAR(255) NULL AFTER auth_provider;
ALTER TABLE users ADD INDEX idx_users_provider (auth_provider, provider_user_id);