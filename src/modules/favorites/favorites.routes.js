const express = require('express');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const controller = require('./favorites.controller');
const eventController = require('./event-favorites.controller');

const router = express.Router();

router.use(requireAuth); // every favorites route needs a real account — no guest favorites

router.get('/', controller.getMyFavorites);

router.post(
  '/',
  [body('businessId').notEmpty().withMessage('businessId is required')],
  validate,
  controller.addFavorite,
);

router.delete('/:businessId', controller.removeFavorite);

// Events favorites — see event-favorites.service.js. Distinct sub-path
// (rather than overloading the routes above with a businessId-or-eventId
// body) keeps the business-favorites contract above completely unchanged
// for existing clients.
router.get('/events', eventController.getMyFavorites);

router.post(
  '/events',
  [body('eventId').notEmpty().withMessage('eventId is required')],
  validate,
  eventController.addFavorite,
);

router.delete('/events/:eventId', eventController.removeFavorite);

module.exports = router;
