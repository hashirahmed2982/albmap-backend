const express = require('express');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const { requireAuth, requireRole } = require('../../middleware/auth');
const controller = require('./admin.controller');

const router = express.Router();

// Every route in this file requires an authenticated admin — enforced once
// here rather than repeated on each route.
router.use(requireAuth, requireRole('admin'));

router.get('/dashboard', controller.getDashboardStats);

router.get('/businesses/pending', controller.getPendingBusinesses);
router.get('/businesses', controller.getAllBusinesses);
router.patch(
  '/businesses/:id/review',
  [body('decision').isIn(['approved', 'rejected']).withMessage('decision must be approved or rejected')],
  validate,
  controller.reviewBusiness,
);
router.patch('/businesses/:id/active', controller.setBusinessActive);

router.get('/users', controller.getAllUsers);
router.patch('/users/:id/active', controller.setUserActive);

router.get('/events', controller.getAllEvents);
router.patch('/events/:id/active', controller.setEventActive);

router.get('/admins', controller.getAllAdmins);
router.post(
  '/admins',
  [
    body('email').isEmail().withMessage('A valid email is required').normalizeEmail(),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    body('name').trim().notEmpty().withMessage('Name is required'),
  ],
  validate,
  controller.createAdmin,
);
router.delete('/admins/:id', controller.deleteAdmin);

router.get('/categories', controller.getAllCategories);
router.post(
  '/categories',
  [
    body('name').trim().notEmpty().withMessage('Category name is required'),
    body('sortOrder').optional().isInt().withMessage('sortOrder must be an integer'),
  ],
  validate,
  controller.createCategory,
);
router.patch(
  '/categories/:id',
  [
    body('name').optional().trim().notEmpty().withMessage('Category name cannot be empty'),
    body('sortOrder').optional().isInt().withMessage('sortOrder must be an integer'),
  ],
  validate,
  controller.updateCategory,
);
router.delete('/categories/:id', controller.deleteCategory);

router.get('/notifications/pending', controller.getPendingBroadcasts);
router.get('/notifications', controller.getAllBroadcasts);
router.patch(
  '/notifications/:id/review',
  [body('decision').isIn(['approved', 'rejected']).withMessage('decision must be approved or rejected')],
  validate,
  controller.reviewBroadcast,
);

// Shape validation beyond "is it JSON" happens in content.service.js's
// validateShape — it differs per key (about_us needs 5 required strings,
// privacy_policy/terms_conditions need a title + sections array, etc.),
// so it isn't worth expressing again here as express-validator rules.
router.put('/content/:key', controller.updateContent);

module.exports = router;
