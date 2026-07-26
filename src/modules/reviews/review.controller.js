const asyncHandler = require('../../utils/asyncHandler');
const reviewService = require('./review.service');

const getBusinessReviews = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const reviews = await reviewService.getBusinessReviews(req.params.id, { page, limit });
  res.json({ data: reviews });
});

const submitReview = asyncHandler(async (req, res) => {
  const { rating, comment } = req.body;
  const review = await reviewService.submitReview(req.params.id, req.user.id, { rating, comment });
  res.status(201).json(review);
});

const deleteReview = asyncHandler(async (req, res) => {
  await reviewService.deleteReview(req.params.id, req.user.id);
  res.status(204).send();
});

module.exports = { getBusinessReviews, submitReview, deleteReview };
