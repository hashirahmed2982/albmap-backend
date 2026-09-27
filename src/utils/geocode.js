const env = require('../config/env');

/**
 * Geocoding via Google's Geocoding API — used only by
 * business-import.service.js: the CSV import's rows have a street address
 * but no coordinates, and `businesses.latitude`/`longitude` are NOT NULL.
 *
 * Was Nominatim (OpenStreetMap), which is free but hard-caps requests at
 * 1/second by usage policy — for a 2,600-row import that's 45+ minutes
 * minimum, run synchronously inside one HTTP request, with a real risk of
 * a reverse proxy or the admin portal's own client timing it out partway
 * through. Google's Geocoding API has no such artificial throttle (order
 * of 50 req/sec), so a same-size import finishes in a couple of minutes
 * instead — the same app is already on Google Maps everywhere else
 * (mobile, website), so this isn't introducing a new provider, just using
 * it server-side too. Requires GOOGLE_MAPS_GEOCODING_API_KEY — see
 * env.js's comment for why this has to be a separate key from the
 * Android/iOS Maps SDK ones already in the app.
 */
const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

async function geocodeQuery(query) {
  if (!query) return null;
  if (!env.googleMaps.apiKey) {
    throw new Error('Geocoding is not configured on the server (GOOGLE_MAPS_GEOCODING_API_KEY unset)');
  }
  try {
    const url = `${GOOGLE_GEOCODE_URL}?address=${encodeURIComponent(query)}&key=${env.googleMaps.apiKey}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    const data = await response.json();
    // ZERO_RESULTS (nothing found) is expected and common — falls through
    // to the coarse fallback below like any other "couldn't place this"
    // outcome. OVER_QUERY_LIMIT/REQUEST_DENIED/INVALID_REQUEST are real
    // configuration/quota problems, but still treated as "couldn't
    // geocode this row" rather than crashing the whole import — the
    // per-row failure (see business-import.service.js's importRow) is
    // how that surfaces back to the admin.
    if (data.status !== 'OK') return null;
    const location = data.results?.[0]?.geometry?.location;
    if (!location || typeof location.lat !== 'number' || typeof location.lng !== 'number') return null;
    return { latitude: location.lat, longitude: location.lng };
  } catch {
    // A geocoding failure (network hiccup, Google API down, malformed
    // response) should never crash the import — the caller treats a
    // null result as "couldn't place this one," not a fatal error.
    return null;
  }
}

/**
 * Tries the full street address first; if that doesn't resolve to
 * anything (a typo, an address too specific/new for Google's index),
 * falls back to just city + country — a rough city-center pin beats no
 * pin at all for a business whose owner can drag it to the right spot
 * afterward via the existing "pick location on map" editor (same one
 * Add/Edit Business already uses).
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
