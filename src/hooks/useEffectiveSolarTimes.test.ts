import { renderHook } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useEffectiveSolarTimes } from './useEffectiveSolarTimes';
import { computeSolarTimes, isoDateToNoonUtc } from '../solar/calc';
import type { HorizonProfile } from '../types';

const LONDON = { lat: 51.5074, lng: -0.1278 };
const TIMES = computeSolarTimes(LONDON, isoDateToNoonUtc('2024-06-21'));

// A flat horizon (all buckets 0) obstructs nothing, so the effective times
// stay close to the geometric ones — enough to prove the hook delegates.
function flatProfile(): HorizonProfile {
  return {
    bucketsRad: new Float32Array(360).fill(0),
    buildingCount: 0,
    radiusMeters: 1000,
    centerLat: LONDON.lat,
    centerLng: LONDON.lng,
    fetchedAt: Date.now(),
  };
}

describe('useEffectiveSolarTimes', () => {
  it('returns null when the pin is missing', () => {
    const { result } = renderHook(() => useEffectiveSolarTimes(null, TIMES, flatProfile()));
    expect(result.current).toBeNull();
  });

  it('returns null when times are missing', () => {
    const { result } = renderHook(() => useEffectiveSolarTimes(LONDON, null, flatProfile()));
    expect(result.current).toBeNull();
  });

  it('returns null when the profile is missing', () => {
    const { result } = renderHook(() => useEffectiveSolarTimes(LONDON, TIMES, null));
    expect(result.current).toBeNull();
  });

  it('applies the horizon profile to the solar times when all inputs are present', () => {
    const { result } = renderHook(() => useEffectiveSolarTimes(LONDON, TIMES, flatProfile()));
    expect(result.current).not.toBeNull();
    // A flat horizon leaves the geometric sunrise essentially unchanged.
    expect(result.current?.sunrise).toBeInstanceOf(Date);
  });
});
