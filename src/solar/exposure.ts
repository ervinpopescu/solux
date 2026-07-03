// ==============================================================================
// Sun exposure — is the pin in direct sun or building shadow right now?
// ==============================================================================
//
// This is the practical photographer's question: "standing at this spot, is
// the sun actually hitting me at this time, or is that building to the west
// blocking it?" We answer it by comparing the sun's altitude against the
// obstruction angle of the surrounding buildings *in the sun's direction*,
// using the same horizon profile that drives the effective sunrise/sunset
// calculation — so the badge and the panel always agree.

import SunCalc from 'suncalc';
import type { HorizonProfile, LatLng } from '../types';
import { obstructionAtSunAzimuth } from '../buildings/horizon';

const DEG = 180 / Math.PI;

export type SunExposure =
  // Sun is geometrically below the horizon — night, or pre-dawn/post-dusk.
  | { state: 'below_horizon'; sunAltitudeDeg: number }
  // Sun is up AND clears the local building horizon: the spot is sunlit.
  // `clearanceDeg` is how far above the obstruction the sun sits.
  | { state: 'lit'; sunAltitudeDeg: number; obstructionDeg: number; clearanceDeg: number }
  // Sun is up but a building blocks it: the spot is in shadow. `deficitDeg`
  // is how far below the obstruction the sun sits (how much it must still
  // climb, or how far it has already dropped, to reach the spot).
  | { state: 'shadow'; sunAltitudeDeg: number; obstructionDeg: number; deficitDeg: number };

/**
 * Determine whether the pin is in direct sun or building shadow at `instant`.
 *
 * `profile` may be `null` while the building horizon is still loading (or when
 * there are no buildings); we then treat the horizon as flat, so the answer
 * reduces to "is the sun above the true horizon". This degrades gracefully:
 * the badge shows lit/below-horizon and upgrades to shadow-aware once the
 * profile arrives.
 */
export function sunExposureAt(
  pin: LatLng,
  instant: Date,
  profile: HorizonProfile | null,
): SunExposure {
  const { altitude, azimuth } = SunCalc.getPosition(instant, pin.lat, pin.lng);
  const sunAltitudeDeg = altitude * DEG;

  if (altitude <= 0) {
    return { state: 'below_horizon', sunAltitudeDeg };
  }

  const obstructionDeg = profile ? obstructionAtSunAzimuth(profile, azimuth) * DEG : 0;
  const marginDeg = sunAltitudeDeg - obstructionDeg;

  return marginDeg > 0
    ? { state: 'lit', sunAltitudeDeg, obstructionDeg, clearanceDeg: marginDeg }
    : { state: 'shadow', sunAltitudeDeg, obstructionDeg, deficitDeg: -marginDeg };
}
