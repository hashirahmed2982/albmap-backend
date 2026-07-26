const { pool } = require('../../config/db');
const ApiError = require('../../utils/ApiError');

/** Public shape — used by the mobile app's category picker. Unchanged from before. */
function toPublicCategory(row) {
  return { name: row.name, iconName: row.icon_name };
}

async function getPublicCategories() {
  const [rows] = await pool.query('SELECT name, icon_name, sort_order FROM categories ORDER BY sort_order ASC');
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
    `SELECT c.id, c.name, c.icon_name, c.sort_order,
            (SELECT COUNT(*) FROM businesses b WHERE b.category = c.name) AS business_count
     FROM categories c
     ORDER BY c.sort_order ASC`,
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    iconName: r.icon_name,
    sortOrder: r.sort_order,
    businessCount: Number(r.business_count),
  }));
}

async function createCategory({ name, iconName, sortOrder }) {
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
    'INSERT INTO categories (name, icon_name, sort_order) VALUES (?, ?, ?)',
    [name, iconName || null, finalSortOrder],
  );
  return { id: result.insertId, name, iconName: iconName || null, sortOrder: finalSortOrder, businessCount: 0 };
}

async function updateCategory(id, { name, iconName, sortOrder }) {
  const [existingRows] = await pool.query('SELECT * FROM categories WHERE id = ?', [id]);
  if (existingRows.length === 0) throw ApiError.notFound('Category not found');

  if (name !== undefined) {
    const [nameClash] = await pool.query('SELECT id FROM categories WHERE name = ? AND id != ?', [name, id]);
    if (nameClash.length > 0) throw ApiError.conflict('A category with this name already exists');
  }

  const updates = [];
  const params = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (iconName !== undefined) { updates.push('icon_name = ?'); params.push(iconName); }
  if (sortOrder !== undefined) { updates.push('sort_order = ?'); params.push(sortOrder); }

  if (updates.length > 0) {
    params.push(id);
    await pool.query(`UPDATE categories SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const [[updated]] = await pool.query(
    `SELECT c.id, c.name, c.icon_name, c.sort_order,
            (SELECT COUNT(*) FROM businesses b WHERE b.category = c.name) AS business_count
     FROM categories c WHERE c.id = ?`,
    [id],
  );
  return {
    id: updated.id,
    name: updated.name,
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
