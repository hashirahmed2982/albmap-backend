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
    // Must be a domain actually verified with whatever SMTP_HOST provider
    // is configured (SPF/DKIM, marked verified in their dashboard) — the
    // bare apex domain (no-reply@albmap.app) is NOT automatically covered
    // by verifying a subdomain like mail.albmap.app, and sending from an
    // unverified domain gets the whole send rejected with a 550. This
    // default matches the subdomain actually verified for this project;
    // override via SMTP_FROM_ADDRESS if that ever changes.
    fromAddress: process.env.SMTP_FROM_ADDRESS || 'AlbMap <no-reply@mail.albmap.app>',
    adminNotificationEmail: process.env.ADMIN_NOTIFICATION_EMAIL || null,
  },

  websiteUrl: process.env.WEBSITE_URL || 'http://localhost:3001',

  // Same "ordered, not live yet" placeholders as the website's own
  // src/lib/app-links.ts — used for the QR codes in the business-owner
  // invite email (notifications/email.js). Override via env the moment
  // the app actually ships, or sooner if a TestFlight/internal-testing
  // link exists ahead of a full release — everything else about the
  // email works unchanged once these point somewhere real.
  appStore: {
    android: process.env.ANDROID_PLAY_STORE_URL || 'https://play.google.com/store/apps/details?id=com.albmap.app',
    ios: process.env.IOS_APP_STORE_URL || 'https://apps.apple.com/app/albmap/id0000000000',
  },

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

  // Server-side geocoding for the CSV business import (utils/geocode.js) —
  // a DIFFERENT key than the Android/iOS Maps SDK keys already baked into
  // the app (those are restricted to this app's package name/bundle ID +
  // signing fingerprint, which a plain server-to-server HTTP call has no
  // way to present, so they won't work here). Create a separate key in
  // Google Cloud Console with the Geocoding API enabled, restricted by
  // server IP rather than app identity.
  googleMaps: {
    apiKey: process.env.GOOGLE_MAPS_GEOCODING_API_KEY || null,
  },

  facebook: {
    appId: process.env.FACEBOOK_APP_ID || null,
    appSecret: process.env.FACEBOOK_APP_SECRET || null,
  },

  apple: {
    // A Sign in with Apple identity token's `aud` claim is whichever
    // client ID actually requested it — the iOS app's own bundle ID for
    // the native in-app flow, but the Services ID for the Android/web
    // flow (Android has no native Apple SDK, so it goes through Apple's
    // web sign-in page instead, configured under a Services ID). Both are
    // legitimate for this one app, so loginWithApple() accepts either —
    // see docs/APPLE_SIGN_IN_SETUP.md for how to obtain them.
    bundleId: process.env.APPLE_BUNDLE_ID || 'com.albmap.app',
    servicesId: process.env.APPLE_SERVICES_ID || null,
    // Only used to build the deep link back into the Android app from
    // appleCallback() below — the Android app's own applicationId.
    androidPackageId: process.env.APPLE_ANDROID_PACKAGE_ID || 'com.albmap.app',
  },

  seedAdmin: {
    email: process.env.SEED_ADMIN_EMAIL || 'admin@albmap.app',
    password: process.env.SEED_ADMIN_PASSWORD || 'ChangeThisPassword123!',
  },
};

module.exports = env;
