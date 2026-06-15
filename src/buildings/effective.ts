// ==============================================================================
// Effective (visibility-corrected) sunrise / sunset
// ==============================================================================
//
// Given a geometric `SolarTimes` record and a `HorizonProfile`, find when
// the sun actually first becomes visible in the morning and last visible in
// the evening — i.e. when its altitude exceeds the obstruction angle at the
// sun's instantaneous azimuth.
//
// Why this matters: a photographer standing between buildings cares about
// the moment the sun's disk clears those buildings, not the moment it
// crosses the geometric horizon. The two can differ by many minutes in any
// city.
//
// Approach: a coarse minute-by-minute scan around the geometric event
// followed by a binary-search refinement to second precision. This is more
// than fast enough (a few hundred SunCalc.getPosition calls) and avoids
// pulling in a closed-form solver.

import SunCalc from 'suncalc';
import type {
  EffectiveVisibility,
  HorizonProfile,
  LatLng,
  SolarTimes,
  TimeWindow,
} from '../types';
import { obstructionAt } from './horizon';

/** Minutes scanned either side of the geometric event. */
const SCAN_HALF_WINDOW_MIN = 240;
/** Coarse step (ms). */
const STEP_MS = 60_000;
/** Final refinement precision (ms). */
const REFINE_PRECISION_MS = 1_000;

function isSunVisible(pin: LatLng, when: Date, profile: HorizonProfile): boolean {
  const { altitude, azimuth } = SunCalc.getPosition(when, pin.lat, pin.lng);
  return altitude > obstructionAt(profile, azimuth);
}

/**
 * Bisect between two times `vis` (visible) and `inv` (invisible) to find the
 * transition to <REFINE_PRECISION_MS. Order of arguments matters: `vis` is a
 * known-visible instant, `inv` is known-invisible. Returns the instant where
 * the transition occurs (the LATER of the visible/invisible pair after
 * convergence).
 */
function refine(
  pin: LatLng,
  vis: number,
  inv: number,
  profile: HorizonProfile,
): Date {
  let lo = vis;
  let hi = inv;
  while (Math.abs(hi - lo) > REFINE_PRECISION_MS) {
    const mid = (lo + hi) / 2;
    if (isSunVisible(pin, new Date(mid), profile)) lo = mid;
    else hi = mid;
  }
  // Return the first invisible-side instant for sunset, first visible-side
  // for sunrise. Both make sense as "the moment of transition"; we return
  // `lo` (the last-known-visible boundary), which is the most consumer-
  // friendly answer for both events: "sun is still visible at this time".
  return new Date(lo);
}

/**
 * Find the first instant within the scan window when the sun becomes
 * visible. Returns `null` if no transition occurs (perpetual obstruction
 * within the window — e.g. a deep urban canyon to the east).
 */
function findEffectiveSunrise(
  pin: LatLng,
  geometricSunrise: Date | null,
  profile: HorizonProfile,
): Date | null {
  if (!geometricSunrise) return null;

  const t0 = geometricSunrise.getTime() - SCAN_HALF_WINDOW_MIN * 60_000;
  const t1 = geometricSunrise.getTime() + SCAN_HALF_WINDOW_MIN * 60_000;

  let prevVisible = isSunVisible(pin, new Date(t0), profile);
  let prevT = t0;
  for (let t = t0 + STEP_MS; t <= t1; t += STEP_MS) {
    const visible = isSunVisible(pin, new Date(t), profile);
    if (!prevVisible && visible) {
      // Transition found between prevT and t. Note arg order: `vis` should
      // be the visible instant, `inv` the invisible. Refine reverses lo/hi.
      return refine(pin, t, prevT, profile);
    }
    prevVisible = visible;
    prevT = t;
  }
  return null;
}

/**
 * Find the last instant within the scan window when the sun is visible.
 * Returns `null` if the sun never becomes visible inside the window.
 */
function findEffectiveSunset(
  pin: LatLng,
  geometricSunset: Date | null,
  profile: HorizonProfile,
): Date | null {
  if (!geometricSunset) return null;

  const t0 = geometricSunset.getTime() - SCAN_HALF_WINDOW_MIN * 60_000;
  const t1 = geometricSunset.getTime() + SCAN_HALF_WINDOW_MIN * 60_000;

  let prevVisible = isSunVisible(pin, new Date(t0), profile);
  let prevT = t0;
  for (let t = t0 + STEP_MS; t <= t1; t += STEP_MS) {
    const visible = isSunVisible(pin, new Date(t), profile);
    if (prevVisible && !visible) {
      // Transition from visible → invisible between prevT and t.
      return refine(pin, prevT, t, profile);
    }
    prevVisible = visible;
    prevT = t;
  }
  return null;
}

/**
 * Compute the building-aware visibility events corresponding to the given
 * geometric `SolarTimes`.
 *
 * `obstructionAt{Sunrise,Sunset}Deg` reports the horizon-profile altitude at
 * the sun's azimuth at the GEOMETRIC sunrise/sunset moment — useful for the
 * UI to explain WHY the times shifted ("east obstruction: 7.4°").
 */
