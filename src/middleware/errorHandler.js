const env = require('../config/env');

/**
 * Must be registered LAST, after all routes. Shapes every error — whether
 * a deliberate ApiError or an unexpected exception — into the same
 * { message } JSON shape the mobile app's ServerException/AuthException
 * parsing expects (see the Flutter app's remote datasource files, which
 * read e.response?.data?['message']).
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const statusCode = err.isApiError ? err.statusCode : 500;
  const message = err.isApiError ? err.message : 'Something went wrong on the server.';

  if (statusCode >= 500) {
    // Log full detail server-side; never leak stack traces to the client.
    console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}:`, err);
  }

  const body = { message };
  // Some ApiErrors attach extra structured context (e.g. duplicate-business
  // details) beyond a plain message — pass it through if present, so the
  // client can render something more specific than just the text.
  if (err.duplicate) body.duplicate = err.duplicate;
  if (!env.isProduction && statusCode >= 500) {
    body.stack = err.stack;
  }

  res.status(statusCode).json(body);
}

function notFoundHandler(req, res) {
  res.status(404).json({ message: `No route: ${req.method} ${req.originalUrl}` });
}

module.exports = { errorHandler, notFoundHandler };
