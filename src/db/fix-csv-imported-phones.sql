-- Fix phone numbers and WhatsApp on existing CSV-imported businesses
--
-- Repairs two issues in businesses imported via the admin CSV importer
-- before business-import.service.js's normalizePhone() and
-- whatsapp_number fix existed:
--   1. A phone number Excel silently stripped the leading "+" from (see
--      normalizePhone()'s comment for why this happens) — repaired with
--      the exact same "purely digits, 8-15 of them" heuristic the import
--      code now applies going forward, so this script and the code stay
--      in agreement about what counts as a recoverable case.
--   2. whatsapp_number left NULL because the importer never set it —
--      backfilled to match phone, same as every newly-imported business
--      now gets automatically.
--
-- Scoped to ONLY businesses that actually came through the CSV importer
-- (identified via their business_status_history row's exact reason
-- text, 'Imported from CSV (auto-approved)' — see importRow()) —
-- businesses submitted normally by an owner are never touched, since a
-- bare local-format phone number there is far more likely to be exactly
-- what the owner meant to enter, not a stripped "+".
--
-- Run with: mysql -u <user> -p <database> < src/db/fix-csv-imported-phones.sql

-- ---------------------------------------------------------------------
-- STEP 1 — preview what will change before touching anything.
-- ---------------------------------------------------------------------
SELECT b.id, b.name, b.phone AS current_phone, CONCAT('+', b.phone) AS would_become_phone,
       b.whatsapp_number AS current_whatsapp
FROM businesses b
JOIN business_status_history h ON h.business_id = b.id AND h.reason = 'Imported from CSV (auto-approved)'
WHERE b.phone REGEXP '^[0-9]{8,15}$';

SELECT b.id, b.name, b.phone, b.whatsapp_number AS current_whatsapp
FROM businesses b
JOIN business_status_history h ON h.business_id = b.id AND h.reason = 'Imported from CSV (auto-approved)'
WHERE b.whatsapp_number IS NULL AND b.phone IS NOT NULL;

-- ---------------------------------------------------------------------
-- STEP 2 — the actual fix.
-- ---------------------------------------------------------------------
START TRANSACTION;

-- Re-add the stripped "+" — only touches phone values that are purely
-- 8-15 digits (same guard as normalizePhone()), so an already-correct
-- "+355..." value or a short/local number is never touched.
UPDATE businesses b
JOIN business_status_history h ON h.business_id = b.id AND h.reason = 'Imported from CSV (auto-approved)'
SET b.phone = CONCAT('+', b.phone)
WHERE b.phone REGEXP '^[0-9]{8,15}$';

-- Backfill whatsapp_number to match phone wherever it was left NULL —
-- uses the (now possibly just-fixed) phone value, so both fixes compose
-- correctly in one pass regardless of statement order within this
-- transaction.
UPDATE businesses b
JOIN business_status_history h ON h.business_id = b.id AND h.reason = 'Imported from CSV (auto-approved)'
SET b.whatsapp_number = b.phone
WHERE b.whatsapp_number IS NULL AND b.phone IS NOT NULL;

-- Review the row counts MySQL reports for each UPDATE above. If they
-- look right, commit:
COMMIT;
-- If anything looks wrong instead, run ROLLBACK; here instead of COMMIT;
-- and nothing above will have taken effect.

-- ---------------------------------------------------------------------
-- STEP 3 — confirm no CSV-imported business still has a bare-digit
-- phone number or a NULL whatsapp_number (should return zero rows).
-- ---------------------------------------------------------------------
SELECT COUNT(*) AS remaining_stripped_plus
FROM businesses b
JOIN business_status_history h ON h.business_id = b.id AND h.reason = 'Imported from CSV (auto-approved)'
WHERE b.phone REGEXP '^[0-9]{8,15}$';

SELECT COUNT(*) AS remaining_null_whatsapp
FROM businesses b
JOIN business_status_history h ON h.business_id = b.id AND h.reason = 'Imported from CSV (auto-approved)'
WHERE b.whatsapp_number IS NULL AND b.phone IS NOT NULL;
