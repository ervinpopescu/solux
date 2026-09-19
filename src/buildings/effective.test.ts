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

    // Sun-direct windows survive too on a flat horizon and preserve exact geometric endpoints.
    expect(result.goldenHourMorning?.start.getTime()).toBe(geom.goldenHourMorning?.start.getTime());
    expect(result.goldenHourMorning?.end.getTime()).toBe(geom.goldenHourMorning?.end.getTime());
    expect(result.goldenHourEvening?.start.getTime()).toBe(geom.goldenHourEvening?.start.getTime());
    expect(result.goldenHourEvening?.end.getTime()).toBe(geom.goldenHourEvening?.end.getTime());
    expect(result.softLightMorning?.start.getTime()).toBe(geom.softLightMorning?.start.getTime());
    expect(result.softLightMorning?.end.getTime()).toBe(geom.softLightMorning?.end.getTime());
    expect(result.softLightEvening?.start.getTime()).toBe(geom.softLightEvening?.start.getTime());
    expect(result.softLightEvening?.end.getTime()).toBe(geom.softLightEvening?.end.getTime());
    expect(result.lateMorning?.start.getTime()).toBe(geom.lateMorning?.start.getTime());
    expect(result.lateMorning?.end.getTime()).toBe(geom.lateMorning?.end.getTime());
    expect(result.lateAfternoon?.start.getTime()).toBe(geom.lateAfternoon?.start.getTime());
    expect(result.lateAfternoon?.end.getTime()).toBe(geom.lateAfternoon?.end.getTime());
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

  it('preserves exact non-30-second aligned endpoints on a flat horizon', () => {
    const profile = flatProfile(LONDON);
    const customTimes = {
      ...geom,
      goldenHourMorning: {
        start: new Date(geom.goldenHourMorning!.start.getTime() + 12_345),
        end: new Date(geom.goldenHourMorning!.end.getTime() - 7_891),
      },
    };
    const result = applyHorizonToSolarTimes(LONDON, customTimes, profile);
    expect(result.goldenHourMorning?.start.getTime()).toBe(
      customTimes.goldenHourMorning.start.getTime(),
    );
    expect(result.goldenHourMorning?.end.getTime()).toBe(
      customTimes.goldenHourMorning.end.getTime(),
    );
  });

  it('refines partially obstructed window boundaries beyond coarse 30s steps', () => {
    const profile = flatProfile(LONDON);
    // Block the earliest portion of morning golden hour (~45° to 52° azimuth)
    // with a low 2.8° (0.05 rad) obstruction so that goldenHourMorning starts late.
    for (let b = 45; b <= 52; b++) {
      profile.bucketsRad[b] = 0.05;
    }
    const result = applyHorizonToSolarTimes(LONDON, geom, profile);
    const gh = result.goldenHourMorning;
    expect(gh).not.toBeNull();
    expect(gh!.start.getTime()).toBeGreaterThan(geom.goldenHourMorning!.start.getTime());
    expect(gh!.start.getTime()).toBeLessThan(gh!.end.getTime());
    // End is unobstructed, so it remains exact.
    expect(gh!.end.getTime()).toBe(geom.goldenHourMorning!.end.getTime());
  });
});
