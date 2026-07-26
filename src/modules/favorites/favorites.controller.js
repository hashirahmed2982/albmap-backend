const asyncHandler = require('../../utils/asyncHandler');
const favoritesService = require('./favorites.service');

const addFavorite = asyncHandler(async (req, res) => {
  await favoritesService.addFavorite(req.user.id, req.body.businessId);
  res.status(204).send();
});

const removeFavorite = asyncHandler(async (req, res) => {
  await favoritesService.removeFavorite(req.user.id, req.params.businessId);
  res.status(204).send();
});

const getMyFavorites = asyncHandler(async (req, res) => {
  const favorites = await favoritesService.getMyFavorites(req.user.id);
  res.json({ data: favorites });
});

module.exports = { addFavorite, removeFavorite, getMyFavorites };
