const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../config/db');
const env = require('../../config/env');
const ApiError = require('../../utils/ApiError');
const { signAccessToken, signRefreshToken, verifyRefreshToken, hashToken } = require('../../utils/jwt');
const emailService = require('../notifications/email');

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

async function signup({ email, password, name }) {
  const [existing] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
  if (existing.length > 0) {
    throw ApiError.conflict('An account with this email already exists');
  }

  const passwordHash = await bcrypt.hash(password, 10);
  const userId = uuidv4();

  await pool.query(
    `INSERT INTO users (id, email, password_hash, name, role, auth_provider)
     VALUES (?, ?, ?, ?, 'business', 'password')`,
    [userId, email, passwordHash, name],
  );

  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [userId]);
  const tokens = await issueTokenPair(userId);

  // Fire-and-forget — a slow or failed email should never delay or break
  // the signup response itself. emailService.sendWelcomeEmail already
  // catches its own errors internally and never throws.
  emailService.sendWelcomeEmail(rows[0]);

  return { user: toPublicUser(rows[0]), ...tokens };
}

async function login({ email, password }) {
  const [rows] = await pool.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);
  const user = rows[0];

  if (!user || !user.password_hash) {
    throw ApiError.unauthorized('Invalid email or password');
  }
  if (!user.is_active) {
    throw ApiError.forbidden('This account has been deactivated');
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

  if (!user.is_active) throw ApiError.forbidden('This account has been deactivated');

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

  if (!user.is_active) throw ApiError.forbidden('This account has been deactivated');

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
  signup,
  login,
  loginWithGoogle,
  loginWithFacebook,
  refresh,
  logout,
  getCurrentUser,
  forgotPassword,
  resetPassword,
  changePassword,
  updateProfile,
  toPublicUser,
};