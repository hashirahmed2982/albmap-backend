const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../config/db');
const env = require('../../config/env');
const ApiError = require('../../utils/ApiError');
const { signAccessToken, signRefreshToken, verifyRefreshToken, hashToken } = require('../../utils/jwt');
const emailService = require('../notifications/email');

// Matches the admin portal's own client-side inactivity timer
// (useInactivityLogout.ts) — kept as a plain constant like that one
// rather than an env var, since it's a fixed UX decision, not
// per-deployment config. See refresh()'s comment for how this is
// actually enforced. In minutes (not ms) because it's fed straight into
// a MySQL DATE_SUB(NOW(), INTERVAL ? MINUTE) — doing the age comparison
// in SQL against MySQL's own NOW() sidesteps having to parse the
// dateStrings-mode DATETIME string this driver returns back into a JS
// Date and reason about server-timezone-vs-Node-timezone consistency.
const ADMIN_IDLE_LIMIT_MINUTES = 15;

// Signup-by-email-OTP tuning (mobile app + website password signup only —
// see requestSignupOtp/verifySignupOtp).
const SIGNUP_OTP_EXPIRY_MINUTES = 10;
const SIGNUP_OTP_MAX_ATTEMPTS = 5;
const SIGNUP_OTP_RESEND_COOLDOWN_SECONDS = 60;

/**
 * Every login path (password, Google, Facebook) checks is_active and
 * needs the exact same message — a banned user has no dashboard/account
 * page to see why on, so this login-attempt error is the only "website"
 * surface they'll ever see it on, alongside the ban email
 * (sendUserBannedEmail).
 */
function deactivatedAccountMessage(user) {
  return user.deactivation_reason
    ? `This account has been deactivated. Reason: ${user.deactivation_reason}`
    : 'This account has been deactivated.';
}

function toPublicUser(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    profileImageUrl: row.profile_image_url,
    role: row.role,
    isEmailVerified: !!row.is_email_verified,
  };
}

async function issueTokenPair(userId) {
  const accessToken = signAccessToken({ sub: userId });
  const refreshToken = signRefreshToken({ sub: userId });

  await pool.query(
    `INSERT INTO refresh_tokens (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 30 DAY))`,
    [uuidv4(), userId, hashToken(refreshToken)],
  );

  return { accessToken, refreshToken };
}

/**
 * Step 1 of password signup (mobile app + website) — does NOT create a
 * `users` row. Only social login (Google/Facebook, whose provider has
 * already verified the email) and this OTP flow's step 2 ever insert
 * into `users` for a new account; a plain POST here can no longer create
 * an unverified account the way it used to, which is the actual point:
 * the email has to be proven real, or no account ever exists for it.
 *
 * Re-calling this for the same still-unverified email (e.g. "Resend
 * code", or fixing a typo'd password before re-submitting) is supported
 * and expected — it just replaces the pending row with a fresh OTP +
 * fresh password/name, rather than needing a separate endpoint.
 */
