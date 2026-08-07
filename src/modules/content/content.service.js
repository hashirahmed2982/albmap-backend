const { pool } = require('../../config/db');
const ApiError = require('../../utils/ApiError');

// Every page an admin can edit here — adding a fifth one later means
// adding its key + validateShape() case, not a migration (see
// site_content's table comment in schema.sql).
const ALLOWED_KEYS = ['about_us', 'social_links', 'privacy_policy', 'terms_conditions'];

const REQUIRED_STRING_FIELDS = {
  about_us: ['tagline', 'missionTitle', 'missionBody', 'visionTitle', 'visionBody'],
};

// Every field is optional here — a business only fills in the platforms
// it actually has, and a null/missing one means "don't show that icon,"
// on both clients.
const OPTIONAL_URL_FIELDS = {
  social_links: ['facebook', 'instagram', 'twitter', 'tiktok', 'youtube', 'linkedin'],
};

function toCamelKey(key) {
  return key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

/**
 * Privacy Policy and Terms & Conditions are both "a title plus an ordered
 * list of heading/body sections" — same shape, just different content —
 * so both keys share this validator rather than duplicating it.
 */
function validateLegalPage(key, data) {
  if (typeof data.title !== 'string' || !data.title.trim()) {
    throw ApiError.badRequest(`${key}.title is required`);
  }
  if (!Array.isArray(data.sections) || data.sections.length === 0) {
    throw ApiError.badRequest(`${key}.sections must be a non-empty array`);
  }
  data.sections.forEach((section, i) => {
    if (!section || typeof section !== 'object') {
      throw ApiError.badRequest(`${key}.sections[${i}] must be an object`);
    }
    if (typeof section.heading !== 'string' || !section.heading.trim()) {
      throw ApiError.badRequest(`${key}.sections[${i}].heading is required`);
    }
    if (typeof section.body !== 'string' || !section.body.trim()) {
      throw ApiError.badRequest(`${key}.sections[${i}].body is required`);
    }
  });
}

function validateShape(key, data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw ApiError.badRequest('Content data must be an object');
  }

  if (key === 'privacy_policy' || key === 'terms_conditions') {
    validateLegalPage(key, data);
    return;
  }

  for (const field of REQUIRED_STRING_FIELDS[key] || []) {
    if (typeof data[field] !== 'string' || !data[field].trim()) {
      throw ApiError.badRequest(`${key}.${field} is required`);
    }
  }
  for (const field of OPTIONAL_URL_FIELDS[key] || []) {
    if (data[field] != null && typeof data[field] !== 'string') {
      throw ApiError.badRequest(`${key}.${field} must be a string URL or null`);
    }
  }
}

/**
 * Every page, keyed camelCase (aboutUs, socialLinks, ...) for both clients.
 *
 * `row.data` is already a plain object here, not a JSON string — mysql2
 * auto-parses columns declared JSON (see site_content in schema.sql)
 * unless the pool is created with `jsonStrings: true` (it isn't, see
 * config/db.js). Calling JSON.parse() on it (the original bug here)
 * blew up in production: JSON.parse coerces a non-string argument via
 * String(value) first, and String({...}) is the literal text
 * "[object Object]" — not valid JSON, so every GET /content request
 * failed with "SyntaxError: \"[object Object]\" is not valid JSON".
 */
async function getAllContent() {
  const [rows] = await pool.query('SELECT `key`, data, updated_at FROM site_content');
  const byKey = new Map(rows.map((r) => [r.key, r]));

  const result = {};
  for (const key of ALLOWED_KEYS) {
    const row = byKey.get(key);
    result[toCamelKey(key)] = row
      ? { ...row.data, updatedAt: row.updated_at }
      : null;
  }
  return result;
}

async function updateContent(key, data, adminId) {
  if (!ALLOWED_KEYS.includes(key)) {
    throw ApiError.badRequest(`Unknown content key: ${key}`);
  }
  validateShape(key, data);

  await pool.query(
    `INSERT INTO site_content (\`key\`, data, updated_by, updated_at)
     VALUES (?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE data = VALUES(data), updated_by = VALUES(updated_by), updated_at = NOW()`,
    [key, JSON.stringify(data), adminId],
  );

  const [rows] = await pool.query('SELECT data, updated_at FROM site_content WHERE `key` = ?', [key]);
  // Same reasoning as getAllContent above — rows[0].data is already an
  // object, not a JSON string.
  return { ...rows[0].data, updatedAt: rows[0].updated_at };
}

module.exports = { ALLOWED_KEYS, getAllContent, updateContent };
