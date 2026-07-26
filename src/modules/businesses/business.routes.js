const express = require('express');
const { body } = require('express-validator');
const validate = require('../../middleware/validate');
const { requireAuth, optionalAuth } = require('../../middleware/auth');
const upload = require('../../middleware/upload');
const controller = require('./business.controller');

const router = express.Router();

// optionalAuth (not requireAuth): guests can browse the public feed with no
// token at all; the controller only requires req.user when ?ownerId= is
// passed (the "my businesses" case) — see business.controller.js.
router.get('/', optionalAuth, controller.getBusinesses);

router.get('/search', controller.searchBusinesses);

router.get('/:id', controller.getBusinessById);

router.post(
  '/',
  requireAuth,
  [
    body('name').trim().notEmpty().withMessage('Business name is required'),
    body('category').trim().notEmpty().withMessage('Category is required'),
    body('streetAddress').trim().notEmpty().withMessage('Street address is required'),
    body('city').trim().notEmpty().withMessage('City is required'),
    body('postalCode').trim().notEmpty().withMessage('Postal code is required'),
    body('country').optional().trim().notEmpty().withMessage('Country cannot be empty'),
    body('latitude').isFloat().withMessage('Valid latitude is required'),
    body('longitude').isFloat().withMessage('Valid longitude is required'),
    body('whatsappNumber').optional({ nullable: true }).trim(),
  ],
  validate,
  controller.submitBusiness,
);

router.patch('/:id', requireAuth, controller.updateOwnBusiness);

router.post('/logo', requireAuth, upload.single('logo'), controller.uploadLogo);

module.exports = router;
