-- Fix legacy absolute image URLs
--
-- Converts any existing logo_url / image_url / profile_image_url that was
-- stored as a full absolute URL (e.g. "https://abc123.ngrok-free.app/uploads/xxx.png")
-- into a relative path ("/uploads/xxx.png") — matching what the backend
-- returns for all uploads going forward (see business.controller.js,
-- event.routes.js, user.routes.js). Safe to run more than once: it only
-- touches rows that still start with "http", so already-relative rows
-- (including ones this script already fixed) are left untouched.
--
-- Run with: mysql -u <user> -p <database> < src/db/fix-legacy-media-urls.sql

-- ---------------------------------------------------------------------
-- STEP 1 — preview what will change before touching anything. Run this
-- block alone first (comment out STEP 2 below, or just copy/paste STEP 1
-- into a client) and eyeball the results.
-- ---------------------------------------------------------------------
SELECT id, name, logo_url,
       SUBSTRING(logo_url, LOCATE('/uploads/', logo_url)) AS would_become
FROM businesses
WHERE logo_url LIKE 'http%' AND LOCATE('/uploads/', logo_url) > 0;

SELECT id, name, image_url,
       SUBSTRING(image_url, LOCATE('/uploads/', image_url)) AS would_become
FROM events
WHERE image_url LIKE 'http%' AND LOCATE('/uploads/', image_url) > 0;

SELECT id, email, profile_image_url,
       SUBSTRING(profile_image_url, LOCATE('/uploads/', profile_image_url)) AS would_become
FROM users
WHERE profile_image_url LIKE 'http%' AND LOCATE('/uploads/', profile_image_url) > 0;

-- ---------------------------------------------------------------------
-- STEP 2 — the actual fix. Only touches rows where the value starts
-- with "http" AND contains "/uploads/" somewhere in it (guards against
-- an unexpected/malformed value being mangled instead of just left
-- alone — anything that doesn't match this exact shape is skipped, not
-- corrupted).
-- ---------------------------------------------------------------------
START TRANSACTION;

UPDATE businesses
SET logo_url = SUBSTRING(logo_url, LOCATE('/uploads/', logo_url))
WHERE logo_url LIKE 'http%' AND LOCATE('/uploads/', logo_url) > 0;

UPDATE events
SET image_url = SUBSTRING(image_url, LOCATE('/uploads/', image_url))
WHERE image_url LIKE 'http%' AND LOCATE('/uploads/', image_url) > 0;

UPDATE users
SET profile_image_url = SUBSTRING(profile_image_url, LOCATE('/uploads/', profile_image_url))
WHERE profile_image_url LIKE 'http%' AND LOCATE('/uploads/', profile_image_url) > 0;

-- Review the row counts MySQL reports for each UPDATE above. If they
-- look right, commit:
COMMIT;
-- If anything looks wrong instead, run ROLLBACK; here instead of COMMIT;
-- and nothing above will have taken effect.

-- ---------------------------------------------------------------------
-- STEP 3 — confirm nothing starting with "http" is left in any of the
-- three columns (should return zero rows across all three queries).
-- ---------------------------------------------------------------------
SELECT COUNT(*) AS remaining_absolute_business_logos FROM businesses WHERE logo_url LIKE 'http%';
SELECT COUNT(*) AS remaining_absolute_event_images FROM events WHERE image_url LIKE 'http%';
SELECT COUNT(*) AS remaining_absolute_avatars FROM users WHERE profile_image_url LIKE 'http%';