export function computeEffectiveVisibility(
  pin: LatLng,
  times: SolarTimes,
  profile: HorizonProfile,
): EffectiveVisibility {
  const obstrAtSunriseDeg = times.sunrise
    ? (obstructionAt(
        profile,
        SunCalc.getPosition(times.sunrise, pin.lat, pin.lng).azimuth,
      ) *
        180) /
      Math.PI
    : null;

  const obstrAtSunsetDeg = times.sunset
    ? (obstructionAt(
        profile,
        SunCalc.getPosition(times.sunset, pin.lat, pin.lng).azimuth,
      ) *
        180) /
      Math.PI
    : null;

  return {
    effectiveSunrise: findEffectiveSunrise(pin, times.sunrise, profile),
    effectiveSunset: findEffectiveSunset(pin, times.sunset, profile),
    obstructionAtSunriseDeg: obstrAtSunriseDeg,
    obstructionAtSunsetDeg: obstrAtSunsetDeg,
  };
}

// ==============================================================================
// Per-phase visibility adjustment
// ==============================================================================
//
// Apply a horizon profile to an entire `SolarTimes` record, producing a new
// record where every sun-direct phase has been clipped to the moments when
// the sun is actually visible from behind the building skyline.
//
// What gets adjusted:
//   - sunrise, sunset                 (visibility transitions; can shift hours)
//   - solar noon                      (rare, but possible at high latitudes)
//   - golden hour AM/PM               (sun visible within the geom window?)
//   - soft light AM/PM                (ditto)
//   - late morning / late afternoon   (ditto)
//
// What is NOT adjusted (passes through unchanged):
//   - Blue hour                       (sun is below horizon, this is sky color)
//   - Civil/nautical/astronomical     (twilight is atmospheric scattering;
//     dawn/dusk                       buildings can't block the sky)
//
// A phase whose entire geometric window is obstructed becomes `null`. The
// UI is expected to render "blocked" copy in that case rather than the
// silently-missing dash used for naturally-absent phases.

const VIS_SCAN_STEP_MS = 30_000;

/**
 * Clip a phase window to the times within it when the sun is visible above
 * the building horizon. Returns `null` if the sun is never visible in the
 * geometric window.
 */
function effectiveWindow(
  pin: LatLng,
  geom: TimeWindow | null,
  profile: HorizonProfile,
): TimeWindow | null {
  if (!geom) return null;

  let firstVisible: number | null = null;
  let lastVisible: number | null = null;

  // Inclusive endpoints — geometric phase boundaries can themselves be the
  // visible moments if the obstruction is just below the sun's altitude.
  for (
    let t = geom.start.getTime();
    t <= geom.end.getTime();
    t += VIS_SCAN_STEP_MS
  ) {
    if (isSunVisible(pin, new Date(t), profile)) {
      if (firstVisible === null) firstVisible = t;
      lastVisible = t;
    }
  }

  if (firstVisible === null || lastVisible === null) return null;
  return {
    start: new Date(firstVisible),
    end: new Date(lastVisible),
  };
}

/**
 * For a single-instant event (solar noon, etc.), pass it through if the sun
 * is visible at that moment, otherwise null it out.
 */
function effectiveInstant(
  pin: LatLng,
  geom: Date | null,
  profile: HorizonProfile,
): Date | null {
  if (!geom) return null;
  return isSunVisible(pin, geom, profile) ? geom : null;
}

/**
 * Apply the horizon profile to every sun-direct phase in `times`. Returns a
 * new `SolarTimes`-shaped record where:
 *
 *   - Twilight and blue-hour fields are copies of the geometric values.
 *   - Sun-direct fields are visibility-clipped (or `null` when blocked).
 *
 * Pass the original `times` alongside this result to the UI so it can show
 * "what was expected" vs "what's actually visible".
 */
export function applyHorizonToSolarTimes(
  pin: LatLng,
  times: SolarTimes,
  profile: HorizonProfile,
): SolarTimes {
  return {
    // --- visibility transitions (can shift well outside the geometric event)
    sunrise: findEffectiveSunrise(pin, times.sunrise, profile),
    sunset: findEffectiveSunset(pin, times.sunset, profile),

    // --- sun-direct point and window phases (clip to geometric window)
    solarNoon: effectiveInstant(pin, times.solarNoon, profile),
    goldenHourMorning: effectiveWindow(pin, times.goldenHourMorning, profile),
    goldenHourEvening: effectiveWindow(pin, times.goldenHourEvening, profile),
    softLightMorning: effectiveWindow(pin, times.softLightMorning, profile),
    softLightEvening: effectiveWindow(pin, times.softLightEvening, profile),
    lateMorning: effectiveWindow(pin, times.lateMorning, profile),
    lateAfternoon: effectiveWindow(pin, times.lateAfternoon, profile),

    // --- sky-only phases pass through (atmospheric scattering, not direct sun)
    blueHourMorning: times.blueHourMorning,
    blueHourEvening: times.blueHourEvening,
    civilDawn: times.civilDawn,
    civilDusk: times.civilDusk,
    nauticalDawn: times.nauticalDawn,
    nauticalDusk: times.nauticalDusk,
    astroDawn: times.astroDawn,
    astroDusk: times.astroDusk,
  };
}
