/**
 * Free geocoding via OpenStreetMap's Nominatim — the same map-tile
 * provider the mobile app already points at with no separate API key
 * (see AppConstants.mapTileUrlTemplate), so this needs no new account or
 * credential either. Used only by business-import.service.js: the CSV
 * import's rows have a street address but no coordinates, and
 * `businesses.latitude`/`longitude` are NOT NULL.
 *
 * Nominatim's usage policy caps requests at 1/second and requires a
 * descriptive User-Agent identifying the calling app — both enforced
 * here so a bulk import doesn't get rate-limited or IP-blocked partway
 * through a large CSV.
 */
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'AlbMap-AdminImport/1.0 (business CSV import; see albmap-backend)';
const MIN_REQUEST_INTERVAL_MS = 1100; // just over 1/sec, with margin

let lastRequestAt = 0;

async function throttle() {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed));
  }
  lastRequestAt = Date.now();
}

async function geocodeQuery(query) {
  if (!query) return null;
  await throttle();
  try {
    const url = `${NOMINATIM_URL}?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    if (!response.ok) return null;
    const results = await response.json();
    const first = results[0];
    if (!first) return null;
    const latitude = parseFloat(first.lat);
    const longitude = parseFloat(first.lon);
    if (Number.isNaN(latitude) || Number.isNaN(longitude)) return null;
    return { latitude, longitude };
  } catch {
    // A geocoding failure (network hiccup, Nominatim down, malformed
    // response) should never crash the import — the caller treats a
    // null result as "couldn't place this one," not a fatal error.
    return null;
  }
}

/**
 * Tries the full street address first; if that doesn't resolve to
 * anything (a typo, a too-specific address Nominatim's free index
 * doesn't have), falls back to just city + country — a rough city-center
 * pin beats no pin at all for a business whose owner can drag it to the
 * right spot afterward via the existing "pick location on map" editor
 * (same one Add/Edit Business already uses).
 */
async function geocodeAddress({ streetAddress, postalCode, city, country }) {
  const fullQuery = [streetAddress, postalCode, city, country].filter(Boolean).join(', ');
  const precise = await geocodeQuery(fullQuery);
  if (precise) return precise;

  const coarseQuery = [city, country].filter(Boolean).join(', ');
  if (coarseQuery === fullQuery) return null; // nothing left to fall back to
  return geocodeQuery(coarseQuery);
}

module.exports = { geocodeAddress };
