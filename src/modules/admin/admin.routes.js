const express = require('express');
const multer = require('multer');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const { requireAuth, requireRole } = require('../../middleware/auth');
const ApiError = require('../../utils/ApiError');
const controller = require('./admin.controller');

const router = express.Router();

// Every route in this file requires an authenticated admin — enforced once
// here rather than repeated on each route.
router.use(requireAuth, requireRole('admin'));

// Memory storage (not the shared disk-based `upload` middleware in
// middleware/upload.js, which is image-only and writes straight to
// env.uploads.dir) — a CSV import is parsed once into rows and never
// needs to persist as a file on disk, so buffering it in memory is
// simpler and avoids leaving stray upload artifacts around. 10MB is
// generous for a business-listing CSV.
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const isCsv = file.mimetype === 'text/csv' || file.originalname.toLowerCase().endsWith('.csv');
    if (!isCsv) return cb(ApiError.badRequest('Only .csv files are allowed'));
    cb(null, true);
  },
});

router.get('/dashboard', controller.getDashboardStats);

router.get('/businesses/pending', controller.getPendingBusinesses);
router.get('/businesses/export.csv', controller.exportBusinessesCsv);
router.get('/businesses', controller.getAllBusinesses);
router.patch(
  '/businesses/:id/review',
  [
    body('decision').isIn(['approved', 'rejected']).withMessage('decision must be approved or rejected'),
    // Only conditionally required (rejected, not approved) — express-
    // validator's declarative .if() is finicky against a sibling field's
    // exact value, so this checks it directly. admin.service.js's
    // reviewBusiness() enforces the same rule again regardless — this is
    // just what turns it into a clean 400 with a field-specific message
    // instead of a generic one.
    body('reason').custom((value, { req }) => {
      if (req.body.decision === 'rejected' && !value?.trim()) {
        throw new Error('A rejection reason is required');
      }
      return true;
    }),
  ],
  validate,
  controller.reviewBusiness,
);
router.patch(
  '/businesses/:id/active',
  [
    body('reason').custom((value, { req }) => {
      if (req.body.isActive === false && !value?.trim()) {
        throw new Error('A deactivation reason is required');
      }
      return true;
    }),
  ],
  validate,
  controller.setBusinessActive,
);
router.post('/businesses/import', csvUpload.single('file'), controller.importBusinessesCsv);

router.get('/users', controller.getAllUsers);
router.get('/users/export.csv', controller.exportUsersCsv);
router.patch(
  '/users/:id/active',
  [
    body('reason').custom((value, { req }) => {
      if (req.body.isActive === false && !value?.trim()) {
        throw new Error('A deactivation reason is required');
      }
      return true;
    }),
  ],
  validate,
  controller.setUserActive,
);

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
