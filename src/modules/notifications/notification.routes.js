const express = require('express');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const controller = require('./notification.controller');

// Mounted at /businesses/:id/broadcast — see routes/index.js
const router = express.Router({ mergeParams: true });

router.post(
  '/',
  requireAuth,
  [
    body('title').trim().notEmpty().isLength({ max: 150 }).withMessage('Title is required (max 150 chars)'),
    body('body').trim().notEmpty().isLength({ max: 500 }).withMessage('Message is required (max 500 chars)'),
  ],
  validate,
  controller.submitBroadcast,
);

module.exports = router;
