const { validationResult } = require('express-validator');
const ApiError = require('../utils/ApiError');

/**
 * Place after express-validator's check(...) chains in a route definition.
 * Collects validation errors and throws a single readable ApiError instead
 * of each route hand-rolling its own validation-check boilerplate.
 */
function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const firstError = errors.array()[0];
    return next(ApiError.badRequest(firstError.msg));
  }
  next();
}

module.exports = validate;
