-- Migration: multi-language site content (About Us, Privacy Policy,
-- Terms & Conditions)
--
-- Before this, each of these three site_content rows stored ONE
-- language's copy as a flat object (e.g. about_us = { tagline, ... }).
-- Going forward, an admin must fill in English, German, and Albanian
-- versions together — content.service.js now rejects a save that's
-- missing any of the three (see LOCALIZED_KEYS/SUPPORTED_LOCALES there)
-- — and each row's `data` is nested per locale instead:
--   about_us = { en: { tagline, ... }, de: { tagline, ... }, sq: { tagline, ... } }
-- `social_links` is unchanged — a Facebook/Instagram/etc. URL isn't
-- language-dependent, so it stays a flat object.
--
-- This wraps any already-existing flat-shaped row into the new
-- 3-locale shape, duplicating the existing (English) copy into the
-- de/sq slots as a starting point so nothing goes blank on the
-- website/app the moment this ships — an admin still needs to go into
-- the Content page afterward and replace the German/Albanian text
-- with real translations (the seed script's German/Albanian defaults
-- are placeholders too, not professionally translated copy — see
-- seed.js).
--
-- Safe to re-run: only touches a row that doesn't already have an
-- `en` key, so a row already migrated (or already edited by an admin
-- under the new shape) is left alone.
--
-- Run with: mysql -u <user> -p <database> < src/db/migrate-content-i18n.sql

UPDATE site_content
SET data = JSON_OBJECT('en', data, 'de', data, 'sq', data)
WHERE `key` IN ('about_us', 'privacy_policy', 'terms_conditions')
  AND JSON_EXTRACT(data, '$.en') IS NULL;
