const express = require('express');
const asyncHandler = require('../../utils/asyncHandler');
const categoryService = require('./category.service');

const router = express.Router();

// Public, unauthenticated — used by the mobile app's category picker.
// Admin management (create/edit/delete) lives under the already-
// protected /admin router instead (see admin.routes.js) rather than
// adding auth middleware to individual routes here — one consistent,
// already-audited admin gate, not two.
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const categories = await categoryService.getPublicCategories();
    res.json({ data: categories });
  }),
);

module.exports = router;
