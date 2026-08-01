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
//   For every EDGE of every building, walk points along the edge and for each:
//     1. Compute great-circle distance and initial bearing from the pin.
//     2. Subtract the observer's eye height from the building's height —
//        a 1.7 m eye doesn't need the sun to clear the BASE of a roof, it
//        needs to clear the top minus the standing-height baseline.
//     3. Altitude angle = atan(effective_height / distance).
//     4. Record max(existing, altitude) at the azimuth bucket.
//
// We sample EDGES, not just vertices. A large flat-roofed building is a few
// corner vertices joined by long walls; sampling only the vertices leaves the
// wall spans between them empty, so a wide building directly toward the sun
// registers no obstruction across most of its azimuth range. That produced a
// visible inconsistency: the ground-shadow layer (which projects the whole
// footprint) would darken the pin while this profile still reported "in sun".
// Walking points along each edge closes that gap — every azimuth bucket the
// wall spans gets the obstruction of the nearest wall point — so the badge and
// the rendered shadows agree. The step is a few metres, capped per edge to
// bound work on pathologically detailed footprints.
//
// We deliberately do NOT smooth or interpolate across buckets here: leaving
// the per-sample max gives the profile a slightly jagged edge that matches
// reality (real building skylines are jagged). The effective-time search uses
// linear interpolation between buckets to soften this.

import type { Obstruction, HorizonProfile, LatLng } from '../types';
import { bearingDeg, distanceMetres } from './geo';

/**
 * Ray-casting point-in-polygon for a lat/lng ring.
 *
 * Casts a ray eastward from `pin` and counts edge crossings. Odd = inside.
 * Works reliably for the ~1 km polygons we deal with; not suitable for
 * polygons that wrap the antimeridian (irrelevant at this scale).
 */
function pointInPolygon(pin: LatLng, ring: LatLng[]): boolean {
  const { lat: py, lng: px } = pin;
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i].lng,
      yi = ring[i].lat;
    const xj = ring[j].lng,
      yj = ring[j].lat;
    // Does the edge [j→i] cross the horizontal ray from (px, py) going east?
    const crossesLat = yi > py !== yj > py;
    const xAtCross = ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (crossesLat && px < xAtCross) inside = !inside;
  }
  return inside;
}

/** Standing eye-height of an observer at the pin, in metres. */
const EYE_HEIGHT_M = 1.7;

// Edge sampling density. We step along each edge finely enough to satisfy BOTH
// a metric resolution (so long walls are well covered) AND an angular one — the
// latter is what matters for filling buckets: samples must be < 1° apart in
// azimuth or an intervening 1° bucket gets skipped (a close wall spans many
// degrees over a short length, so metric spacing alone under-samples it).
const EDGE_SAMPLE_STEP_M = 2.5;
const EDGE_SAMPLE_STEP_DEG = 0.75;
/** Upper bound on samples per edge, so a huge/curved footprint can't blow up. */
const MAX_EDGE_SAMPLES = 256;

/**
 * Build a 360-bucket obstruction profile from a list of obstructions.
 *
 * @param pin          The observer location.
 * @param obstructions Obstructions within the chosen radius.
 * @param radiusM      Radius the obstructions were fetched from, recorded for UI.
 * @param centerLat    Centre lat used for caching (may be grid-rounded).
 * @param centerLng    Centre lng used for caching.
 */
export function buildHorizonProfile(
  pin: LatLng,
  obstructions: Obstruction[],
  radiusM: number,
  centerLat: number,
  centerLng: number,
): HorizonProfile {
  const buckets = new Float32Array(360);

  // Record one obstruction sample: bearing bucket gets the higher of its
  // current value and the altitude subtended by a roof `dh` metres up at
  // distance `d`.
  const record = (point: LatLng, dh: number) => {
    const d = distanceMetres(pin, point);
    if (d < 1) return; // ignore points on top of the pin
    const altRad = Math.atan2(dh, d);
    const i = Math.floor(bearingDeg(pin, point)) % 360;
    if (altRad > buckets[i]) buckets[i] = altRad;
  };

  let buildingCount = 0;
  let treeCount = 0;
  let insideForest = false;

  for (const o of obstructions) {
    if (o.kind === 'building') buildingCount++;
    else treeCount++;

    // Effective height = how far the roof rises above eye level. Treat any
    // obstruction shorter than eye level as "no obstruction" — we'd just see
    // over it.
    const dh = o.heightMeters - EYE_HEIGHT_M;
    if (dh <= 0) continue;

    const ring = o.geometry;
    const n = ring.length;
    if (n === 0) continue;

    // Walk each edge (closing the ring back to the first vertex) sampling
    // points along it, so long walls obstruct every azimuth bucket they span,
    // not just the two at their end vertices.
    for (let v = 0; v < n; v++) {
      const a = ring[v];
      const c = ring[(v + 1) % n]; // next vertex; wraps to close the polygon
      const edgeLen = distanceMetres(a, c);
      // Azimuth span of the edge as seen from the pin (smaller arc).
      let dAz = Math.abs(bearingDeg(pin, a) - bearingDeg(pin, c));
      if (dAz > 180) dAz = 360 - dAz;
      const steps = Math.min(
        MAX_EDGE_SAMPLES,
        Math.max(1, Math.ceil(edgeLen / EDGE_SAMPLE_STEP_M), Math.ceil(dAz / EDGE_SAMPLE_STEP_DEG)),
      );
      // s runs [0, steps): includes the start vertex `a`; the end vertex `c`
      // is the next edge's start, so it isn't double-counted here.
      for (let s = 0; s < steps; s++) {
        const t = s / steps;
        record({ lat: a.lat + (c.lat - a.lat) * t, lng: a.lng + (c.lng - a.lng) * t }, dh);
      }
    }

    // Detect pin-inside-forest for UI disclosure. We do NOT modify the buckets
    // here: OSM forest polygons include open paths and clearings, so a blanket
    // canopy-floor would incorrectly shadow a pin on a path inside the polygon
    // boundary. The `insideForest` flag surfaces in BuildingsStatus so the user
    // knows the overhead canopy is not modeled, without producing false results.
    if (o.forestArea && pointInPolygon(pin, ring)) {
      insideForest = true;
    }
  }

  return {
    bucketsRad: buckets,
    buildingCount,
    treeCount,
    insideForest,
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
 * Sample the obstruction in the direction of the sun, given a SunCalc azimuth.
 *
 * SunCalc measures azimuth from SOUTH (0 = south, positive toward west), while
 * the profile is indexed by compass bearing from NORTH. This wrapper applies
 * the `+π` conversion so callers can't forget it — omitting it samples the
 * obstruction 180° from the sun, a silent and easy mistake to make.
 */
export function obstructionAtSunAzimuth(
  profile: HorizonProfile,
  suncalcAzimuthRad: number,
): number {
  return obstructionAt(profile, suncalcAzimuthRad + Math.PI);
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
