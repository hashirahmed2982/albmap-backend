/**
 * Wraps an async route handler so rejected promises are forwarded to
 * Express's error-handling middleware automatically, instead of every
 * controller needing its own try/catch + next(err) boilerplate.
 *
 * Usage: router.get('/x', asyncHandler(async (req, res) => { ... }))
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = asyncHandler;
