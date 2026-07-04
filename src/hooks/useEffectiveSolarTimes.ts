import { useMemo } from 'react';
import { applyHorizonToSolarTimes } from '../buildings/effective';
import type { HorizonProfile, LatLng, SolarTimes } from '../types';

/**
 * Returns a visibility-clipped copy of `times` when a horizon profile is
 * available; otherwise returns `null` (caller should fall back to the raw
 * geometric times).
 *
 * Memoized on the trio (pin, times, profile) so per-phase scans run at most
 * once per click or per loaded profile.
 */
export function useEffectiveSolarTimes(
  pin: LatLng | null,
  times: SolarTimes | null,
  profile: HorizonProfile | null,
): SolarTimes | null {
  return useMemo(() => {
    if (!pin || !times || !profile) return null;
    return applyHorizonToSolarTimes(pin, times, profile);
  }, [pin, times, profile]);
}
