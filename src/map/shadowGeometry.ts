// ==============================================================================
// Building shadow geometry
// ==============================================================================
//
// Turns building footprints + a sun direction into a flat ground-shadow mesh.
//
// The math is the classic planar shadow of a vertical prism onto flat ground.
// A rooftop point at height `h` casts its shadow to the ground displaced
// horizontally by
//
//     d = h / tan(altitude)
//
// in the anti-solar direction (directly away from the sun's compass bearing).
// The full ground shadow of the prism is therefore the Minkowski sum of the
// footprint with the segment [0, offset], i.e. the union of three pieces:
//
//   1. the footprint itself,
//   2. the footprint translated by the shadow offset (the projected roof),
//   3. the "swept" band connecting each footprint edge to its translated copy.
//
// We emit all three as triangles. Overlap between the pieces (and between
// neighbouring buildings) is resolved by the *renderer*, which unions them via
// a stencil mask before a single translucent wash — see `shadowLayer.ts`. That
// is why we don't attempt any polygon union here: we can freely emit
// overlapping triangles and let the stencil dedupe them.
//
// Coordinates. All output is LOCAL METRE space relative to the pin, matching
// the sun-path arc's convention (X = east, Y = up, Z = south). Shadows live on
// the ground, so Y is always 0. Keeping vertices small (metres, not mercator)
// is what lets the layer dodge the float32 precision problem — the same
// double-precision model matrix used by the arc maps these to mercator.

import earcut from 'earcut';
import type { LatLng } from '../types';

/** WGS-84 equatorial radius; used for the local equirectangular metre map. */
const EARTH_RADIUS_M = 6_378_137;

/**
 * Sun altitude (radians) above which building shadows are drawn at full
 * strength. As the sun sinks from here to the horizon, shadows keep growing but
 * fade out (see `shadowOpacityForAltitude`) so they dissolve into the night
 * wash instead of snapping off. ~6°.
 */
export const SHADOW_FADE_START_RAD = (6 * Math.PI) / 180;

/**
 * Cap on the `1/tan(altitude)` length factor. Near the horizon this term
 * explodes toward infinity; clamping it keeps low-sun shadows long enough to
 * read as a dramatic "smear" without streaking kilometres across the scene.
 * 26 ≈ the sun at ~2.2°, so a 20 m building casts at most a ~520 m shadow.
 */
const MAX_SHADOW_INVTAN = 26;

/** A footprint prepared for repeated meshing as the sun (offset) changes. */
export type ShadowBuilding = {
  /** Outer ring as flat local-metre pairs [x0, z0, x1, z1, …] (x=east, z=south). */
  ring: number[];
  /** earcut triangle indices into `ring` (each index addresses one x/z pair). */
  tris: number[];
  /** Building height in metres. */
  height: number;
};

/**
 * Convert a lng/lat point to local metres (east, south) relative to `pin`,
 * using a local equirectangular approximation. Accurate to well under 0.1% at
 * the ~1 km scale we operate on, and — crucially — cheap and free of the
 * mercator float precision loss we'd hit converting each point to world space.
 *
 * South is positive to match the arc's Z axis (bearing 0 = north).
 */
export function lngLatToLocalMetres(pin: LatLng, p: LatLng): [number, number] {
  const latRad = (pin.lat * Math.PI) / 180;
  const dLng = ((p.lng - pin.lng) * Math.PI) / 180;
  const dLat = ((p.lat - pin.lat) * Math.PI) / 180;
  const east = dLng * Math.cos(latRad) * EARTH_RADIUS_M;
  const south = -dLat * EARTH_RADIUS_M;
  return [east, south];
}

/**
 * Prepare a building footprint (lng/lat ring) for meshing: project it into
 * local metres and triangulate it once with earcut. Returns `null` for
 * degenerate rings (fewer than 3 distinct points) or non-positive heights.
 *
 * Holes are intentionally ignored: courtyards are rare in the vector-tile
 * building layer and their shadow contribution is negligible. We document the
 * omission rather than silently assuming footprints are hole-free.
 */
export function prepareShadowBuilding(
  pin: LatLng,
  ring: LatLng[],
  height: number,
): ShadowBuilding | null {
  if (height <= 0 || ring.length < 3) return null;

  // Drop a trailing point that duplicates the first (closed-ring convention);
  // earcut and our edge loop both assume an open ring.
  const pts = ring.slice();
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first.lat === last.lat && first.lng === last.lng) pts.pop();
  if (pts.length < 3) return null;

  const flat: number[] = [];
  for (const p of pts) {
    const [x, z] = lngLatToLocalMetres(pin, p);
    flat.push(x, z);
  }

  const tris = earcut(flat);
  if (tris.length === 0) return null;

  return { ring: flat, tris, height };
}

