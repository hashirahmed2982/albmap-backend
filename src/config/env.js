require('dotenv').config();

/**
 * Single source of truth for env vars. Fails fast at startup if a required
 * variable is missing, rather than surfacing a confusing error deep inside
 * a request handler later.
 */
function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const env = {
  port: parseInt(process.env.PORT || '4000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',

  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: required('DB_USER'),
    password: process.env.DB_PASSWORD || '',
    database: required('DB_NAME'),
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT || '10', 10),
  },

  jwt: {
    accessSecret: required('JWT_ACCESS_SECRET'),
    refreshSecret: required('JWT_REFRESH_SECRET'),
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  cors: {
    allowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || '')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  },

  uploads: {
    dir: process.env.UPLOAD_DIR || 'uploads',
    maxSizeMb: parseInt(process.env.MAX_UPLOAD_SIZE_MB || '5', 10),
  },

  firebase: {
    serviceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || null,
  },

  smtp: {
    host: process.env.SMTP_HOST || null,
    port: parseInt(process.env.SMTP_PORT || '2525', 10),
    user: process.env.SMTP_USER || null,
    password: process.env.SMTP_PASSWORD || null,
    fromAddress: process.env.SMTP_FROM_ADDRESS || 'AlbMap <no-reply@albmap.app>',
    adminNotificationEmail: process.env.ADMIN_NOTIFICATION_EMAIL || null,
  },

  websiteUrl: process.env.WEBSITE_URL || 'http://localhost:3001',

   google: {
    // The "audience" a Google ID token must have been issued for — this
    // is what actually proves the token was meant for THIS app, not some
    // other app that happens to also use Google Sign-In. Get this from
    // Google Cloud Console (see docs/SOCIAL_LOGIN_SETUP.md). Using the
    // Web client ID here is correct even for mobile — Android/iOS client
    // IDs are for the native SDK's own config, but ID token verification
    // on the backend checks against the associated Web client ID.
    clientId: process.env.GOOGLE_CLIENT_ID || null,
  },

  facebook: {
    appId: process.env.FACEBOOK_APP_ID || null,
    appSecret: process.env.FACEBOOK_APP_SECRET || null,
  },

  seedAdmin: {
    email: process.env.SEED_ADMIN_EMAIL || 'admin@albmap.app',
    password: process.env.SEED_ADMIN_PASSWORD || 'ChangeThisPassword123!',
  },
};

module.exports = env;