async function requestSignupOtp({ email, password, name }) {
  const [existing] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
  if (existing.length > 0) {
    throw ApiError.conflict('An account with this email already exists');
  }

  const [recent] = await pool.query(
    `SELECT id FROM signup_otps
     WHERE email = ? AND created_at > DATE_SUB(NOW(), INTERVAL ? SECOND)
     LIMIT 1`,
    [email, SIGNUP_OTP_RESEND_COOLDOWN_SECONDS],
  );
  if (recent.length > 0) {
    throw ApiError.badRequest('A code was just sent — please wait a bit before requesting another.');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  // crypto.randomInt (not Math.random) — this gates account creation, so
  // it needs to be unguessable the same way a password reset token is.
  const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const otpHash = hashToken(otp);

  // One pending signup per email at a time — a fresh request (typo'd
  // password, "resend code", or a stale abandoned attempt) always
  // replaces whatever was there before rather than piling up rows.
  await pool.query('DELETE FROM signup_otps WHERE email = ?', [email]);
  await pool.query(
    `INSERT INTO signup_otps (id, email, otp_hash, password_hash, name, expires_at)
     VALUES (?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
    [uuidv4(), email, otpHash, passwordHash, name, SIGNUP_OTP_EXPIRY_MINUTES],
  );

  await emailService.sendSignupOtpEmail(email, name, otp);
}

/**
 * Step 2 — the only place a password-signup `users` row actually gets
 * created. Marks is_email_verified straight away, since successfully
 * entering the code IS the verification (unlike the default signed-up-
 * via-password state, which starts unverified).
 */
async function verifySignupOtp({ email, otp }) {
  const [rows] = await pool.query(
    'SELECT *, (expires_at < NOW()) AS is_expired FROM signup_otps WHERE email = ? ORDER BY created_at DESC LIMIT 1',
    [email],
  );
  const pending = rows[0];
  if (!pending) {
    throw ApiError.badRequest('No pending signup found for this email — please sign up again.');
  }

  if (pending.is_expired) {
    await pool.query('DELETE FROM signup_otps WHERE id = ?', [pending.id]);
    throw ApiError.badRequest('This code has expired — please request a new one.');
  }

  if (pending.attempts >= SIGNUP_OTP_MAX_ATTEMPTS) {
    await pool.query('DELETE FROM signup_otps WHERE id = ?', [pending.id]);
    throw ApiError.badRequest('Too many incorrect attempts — please request a new code.');
  }

  if (hashToken(otp) !== pending.otp_hash) {
    await pool.query('UPDATE signup_otps SET attempts = attempts + 1 WHERE id = ?', [pending.id]);
    throw ApiError.badRequest('Incorrect code.');
  }

  // Re-check for a race: someone could have registered this email a
  // different way (e.g. social login) in the minutes between requesting
  // and entering the code.
  const [existing] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
  if (existing.length > 0) {
    await pool.query('DELETE FROM signup_otps WHERE id = ?', [pending.id]);
    throw ApiError.conflict('An account with this email already exists');
  }

  const userId = uuidv4();
  await pool.query(
    `INSERT INTO users (id, email, password_hash, name, role, auth_provider, is_email_verified)
     VALUES (?, ?, ?, ?, 'business', 'password', 1)`,
    [userId, email, pending.password_hash, pending.name],
  );
  await pool.query('DELETE FROM signup_otps WHERE id = ?', [pending.id]);

  const [userRows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
  const tokens = await issueTokenPair(userId);

  // Fire-and-forget — a slow or failed email should never delay or break
  // the signup response itself. emailService.sendWelcomeEmail already
  // catches its own errors internally and never throws.
  emailService.sendWelcomeEmail(userRows[0]);

  return { user: toPublicUser(userRows[0]), ...tokens };
}

async function login({ email, password }) {
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
  const user = rows[0];

  if (!user || !user.password_hash) {
    throw ApiError.unauthorized('Invalid email or password');
  }
  if (!user.is_active) {
    throw ApiError.forbidden(deactivatedAccountMessage(user));
  }

  const passwordMatches = await bcrypt.compare(password, user.password_hash);
  if (!passwordMatches) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  const tokens = await issueTokenPair(user.id);
  return { user: toPublicUser(user), ...tokens };
}

/**
 * Shared by loginWithGoogle/loginWithFacebook — finds the user by
 * (auth_provider, provider_user_id) first (the reliable path for a
 * repeat login), falling back to matching by email for a first-time
 * social login on an account that already exists via password signup
 * (in which case this LINKS the social identity to that existing
 * account rather than creating a duplicate — same email, one account,
 * regardless of which method was used to sign in this time).
 */
async function findOrCreateSocialUser({ provider, providerUserId, email, name, profileImageUrl }) {
  const [byProvider] = await pool.query(
    'SELECT * FROM users WHERE auth_provider = ? AND provider_user_id = ? LIMIT 1',
    [provider, providerUserId],
  );
  if (byProvider.length > 0) {
    return byProvider[0];
  }

  const [byEmail] = await pool.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
  if (byEmail.length > 0) {
    // Link this social identity to the existing (e.g. password-based)
    // account rather than creating a second one with the same email —
    // email has a UNIQUE constraint, so a naive INSERT here would fail
    // anyway, but doing it explicitly makes the linking intentional
    // rather than accidental.
    await pool.query(
      'UPDATE users SET auth_provider = ?, provider_user_id = ?, is_email_verified = 1 WHERE id = ?',
      [provider, providerUserId, byEmail[0].id],
    );
    const [refreshed] = await pool.query('SELECT * FROM users WHERE id = ?', [byEmail[0].id]);
    return refreshed[0];
  }

  const userId = uuidv4();
  await pool.query(
    `INSERT INTO users (id, email, name, profile_image_url, role, auth_provider, provider_user_id, is_email_verified)
     VALUES (?, ?, ?, ?, 'business', ?, ?, 1)`,
    [userId, email, name, profileImageUrl || null, provider, providerUserId],
  );
  const [created] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
  return created[0];
}

/**
 * Verifies a Google ID token against Google's public keys (via
 * google-auth-library, which handles fetching/caching/rotating Google's
 * signing keys) and checks it was issued for THIS app specifically
 * (the `audience` check) — without that check, any valid Google ID
 * token from any app would be accepted, not just ones from this app's
 * own sign-in flow.
 */
async function loginWithGoogle({ idToken }) {
  if (!idToken) {
    throw ApiError.badRequest('Missing Google ID token');
  }
  if (!env.google.clientId) {
    throw ApiError.internal('Google sign-in is not configured on the server (GOOGLE_CLIENT_ID unset)');
  }

  const { OAuth2Client } = require('google-auth-library');
  const client = new OAuth2Client(env.google.clientId);

  let payload;
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: env.google.clientId });
    payload = ticket.getPayload();
  } catch (err) {
    throw ApiError.unauthorized('Invalid or expired Google ID token');
  }

  if (!payload?.email) {
    throw ApiError.unauthorized('Google account has no email address');
  }

  const user = await findOrCreateSocialUser({
    provider: 'google',
    providerUserId: payload.sub,
    email: payload.email,
    name: payload.name || payload.email.split('@')[0],
    profileImageUrl: payload.picture,
  });

  if (!user.is_active) throw ApiError.forbidden(deactivatedAccountMessage(user));

  const tokens = await issueTokenPair(user.id);
  return { user: toPublicUser(user), ...tokens };
}

/**
 * Verifies a Facebook access token two ways: first that it's simply
 * valid (the /me call succeeds at all), then — critically — that it was
 * actually issued for THIS app via the /debug_token endpoint, using our
 * own app_id+app_secret as credentials for that check. Skipping the
 * debug_token step would mean accepting ANY valid Facebook access token
 * from ANY app, not just ones from this app's own login flow — a real
 * security gap, not just a formality.
 */
async function loginWithFacebook({ accessToken }) {
  if (!accessToken) {
    throw ApiError.badRequest('Missing Facebook access token');
  }
  if (!env.facebook.appId || !env.facebook.appSecret) {
    throw ApiError.internal(
      'Facebook sign-in is not configured on the server (FACEBOOK_APP_ID/FACEBOOK_APP_SECRET unset)',
    );
  }

  const appAccessToken = `${env.facebook.appId}|${env.facebook.appSecret}`;
  const debugUrl = `https://graph.facebook.com/debug_token?input_token=${encodeURIComponent(accessToken)}&access_token=${encodeURIComponent(appAccessToken)}`;

  let debugData;
  try {
    const debugRes = await fetch(debugUrl);
    debugData = await debugRes.json();
  } catch (err) {
    throw ApiError.unauthorized('Could not verify Facebook access token');
  }

  const tokenInfo = debugData?.data;
  if (!tokenInfo?.is_valid || tokenInfo.app_id !== env.facebook.appId) {
    throw ApiError.unauthorized('Invalid Facebook access token, or issued for a different app');
  }

  let profile;
  try {
    const profileRes = await fetch(
      `https://graph.facebook.com/me?fields=id,name,email,picture&access_token=${encodeURIComponent(accessToken)}`,
    );
    profile = await profileRes.json();
  } catch (err) {
    throw ApiError.unauthorized('Could not fetch Facebook profile');
  }

  if (!profile?.email) {
    // Facebook only returns email if the user granted that permission
    // AND has a verified email on their account — some accounts
    // (phone-only signup, or the permission was declined) genuinely
    // have none, which this app requires since email is how accounts
    // are matched/deduplicated across sign-in methods.
    throw ApiError.badRequest(
      'Your Facebook account has no email available. Please use email/password or Google sign-in instead.',
    );
  }

  const user = await findOrCreateSocialUser({
    provider: 'facebook',
    providerUserId: profile.id,
    email: profile.email,
    name: profile.name || profile.email.split('@')[0],
    profileImageUrl: profile.picture?.data?.url,
  });

  if (!user.is_active) throw ApiError.forbidden(deactivatedAccountMessage(user));

  const tokens = await issueTokenPair(user.id);
  return { user: toPublicUser(user), ...tokens };
}

async function refresh({ refreshToken }) {
  if (!refreshToken) {
    throw ApiError.badRequest('Missing refresh token');
  }

  let decoded;
  try {
    decoded = verifyRefreshToken(refreshToken);
  } catch (err) {
    throw ApiError.unauthorized('Invalid or expired refresh token');
  }

  const tokenHash = hashToken(refreshToken);
  const [rows] = await pool.query(
    `SELECT * FROM refresh_tokens
     WHERE user_id = ? AND token_hash = ? AND revoked_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [decoded.sub, tokenHash],
  );

  if (rows.length === 0) {
    throw ApiError.unauthorized('Refresh token has been revoked or expired');
  }

  // Admin portal only: a hard 15-minute idle timeout, enforced here so it
  // holds even if the browser was closed the whole time — the admin
  // portal's own client-side inactivity timer only runs while a tab is
  // open, so this is the backstop for "closed the laptop, came back
  // later." last_active_at is updated on every authenticated request by
  // requireAuth, so it reflects real activity, not just how often the
  // (separately, always-15-minute) access token happens to expire and
  // get refreshed — an admin using the portal continuously never trips
  // this, since some request always lands well within the last 15
  // minutes. Business/mobile/website users are untouched: this whole
  // block is a no-op for them since last_active_at is never set for
  // anything but role='admin'.
  const [userRows] = await pool.query(
    `SELECT role, (last_active_at IS NOT NULL AND last_active_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)) AS is_idle
     FROM users WHERE id = ? LIMIT 1`,
    [ADMIN_IDLE_LIMIT_MINUTES, decoded.sub],
  );
  const user = userRows[0];
  if (user?.role === 'admin' && user.is_idle) {
    await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = ?', [rows[0].id]);
    throw ApiError.unauthorized('Session expired after 15 minutes of inactivity');
  }

  const accessToken = signAccessToken({ sub: decoded.sub });
  return { accessToken };
}

async function logout({ refreshToken }) {
  if (!refreshToken) return;
  const tokenHash = hashToken(refreshToken);
  await pool.query(
    'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = ?',
    [tokenHash],
  );
}

async function getCurrentUser(userId) {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ? LIMIT 1', [userId]);
  if (rows.length === 0) throw ApiError.notFound('User not found');
  return toPublicUser(rows[0]);
}

async function forgotPassword({ email }) {
  const [rows] = await pool.query('SELECT id, name, email FROM users WHERE email = ? LIMIT 1', [email]);
  // Always respond successfully regardless of whether the email exists —
  // don't leak which emails are registered via response timing/content.
  // This is deliberate, not a bug: it's the same anti-enumeration
  // pattern every major site uses (Gmail, GitHub, etc. never confirm or
  // deny whether an email is registered from this endpoint).
  if (rows.length === 0) return;

  const user = rows[0];
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);

  await pool.query(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
    [uuidv4(), user.id, tokenHash],
  );

  await emailService.sendPasswordResetEmail(user, rawToken);
}

/**
 * Consumes the token from forgotPassword()'s email link. Doesn't require
 * the old password (the whole point of "forgot" password) — the token
 * itself, which only reached the real account owner's inbox, is the
 * proof of identity here.
 */
async function resetPassword({ token, newPassword }) {
  if (!token) throw ApiError.badRequest('Missing reset token');

  const tokenHash = hashToken(token);
  const [rows] = await pool.query(
    `SELECT * FROM password_reset_tokens
     WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash],
  );
  const resetToken = rows[0];
  if (!resetToken) {
    throw ApiError.badRequest('This reset link is invalid or has expired. Please request a new one.');
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, resetToken.user_id]);
  await pool.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = ?', [resetToken.id]);

  // Same reasoning as changePassword: a password reset should invalidate
  // every existing session, not just leave old refresh tokens usable.
  await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?', [resetToken.user_id]);
}

