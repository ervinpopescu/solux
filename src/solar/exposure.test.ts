// Tests for sunExposureAt. The key property is directional: a building in the
// sun's actual direction shades the spot, while the same building in the
// opposite direction does not. This locks the SunCalc-azimuth → compass-bearing
// convention that the badge and the effective-times calc both depend on.

import { describe, expect, it } from 'vitest';
import * as SunCalc from 'suncalc';
import { apparentToGeometricAltitude, sunExposureAt } from './exposure';
import type { HorizonProfile, LatLng } from '../types';

const LONDON: LatLng = { lat: 51.5074, lng: -0.1278 };
// London midsummer, near solar noon: the sun is high (~62°) and due south.
const NOON = new Date(Date.UTC(2024, 5, 21, 12, 0, 0));

const DEG = 180 / Math.PI;

// A profile that blocks a small arc centred on one compass bearing.
function profileBlockingBearing(bearingDeg: number, altitudeRad: number): HorizonProfile {
  const buckets = new Float32Array(360);
  for (let d = bearingDeg - 2; d <= bearingDeg + 2; d++) {
    buckets[((Math.round(d) % 360) + 360) % 360] = altitudeRad;
  }
  return {
    bucketsRad: buckets,
    buildingCount: 1,
    treeCount: 0,
    insideForest: false,
    radiusMeters: 1000,
    centerLat: LONDON.lat,
    centerLng: LONDON.lng,
    fetchedAt: 0,
  };
}

describe('sunExposureAt', () => {
  const { altitude, azimuth } = SunCalc.getPosition(NOON, LONDON.lat, LONDON.lng);
  // SunCalc 2 returns both values in degrees, with azimuth clockwise from north.
  const sunAltDeg = altitude;
  const sunBearingDeg = azimuth;
  // An obstruction taller than the sun, used to force a shaded result.
  const tallerThanSun = (sunAltDeg + 10) / DEG;

  it('reports shadow when a tall building sits in the sun’s direction', () => {
    const profile = profileBlockingBearing(sunBearingDeg, tallerThanSun);
    expect(sunExposureAt(LONDON, NOON, profile).state).toBe('shadow');
  });

  it('reports lit when the same obstruction is opposite the sun', () => {
    const profile = profileBlockingBearing((sunBearingDeg + 180) % 360, tallerThanSun);
    expect(sunExposureAt(LONDON, NOON, profile).state).toBe('lit');
  });

  it('reports below_horizon at night', () => {
    const midnight = new Date(Date.UTC(2024, 5, 21, 0, 0, 0));
    expect(sunExposureAt(LONDON, midnight, null).state).toBe('below_horizon');
  });

  it('treats a null profile as a flat horizon (lit while the sun is up)', () => {
    expect(sunExposureAt(LONDON, NOON, null).state).toBe('lit');
  });

  it('reports below_horizon when apparent altitude is positive but geometric altitude is below horizon', () => {
    // London 2024-06-21 at 03:47 UTC:
    // SunCalc reports an apparent altitude ~+0.10° due to atmospheric refraction,
    // but the true geometric altitude is ~-0.38° (solar center is below the true horizon).
    const preSunriseInstant = new Date('2024-06-21T03:47:00Z');
    const { altitude: apparentAlt } = SunCalc.getPosition(
      preSunriseInstant,
      LONDON.lat,
      LONDON.lng,
    );
    expect(apparentAlt).toBeGreaterThan(0);

    const exposure = sunExposureAt(LONDON, preSunriseInstant, null);
    expect(exposure.state).toBe('below_horizon');
    expect(exposure.sunAltitudeDeg).toBeLessThan(0);
  });

  it('reports lit once the sun has crossed the geometric horizon', () => {
    // London 2024-06-21 at 03:55 UTC: geometric altitude is ~+0.50°.
    const postSunriseInstant = new Date('2024-06-21T03:55:00Z');
    const exposure = sunExposureAt(LONDON, postSunriseInstant, null);
    expect(exposure.state).toBe('lit');
    if (exposure.state === 'lit') {
      expect(exposure.sunAltitudeDeg).toBeGreaterThan(0);
      expect(exposure.clearanceDeg).toBeGreaterThan(0);
    }
  });

  it('accurately converts apparent altitude to geometric altitude', () => {
    // Zero apparent altitude is ~0.484° below the horizon geometrically
    const geomAtZeroApparent = apparentToGeometricAltitude(0);
    expect(geomAtZeroApparent).toBeCloseTo(-0.484, 2);

    // Negative apparent altitude preserves linear geometric displacement
    expect(apparentToGeometricAltitude(-1)).toBeCloseTo(-1.484, 2);

    // High altitude (noon): refraction is tiny (~0.009°)
    const noonApparent = SunCalc.getPosition(NOON, LONDON.lat, LONDON.lng).altitude;
    const noonGeometric = apparentToGeometricAltitude(noonApparent);
    expect(noonGeometric).toBeLessThan(noonApparent);
    expect(noonApparent - noonGeometric).toBeCloseTo(0.009, 3);
  });
});
