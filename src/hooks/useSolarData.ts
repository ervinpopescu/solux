import { useMemo } from 'react';
import { computeSolarTimes, isoDateToNoonUtc } from '../solar/calc';
import type { LatLng, SolarTimes } from '../types';

function isValidIsoDate(isoDate: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (month < 1 || month > 12 || day < 1 || day > 31) return false;

  const date = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Memoized solar calculation hook.
 *
 * Returns `null` while no pin or date is selected, or if the date string is
 * invalid. Recomputes only when coordinates or date change — the calc itself
 * is cheap, but memoizing keeps referential stability for downstream `React.memo` consumers.
 */
export function useSolarData(pin: LatLng | null, isoDate: string): SolarTimes | null {
  return useMemo(() => {
    if (!pin || !isoDate || !isValidIsoDate(isoDate)) return null;
    return computeSolarTimes(pin, isoDateToNoonUtc(isoDate));
  }, [pin, isoDate]);
}
