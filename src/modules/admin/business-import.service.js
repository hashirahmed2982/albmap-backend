const { parse } = require('csv-parse/sync');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { pool } = require('../../config/db');
const ApiError = require('../../utils/ApiError');
const { hashToken } = require('../../utils/jwt');
const { geocodeAddress } = require('../../utils/geocode');
const emailService = require('../notifications/email');
const businessService = require('../businesses/business.service');

/**
 * Header aliases per target field, tried in priority order — the first
 * one actually present (and non-empty) in a given row wins. Exact and
 * case-sensitive on purpose — if yet another differently-shaped export
 * needs supporting later, add another alias here rather than trying to
 * fuzzy-match arbitrary headers, which would silently misfile a column
 * no one actually checked.
 *
 * Two shapes are supported:
 * - The German columns from the admin's past-platform export (checked
 *   first for `category`, see the comment on that in normalizeRow).
 * - This app's OWN "export businesses to CSV" output (see
 *   admin.service.js's exportBusinessesToCsv) — exporting, editing, and
 *   re-importing that file is a completely reasonable thing an admin
 *   would want to do, and previously failed on every single row since
 *   none of its English headers matched anything here.
 */
const FIELD_ALIASES = {
  name: ['Name'],
  category: ['Kategorie', 'Category'],
  streetAddress: ['Adresse', 'Street Address'],
  postalCode: ['PLZ', 'Postal Code'],
  city: ['Stadt', 'City'],
  country: ['Land', 'Country'],
  phone: ['Telefon', 'Phone'],
  email: ['E-Mail', 'Owner Email'],
  website: ['Website'],
};

/**
 * Loads every real category's English name plus its German/Albanian
 * translations from the categories table (categories are admin-managed/
 * free-form now, not a fixed hardcoded set — see db/seed.js's CATEGORIES
 * for just the originally-seeded ones), as a single lowercased lookup:
 * whichever language a CSV's category value happens to be written in,
 * it resolves back to the one canonical English name actually stored on
 * businesses.category. Loaded once per import run (not once per row)
 * and passed down as a plain Map, keeping the actual per-row resolution
 * synchronous and cheap.
 */
async function loadCategoryLookup() {
  const [rows] = await pool.query('SELECT name, name_de, name_sq FROM categories');
  const lookup = new Map();
  for (const row of rows) {
    for (const value of [row.name, row.name_de, row.name_sq]) {
      if (value) lookup.set(value.trim().toLowerCase(), row.name);
    }
  }
  return lookup;
}

/**
 * A category value is used as-is (case/whitespace aside) only if it
 * actually matches one of our own categories in English, German, or
 * Albanian — anything else (a category from a different platform's own
 * scheme, a typo, an empty cell) falls back to 'Other', the same safe
 * catch-all the rest of the app already uses for an unrecognized
 * category, rather than inventing a new category string that wouldn't
 * match anything in the categories table. An admin can always correct a
 * specific business's category afterward via the normal edit flow.
 */
function resolveCategory(raw, categoryLookup) {
  if (!raw) return 'Other';
  return categoryLookup.get(raw.trim().toLowerCase()) || 'Other';
}

/** Returns the first alias with a non-empty value in `rawRow` — tries
 * each in FIELD_ALIASES' priority order and returns the first hit. */
function firstNonEmpty(rawRow, aliases) {
  for (const header of aliases) {
    const value = (rawRow[header] || '').trim();
    if (value) return value;
  }
  return null;
}

function normalizeRow(rawRow, categoryLookup) {
  const normalized = {};
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    if (field === 'category') continue; // resolved separately below
    normalized[field] = firstNonEmpty(rawRow, aliases);
  }
  normalized.category = resolveCategory(firstNonEmpty(rawRow, FIELD_ALIASES.category), categoryLookup);
  return normalized;
}