/**
 * Requires the user's CURRENT password before allowing a change — this
 * matters because the access token alone (e.g. a stolen/leftover session
 * on a shared device) shouldn't be enough to lock the real owner out by
 * changing their password.
 */
async function changePassword(userId, { currentPassword, newPassword }) {
  const [rows] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
  const user = rows[0];
  if (!user) throw ApiError.notFound('User not found');

  if (!user.password_hash) {
    throw ApiError.badRequest(
      'This account signed up via Google/Facebook and has no password to change.',
    );
  }

  const matches = await bcrypt.compare(currentPassword, user.password_hash);
  if (!matches) throw ApiError.unauthorized('Current password is incorrect');

  const newHash = await bcrypt.hash(newPassword, 10);
  await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, userId]);

  // Changing password revokes every existing session except the one making
  // this request — standard security practice (if someone else's device
  // had a valid refresh token, it stops working the moment you change
  // your password).
  await pool.query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = ?', [userId]);
}

/**
 * Permanent, self-service account deletion — required for App Store
 * review (Guideline 5.1.1(v): an app that supports account creation must
 * also let a user delete their account from within the app), and there
 * was previously no path to this at all, in-app or otherwise.
 *
 * A hard DELETE, not a deactivate/soft-delete: every table that
 * references users.id does so with ON DELETE CASCADE (businesses,
 * favorites, reviews, event_favorites, event_interests, refresh_tokens,
 * password_reset_tokens, notifications.target_user_id — see schema.sql),
 * so this one query is genuinely sufficient; there's no second pass of
 * manual cleanup needed. That cascade is also why the caller-facing
 * warning matters: for a business owner, this also deletes every
 * business they own (and, transitively, that business's events/reviews)
 * — not just their login. The mobile app surfaces that plainly before
 * calling this, rather than the API silently taking down someone's
 * listings as a side effect of "delete my account."
 *
 * Password-account holders must confirm their current password first —
 * same reasoning as changePassword: the access token alone (e.g. a
 * stolen/left-open session) shouldn't be enough to permanently destroy
 * the account. Social-login-only accounts (no password_hash) have
 * nothing to confirm, so requireAuth's live JWT is the only gate for them.
 */
