const express = require('express');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const controller = require('./auth.controller');

const router = express.Router();

router.post(
  '/signup',
  [
    body('email').isEmail().withMessage('A valid email is required').normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('name').trim().notEmpty().withMessage('Name is required'),
  ],
  validate,
  controller.signup,
);

router.post(
  '/login',
  [
    body('email').isEmail().withMessage('A valid email is required').normalizeEmail(),
    body('password').notEmpty().withMessage('Password is required'),
  ],
  validate,
  controller.login,
);

router.post('/google', controller.loginWithGoogle);
router.post('/facebook', controller.loginWithFacebook);

router.post(
  '/refresh',
  [body('refreshToken').notEmpty().withMessage('Refresh token is required')],
  validate,
  controller.refresh,
);

router.post('/logout', controller.logout);

router.get('/me', requireAuth, controller.me);

router.patch(
  '/me',
  requireAuth,
  [
    body('name').optional().trim().notEmpty().withMessage('Name cannot be empty'),
    body('phone').optional().trim(),
    body('profileImageUrl').optional().isURL().withMessage('profileImageUrl must be a valid URL'),
  ],
  validate,
  controller.updateProfile,
);

router.post(
  '/change-password',
  requireAuth,
  [
    body('currentPassword').notEmpty().withMessage('Current password is required'),
    body('newPassword').isLength({ min: 6 }).withMessage('New password must be at least 6 characters'),
  ],
  validate,
  controller.changePassword,
);

router.post(
  '/forgot-password',
  [body('email').isEmail().withMessage('A valid email is required').normalizeEmail()],
  validate,
  controller.forgotPassword,
);

module.exports = router;
