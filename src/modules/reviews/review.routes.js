const express = require('express');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const controller = require('./review.controller');

// Mounted at /businesses/:id/reviews — see routes/index.js
const router = express.Router({ mergeParams: true });

router.get('/', controller.getBusinessReviews);

router.post(
  '/',
  requireAuth,
  [
    body('rating').isInt({ min: 1, max: 5 }).withMessage('Rating must be between 1 and 5'),
    body('comment').optional().isLength({ max: 1000 }).withMessage('Comment is too long'),
  ],
  validate,
  controller.submitReview,
);

router.delete('/', requireAuth, controller.deleteReview);

module.exports = router;
