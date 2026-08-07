const express = require('express');
const controller = require('./content.controller');

// Public and unauthenticated on purpose — this is marketing/legal copy
// (About Us, social links, Privacy Policy, Terms & Conditions), not
// user data, and both the mobile app and website need to read it before
// a user is ever logged in (e.g. Terms & Conditions on the signup
// screen). Writing it is a separate, admin-only path — see
// PUT /admin/content/:key in modules/admin.
const router = express.Router();

router.get('/', controller.getContent);

module.exports = router;
