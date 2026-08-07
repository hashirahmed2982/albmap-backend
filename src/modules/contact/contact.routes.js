const express = require('express');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const asyncHandler = require('../../utils/asyncHandler');
const emailService = require('../notifications/email');

const router = express.Router();

/**
 * Public — no auth required, matches the website's Contact Us form being
 * usable by anyone, not just signed-in users. Sends via SMTP to
 * ADMIN_NOTIFICATION_EMAIL rather than opening the visitor's own mail
 * client, so submissions are guaranteed to actually reach someone
 * instead of depending on the visitor having a configured mail app.
 */
router.post(
  '/',
  [
    body('name').trim().notEmpty().isLength({ max: 150 }).withMessage('Name is required'),
    body('email').isEmail().withMessage('A valid email is required').normalizeEmail(),
    body('inquiryType').trim().notEmpty().withMessage('Inquiry type is required'),
    body('message').trim().notEmpty().isLength({ max: 2000 }).withMessage('Message is required (max 2000 chars)'),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { name, email, inquiryType, message } = req.body;
    const result = await emailService.sendContactFormEmail({ name, email, inquiryType, message });
    res.status(201).json({ message: 'Message sent.', delivered: result.sent });
  }),
);

module.exports = router;
