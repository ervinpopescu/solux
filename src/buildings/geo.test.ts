import { describe, expect, it } from 'vitest';
import { bearingDeg, distanceMetres } from './geo';

const LONDON: { lat: number; lng: number } = { lat: 51.5074, lng: -0.1278 };
const PARIS: { lat: number; lng: number }  = { lat: 48.8566, lng:  2.3522 };
// Exact same point
const IDENT  = { lat: 51.5074, lng: -0.1278 };

describe('distanceMetres', () => {
  it('returns 0 for identical coordinates', () => {
    expect(distanceMetres(LONDON, IDENT)).toBeCloseTo(0, 0);
  });

  it('approximates London–Paris distance within 1 km', () => {
    // Widely cited value: ~341 km great-circle.
    const d = distanceMetres(LONDON, PARIS);
    expect(d).toBeGreaterThan(338_000);
    expect(d).toBeLessThan(344_000);
  });

  it('is symmetric', () => {
    const ab = distanceMetres(LONDON, PARIS);
    const ba = distanceMetres(PARIS, LONDON);
    expect(ab).toBeCloseTo(ba, 0);
  });

  it('handles antipodal points (roughly half Earth circumference)', () => {
    const north: { lat: number; lng: number } = { lat:  90, lng: 0 };
    const south: { lat: number; lng: number } = { lat: -90, lng: 0 };
    const d = distanceMetres(north, south);
    // Half Earth circumference ≈ 20_015 km.
    expect(d).toBeGreaterThan(19_900_000);
    expect(d).toBeLessThan(20_100_000);
  });
});

describe('bearingDeg', () => {
  const ref = { lat: 0, lng: 0 };

  it('returns ~0 for a point directly north', () => {
    expect(bearingDeg(ref, { lat: 1, lng: 0 })).toBeCloseTo(0, 0);
  });

  it('returns ~90 for a point directly east', () => {
    expect(bearingDeg(ref, { lat: 0, lng: 1 })).toBeCloseTo(90, 0);
  });

  it('returns ~180 for a point directly south', () => {
    expect(bearingDeg(ref, { lat: -1, lng: 0 })).toBeCloseTo(180, 0);
  });

  it('returns ~270 for a point directly west', () => {
    expect(bearingDeg(ref, { lat: 0, lng: -1 })).toBeCloseTo(270, 0);
  });

  it('stays within [0, 360)', () => {
    const b = bearingDeg(ref, { lat: -1, lng: -1 });
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThan(360);
  });
});
