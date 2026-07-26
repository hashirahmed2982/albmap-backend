const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const env = require('../config/env');

const CATEGORIES = [
  { name: 'Restaurants', icon: 'restaurant_outlined', sort: 1 },
  { name: 'Cafes', icon: 'coffee_outlined', sort: 2 },
  { name: 'Shops', icon: 'storefront_outlined', sort: 3 },
  { name: 'Services', icon: 'build_outlined', sort: 4 },
  { name: 'Health', icon: 'fitness_center_outlined', sort: 5 },
  { name: 'Entertainment', icon: 'local_movies_outlined', sort: 6 },
  { name: 'Other', icon: 'category_outlined', sort: 7 },
];

async function seedCategories() {
  for (const cat of CATEGORIES) {
    await pool.query(
      `INSERT INTO categories (name, icon_name, sort_order)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE icon_name = VALUES(icon_name), sort_order = VALUES(sort_order)`,
      [cat.name, cat.icon, cat.sort],
    );
  }
  console.log(`✅ Seeded ${CATEGORIES.length} categories`);
}

async function seedAdmin() {
  const [existing] = await pool.query('SELECT id FROM users WHERE role = "admin" LIMIT 1');
  if (existing.length > 0) {
    console.log('ℹ️  Admin account already exists, skipping');
    return;
  }

  const passwordHash = await bcrypt.hash(env.seedAdmin.password, 10);
  await pool.query(
    `INSERT INTO users (id, email, password_hash, name, role, is_email_verified, is_active)
     VALUES (?, ?, ?, 'AlbMap Admin', 'admin', 1, 1)`,
    [uuidv4(), env.seedAdmin.email, passwordHash],
  );
  console.log(`✅ Created admin account: ${env.seedAdmin.email}`);
  console.log('   ⚠️  Change this password immediately after first login.');
}

async function run() {
  try {
    await seedCategories();
    await seedAdmin();
    console.log('✅ Seed complete');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  }
}

run();
