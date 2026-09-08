-- Migration: allow 'apple' as a users.auth_provider value
--
-- Only needed if your database already exists from before this change —
-- a fresh install via `npm run db:migrate` already has this, and
-- `npm run db:migrate` on an existing database also applies this
-- automatically (see migrate.js's ENUM_VALUES_TO_ENSURE). This file is
-- here only for running it directly, same as migrate-social-login.sql.
--
-- Run with: mysql -u <user> -p <database> < src/db/migrate-apple-login.sql

ALTER TABLE users MODIFY COLUMN auth_provider ENUM('password', 'google', 'facebook', 'apple') NOT NULL DEFAULT 'password';
