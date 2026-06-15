import { useMemo } from 'react';
import { ianaZoneFor, UTC_FALLBACK } from '../timezone/lookup';
import type { LatLng } from '../types';

/**
 * Memoized IANA-zone resolution for a coordinate.
 *
 * When no pin is set we return `'UTC'` rather than a `null`-ish value so that
 * downstream formatting code never has to short-circuit on a missing zone.
 */
export function useTimezone(pin: LatLng | null): string {
  return useMemo(() => (pin ? ianaZoneFor(pin) : UTC_FALLBACK), [pin?.lat, pin?.lng, pin]);
}
