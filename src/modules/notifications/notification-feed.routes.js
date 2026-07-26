const express = require('express');
const { requireAuth } = require('../../middleware/auth');
const controller = require('./notification.controller');

// Mounted at /notifications (top-level, not nested under a business) —
// this is every user's own view of the shared, approved notification
// feed, not scoped to any particular business.
const router = express.Router();

router.use(requireAuth);

router.get('/', controller.getFeed);
router.post('/:id/read', controller.markAsRead);
router.post('/read-all', controller.markAllAsRead);

module.exports = router;
