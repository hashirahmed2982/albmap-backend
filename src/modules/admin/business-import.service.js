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
 * Maps the German column headers from the admin's past-platform export to
 * our own field names. Exact and case-sensitive on purpose — if a
 * differently-shaped export needs supporting later, add another header
 * variant here rather than trying to fuzzy-match arbitrary headers, which
 * would silently misfile a column no one actually checked.
 */
const COLUMN_MAP = {
  Name: 'name',
  Kategorie: 'category',
  Adresse: 'streetAddress',
  PLZ: 'postalCode',
  Stadt: 'city',
  Land: 'country',
  Telefon: 'phone',
  'E-Mail': 'email',
  Website: 'website',
};

/**
 * Best-effort German -> our own seeded category names (see db/seed.js's
 * CATEGORIES). Anything not listed here — including a category the CSV
 * simply doesn't set — falls back to 'Other', the same safe catch-all the
 * rest of the app already uses for an unrecognized category, rather than
 * inventing a new category string that wouldn't match anything in the
 * categories table. An admin can always correct a specific business's
 * category afterward via the normal edit flow.
 */
const CATEGORY_MAP = {
  Restaurant: 'Restaurants',
  Restaurants: 'Restaurants',
  Café: 'Cafes',
  Cafe: 'Cafes',
  Bäckerei: 'Shops',
  Bekleidung: 'Shops',
  Autohandel: 'Shops',
  Handwerk: 'Services',
  Dienstleistung: 'Services',
  Gesundheit: 'Health',
  Unterhaltung: 'Entertainment',
  Sonstiges: 'Other',
};

function mapCategory(raw) {
  if (!raw) return 'Other';
  return CATEGORY_MAP[raw.trim()] || 'Other';
}

function normalizeRow(rawRow) {
  const normalized = {};
  for (const [csvHeader, field] of Object.entries(COLUMN_MAP)) {
    normalized[field] = (rawRow[csvHeader] || '').trim() || null;
  }
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
 * sendPasswordResetEmail's.
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
 * Checked before geocoding, not after — no point spending a rate-limited
 * Nominatim request (see utils/geocode.js) resolving coordinates for a
 * row that's just going to be skipped anyway.
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
 * Imports one already-normalized row. Always lands as 'pending' —
 * regardless of whatever Status/Verifiziert the CSV itself claims — since
 * those describe the *old* platform's own decision, not a review this
 * admin has actually made here. Every imported business goes through the
 * exact same Pending Review queue as a normal submission, with the
 * additional owner-account-activation gate on top (see
 * admin.service.js's reviewBusiness()).
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
       latitude, longitude, phone, website, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [
      businessId,
      owner.id,
      row.name,
      mapCategory(row.category),
      row.streetAddress,
      row.city,
      row.postalCode,
      row.country || 'Albania',
      coords.latitude,
      coords.longitude,
      row.phone,
      row.website,
    ],
  );
  await pool.query(
    `INSERT INTO business_status_history (id, business_id, old_status, new_status, reason, changed_by)
     VALUES (?, ?, NULL, 'pending', 'Imported from CSV', ?)`,
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
 * owner-resolution logic anyway, and processing sequentially keeps
 * Nominatim's rate limit (see utils/geocode.js) satisfied without extra
 * coordination. A single bad row (missing field, unresolvable address)
 * fails that row only — the rest of the file still imports, and the
 * failure is reported back by row number so the admin can fix and
 * re-import just that one.
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
      const normalized = normalizeRow(records[i]);
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

module.exports = { importBusinessesFromCsv };