// ── Day → night crossfade ────────────────────────────────────────────────────
//
// Around sunset we cross-dissolve two effects instead of switching between them
// at a hard boundary:
//
//   shadow opacity  1 ─────╲                        (shadows lengthen + fade out)
//                          ╲____
//   night wash            ____╱─────── 1            (darkness fades in)
//                    ╱────╱
//              6°        0°        −12°   sun altitude →
//
// Both are anchored at SHADOW_FADE_START_RAD (6°): as the sun drops from there
// to the horizon, shadows keep growing (bounded by MAX_SHADOW_INVTAN) while
// their opacity ramps to 0, and the night wash simultaneously ramps up — so the
// long low shadows visibly smear into the gathering night. Below the horizon
// only the night wash remains, deepening to full by nautical dusk (−12°).
export const NIGHT_FULL_ALTITUDE_RAD = (-12 * Math.PI) / 180;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const c = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return c * c * (3 - 2 * c);
}

/** Building-shadow opacity multiplier for a sun altitude: 1 high, →0 at horizon. */
export function shadowOpacityForAltitude(altitude: number): number {
  return smoothstep(0, SHADOW_FADE_START_RAD, altitude);
}

/** Night-wash strength in [0,1]: 0 at/above 6°, →1 at/below −12° (deep night). */
export function nightFactorForAltitude(altitude: number): number {
  // Inverted range: 0 at the bright end (6°), 1 at the dark end (−12°).
  return 1 - smoothstep(NIGHT_FULL_ALTITUDE_RAD, SHADOW_FADE_START_RAD, altitude);
}

/**
 * Horizontal ground offset the shadow of a 1-metre-tall point receives, given
 * the sun's position. Multiply by a building's height to get its displacement.
 *
 * Returns `null` when the sun is at or below the horizon (no direct light). The
 * `1/tan(altitude)` length is clamped to `MAX_SHADOW_INVTAN` so near-horizon
 * shadows stay bounded. The offset points in the anti-solar direction:
 *
 *   - `azimuth` follows SunCalc (0 = south, +toward west); compass bearing is
 *     `azimuth + π`.
 *   - the sun's horizontal direction is (sin β, −cos β) in (east, south);
 *   - shadows fall opposite, so the offset direction is (−sin β, +cos β).
 */
export function sunShadowOffsetPerMetre(
  azimuth: number,
  altitude: number,
): [number, number] | null {
  if (altitude <= 0) return null;
  const bearing = azimuth + Math.PI;
  const invTan = Math.min(1 / Math.tan(altitude), MAX_SHADOW_INVTAN);
  const east = -Math.sin(bearing) * invTan;
  const south = Math.cos(bearing) * invTan;
  return [east, south];
}

/**
 * Build the flat shadow mesh (interleaved XYZ triples, Y = 0) for all
 * buildings given the per-metre shadow offset. Emits, per building:
 *
 *   - the footprint triangles,
 *   - the same triangles translated by the building's own offset (h · offset),
 *   - two triangles per footprint edge sweeping base → translated copy.
 *
 * The result is meant to be uploaded straight into the stencil-union pass.
 */
export function buildShadowMesh(
  buildings: ShadowBuilding[],
  offsetPerMetre: [number, number],
): Float32Array {
  const [oxPerM, ozPerM] = offsetPerMetre;

  // Size the output exactly: base + top = 2 · tris; edges = 6 verts per point.
  let vertexCount = 0;
  for (const b of buildings) {
    vertexCount += b.tris.length * 2;
    vertexCount += (b.ring.length / 2) * 6;
  }
  const out = new Float32Array(vertexCount * 3);
  let o = 0;

  const put = (x: number, z: number) => {
    out[o++] = x;
    out[o++] = 0; // ground plane
    out[o++] = z;
  };

  for (const b of buildings) {
    const dx = oxPerM * b.height;
    const dz = ozPerM * b.height;
    const r = b.ring;

    // Base + projected-roof triangles.
    for (const idx of b.tris) {
      put(r[idx * 2], r[idx * 2 + 1]);
    }
    for (const idx of b.tris) {
      put(r[idx * 2] + dx, r[idx * 2 + 1] + dz);
    }

    // Swept side band: one quad (two triangles) per footprint edge.
    const n = r.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = r[i * 2],
        az = r[i * 2 + 1];
      const bx = r[j * 2],
        bz = r[j * 2 + 1];
      const axo = ax + dx,
        azo = az + dz;
      const bxo = bx + dx,
        bzo = bz + dz;
      put(ax, az);
      put(bx, bz);
      put(bxo, bzo);
      put(ax, az);
      put(bxo, bzo);
      put(axo, azo);
    }
  }

  return out;
}
