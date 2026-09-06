const { pool } = require('../../config/db');
const ApiError = require('../../utils/ApiError');

// Every category must have a name in all three of these languages —
// enforced in createCategory/updateCategory below. `name` (English)
// stays the canonical value businesses.category actually stores and
// matches against; name_de/name_sq are display-only translations.
const REQUIRED_LOCALES = ['name', 'nameDe', 'nameSq'];

/** Public shape — used by both the mobile app's and website's category
 * picker/labels. `name`/`nameDe`/`nameSq` let each client pick its own
 * current-locale label without a round-trip per language. */
function toPublicCategory(row) {
  return { name: row.name, nameDe: row.name_de, nameSq: row.name_sq, iconName: row.icon_name };
}

async function getPublicCategories() {
  const [rows] = await pool.query(
    'SELECT name, name_de, name_sq, icon_name, sort_order FROM categories ORDER BY sort_order ASC',
  );
  return rows.map(toPublicCategory);
}

/**
 * Admin listing includes `id` (needed to edit/delete a specific row) and
 * `businessCount` — how many businesses currently use this category name.
 * There's no foreign key tying businesses.category to categories.id (it's
 * just a plain string match), so deleting a category never cascades or
 * breaks existing businesses — they simply keep showing a category name
 * that's no longer in the managed list. Surfacing the count here lets the
 * admin make an informed call rather than deleting blind.
 */
async function getAdminCategories() {
  const [rows] = await pool.query(
    `SELECT c.id, c.name, c.name_de, c.name_sq, c.icon_name, c.sort_order,
            (SELECT COUNT(*) FROM businesses b WHERE b.category = c.name) AS business_count
     FROM categories c
     ORDER BY c.sort_order ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    nameDe: r.name_de,
    nameSq: r.name_sq,
    iconName: r.icon_name,
    sortOrder: r.sort_order,
    businessCount: Number(r.business_count),
  }));
}

/** Throws unless every REQUIRED_LOCALES field is present as a non-empty
 * string — "an admin can't save a category without all 3 language
 * versions" is a hard requirement, not a suggestion. */
function requireAllLocales(fields) {
  for (const field of REQUIRED_LOCALES) {
    if (typeof fields[field] !== 'string' || !fields[field].trim()) {
      throw ApiError.badRequest(
        `All three language versions are required (name, nameDe, nameSq) — missing ${field}`,
      );
    }
  }
}

async function createCategory({ name, nameDe, nameSq, iconName, sortOrder }) {
  requireAllLocales({ name, nameDe, nameSq });

  const [existing] = await pool.query('SELECT id FROM categories WHERE name = ?', [name]);
  if (existing.length > 0) {
    throw ApiError.conflict('A category with this name already exists');
  }

  let finalSortOrder = sortOrder;
  if (finalSortOrder == null) {
    const [[{ maxOrder }]] = await pool.query('SELECT COALESCE(MAX(sort_order), 0) AS maxOrder FROM categories');
    finalSortOrder = maxOrder + 1;
  }

  const [result] = await pool.query(
    'INSERT INTO categories (name, name_de, name_sq, icon_name, sort_order) VALUES (?, ?, ?, ?, ?)',
    [name, nameDe, nameSq, iconName || null, finalSortOrder],
  );
  return {
    id: result.insertId,
    name,
    nameDe,
    nameSq,
    iconName: iconName || null,
    sortOrder: finalSortOrder,
    businessCount: 0,
  };
}

async function updateCategory(id, { name, nameDe, nameSq, iconName, sortOrder }) {
  const [existingRows] = await pool.query('SELECT * FROM categories WHERE id = ?', [id]);
  if (existingRows.length === 0) throw ApiError.notFound('Category not found');

  // Editing any one language version means re-submitting all three —
  // there's no such thing as "update just the German name," since that
  // would leave the other two stale/unreviewed without the admin ever
  // seeing them. Leaving every name field out entirely (e.g. a request
  // that only changes sortOrder or iconName) is fine and doesn't touch
  // the names at all.
  const touchesName = name !== undefined || nameDe !== undefined || nameSq !== undefined;
  if (touchesName) {
    requireAllLocales({ name, nameDe, nameSq });
    const [nameClash] = await pool.query('SELECT id FROM categories WHERE name = ? AND id != ?', [name, id]);
    if (nameClash.length > 0) throw ApiError.conflict('A category with this name already exists');
  }

  const updates = [];
  const params = [];
  if (touchesName) {
    updates.push('name = ?', 'name_de = ?', 'name_sq = ?');
    params.push(name, nameDe, nameSq);
  }
  if (iconName !== undefined) { updates.push('icon_name = ?'); params.push(iconName); }
  if (sortOrder !== undefined) { updates.push('sort_order = ?'); params.push(sortOrder); }

  if (updates.length > 0) {
    params.push(id);
    await pool.query(`UPDATE categories SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const [[updated]] = await pool.query(
    `SELECT c.id, c.name, c.name_de, c.name_sq, c.icon_name, c.sort_order,
            (SELECT COUNT(*) FROM businesses b WHERE b.category = c.name) AS business_count
     FROM categories c WHERE c.id = ?`,
    [id],
  );
  return {
    id: updated.id,
    name: updated.name,
    nameDe: updated.name_de,
    nameSq: updated.name_sq,
    iconName: updated.icon_name,
    sortOrder: updated.sort_order,
    businessCount: Number(updated.business_count),
  };
}

async function deleteCategory(id) {
  const [result] = await pool.query('DELETE FROM categories WHERE id = ?', [id]);
  if (result.affectedRows === 0) throw ApiError.notFound('Category not found');
}

module.exports = {
  getPublicCategories,
  getAdminCategories,
  createCategory,
  updateCategory,
  deleteCategory,
};
