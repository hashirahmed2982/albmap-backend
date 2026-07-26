const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const controller = require('./analytics.controller');

// Mounted at /businesses/:id/analytics — see routes/index.js
const router = express.Router({ mergeParams: true });

router.get('/', requireAuth, controller.getBusinessAnalytics);
router.post('/event', controller.recordEvent); // no auth: any visitor's tap counts

module.exports = router;