/**
 * Finds the row's owner by email, or creates a brand-new invited account
 * for it. Never trusts the CSV to say whether the email is already
 * registered — always checks.
 *
 * A freshly-created account here has no usable password_hash (see
 * schema.sql's comment on users.account_status) and 'invited' status —
 * see auth.service.js's resetPassword() for how the invite link this
 * fires off actually activates it.
 *
 * The account's display name is seeded from the business name, not left
 * blank — there's no real person's name anywhere in this CSV, and the
 * business name is at least the one recognizable, contextual value on
 * hand. The invite email explains what's going on either way, and the
 * owner can change their name once they're in (Edit Profile already
 * supports that).
 */
async function resolveOwner(email, businessName) {
  const [existingRows] = await pool.query('SELECT id, name, email, account_status FROM users WHERE email = ?', [
    email,
  ]);
  if (existingRows.length > 0) {
    return { user: existingRows[0], wasCreated: false };
  }

  const userId = uuidv4();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, name, role, auth_provider, is_email_verified, account_status)
     VALUES (?, ?, NULL, ?, 'business', 'password', 0, 'invited')`,
    [userId, email, businessName],
  );
  return {
    user: { id: userId, name: businessName, email, account_status: 'invited' },
    wasCreated: true,
  };
}

/**
 * Issues the same kind of token forgotPassword() does, against the same
 * table — see auth.service.js's resetPassword() for the consuming side.
 * Kept here rather than calling into auth.service.js directly since this
 * needs sendBusinessOwnerInviteEmail's distinct copy, not
 * sendPasswordResetEmail's. Exported (see module.exports below) so
 * admin.service.js's resendOwnerInvite can fire this same email again on
 * demand — every call issues a fresh token, so an old link from a
 * previous send simply stops working rather than there being two live
 * tokens for the same account.
 */
async function sendOwnerInvite(user, business) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);
  await pool.query(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
    [uuidv4(), user.id, tokenHash],
  );
  await emailService.sendBusinessOwnerInviteEmail(user, business, rawToken);
}

/**
 * A row counts as "the same business" as one already imported if the
 * same email already owns a business with the same name at the same
 * street address — deliberately not just name-matching (a chain with
 * several branches sharing a name isn't a duplicate of itself) and not
 * just email-matching (one owner can have several real businesses).
 * Checked before geocoding, not after — no point spending a Google
 * Geocoding API request (see utils/geocode.js) resolving coordinates for
 * a row that's just going to be skipped anyway.
 *
 * This is what makes re-running the exact same CSV any number of times a
 * safe no-op for rows already imported — the admin doesn't need to hand-
 * edit the file down to just the new/fixed rows before re-uploading it.
 */
async function findDuplicateBusiness(email, name, streetAddress) {
  const [rows] = await pool.query(
    `SELECT b.id FROM businesses b
     JOIN users u ON u.id = b.owner_id
     WHERE u.email = ? AND b.name = ? AND b.street_address = ?
     LIMIT 1`,
    [email, name, streetAddress],
  );
  return rows[0] || null;
}

/**
 * Imports one already-normalized row. Lands as 'approved' immediately —
 * NOT 'pending' the way a business submitted through the app does — so
 * it shows up on the map/in search right away, regardless of whatever
 * Status/Verifiziert the CSV itself claims and regardless of whether the
 * owner account this links to is brand-new ('invited', no password set
 * yet) or already active. A CSV import is itself the admin's review —
 * these are businesses the admin already knows about and is deliberately
 * bulk-adding, not an unvetted public submission — so there's no
 * Pending Review step to wait on, and none of reviewBusiness()'s
 * owner-account-activation gate applies here (that gate only fires when
 * an admin clicks Approve on an actually-pending business; this never
 * goes through that path at all).
 */
async function importRow(row, adminId) {
  if (!row.name || !row.streetAddress || !row.city || !row.postalCode || !row.email) {
    throw new Error('Missing required field (name, address, city, postal code, or email)');
  }

  const duplicate = await findDuplicateBusiness(row.email, row.name, row.streetAddress);
  if (duplicate) {
    return { duplicate: true };
  }

  const coords = await geocodeAddress({
    streetAddress: row.streetAddress,
    postalCode: row.postalCode,
    city: row.city,
    country: row.country,
  });
  if (!coords) {
    throw new Error('Could not determine map coordinates for this address');
  }

  const { user: owner, wasCreated } = await resolveOwner(row.email, row.name);

  const businessId = uuidv4();
  await pool.query(
    `INSERT INTO businesses
      (id, owner_id, name, category, street_address, city, postal_code, country,
       latitude, longitude, phone, website, status, reviewed_by, reviewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, NOW())`,
    [
      businessId,
      owner.id,
      row.name,
      row.category, // already resolved against categoryLookup by normalizeRow
      row.streetAddress,
      row.city,
      row.postalCode,
      row.country || 'Albania',
      coords.latitude,
      coords.longitude,
      row.phone,
      row.website,
      adminId,
    ],
  );
  await pool.query(
    `INSERT INTO business_status_history (id, business_id, old_status, new_status, reason, changed_by)
     VALUES (?, ?, NULL, 'approved', 'Imported from CSV (auto-approved)', ?)`,
    [uuidv4(), businessId, adminId],
  );
  await pool.query('INSERT INTO business_analytics (business_id) VALUES (?)', [businessId]);

  const created = await businessService.getBusinessById(businessId);

  if (wasCreated) {
    // Fire-and-forget, same reasoning as every other email in this
    // codebase — a slow/failed send should never fail the import itself.
    sendOwnerInvite(owner, created);
  }

  return { duplicate: false, business: created, ownerEmail: owner.email, ownerCreated: wasCreated };
}

/**
 * Parses and imports every row in the uploaded CSV, one at a time (not a
 * bulk INSERT) — each row needs its own geocoding round-trip and
 * owner-resolution logic anyway, and processing sequentially avoids two
 * rows for the same new owner email racing each other to create that
 * account (see resolveOwner's comment). Now that geocoding is Google's
 * API rather than Nominatim, there's no external rate limit forcing
 * sequential processing anymore — this could parallelize the geocoding
 * step specifically if import speed ever becomes a problem again, just
 * not the owner-resolution step. A single bad row (missing field,
 * unresolvable address) fails that row only — the rest of the file still
 * imports, and the failure is reported back by row number so the admin
 * can fix and re-import just that one.
 */
async function importBusinessesFromCsv(buffer, adminId) {
  let records;
  try {
    records = parse(buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch (err) {
    throw ApiError.badRequest(`Could not parse CSV file: ${err.message}`);
  }
  if (records.length === 0) {
    throw ApiError.badRequest('CSV file has no data rows');
  }

  const categoryLookup = await loadCategoryLookup();

  const results = {
    imported: 0,
    linkedToExistingUser: 0,
    invitedNewUser: 0,
    duplicatesSkipped: [],
    failed: [],
  };

  for (let i = 0; i < records.length; i += 1) {
    const rowNumber = i + 2; // +1 for 0-index, +1 for the header row itself
    try {
      const normalized = normalizeRow(records[i], categoryLookup);
      const result = await importRow(normalized, adminId);
      if (result.duplicate) {
        results.duplicatesSkipped.push({ row: rowNumber, name: records[i].Name || null });
        continue;
      }
      results.imported += 1;
      if (result.ownerCreated) {
        results.invitedNewUser += 1;
      } else {
        results.linkedToExistingUser += 1;
      }
    } catch (err) {
      results.failed.push({ row: rowNumber, name: records[i].Name || null, reason: err.message });
    }
  }

  return results;
}

module.exports = {
  importBusinessesFromCsv,
  // Reused by admin.service.js's resendOwnerInvite — the "Invite" button
  // on the admin portal's businesses table for a business whose owner
  // account is still 'invited' sends the exact same email this fires on
  // first import, just triggerable again on demand instead of only once.
  sendOwnerInvite,
};
