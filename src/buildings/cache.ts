// ==============================================================================
// Horizon profile cache
// ==============================================================================
//
// Buildings near a given location change rarely (months to years), so we
// cache the computed `HorizonProfile` in `localStorage` keyed by a coarse
// grid cell + radius. Two clicks within the same ~500 m cell reuse the same
// fetch.
//
// We cache the PROFILE, not the raw buildings, for two reasons:
//   1. The profile is tiny (360 floats ≈ 1.4 KB), buildings can be MB.
//   2. We only ever consume the profile downstream — caching it directly
//      saves the rebuild step on every reload.

import type { HorizonProfile, LatLng } from '../types';

// Bumped to v4: HorizonProfile gained insideForest and the canopy-floor pass.
// Old v3 profiles missing the field would report "in sun" inside a forest.
const CACHE_PREFIX = 'solux:horizon:v4:';
const GRID_DEG = 0.005; // ~500 m at the equator; tighter near poles
const TTL_MS = 30 * 24 * 60 * 60_000; // 30 days

/** Round a coordinate down to a stable grid cell. */
function gridCell(p: LatLng) {
  return {
    lat: Math.round(p.lat / GRID_DEG) * GRID_DEG,
    lng: Math.round(p.lng / GRID_DEG) * GRID_DEG,
  };
}

function cacheKey(p: LatLng, radius: number): string {
  const c = gridCell(p);
  return `${CACHE_PREFIX}${c.lat.toFixed(3)},${c.lng.toFixed(3)},${radius}`;
}

type Serialized = {
  bucketsRad: number[];
  buildingCount: number;
  treeCount: number;
  insideForest: boolean;
  radiusMeters: number;
  centerLat: number;
  centerLng: number;
  fetchedAt: number;
};

export function loadProfile(pin: LatLng, radius: number): HorizonProfile | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(pin, radius));
    if (!raw) return null;
    const obj = JSON.parse(raw) as Serialized;
    if (Date.now() - obj.fetchedAt > TTL_MS) return null;
    if (!Array.isArray(obj.bucketsRad) || obj.bucketsRad.length !== 360) return null;
    return {
      bucketsRad: new Float32Array(obj.bucketsRad),
      buildingCount: obj.buildingCount,
      treeCount: obj.treeCount ?? 0,
      insideForest: obj.insideForest ?? false,
      radiusMeters: obj.radiusMeters,
      centerLat: obj.centerLat,
      centerLng: obj.centerLng,
      fetchedAt: obj.fetchedAt,
    };
  } catch {
    return null;
  }
}

export function saveProfile(pin: LatLng, profile: HorizonProfile): void {
  try {
    const ser: Serialized = {
      bucketsRad: Array.from(profile.bucketsRad),
      buildingCount: profile.buildingCount,
      treeCount: profile.treeCount,
      insideForest: profile.insideForest,
      radiusMeters: profile.radiusMeters,
      centerLat: profile.centerLat,
      centerLng: profile.centerLng,
      fetchedAt: profile.fetchedAt,
    };
    window.localStorage.setItem(cacheKey(pin, profile.radiusMeters), JSON.stringify(ser));
  } catch {
    // Quota exceeded or storage blocked → forget it, no observable harm.
  }
}

export { gridCell };
