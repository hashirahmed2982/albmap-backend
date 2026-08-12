const express = require('express');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const { requireAuth, optionalAuth } = require('../../middleware/auth');
const upload = require('../../middleware/upload');
const env = require('../../config/env');
const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');
const controller = require('./event.controller');

const router = express.Router();

// optionalAuth (not requireAuth): browsing events never requires login,
// but a logged-in caller gets `isInterested` computed for them on each
// event — see event.service.js's getEvents/getEventById. The controller
// only requires req.user when ?ownerId= is passed (the "my events" case),
// same split as GET /businesses.
router.get('/', optionalAuth, controller.getEvents);
router.get('/:id', optionalAuth, controller.getEventById);

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

router.patch(
  '/:id',
  requireAuth,
  [
    body('startTime').optional().isISO8601().withMessage('Valid startTime is required'),
    body('endTime').optional().isISO8601().withMessage('Valid endTime is required'),
  ],
  validate,
  controller.updateEvent,
);

// "I'm interested" / RSVP toggle — see event.service.js's addInterest/
// removeInterest and the event_interests table (schema.sql).
router.post('/:id/interest', requireAuth, controller.addInterest);
router.delete('/:id/interest', requireAuth, controller.removeInterest);

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
