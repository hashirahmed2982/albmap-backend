const express = require('express');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const upload = require('../../middleware/upload');
const notificationController = require('../notifications/notification.controller');
const authService = require('../auth/auth.service');
const env = require('../../config/env');
const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');

const router = express.Router();

router.post(
  '/me/fcm-token',
  requireAuth,
  [body('fcmToken').notEmpty().withMessage('fcmToken is required')],
  validate,
  notificationController.updateFcmToken,
);

/**
 * Uploads the file AND updates users.profile_image_url in one step
 * (unlike /businesses/logo, which only uploads and returns a URL for the
 * caller to attach elsewhere) — a profile avatar has exactly one place it
 * ever gets used, so there's no reason to make the client do a separate
 * PATCH /auth/me afterward.
 */
router.post(
  '/me/avatar',
  requireAuth,
  upload.single('avatar'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('No file uploaded');
    const relativePath = `/${env.uploads.dir}/${req.file.filename}`;
    const user = await authService.updateProfile(req.user.id, { profileImageUrl: relativePath });
    res.status(201).json(user);
  }),
);

module.exports = router;
