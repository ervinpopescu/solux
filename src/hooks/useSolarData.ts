import { useMemo } from 'react';
import { computeSolarTimes, isoDateToNoonUtc } from '../solar/calc';
import type { LatLng, SolarTimes } from '../types';

/**
 * Memoized solar calculation hook.
 *
 * Returns `null` while no pin or date is selected. Recomputes only when
 * coordinates or date change — the calc itself is cheap, but memoizing keeps
 * referential stability for downstream `React.memo` consumers.
 */
export function useSolarData(pin: LatLng | null, isoDate: string): SolarTimes | null {
  return useMemo(() => {
    if (!pin || !isoDate) return null;
    return computeSolarTimes(pin, isoDateToNoonUtc(isoDate));
  }, [pin?.lat, pin?.lng, isoDate, pin]);
}
