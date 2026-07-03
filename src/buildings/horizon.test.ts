// Horizon profile tests using a tiny synthetic set of buildings around a
// reference pin. We construct buildings whose geometry-to-pin distance and
// expected obstruction angles are simple enough to verify analytically.

import { describe, expect, it } from 'vitest';
import {
  buildHorizonProfile,
  obstructionAt,
  obstructionAtSunAzimuth,
  tallestObstruction,
} from './horizon';
import type { Building, LatLng } from '../types';

const PIN: LatLng = { lat: 51.5, lng: 0.0 };

/**
 * Place a single point ~`metres` north of the pin. For small distances at
 * mid-latitudes 1° latitude ≈ 111_320 m, so:
 *   delta_lat = metres / 111_320
 *
 * Bearing-from-pin to a point due north is exactly 0°, so this lets us
 * predict the obstruction's bucket and angle precisely.
 */
function northOf(pin: LatLng, metres: number): LatLng {
  return { lat: pin.lat + metres / 111_320, lng: pin.lng };
}

describe('buildHorizonProfile', () => {
  it('records a north-side obstruction in bucket 0', () => {
    const building: Building = {
      // ~50 m north of the pin, all four corners co-located to make the
      // geometry trivial.
      geometry: [northOf(PIN, 50), northOf(PIN, 50), northOf(PIN, 50)],
      heightMeters: 30,
      heightFromTag: true,
    };

    const profile = buildHorizonProfile(PIN, [building], 1000, PIN.lat, PIN.lng);
    // Effective vertical = (30 - 1.7) m at 50 m → atan(28.3/50).
    const expectedRad = Math.atan2(28.3, 50);
    expect(profile.bucketsRad[0]).toBeCloseTo(expectedRad, 3);

    // Other buckets remain zero — the synthetic building only contributes
    // to azimuth 0 because every vertex sits there.
    expect(profile.bucketsRad[1]).toBe(0);
    expect(profile.bucketsRad[180]).toBe(0);
  });

  it('samples along edges so a wide wall obstructs every bucket it spans', () => {
    // A wall ~50 m due north, running E–W, its endpoints 30 m to either side.
    // Its nearest point is due north (bucket 0); no vertex sits there, so the
    // old vertex-only sampling left bucket 0 empty and reported "in sun" even
    // though the wall clearly blocks that direction — the bug behind the badge
    // disagreeing with the rendered ground shadow.
    const dLatN = 50 / 111_320;
    const dLngE = 30 / (111_320 * Math.cos((PIN.lat * Math.PI) / 180));
    const wall: Building = {
      geometry: [
        { lat: PIN.lat + dLatN, lng: PIN.lng - dLngE },
        { lat: PIN.lat + dLatN, lng: PIN.lng + dLngE },
      ],
      heightMeters: 30,
      heightFromTag: true,
    };

    const profile = buildHorizonProfile(PIN, [wall], 1000, PIN.lat, PIN.lng);

    // Bucket 0 (due north, nearest wall point at ~50 m) is now filled.
    expect(profile.bucketsRad[0]).toBeCloseTo(Math.atan2(28.3, 50), 2);
    // And the spans partway toward each endpoint, not just the endpoints.
    expect(profile.bucketsRad[10]).toBeGreaterThan(0);
    expect(profile.bucketsRad[350]).toBeGreaterThan(0);
  });

  it('keeps the maximum when two buildings sit in the same azimuth', () => {
    const close: Building = {
      geometry: [northOf(PIN, 100), northOf(PIN, 100), northOf(PIN, 100)],
      heightMeters: 20,
      heightFromTag: true,
    };
    const far: Building = {
      geometry: [northOf(PIN, 500), northOf(PIN, 500), northOf(PIN, 500)],
      heightMeters: 60,
      heightFromTag: true,
    };

    const profile = buildHorizonProfile(PIN, [close, far], 1000, PIN.lat, PIN.lng);
    // close: atan((20-1.7)/100)=atan(0.183) ~10.4°
    // far:   atan((60-1.7)/500)=atan(0.1166) ~6.66°
    // → max is the closer one.
    expect(profile.bucketsRad[0]).toBeCloseTo(Math.atan2(18.3, 100), 3);
  });

  it('ignores buildings shorter than eye height', () => {
    const tiny: Building = {
      geometry: [northOf(PIN, 50), northOf(PIN, 50), northOf(PIN, 50)],
      heightMeters: 1.0, // below 1.7 m eye level
      heightFromTag: true,
    };

    const profile = buildHorizonProfile(PIN, [tiny], 1000, PIN.lat, PIN.lng);
    expect(profile.bucketsRad[0]).toBe(0);
  });

  it('linearly interpolates between adjacent azimuth buckets', () => {
    const profile = buildHorizonProfile(
      PIN,
      [
        {
          geometry: [northOf(PIN, 50), northOf(PIN, 50), northOf(PIN, 50)],
          heightMeters: 30,
          heightFromTag: true,
        },
      ],
      1000,
      PIN.lat,
      PIN.lng,
    );

    // Halfway between buckets 0 and 1 should be half the bucket-0 value
    // because bucket 1 is empty.
    const halfRad = (0.5 * Math.PI) / 180;
    const sampled = obstructionAt(profile, halfRad);
    expect(sampled).toBeCloseTo(profile.bucketsRad[0] * 0.5, 4);
  });

  it('reports the tallest obstruction with the right octant', () => {
    const profile = buildHorizonProfile(
      PIN,
      [
        {
          // ~50 m north, ~10 m tall → ~10° obstruction at bucket 0.
          geometry: [northOf(PIN, 50), northOf(PIN, 50), northOf(PIN, 50)],
          heightMeters: 10,
          heightFromTag: true,
        },
      ],
      1000,
      PIN.lat,
      PIN.lng,
    );

    const tallest = tallestObstruction(profile);
    expect(tallest).not.toBeNull();
    expect(tallest!.azimuthDeg).toBe(0);
    expect(tallest!.altitudeDeg).toBeGreaterThan(8);
    expect(tallest!.altitudeDeg).toBeLessThan(11);
  });

  it('returns null tallest when nothing is obstructing', () => {
    const profile = buildHorizonProfile(PIN, [], 1000, PIN.lat, PIN.lng);
    expect(tallestObstruction(profile)).toBeNull();
  });

  it('obstructionAtSunAzimuth converts the south-based sun azimuth to compass buckets', () => {
    // Obstruction recorded due south → compass bucket 180.
    const profile = buildHorizonProfile(PIN, [], 1000, PIN.lat, PIN.lng);
    profile.bucketsRad[180] = 0.3;

    // SunCalc azimuth 0 = south, so the sun-aware lookup must read bucket 180.
    // A raw lookup (no conversion) would read bucket 0 and see nothing — the
    // 180° bug this helper exists to prevent.
    expect(obstructionAtSunAzimuth(profile, 0)).toBeCloseTo(0.3, 5);
    expect(obstructionAt(profile, 0)).toBe(0);
  });
});
