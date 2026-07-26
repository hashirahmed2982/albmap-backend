const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../../config/db');
const env = require('../../config/env');
const ApiError = require('../../utils/ApiError');
const { signAccessToken, signRefreshToken, verifyRefreshToken, hashToken } = require('../../utils/jwt');

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
 * Verifies a Google ID token against Google's public keys and finds-or-
 * creates the corresponding user. Requires `google-auth-library` — add it
 * (`npm install google-auth-library`) and set GOOGLE_CLIENT_ID in .env
 * before this is production-ready; left as a clearly-marked stub so the
 * route shape is correct even before you wire up real verification.
 */
async function loginWithGoogle({ idToken }) {
  if (!idToken) {
    throw ApiError.badRequest('Missing Google ID token');
  }

  // TODO: replace with real verification:
  //   const { OAuth2Client } = require('google-auth-library');
  //   const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  //   const ticket = await client.verifyIdToken({ idToken, audience: process.env.GOOGLE_CLIENT_ID });
  //   const payload = ticket.getPayload(); // { email, name, picture, sub }
  throw ApiError.internal(
    'Google sign-in is not yet configured on the server — see auth.service.js loginWithGoogle() TODO',
  );
}

async function loginWithFacebook({ accessToken }) {
  if (!accessToken) {
    throw ApiError.badRequest('Missing Facebook access token');
  }
  // TODO: verify accessToken against Facebook's Graph API
  // (GET https://graph.facebook.com/me?fields=id,name,email&access_token=...)
  throw ApiError.internal(
    'Facebook sign-in is not yet configured on the server — see auth.service.js loginWithFacebook() TODO',
  );
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
  const [rows] = await pool.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email]);
  // Always respond successfully regardless of whether the email exists —
  // don't leak which emails are registered via response timing/content.
  if (rows.length === 0) return;

  const userId = rows[0].id;
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(rawToken);

  await pool.query(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
     VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
    [uuidv4(), userId, tokenHash],
  );

  // TODO: send an email containing a deep link like
  //   https://albmap.app/reset-password?token=${rawToken}
  // via your email provider of choice (SendGrid, SES, Postmark, etc).
  console.log(`[DEV ONLY] Password reset token for ${email}: ${rawToken}`);
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
  changePassword,
  updateProfile,
  toPublicUser,
};
