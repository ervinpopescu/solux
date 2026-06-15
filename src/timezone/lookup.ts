// ==============================================================================
// Timezone resolution
// ==============================================================================
//
// Maps a lat/lng to an IANA timezone string (e.g. "Europe/London") using the
// `tz-lookup` library, which embeds a compact offline lookup table. This is
// preferable to a network call because solar timing is meaningful even in
// air-gapped or low-connectivity scenarios (photographers in the field).
//
// Edge case: `tz-lookup` throws for some open-ocean coordinates that fall
// outside its sampled polygons. We catch that and fall back to UTC so the
// app stays usable everywhere. The UI surfaces the fallback explicitly.

import tzLookup from 'tz-lookup';
import type { LatLng } from '../types';

export const UTC_FALLBACK = 'UTC';

/**
 * Resolve the IANA timezone identifier for a coordinate.
 *
 * Returns `'UTC'` for any input that `tz-lookup` cannot place (typically
 * deep-ocean coordinates far from coastlines). The UI is responsible for
 * communicating to the user when this fallback is in effect.
 */
export function ianaZoneFor(latLng: LatLng): string {
  try {
    return tzLookup(latLng.lat, latLng.lng);
  } catch {
    return UTC_FALLBACK;
  }
}
