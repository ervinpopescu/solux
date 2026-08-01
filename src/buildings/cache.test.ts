import { afterEach, describe, expect, it, vi } from 'vitest';
import { gridCell, loadProfile, saveProfile } from './cache';
import type { HorizonProfile } from '../types';

afterEach(() => {
  window.localStorage.clear();
  vi.useRealTimers();
});

function makeProfile(overrides: Partial<HorizonProfile> = {}): HorizonProfile {
  return {
    bucketsRad: new Float32Array(360).fill(0),
    buildingCount: 42,
    treeCount: 0,
    insideForest: false,
    radiusMeters: 1000,
    centerLat: 51.505,
    centerLng: -0.13,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

const PIN = { lat: 51.5074, lng: -0.1278 };

describe('gridCell', () => {
  it('rounds to the nearest 0.005 grid', () => {
    const c = gridCell({ lat: 51.5074, lng: -0.1278 });
    // 51.5074 / 0.005 = 10301.48 → round → 10301 × 0.005 = 51.505
    expect(c.lat).toBeCloseTo(51.505, 3);
    // -0.1278 / 0.005 = -25.56 → round → -26 × 0.005 = -0.130
    expect(c.lng).toBeCloseTo(-0.13, 3);
  });

  it('two close pins snap to the same cell', () => {
    // Both fall within 0.0025° of 51.505 (the cell centre) so they round
    // to the same grid lat. Similarly for lng at -0.130.
    const a = gridCell({ lat: 51.506, lng: -0.1285 });
    const b = gridCell({ lat: 51.504, lng: -0.1315 });
    expect(a.lat).toBeCloseTo(b.lat, 4);
    expect(a.lng).toBeCloseTo(b.lng, 4);
  });
});

describe('saveProfile / loadProfile', () => {
  it('returns null when nothing is stored', () => {
    expect(loadProfile(PIN, 1000)).toBeNull();
  });

  it('round-trips a profile correctly', () => {
    const profile = makeProfile({ buildingCount: 99, radiusMeters: 500 });
    saveProfile(PIN, profile);
    const loaded = loadProfile(PIN, 500);

    expect(loaded).not.toBeNull();
    expect(loaded!.buildingCount).toBe(99);
    expect(loaded!.radiusMeters).toBe(500);
    expect(loaded!.bucketsRad).toHaveLength(360);
  });

  it('preserves non-zero bucket values', () => {
    const buckets = new Float32Array(360);
    buckets[90] = 0.25; // east obstruction
    buckets[270] = 0.1; // west obstruction
    const profile = makeProfile({ bucketsRad: buckets });
    saveProfile(PIN, profile);

    const loaded = loadProfile(PIN, 1000)!;
    expect(loaded.bucketsRad[90]).toBeCloseTo(0.25, 4);
    expect(loaded.bucketsRad[270]).toBeCloseTo(0.1, 4);
    expect(loaded.bucketsRad[0]).toBe(0);
  });

  it('returns null when the stored entry is expired (> 30 days old)', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const profile = makeProfile({ fetchedAt: now });
    saveProfile(PIN, profile);

    // Advance past the 30-day TTL.
    vi.setSystemTime(now + 31 * 24 * 60 * 60_000);
    expect(loadProfile(PIN, 1000)).toBeNull();
  });

  it('returns a valid profile when within the TTL window', () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);

    const profile = makeProfile({ fetchedAt: now });
    saveProfile(PIN, profile);

    // Advance to just before the TTL.
    vi.setSystemTime(now + 29 * 24 * 60 * 60_000);
    expect(loadProfile(PIN, 1000)).not.toBeNull();
  });

  it('returns null for malformed JSON in localStorage', () => {
    // Construct the cache key manually and inject garbage.
    // Keys use v3 — the current cache prefix.
    const cell = gridCell(PIN);
    const key = `solux:horizon:v4:${cell.lat.toFixed(3)},${cell.lng.toFixed(3)},1000`;
    window.localStorage.setItem(key, '{not json');
    expect(loadProfile(PIN, 1000)).toBeNull();
  });

  it('returns null when bucketsRad length is wrong', () => {
    const cell = gridCell(PIN);
    const key = `solux:horizon:v4:${cell.lat.toFixed(3)},${cell.lng.toFixed(3)},1000`;
    window.localStorage.setItem(
      key,
      JSON.stringify({
        bucketsRad: [0, 1, 2], // wrong length
        buildingCount: 1,
        treeCount: 0,
        insideForest: false,
        radiusMeters: 1000,
        centerLat: 51.505,
        centerLng: -0.13,
        fetchedAt: Date.now(),
      }),
    );
    expect(loadProfile(PIN, 1000)).toBeNull();
  });

  it('misses when radius differs', () => {
    const profile = makeProfile({ radiusMeters: 1000 });
    saveProfile(PIN, profile);
    // Profile was saved for radius 1000, looking for 500 → different key.
    expect(loadProfile(PIN, 500)).toBeNull();
  });
});
