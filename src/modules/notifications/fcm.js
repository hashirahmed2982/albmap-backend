const path = require('path');
const env = require('../../config/env');

let admin = null;

/**
 * Lazily initialized so the server can boot and serve everything else even
 * if Firebase isn't configured yet — push notifications degrade to a
 * no-op with a console warning rather than crashing the whole API.
 *
 * Only caches on SUCCESS. Previously this cached after the very first
 * call regardless of outcome (a stray `initialized = true` set before the
 * config/try-catch even ran) — meaning if FIREBASE_SERVICE_ACCOUNT_PATH
 * was momentarily wrong on the first notification ever sent (e.g. a
 * duplicate key in .env silently overriding it with an empty value, or
 * the server having started before the file was in place), FCM would
 * stay permanently "disabled" for that process's entire lifetime, even
 * after fixing the underlying problem — the fix would only take effect
 * on the next actual server restart, not the next send attempt. Retrying
 * on every call until it actually succeeds means a config fix takes
 * effect on the very next notification, no restart required.
 */
function getFirebaseAdmin() {
  if (admin) return admin;

  if (!env.firebase.serviceAccountPath) {
    console.warn(
      '⚠️  FIREBASE_SERVICE_ACCOUNT_PATH not set — push notifications will be logged, not delivered. See docs/FCM_SETUP.md',
    );
    return null;
  }

  try {
    // eslint-disable-next-line global-require
    const firebaseAdmin = require('firebase-admin');
    // Re-requiring an already-initialized default app throws — guard
    // against calling initializeApp() twice if a previous attempt in this
    // same process partially succeeded (got this far but failed lower down).
    if (firebaseAdmin.apps.length === 0) {
      // FIREBASE_SERVICE_ACCOUNT_PATH is written in .env from the
      // project-root's perspective (where you'd naturally drop the
      // downloaded service account JSON) — but require() resolves a
      // relative path against the location of the file calling it (this
      // file, buried in src/modules/notifications/), not the project
      // root and not .env's location. Resolving against process.cwd()
      // here means a path like "./albmap1.json" in .env correctly finds
      // a file sitting next to package.json, matching what anyone would
      // reasonably expect to write. An already-absolute path (e.g. a
      // full Windows "C:\..." path) passes through unchanged.
      const resolvedPath = path.isAbsolute(env.firebase.serviceAccountPath)
        ? env.firebase.serviceAccountPath
        : path.resolve(process.cwd(), env.firebase.serviceAccountPath);
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const serviceAccount = require(resolvedPath);
      firebaseAdmin.initializeApp({ credential: firebaseAdmin.credential.cert(serviceAccount) });
    }
    admin = firebaseAdmin;
    console.log('✅ Firebase Admin initialized');
    return admin;
  } catch (err) {
    console.error('❌ Failed to initialize Firebase Admin:', err.message);
    return null;
  }
}

/**
 * Every device subscribes to this topic on app start (see the mobile
 * app's FCM initialization) — used for broadcasts meant to reach every
 * registered user, as opposed to sendToTopic's per-business topics which
 * only reach that business's followers.
 */
const ALL_USERS_TOPIC = 'all_users';

/**
 * Sends to a topic rather than individual device tokens — subscribe every
 * user's device to a per-business topic (e.g. `business_<id>_followers`)
 * client-side when they favorite that business, or to a global `all_users`
 * topic for general broadcasts. Topic-based delivery scales far better
 * than looping over individual tokens for anything beyond a handful of
 * recipients.
 */
async function sendToTopic(topic, { title, body, data = {} }) {
  const fcm = getFirebaseAdmin();
  if (!fcm) {
    console.log(`[FCM disabled] Would send to topic "${topic}": ${title} — ${body}`);
    return { delivered: false, reason: 'Firebase not configured' };
  }

  const message = {
    topic,
    notification: { title, body },
    data,
  };

  const response = await fcm.messaging().send(message);
  return { delivered: true, messageId: response };
}

module.exports = { sendToTopic, ALL_USERS_TOPIC };