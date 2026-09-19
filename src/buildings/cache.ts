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

// Bumped to v5: fresh profiles use 1 km buildings, trees capped at 400 m,
// and omit forest polygons. Older profiles represent different query coverage.
const CACHE_PREFIX = 'solux:horizon:v5:';
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

function isFiniteNumber(val: unknown): val is number {
  return typeof val === 'number' && Number.isFinite(val);
}

function isValidTimestamp(fetchedAt: unknown): fetchedAt is number {
  if (!isFiniteNumber(fetchedAt)) return false;
  const now = Date.now();
  return now - fetchedAt <= TTL_MS && fetchedAt <= now + 60_000;
}

function isFiniteCoordinate(val: unknown, min: number, max: number): val is number {
  return isFiniteNumber(val) && val >= min && val <= max;
}

function isValidBuckets(buckets: unknown): buckets is number[] {
  if (!Array.isArray(buckets) || buckets.length !== 360) return false;
  for (let i = 0; i < 360; i++) {
    if (!isFiniteNumber(buckets[i])) return false;
  }
  return true;
}

export function loadProfile(pin: LatLng, radius: number): HorizonProfile | null {
  try {
    const raw = window.localStorage.getItem(cacheKey(pin, radius));
    if (!raw) return null;
    const obj = JSON.parse(raw) as Partial<Serialized>;
    if (!obj || typeof obj !== 'object') return null;

    if (!isValidTimestamp(obj.fetchedAt)) return null;
    if (!isFiniteNumber(obj.radiusMeters) || obj.radiusMeters <= 0) return null;
    if (
      !isFiniteCoordinate(obj.centerLat, -90, 90) ||
      !isFiniteCoordinate(obj.centerLng, -180, 180)
    ) {
      return null;
    }

    if (!isFiniteNumber(obj.buildingCount) || obj.buildingCount < 0) return null;
    const treeCount = obj.treeCount ?? 0;
    if (!isFiniteNumber(treeCount) || treeCount < 0) return null;

    if (obj.insideForest !== undefined && typeof obj.insideForest !== 'boolean') return null;

    if (!isValidBuckets(obj.bucketsRad)) return null;

    return {
      bucketsRad: new Float32Array(obj.bucketsRad),
      buildingCount: obj.buildingCount,
      treeCount,
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
