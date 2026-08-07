const asyncHandler = require('../../utils/asyncHandler');
const eventFavoritesService = require('./event-favorites.service');

const addFavorite = asyncHandler(async (req, res) => {
  await eventFavoritesService.addFavorite(req.user.id, req.body.eventId);
  res.status(204).send();
});

const removeFavorite = asyncHandler(async (req, res) => {
  await eventFavoritesService.removeFavorite(req.user.id, req.params.eventId);
  res.status(204).send();
});

const getMyFavorites = asyncHandler(async (req, res) => {
  const favorites = await eventFavoritesService.getMyFavorites(req.user.id);
  res.json({ data: favorites });
});

module.exports = { addFavorite, removeFavorite, getMyFavorites };
