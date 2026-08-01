/**
 * Geolocation helpers for workplace proximity.
 *
 * Design stance, and say this in the pitch: GPS is CORROBORATION, not proof.
 * It can be spoofed by anyone motivated enough. What makes a location record
 * credible is consistency across many entries over time, not any single point.
 *
 * Consequences that are deliberate, not oversights:
 *   - Off-site entries are FLAGGED, never BLOCKED. GPS accuracy varies wildly
 *     (indoors, urban canyons, cheap phones). Silently rejecting edge cases
 *     would break legitimate use and would break the live demo.
 *   - GPS is OPTIONAL per shift. Delivery, care work, construction, and
 *     agriculture are among the most wage-theft-affected occupations and have
 *     no fixed worksite. An app that requires a geofence excludes them.
 */

const EARTH_RADIUS_M = 6_371_000;

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two points, in metres.
 * Haversine -- accurate to ~0.5%, far tighter than consumer GPS error.
 */
export function haversineMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Default geofence radius. Generous on purpose: consumer GPS is routinely
 * 20-50m off, worse indoors, and a large worksite (warehouse, campus, job
 * site) can span hundreds of metres on its own.
 */
export const DEFAULT_GEOFENCE_M = 200;

/**
 * Finds the closest saved workplace to a reading.
 *
 * @param {{lat:number,lng:number}} point
 * @param {Array<{id:number,label:string,lat:number,lng:number}>} workplaces
 * @param {number} radiusM
 * @returns {{workplaceId:number|null, label:string|null, distanceM:number|null, offsiteFlag:boolean}}
 */
export function nearestWorkplace(point, workplaces, radiusM = DEFAULT_GEOFENCE_M) {
  if (!point || typeof point.lat !== 'number' || typeof point.lng !== 'number') {
    // No GPS supplied. Not off-site -- simply unknown. A shift with no location
    // is perfectly valid; it just carries no locational corroboration.
    return { workplaceId: null, label: null, distanceM: null, offsiteFlag: false };
  }

  const located = (workplaces || []).filter(
    (w) => typeof w.lat === 'number' && typeof w.lng === 'number'
  );

  if (located.length === 0) {
    return { workplaceId: null, label: null, distanceM: null, offsiteFlag: false };
  }

  let best = null;
  for (const w of located) {
    const d = haversineMeters(point.lat, point.lng, w.lat, w.lng);
    if (best === null || d < best.distanceM) {
      best = { workplaceId: w.id, label: w.label, distanceM: d };
    }
  }

  return {
    ...best,
    distanceM: Math.round(best.distanceM),
    offsiteFlag: best.distanceM > radiusM,
  };
}
