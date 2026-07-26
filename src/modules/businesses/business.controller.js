const asyncHandler = require('../../utils/asyncHandler');
const ApiError = require('../../utils/ApiError');
const businessService = require('./business.service');
const env = require('../../config/env');

/**
 * GET /businesses serves two distinct purposes depending on query params,
 * matching exactly how the Flutter app calls it (see
 * business_remote_datasource.dart — getBusinesses() and getMyBusinesses()
 * both hit this same path):
 *
 * - No `ownerId` param → public discovery feed. Approved + active only,
 *   paginated (`page`/`limit` query params, defaults 1/20).
 * - `ownerId` param present → "my businesses," ALL statuses. Requires the
 *   caller to be authenticated AND to be requesting their own id.
 */
const getBusinesses = asyncHandler(async (req, res) => {
  const { category, sortBy, lat, lng, radiusKm, ownerId, page, limit } = req.query;

  if (ownerId) {
    if (!req.user) {
      throw ApiError.unauthorized('Login required to view your businesses');
    }
    if (ownerId !== req.user.id) {
      throw ApiError.forbidden('You can only view your own businesses');
    }
    const businesses = await businessService.getMyBusinesses(req.user.id);
    return res.json({ data: businesses });
  }

  const { businesses, pagination } = await businessService.getBusinesses({
    category,
    sortBy,
    userLat: lat ? parseFloat(lat) : null,
    userLng: lng ? parseFloat(lng) : null,
    radiusKm: radiusKm ? parseFloat(radiusKm) : null,
    page,
    limit,
  });
  res.json({ data: businesses, pagination });
});

const getBusinessById = asyncHandler(async (req, res) => {
  const business = await businessService.getBusinessById(req.params.id);
  res.json(business);
});

const searchBusinesses = asyncHandler(async (req, res) => {
  const { q, page, limit } = req.query;
  if (!q || q.trim().length < 1) {
    return res.json({ data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
  }
  const { businesses, pagination } = await businessService.searchBusinesses(q.trim(), { page, limit });
  res.json({ data: businesses, pagination });
});

const submitBusiness = asyncHandler(async (req, res) => {
  const business = await businessService.submitBusiness(req.user.id, req.body);
  res.status(201).json(business);
});

const updateOwnBusiness = asyncHandler(async (req, res) => {
  const business = await businessService.updateOwnBusiness(req.params.id, req.user.id, req.body);
  res.json(business);
});

const uploadLogo = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('No file uploaded');
  // Relative path, not an absolute URL — see docs/MEDIA_URLS.md. Storing
  // "/uploads/xxx.png" instead of "https://some-host/uploads/xxx.png"
  // means this never goes stale when the backend's externally-reachable
  // address changes (a new ngrok tunnel, a server migration, etc) —
  // clients resolve it against whatever base URL they're currently
  // configured with, at display time, not at upload time.
  const relativePath = `/${env.uploads.dir}/${req.file.filename}`;
  res.status(201).json({ url: relativePath });
});

module.exports = {
  getBusinesses,
  getBusinessById,
  searchBusinesses,
  submitBusiness,
  updateOwnBusiness,
  uploadLogo,
};
