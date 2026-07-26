const ApiError = require('../utils/ApiError');
const { verifyAccessToken } = require('../utils/jwt');
const { pool } = require('../config/db');

/**
 * Verifies the Bearer access token and attaches { id, email, role } to
 * req.user. This matches exactly what the Flutter app's DioClient sends —
 * see lib/core/network/dio_client.dart's onRequest interceptor.
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!token) {
      throw ApiError.unauthorized('Missing access token');
    }

    let decoded;
    try {
      decoded = verifyAccessToken(token);
    } catch (err) {
      // Distinguishing expired-vs-invalid isn't necessary here: either way
      // the mobile app's DioClient interceptor will attempt a silent
      // refresh on any 401, so a generic message is fine.
      throw ApiError.unauthorized('Invalid or expired access token');
    }

    const [rows] = await pool.query(
      'SELECT id, email, role, is_active FROM users WHERE id = ? LIMIT 1',
      [decoded.sub],
    );
    const user = rows[0];
    if (!user || !user.is_active) {
      throw ApiError.unauthorized('Account not found or deactivated');
    }

    req.user = { id: user.id, email: user.email, role: user.role };
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Use after requireAuth. Restricts a route to one or more roles, e.g.
 * router.patch('/admin/x', requireAuth, requireRole('admin'), handler)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(ApiError.forbidden('You do not have permission to perform this action'));
    }
    next();
  };
}

/**
 * Like requireAuth, but doesn't fail if there's no token — just leaves
 * req.user undefined. Useful for endpoints that behave differently for
 * logged-in vs anonymous/guest callers (e.g. business details showing a
 * favorite state only when authenticated) without hard-requiring login.
 */
async function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return next();

  try {
    const decoded = verifyAccessToken(token);
    const [rows] = await pool.query(
      'SELECT id, email, role, is_active FROM users WHERE id = ? LIMIT 1',
      [decoded.sub],
    );
    const user = rows[0];
    if (user && user.is_active) {
      req.user = { id: user.id, email: user.email, role: user.role };
    }
  } catch (err) {
    // Invalid/expired token on an optional route — just proceed as anonymous.
  }
  next();
}

module.exports = { requireAuth, requireRole, optionalAuth };
