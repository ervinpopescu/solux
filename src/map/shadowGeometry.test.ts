import { describe, it, expect } from 'vitest';
import {
  lngLatToLocalMetres,
  sunShadowOffsetPerMetre,
  prepareShadowBuilding,
  buildShadowMesh,
  nightFactorForAltitude,
  shadowOpacityForAltitude,
  SHADOW_FADE_START_RAD,
  NIGHT_FULL_ALTITUDE_RAD,
} from './shadowGeometry';
import type { LatLng } from '../types';

const PIN: LatLng = { lat: 44.4268, lng: 26.1025 };

describe('lngLatToLocalMetres', () => {
  it('maps a point due east to +east, ~0 south', () => {
    const [east, south] = lngLatToLocalMetres(PIN, { lat: PIN.lat, lng: PIN.lng + 0.001 });
    expect(east).toBeGreaterThan(70);
    expect(east).toBeLessThan(90);
    expect(Math.abs(south)).toBeLessThan(0.001);
  });

  it('maps a point due north to negative south (south axis points south)', () => {
    const [east, south] = lngLatToLocalMetres(PIN, { lat: PIN.lat + 0.001, lng: PIN.lng });
    expect(Math.abs(east)).toBeLessThan(0.001);
    expect(south).toBeCloseTo(-111.3, 0);
  });
});

describe('sunShadowOffsetPerMetre', () => {
  it('casts the shadow due north when the sun is in the south', () => {
    // SunCalc azimuth 0 = due south. At 45° altitude, 1/tan = 1.
    const off = sunShadowOffsetPerMetre(0, Math.PI / 4);
    expect(off).not.toBeNull();
    const [east, south] = off!;
    expect(east).toBeCloseTo(0, 6);
    expect(south).toBeCloseTo(-1, 6); // negative south = north
  });

  it('casts the shadow due west when the sun is in the east', () => {
    // SunCalc azimuth -PI/2 = due east.
    const [east, south] = sunShadowOffsetPerMetre(-Math.PI / 2, Math.PI / 4)!;
    expect(east).toBeCloseTo(-1, 6); // negative east = west
    expect(south).toBeCloseTo(0, 6);
  });

  it('returns null only when the sun is at or below the horizon', () => {
    expect(sunShadowOffsetPerMetre(0, 0)).toBeNull();
    expect(sunShadowOffsetPerMetre(0, -0.01)).toBeNull();
    // Just above the horizon still casts (a long, clamped shadow).
    expect(sunShadowOffsetPerMetre(0, 0.02)).not.toBeNull();
  });

  it('clamps the shadow length near the horizon instead of exploding', () => {
    const [, south] = sunShadowOffsetPerMetre(0, 0.001)!; // ~0.06°, 1/tan huge
    // Bounded by MAX_SHADOW_INVTAN (26), not the ~1000 an unclamped 1/tan gives.
    expect(Math.abs(south)).toBeLessThanOrEqual(26);
    expect(Math.abs(south)).toBeGreaterThan(20); // still near the cap
  });
});

describe('shadowOpacityForAltitude', () => {
  it('is full while the sun is high and zero at the horizon', () => {
    expect(shadowOpacityForAltitude(SHADOW_FADE_START_RAD)).toBe(1);
    expect(shadowOpacityForAltitude(Math.PI / 4)).toBe(1);
    expect(shadowOpacityForAltitude(0)).toBe(0);
  });

  it('fades monotonically as the sun descends toward the horizon', () => {
    const high = shadowOpacityForAltitude(SHADOW_FADE_START_RAD * 0.75);
    const low = shadowOpacityForAltitude(SHADOW_FADE_START_RAD * 0.25);
    expect(high).toBeGreaterThan(low);
    expect(low).toBeGreaterThan(0);
  });
});

describe('nightFactorForAltitude', () => {
  it('is 0 while the sun is high enough to cast full shadows', () => {
    expect(nightFactorForAltitude(SHADOW_FADE_START_RAD)).toBe(0);
    expect(nightFactorForAltitude(Math.PI / 4)).toBe(0);
  });

  it('is 1 at and below full-night altitude', () => {
    expect(nightFactorForAltitude(NIGHT_FULL_ALTITUDE_RAD)).toBe(1);
    expect(nightFactorForAltitude(NIGHT_FULL_ALTITUDE_RAD - 0.5)).toBe(1);
  });

  it('ramps monotonically through the horizon between the two anchors', () => {
    const horizon = nightFactorForAltitude(0);
    expect(horizon).toBeGreaterThan(0);
    expect(horizon).toBeLessThan(1);
    // Deeper below the horizon is always darker.
    const belowCivil = nightFactorForAltitude((-6 * Math.PI) / 180);
    expect(belowCivil).toBeGreaterThan(horizon);
  });
});

describe('prepareShadowBuilding', () => {
  // ~20 m square footprint around the pin.
  const square: LatLng[] = [
    { lat: PIN.lat, lng: PIN.lng },
    { lat: PIN.lat, lng: PIN.lng + 0.00025 },
    { lat: PIN.lat + 0.00018, lng: PIN.lng + 0.00025 },
    { lat: PIN.lat + 0.00018, lng: PIN.lng },
  ];

  it('triangulates a square footprint into two triangles', () => {
    const b = prepareShadowBuilding(PIN, square, 15);
    expect(b).not.toBeNull();
    expect(b!.ring).toHaveLength(8); // 4 points × 2 coords
    expect(b!.tris).toHaveLength(6); // 2 triangles × 3 indices
  });

  it('drops a duplicated closing vertex', () => {
    const closed = [...square, square[0]];
    const b = prepareShadowBuilding(PIN, closed, 15);
    expect(b!.ring).toHaveLength(8);
  });

  it('rejects degenerate or zero-height footprints', () => {
    expect(prepareShadowBuilding(PIN, square, 0)).toBeNull();
    expect(prepareShadowBuilding(PIN, square.slice(0, 2), 15)).toBeNull();
  });
});

describe('buildShadowMesh', () => {
  const square: LatLng[] = [
    { lat: PIN.lat, lng: PIN.lng },
    { lat: PIN.lat, lng: PIN.lng + 0.00025 },
    { lat: PIN.lat + 0.00018, lng: PIN.lng + 0.00025 },
    { lat: PIN.lat + 0.00018, lng: PIN.lng },
  ];

  it('emits base + roof + edge triangles, all on the ground plane', () => {
    const b = prepareShadowBuilding(PIN, square, 10)!;
    const mesh = buildShadowMesh([b], [0, -1]); // shadow northward, 10 m long

    // base(6) + roof(6) + edges(4 × 6) = 36 vertices × 3 floats.
    expect(mesh).toHaveLength(36 * 3);

    // Every Y coordinate is 0 (flat ground shadow).
    for (let i = 1; i < mesh.length; i += 3) {
      expect(mesh[i]).toBe(0);
    }
  });

  it('offsets the projected roof by height × offset', () => {
    const b = prepareShadowBuilding(PIN, square, 10)!;
    const mesh = buildShadowMesh([b], [0, -1]);
    // Roof triangles start after the 6 base vertices (18 floats in).
    // Their Z should be the base Z minus 10 (offset −1 × height 10).
    const baseZ0 = mesh[2];
    const roofZ0 = mesh[18 + 2];
    expect(roofZ0).toBeCloseTo(baseZ0 - 10, 5);
  });
});
