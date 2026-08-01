// Tests for sunExposureAt. The key property is directional: a building in the
// sun's actual direction shades the spot, while the same building in the
// opposite direction does not. This locks the SunCalc-azimuth → compass-bearing
// convention that the badge and the effective-times calc both depend on.

import { describe, expect, it } from 'vitest';
import SunCalc from 'suncalc';
import { sunExposureAt } from './exposure';
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
  const sunAltDeg = altitude * DEG;
  const sunBearingDeg = ((azimuth + Math.PI) * DEG + 360) % 360;
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
});
