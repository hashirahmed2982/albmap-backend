const express = require('express');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const { requireAuth } = require('../../middleware/auth');
const controller = require('./favorites.controller');

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

module.exports = router;
