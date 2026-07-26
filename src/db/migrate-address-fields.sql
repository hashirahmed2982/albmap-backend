-- Migration: structured address fields + WhatsApp number
--
-- Only needed if your database already exists from before this change —
-- a fresh install via `npm run db:migrate` (which runs schema.sql) already
-- has the new column layout and does NOT need this file.
--
-- Run with: mysql -u <user> -p <database> < src/db/migrate-address-fields.sql
--
-- This preserves existing data: whatever was in the old single `address`
-- column is copied into the new `street_address` column so nothing is
-- silently lost, though `city` and `postal_code` can't be inferred from a
-- free-text address string, so they're backfilled with a placeholder that
-- makes it obvious they need a real value — existing businesses will need
-- an owner/admin edit to fill in real city/postal code data after this runs.

SET FOREIGN_KEY_CHECKS = 0;

ALTER TABLE businesses ADD COLUMN street_address VARCHAR(255) NULL AFTER category;
ALTER TABLE businesses ADD COLUMN city VARCHAR(100) NULL AFTER street_address;
ALTER TABLE businesses ADD COLUMN postal_code VARCHAR(20) NULL AFTER city;
ALTER TABLE businesses ADD COLUMN country VARCHAR(100) NOT NULL DEFAULT 'Albania' AFTER postal_code;
ALTER TABLE businesses ADD COLUMN whatsapp_number VARCHAR(30) NULL AFTER phone;

-- Best-effort data preservation: old free-text address becomes the new
-- street_address. city/postal_code get an obvious placeholder rather than
-- an empty string, so they're easy to find and fix via Edit Business.
UPDATE businesses SET street_address = address WHERE street_address IS NULL;
UPDATE businesses SET city = 'Unknown' WHERE city IS NULL;
UPDATE businesses SET postal_code = '0000' WHERE postal_code IS NULL;

ALTER TABLE businesses MODIFY street_address VARCHAR(255) NOT NULL;
ALTER TABLE businesses MODIFY city VARCHAR(100) NOT NULL;
ALTER TABLE businesses MODIFY postal_code VARCHAR(20) NOT NULL;

ALTER TABLE businesses DROP COLUMN address;

SET FOREIGN_KEY_CHECKS = 1;

-- After running this, find and fix the placeholder rows with:
--   SELECT id, name, street_address, city, postal_code FROM businesses
--   WHERE city = 'Unknown' OR postal_code = '0000';
