// Tests for applyHorizonToSolarTimes with synthetic horizon profiles.
//
// We can't easily test findEffectiveSunrise/Sunset (they call SunCalc.getPosition
// in a tight time loop), but we CAN exhaustively test the window/instant
// clipping logic by constructing profiles that block nothing vs. block
// everything, and checking that each field is handled correctly.

import { describe, expect, it } from 'vitest';
import { computeSolarTimes, isoDateToNoonUtc } from '../solar/calc';
import { buildHorizonProfile } from './horizon';
import { applyHorizonToSolarTimes } from './effective';
import type { LatLng } from '../types';

const LONDON: LatLng = { lat: 51.5074, lng: -0.1278 };
const DATE = isoDateToNoonUtc('2024-06-21');

// A profile with no buildings at all — every azimuth is unobstructed (0 rad).
function flatProfile(pin: LatLng) {
  return buildHorizonProfile(pin, [], 1000, pin.lat, pin.lng);
}

// A profile where every bucket is blocked to ~89° — nothing is ever visible.
function maxBlockProfile(pin: LatLng) {
  const profile = buildHorizonProfile(pin, [], 1000, pin.lat, pin.lng);
  profile.bucketsRad.fill(Math.PI / 2 - 0.01); // just under 90°
  return profile;
}

describe('applyHorizonToSolarTimes', () => {
  const geom = computeSolarTimes(LONDON, DATE);

  it('passes through unchanged when the horizon is flat (no buildings)', () => {
    const profile = flatProfile(LONDON);
    const result = applyHorizonToSolarTimes(LONDON, geom, profile);

    // Twilight fields always pass through regardless.
    expect(result.civilDawn?.getTime()).toBe(geom.civilDawn?.getTime());
    expect(result.civilDusk?.getTime()).toBe(geom.civilDusk?.getTime());
    expect(result.nauticalDawn?.getTime()).toBe(geom.nauticalDawn?.getTime());
    expect(result.nauticalDusk?.getTime()).toBe(geom.nauticalDusk?.getTime());
    expect(result.astroDawn?.getTime()).toBe(geom.astroDawn?.getTime());
    expect(result.astroDusk?.getTime()).toBe(geom.astroDusk?.getTime());
    expect(result.blueHourMorning?.start.getTime()).toBe(geom.blueHourMorning?.start.getTime());
    expect(result.blueHourEvening?.end.getTime()).toBe(geom.blueHourEvening?.end.getTime());

    // Sun-direct windows survive too on a flat horizon.
    expect(result.goldenHourMorning).not.toBeNull();
    expect(result.goldenHourEvening).not.toBeNull();
    expect(result.softLightMorning).not.toBeNull();
    expect(result.softLightEvening).not.toBeNull();
    expect(result.lateMorning).not.toBeNull();
    expect(result.lateAfternoon).not.toBeNull();
  });

  it('blocks all sun-direct phases when the entire sky is obstructed', () => {
    const profile = maxBlockProfile(LONDON);
    const result = applyHorizonToSolarTimes(LONDON, geom, profile);

    // All sun-direct phases become null (no part of any phase window is visible).
    expect(result.goldenHourMorning).toBeNull();
    expect(result.goldenHourEvening).toBeNull();
    expect(result.softLightMorning).toBeNull();
    expect(result.softLightEvening).toBeNull();
    expect(result.lateMorning).toBeNull();
    expect(result.lateAfternoon).toBeNull();

    // Twilight/blue-hour fields STILL pass through (they're sky phenomena).
    expect(result.blueHourMorning?.start.getTime()).toBe(geom.blueHourMorning?.start.getTime());
    expect(result.blueHourEvening?.end.getTime()).toBe(geom.blueHourEvening?.end.getTime());
    expect(result.civilDawn?.getTime()).toBe(geom.civilDawn?.getTime());
    expect(result.astroDusk?.getTime()).toBe(geom.astroDusk?.getTime());
  });

  it('returns null for phases that are null in geometric input regardless of profile', () => {
    // Tromsø 2024-06-21: no sunrise/sunset (polar midnight sun).
    const TROMSO: LatLng = { lat: 69.6492, lng: 18.9553 };
    const geomPolar = computeSolarTimes(TROMSO, DATE);
    const profile = flatProfile(TROMSO);
    const result = applyHorizonToSolarTimes(TROMSO, geomPolar, profile);

    // Already-null geometric phases stay null.
    expect(result.goldenHourMorning).toBeNull();
    expect(result.goldenHourEvening).toBeNull();
    expect(result.blueHourMorning).toBeNull();
    expect(result.blueHourEvening).toBeNull();
  });

  it('preserves window ordering when profile allows partial visibility', () => {
    const profile = flatProfile(LONDON);
    const result = applyHorizonToSolarTimes(LONDON, geom, profile);

    const gh = result.goldenHourMorning!;
    expect(gh.end.getTime()).toBeGreaterThan(gh.start.getTime());

    const ghe = result.goldenHourEvening!;
    expect(ghe.end.getTime()).toBeGreaterThan(ghe.start.getTime());
  });
});
