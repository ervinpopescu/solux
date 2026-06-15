// ==============================================================================
// Horizon profile construction
// ==============================================================================
//
// Convert a list of `Building` records into a `HorizonProfile`: a 360-element
// array where each entry is the maximum sun-altitude angle (in radians)
// obstructed by surrounding structures at that compass azimuth from the
// pin's eye position.
//
// Algorithm:
//
//   For every vertex of every building:
//     1. Compute great-circle distance and initial bearing from the pin.
//     2. Subtract the observer's eye height from the building's height —
//        a 1.7 m eye doesn't need the sun to clear the BASE of a roof, it
//        needs to clear the top minus the standing-height baseline.
//     3. Altitude angle = atan(effective_height / distance).
//     4. Record max(existing, altitude) at the azimuth bucket.
//
// We process polygon VERTICES, not entire silhouettes — this slightly
// underestimates obstruction for buildings with very long edges (a wall
// 50 m wide directly to the west might only obstruct two azimuth degrees
// using vertex sampling). For Solux's use case (city-scale sun timing) the
// approximation is good enough; the densest skylines (e.g. NYC midtown)
// have buildings with closely-spaced footprint vertices in OSM, which keeps
// the profile well-sampled in practice.
//
// We deliberately do NOT smooth or interpolate across buckets here: leaving
// the per-vertex max gives the rendered profile a slightly jagged edge that
// matches reality (real building skylines are jagged). The effective-time
// search uses linear interpolation between buckets to soften this.

import type { Building, HorizonProfile, LatLng } from '../types';
import { bearingDeg, distanceMetres } from './geo';

/** Standing eye-height of an observer at the pin, in metres. */
const EYE_HEIGHT_M = 1.7;

/**
 * Build a 360-bucket obstruction profile from a list of buildings.
 *
 * @param pin       The observer location.
 * @param buildings Buildings within the chosen radius.
 * @param radiusM   Radius the buildings were fetched from, recorded for UI.
 * @param centerLat Centre lat used for caching (may be grid-rounded).
 * @param centerLng Centre lng used for caching.
 */
export function buildHorizonProfile(
  pin: LatLng,
  buildings: Building[],
  radiusM: number,
  centerLat: number,
  centerLng: number,
): HorizonProfile {
  const buckets = new Float32Array(360);

  for (const b of buildings) {
    // Effective height = how far the roof rises above eye level. Treat any
    // building shorter than eye level as "no obstruction" — we'd just see
    // over it.
    const dh = b.heightMeters - EYE_HEIGHT_M;
    if (dh <= 0) continue;

    for (const vertex of b.geometry) {
      const d = distanceMetres(pin, vertex);
      if (d < 1) continue; // ignore vertices on top of the pin
      const altRad = Math.atan2(dh, d);
      const azim = bearingDeg(pin, vertex);
      const i = Math.floor(azim) % 360;
      if (altRad > buckets[i]) buckets[i] = altRad;
    }
  }

  return {
    bucketsRad: buckets,
    buildingCount: buildings.length,
    radiusMeters: radiusM,
    centerLat,
    centerLng,
    fetchedAt: Date.now(),
  };
}

/**
 * Sample the profile at an arbitrary azimuth (radians, north = 0, clockwise
 * positive). Linearly interpolates between the two adjacent 1° buckets so
 * the effective-time search has a continuous function to walk over.
 */
export function obstructionAt(profile: HorizonProfile, azimuthRad: number): number {
  const azDeg = ((azimuthRad * 180) / Math.PI + 360) % 360;
  const i = Math.floor(azDeg);
  const next = (i + 1) % 360;
  const t = azDeg - i;
  return profile.bucketsRad[i] * (1 - t) + profile.bucketsRad[next] * t;
}

/**
 * Find the azimuth (degrees) and altitude (degrees) of the tallest
 * obstruction recorded in the profile. Useful for the UI's "tallest
 * obstruction is to the west at 12.3°" caption.
 *
 * Returns `null` for an entirely empty horizon (no nearby buildings or
 * everything below eye level).
 */
export function tallestObstruction(
  profile: HorizonProfile,
): { azimuthDeg: number; altitudeDeg: number } | null {
  let maxAlt = 0;
  let maxAz = -1;
  for (let i = 0; i < 360; i++) {
    if (profile.bucketsRad[i] > maxAlt) {
      maxAlt = profile.bucketsRad[i];
      maxAz = i;
    }
  }
  if (maxAz < 0) return null;
  return { azimuthDeg: maxAz, altitudeDeg: (maxAlt * 180) / Math.PI };
}