async function deleteAccount(userId, { password } = {}) {
  const [rows] = await pool.query('SELECT password_hash FROM users WHERE id = ?', [userId]);
  const user = rows[0];
  if (!user) throw ApiError.notFound('User not found');

  if (user.password_hash) {
    if (!password) {
      throw ApiError.badRequest('Password is required to delete your account');
    }
    const matches = await bcrypt.compare(password, user.password_hash);
    if (!matches) throw ApiError.unauthorized('Incorrect password');
  }

  await pool.query('DELETE FROM users WHERE id = ?', [userId]);
}

/**
 * Owner-editable profile fields — deliberately excludes email (changing
 * email should go through a re-verification flow, not a plain PATCH) and
 * role (never client-settable).
 */
async function updateProfile(userId, { name, phone, profileImageUrl }) {
  const updates = [];
  const params = [];

  if (name !== undefined) {
    updates.push('name = ?');
    params.push(name);
  }
  if (phone !== undefined) {
    updates.push('phone = ?');
    params.push(phone);
  }
  if (profileImageUrl !== undefined) {
    updates.push('profile_image_url = ?');
    params.push(profileImageUrl);
  }

  if (updates.length > 0) {
    params.push(userId);
    await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  return getCurrentUser(userId);
}

module.exports = {
  requestSignupOtp,
  verifySignupOtp,
  login,
  loginWithGoogle,
  loginWithFacebook,
  refresh,
  logout,
  getCurrentUser,
  forgotPassword,
  resetPassword,
  changePassword,
  deleteAccount,
  updateProfile,
  toPublicUser,
};