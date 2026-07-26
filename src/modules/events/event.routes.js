const express = require('express');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const upload = require('../../middleware/upload');
const env = require('../../config/env');
const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');
const controller = require('./event.controller');

const router = express.Router();

router.get('/', controller.getEvents);
router.get('/:id', controller.getEventById);

router.post(
  '/',
  requireAuth,
  [
    body('businessId').notEmpty().withMessage('businessId is required'),
    body('name').trim().notEmpty().withMessage('Event name is required'),
    body('startTime').isISO8601().withMessage('Valid startTime is required'),
    body('endTime').isISO8601().withMessage('Valid endTime is required'),
  ],
  validate,
  controller.createEvent,
);

/**
 * Pre-upload pattern, same as POST /businesses/logo: upload the poster
 * first, get back a URL, then include that URL as `imageUrl` in the
 * POST /events body. Kept as a separate step (rather than one combined
 * multipart request) so the same upload middleware/flow is reusable
 * across businesses/events/avatars without three different request shapes.
 */
router.post(
  '/image',
  requireAuth,
  upload.single('image'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('No file uploaded');
    const relativePath = `/${env.uploads.dir}/${req.file.filename}`;
    res.status(201).json({ url: relativePath });
  }),
);

module.exports = router;
