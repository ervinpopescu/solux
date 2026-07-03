import { describe, expect, it } from 'vitest';
import { sunToThreeXYZ, classifyPhase, buildArcSamples, buildArcMarkers } from './arcGeometry';
import type { SolarTimes } from '../types';

// ── sunToThreeXYZ ──────────────────────────────────────────────────────────
// SunCalc azimuth convention: 0 = south, -PI/2 = east, PI/2 = west, ±PI = north.
// Three.js output: X = east, Y = altitude (up), Z = south (negative = north).

describe('sunToThreeXYZ', () => {
  it('sun on the eastern horizon → +X, Y=0, Z=0', () => {
    // azimuth = -PI/2 (east), altitude = 0
    const [x, y, z] = sunToThreeXYZ(-Math.PI / 2, 0, 100);
    expect(x).toBeCloseTo(100, 1);
    expect(y).toBeCloseTo(0, 5);
    expect(z).toBeCloseTo(0, 5);
  });

  it('sun on the southern horizon → X=0, Y=0, +Z', () => {
    // azimuth = 0 (south), altitude = 0
    const [x, y, z] = sunToThreeXYZ(0, 0, 100);
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(0, 5);
    expect(z).toBeCloseTo(100, 1);
  });

  it('sun at zenith → X=0, +Y=radius, Z=0', () => {
    const [x, y, z] = sunToThreeXYZ(0, Math.PI / 2, 100);
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(100, 1);
    expect(z).toBeCloseTo(0, 5);
  });

  it('sun at the northern horizon → X=0, Y=0, -Z', () => {
    // azimuth = PI (north), altitude = 0
    const [x, y, z] = sunToThreeXYZ(Math.PI, 0, 100);
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(0, 5);
    expect(z).toBeCloseTo(-100, 1);
  });

  it('sun on the western horizon → -X, Y=0, Z=0', () => {
    // azimuth = PI/2 (west), altitude = 0
    const [x, y, z] = sunToThreeXYZ(Math.PI / 2, 0, 100);
    expect(x).toBeCloseTo(-100, 1);
    expect(y).toBeCloseTo(0, 5);
    expect(z).toBeCloseTo(0, 5);
  });
});

// ── classifyPhase ──────────────────────────────────────────────────────────

function makeWindow(startH: number, endH: number): { start: Date; end: Date } {
  const base = new Date('2024-06-21T00:00:00Z');
  return {
    start: new Date(base.getTime() + startH * 3_600_000),
    end:   new Date(base.getTime() + endH   * 3_600_000),
  };
}

const TIMES: SolarTimes = {
  sunrise: new Date('2024-06-21T03:43:00Z'),
  sunset:  new Date('2024-06-21T20:21:00Z'),
  solarNoon: new Date('2024-06-21T12:01:00Z'),
  blueHourMorning:   makeWindow(3.0, 3.72),  // ~03:00–03:43
  goldenHourMorning: makeWindow(3.72, 5.2),  // ~03:43–05:12
  softLightMorning:  makeWindow(5.2, 6.5),
  lateMorning:       makeWindow(6.5, 10.5),
  lateAfternoon:     makeWindow(13.5, 17.5),
  softLightEvening:  makeWindow(17.5, 18.8),
  goldenHourEvening: makeWindow(18.8, 20.35),
  blueHourEvening:   makeWindow(20.35, 21.0),
  civilDawn:  new Date('2024-06-21T03:00:00Z'),
  civilDusk:  new Date('2024-06-21T21:00:00Z'),
  nauticalDawn: null, nauticalDusk: null,
  astroDawn: null,    astroDusk: null,
};

describe('classifyPhase', () => {
  it('classifies inside golden hour morning', () => {
    const t = new Date('2024-06-21T04:30:00Z');
    expect(classifyPhase(t, TIMES)).toBe('golden_hour');
  });

  it('classifies inside blue hour morning', () => {
    const t = new Date('2024-06-21T03:10:00Z');
    expect(classifyPhase(t, TIMES)).toBe('blue_hour');
  });

  it('classifies before civil dawn as twilight', () => {
    const t = new Date('2024-06-21T02:00:00Z');
    expect(classifyPhase(t, TIMES)).toBe('twilight');
  });

  it('classifies midday', () => {
    const t = new Date('2024-06-21T12:00:00Z');
    expect(classifyPhase(t, TIMES)).toBe('midday');
  });

  it('classifies inside soft light morning', () => {
    const t = new Date('2024-06-21T05:45:00Z'); // 05:45 UTC, inside softLightMorning (5.2–6.5h)
    expect(classifyPhase(t, TIMES)).toBe('soft_light');
  });

  it('classifies inside late morning', () => {
    const t = new Date('2024-06-21T08:00:00Z'); // 08:00 UTC, inside lateMorning (6.5–10.5h)
    expect(classifyPhase(t, TIMES)).toBe('late');
  });
});

// ── buildArcSamples ────────────────────────────────────────────────────────

describe('buildArcSamples', () => {
  const LONDON = { lat: 51.5074, lng: -0.1278 };
  // London 2024-06-21 midnight UTC (UTC+1, so local midnight = 23:00 UTC prev day)
  const DAY_START = new Date('2024-06-20T23:00:00Z');

  it('returns only above-horizon samples', () => {
    const samples = buildArcSamples(LONDON, DAY_START, TIMES);
    // Every sample must have positive altitude
    expect(samples.every(s => s.yM > 0)).toBe(true);
  });

  it('returns samples spread across the day', () => {
    const samples = buildArcSamples(LONDON, DAY_START, TIMES);
    // London midsummer has ~17 h of daylight; at 5-min steps that is ~204 samples
    expect(samples.length).toBeGreaterThan(100);
    expect(samples.length).toBeLessThan(290); // max possible is 288
  });

  it('assigns phases from the provided SolarTimes', () => {
    const samples = buildArcSamples(LONDON, DAY_START, TIMES);
    const phases = new Set(samples.map(s => s.phase));
    // Should see at least golden hour and midday on a long summer day
    expect(phases.has('golden_hour')).toBe(true);
    expect(phases.has('midday')).toBe(true);
  });
});

// ── buildArcMarkers ────────────────────────────────────────────────────────

describe('buildArcMarkers', () => {
  const LONDON = { lat: 51.5074, lng: -0.1278 };
  const DAY_START = new Date('2024-06-20T23:00:00Z');

  it('emits one marker per event, in sunrise/noon/sunset order', () => {
    const markers = buildArcMarkers(LONDON, DAY_START, TIMES);
    expect(markers.map(m => m.kind)).toEqual(['sunrise', 'noon', 'sunset']);
  });

  it('pins sunrise and sunset onto the horizon (Y≈0) but lifts noon above it', () => {
    const markers = buildArcMarkers(LONDON, DAY_START, TIMES);
    const byKind = Object.fromEntries(markers.map(m => [m.kind, m.pos]));
    expect(byKind.sunrise[1]).toBeCloseTo(0, 1); // Y = altitude, clamped to horizon
    expect(byKind.sunset[1]).toBeCloseTo(0, 1);
    expect(byKind.noon[1]).toBeGreaterThan(50); // London midsummer noon sun is high
  });

  it('omits events that do not occur on the date', () => {
    const noSunset: SolarTimes = { ...TIMES, sunset: null };
    const markers = buildArcMarkers(LONDON, DAY_START, noSunset);
    expect(markers.map(m => m.kind)).toEqual(['sunrise', 'noon']);
  });
});
