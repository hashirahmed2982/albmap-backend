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

// Default content for the four admin-editable pages (see site_content in
// schema.sql) — the exact copy that used to be hardcoded independently in
// the mobile app's localization files and the website's next-intl
// messages/literal JSX, so nothing goes blank on either client the first
// time this runs. social_links.facebook/instagram/twitter carry over the
// same placeholder handles ("albmap") the mobile app's About Us screen
// used to hard-code — almost certainly not real accounts; an admin should
// confirm/replace them via the admin portal's Content page.
const SITE_CONTENT = {
  about_us: {
    tagline: 'Discover local businesses & events around you',
    missionTitle: 'Our mission',
    missionBody:
      'AlbMap connects communities with the local businesses and events that make their neighborhoods vibrant — making discovery effortless for guests and giving business owners the tools to reach the people around them.',
    visionTitle: 'Our vision',
    visionBody: 'To become the go-to platform for local discovery — one map, every community.',
  },
  social_links: {
    facebook: 'https://facebook.com/albmap',
    instagram: 'https://instagram.com/albmap',
    twitter: 'https://twitter.com/albmap',
    tiktok: null,
    youtube: null,
    linkedin: null,
  },
  privacy_policy: {
    title: 'Privacy Policy',
    sections: [
      {
        heading: 'Information we collect',
        body: [
          'Account information: name, email address, and phone number (if provided) when you sign up, including via Google or Facebook Sign-In.',
          "Location: your device's location, used to show nearby businesses and calculate distances. Only used while the app is in use.",
          'Business listing data: if you register a business, its name, address, description, category, phone/WhatsApp number, opening hours, and any logo image you upload.',
          'Event data: events you create, including any images you upload.',
          "Device push token: to deliver notifications you're eligible to receive.",
          'Favorites: businesses you save, synced to your account.',
        ]
          .map((line) => `• ${line}`)
          .join('\n'),
      },
      {
        heading: 'How we use information',
        body: "To operate the app and website's core features: showing nearby businesses and events, managing your account and business listings, and delivering notifications you're eligible to receive. We do not sell your personal information to third parties.",
      },
      {
        heading: 'Third-party services',
        body: "We use Google Sign-In and Facebook Login for authentication, and Firebase Cloud Messaging for push notifications. Each provider's own privacy policy governs their handling of data during that interaction.",
      },
      {
        heading: 'Data retention & deletion',
        body: 'You can request deletion of your account and associated data at any time via our Contact Us page. We will delete your account, business listings, and personal data within 30 days of a verified request.',
      },
      {
        heading: 'Contact',
        body: 'Questions about this policy? Reach us via our Contact Us page.',
      },
    ],
  },
  terms_conditions: {
    title: 'Terms & Conditions',
    sections: [
      {
        heading: '1. Acceptance of terms',
        body: "By creating an account or using AlbMap (the app or this website), you agree to these terms. If you don't agree, please don't use the service.",
      },
      {
        heading: '2. Accounts',
        body: "You're responsible for the accuracy of the information you provide and for keeping your account credentials secure. You must be legally able to enter into these terms in your jurisdiction.",
      },
      {
        heading: '3. Business listings',
        body: "Business owners are responsible for the accuracy of their listing's information (name, address, hours, contact details, images). Every new listing — and certain edits to an existing one — goes through admin review before appearing publicly. We reserve the right to reject, suspend, or remove any listing that violates these terms or is inaccurate, fraudulent, or misleading.",
      },
      {
        heading: '4. Notifications',
        body: 'Business owners may submit offers or announcements for broadcast to users. Every submission is reviewed by an admin before being sent — nothing reaches users automatically. We reserve the right to reject any submission.',
      },
      {
        heading: '5. User conduct',
        body: "You agree not to submit false reviews, impersonate another business or person, upload content you don't have rights to, or otherwise misuse the platform.",
      },
      {
        heading: '6. Content',
        body: 'You retain ownership of content you submit (business descriptions, images, reviews), but grant AlbMap a license to display it as part of the service.',
      },
      {
        heading: '7. Limitation of liability',
        body: 'AlbMap is provided "as is." We don\'t guarantee the accuracy of listings, opening hours, or event details submitted by business owners, and we\'re not liable for any loss arising from reliance on that information.',
      },
      {
        heading: '8. Changes to these terms',
        body: 'We may update these terms from time to time. Continued use of the service after a change constitutes acceptance of the updated terms.',
      },
      {
        heading: '9. Contact',
        body: 'Questions about these terms? Reach us via our Contact Us page.',
      },
    ],
  },
};

async function seedSiteContent() {
  // INSERT IGNORE, not ON DUPLICATE KEY UPDATE — unlike categories, this
  // content is meant to be edited by an admin after it ships, so a
  // re-run of this script (e.g. on every deploy) must never stomp on a
  // change they've already made. Only a key that doesn't exist yet gets
  // filled in.
  for (const [key, data] of Object.entries(SITE_CONTENT)) {
    await pool.query('INSERT IGNORE INTO site_content (`key`, data) VALUES (?, ?)', [
      key,
      JSON.stringify(data),
    ]);
  }
  console.log('✅ Seeded default site content (skipped any key an admin already edited)');
}

async function run() {
  try {
    await seedCategories();
    await seedAdmin();
    await seedSiteContent();
    console.log('✅ Seed complete');
    process.exit(0);
  } catch (err) {
    console.error('❌ Seed failed:', err);
    process.exit(1);
  }
}

run();
