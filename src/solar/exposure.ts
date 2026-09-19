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

import * as SunCalc from 'suncalc';
import type { HorizonProfile, LatLng } from '../types';
import { obstructionAtSunAzimuth } from '../buildings/horizon';

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

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
 * Meeus 16.4 atmospheric refraction formula used by SunCalc v2, in radians.
 * Valid for non-negative altitudes; clamped to 0 for negative altitudes.
 */
function astroRefractionRad(hRad: number): number {
  const h = hRad < 0 ? 0 : hRad;
  return 0.0002967 / Math.tan(h + 0.00312536 / (h + 0.08901179));
}

/**
 * Convert SunCalc v2 apparent (refraction-corrected) altitude in degrees back to
 * true geometric altitude in degrees.
 *
 * For geometric altitudes <= 0, SunCalc adds refraction at the horizon (R0) to the
 * geometric altitude. For positive altitudes, it adds Meeus 16.4 refraction.
 * Inverting this ensures that comparisons against the true horizon and geometric
 * building obstruction profiles are physically consistent and never classify
 * pre-dawn/post-dusk sun as "lit".
 */
export function apparentToGeometricAltitude(altitudeApparentDeg: number): number {
  const hAppRad = altitudeApparentDeg * RAD;
  const r0 = astroRefractionRad(0);
  if (hAppRad <= r0) {
    return (hAppRad - r0) * DEG;
  }
  let h = hAppRad - r0;
  for (let i = 0; i < 6; i++) {
    h = hAppRad - astroRefractionRad(h);
  }
  return h * DEG;
}

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
  // SunCalc 2 reports apparent altitude and compass azimuth in degrees.
  // Invert refraction to obtain geometric altitude so that comparisons
  // against the true horizon and geometric obstruction angles are consistent.
  const geometricAltitudeDeg = apparentToGeometricAltitude(altitude);
  const sunAltitudeDeg = geometricAltitudeDeg;
  const suncalcAzimuthRad = azimuth * RAD - Math.PI;

  if (sunAltitudeDeg <= 0) {
    return { state: 'below_horizon', sunAltitudeDeg };
  }

  const obstructionDeg = profile ? obstructionAtSunAzimuth(profile, suncalcAzimuthRad) * DEG : 0;
  const marginDeg = sunAltitudeDeg - obstructionDeg;

  return marginDeg > 0
    ? { state: 'lit', sunAltitudeDeg, obstructionDeg, clearanceDeg: marginDeg }
    : { state: 'shadow', sunAltitudeDeg, obstructionDeg, deficitDeg: -marginDeg };
}
