const express = require('express');

const authRoutes = require('../modules/auth/auth.routes');
const businessRoutes = require('../modules/businesses/business.routes');
const eventRoutes = require('../modules/events/event.routes');
const analyticsRoutes = require('../modules/analytics/analytics.routes');
const notificationRoutes = require('../modules/notifications/notification.routes');
const notificationFeedRoutes = require('../modules/notifications/notification-feed.routes');
const reviewRoutes = require('../modules/reviews/review.routes');
const adminRoutes = require('../modules/admin/admin.routes');
const categoryRoutes = require('../modules/categories/category.routes');
const userRoutes = require('../modules/users/user.routes');
const favoritesRoutes = require('../modules/favorites/favorites.routes');
const contactRoutes = require('../modules/contact/contact.routes');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/businesses', businessRoutes);
// Nested under /businesses/:id/... — mergeParams:true on these lets them
// read req.params.id from the parent mount.
router.use('/businesses/:id/analytics', analyticsRoutes);
router.use('/businesses/:id/broadcast', notificationRoutes);
router.use('/notifications', notificationFeedRoutes);
router.use('/businesses/:id/reviews', reviewRoutes);
router.use('/events', eventRoutes);
router.use('/categories', categoryRoutes);
router.use('/users', userRoutes);
router.use('/favorites', favoritesRoutes);
router.use('/contact', contactRoutes);
router.use('/admin', adminRoutes);

module.exports = router;
