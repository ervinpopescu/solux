// ==============================================================================
// Solar calculations
// ==============================================================================
//
// This module is the pure-math heart of Solux. Given a lat/lng and a date, it
// returns a `SolarTimes` record with absolute UTC `Date` instants for every
// solar phase we care about: sunrise, sunset, the two golden-hour windows,
// the two blue-hour windows, and the three twilight definitions (civil,
// nautical, astronomical).
//
// It contains NO React, NO timezone handling, and NO `Date.now()` — it is a
// pure function of its inputs, which makes it trivially unit-testable and
// safely memoizable.
//
// ## SunCalc background
//
// We delegate the actual celestial mechanics to the `suncalc` library, which
// implements NOAA's solar position algorithm. Its `getTimes(date, lat, lng)`
// call returns an object keyed by named phase. The mapping from those keys to
// our domain concepts is the non-obvious work this file does:
//
//                 SunCalc key          What it really is
//   ─────────────────────────────────────────────────────────────────────────
//     dawn                              Civil dawn (sun at -6° before sunrise)
//     sunrise                           Top of sun crosses horizon (rising)
//     sunriseEnd                        Bottom of sun crosses horizon (rising)
//     goldenHourEnd                     End of MORNING golden hour
//     solarNoon                         Sun is at its highest point
//     goldenHour                        Start of EVENING golden hour
//     sunsetStart                       Bottom of sun crosses horizon (setting)
//     sunset                            Top of sun crosses horizon (setting)
//     dusk                              Civil dusk (sun at -6° after sunset)
//     nauticalDawn / nauticalDusk       Sun at -12°
//     nightEnd / night                  Astronomical (-18°): full darkness
//
// Photographer-friendly conventions, which is what we expose:
//
//   Morning golden hour = `sunriseEnd` → `goldenHourEnd`
//   Evening golden hour = `goldenHour`  → `sunsetStart`
//   Morning blue   hour = `dawn`        → `sunrise`
//   Evening blue   hour = `sunset`      → `dusk`
//
// ## Polar regions
//
// Near the poles, some phases simply don't occur on a given date (e.g. polar
// summer has no sunset). SunCalc signals this by returning a `Date` whose
// `getTime()` is `NaN` (an "Invalid Date"). We normalize that to `null` so
// downstream code can branch on presence instead of probing for NaN.

import SunCalc from 'suncalc';
import type { LatLng, SolarTimes, TimeWindow } from '../types';

// Register the "soft light" elevation. SunCalc accepts custom sun-altitude
// crossings on top of its standard set; we register the sun-at-12° crossings
// so we can surface the warm-but-not-yet-golden hour that flanks the strict
// golden hour at sun-at-6°.
//
//                  morning timeline (sun rising)
//   sunrise(0°) → goldenHourEnd(6°) → softLightEndMorning(12°) → ... noon
//   |__ blue __|__ golden ___________|__ soft ___________________|
//
//                  evening timeline (sun falling)
//   noon ... → softLightStartEvening(12°) → goldenHour(6°) → sunsetStart(0°)
//                |__ soft _____________|__ golden _________|__ sunset →
//
// We register at module load. SunCalc keeps the custom list in a shared
// module-level array, so registering on every call would duplicate it.
SunCalc.addTime(12, 'softLightEndMorning', 'softLightStartEvening');

// A second custom event at 24° marks the boundary between still-flat midday
// light and the late-morning / late-afternoon band where the sun has
// dropped low enough to start producing pleasant directional light without
// yet being "soft" or "golden".
SunCalc.addTime(24, 'lateMorningEnd', 'lateAfternoonStart');

// SunCalc's `.d.ts` doesn't know about our custom keys, so we widen the
// return type at the single site that needs them. `getTimes` always returns
// extra entries for every `addTime` registration; the keys exist at runtime.
type ExtendedTimes = ReturnType<typeof SunCalc.getTimes> & {
  softLightEndMorning: Date;
  softLightStartEvening: Date;
  lateMorningEnd: Date;
  lateAfternoonStart: Date;
};

// SunCalc's `.d.ts` types every key as `Date`, but in practice each one may
// be an Invalid Date. This helper makes the nullability explicit.
function nullIfInvalid(d: Date): Date | null {
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d : null;
}

// Build a TimeWindow only if both endpoints are valid. If either side is
// missing (polar edge cases), the whole window is `null` — we never report
// a half-defined phase.
function makeWindow(start: Date, end: Date): TimeWindow | null {
  const s = nullIfInvalid(start);
  const e = nullIfInvalid(end);
  return s && e ? { start: s, end: e } : null;
}

/**
 * Compute solar phase times for a location/date.
 *
 * @param latLng  WGS-84 latitude/longitude in degrees.
 * @param date    Any `Date` on the target calendar day. SunCalc resolves the
 *                day boundaries using UTC noon at the given location, so the
 *                exact time-of-day of this input doesn't affect the result
 *                as long as it falls on the intended civil day at the pin.
 */
export function computeSolarTimes(latLng: LatLng, date: Date): SolarTimes {
  const t = SunCalc.getTimes(date, latLng.lat, latLng.lng) as ExtendedTimes;

  return {
    sunrise: nullIfInvalid(t.sunrise),
    sunset: nullIfInvalid(t.sunset),
    solarNoon: nullIfInvalid(t.solarNoon),

    // Late morning / late afternoon: sun between ~12° and ~24°. This is
    // the broader pleasant-light window photographers often call "late
    // afternoon" (or "magic hour" in its loose sense) in the evening; it's
    // brighter and less warm than the soft-light or golden bands but still
    // a more flattering light than harsh midday.
    lateMorning:  makeWindow(t.softLightEndMorning, t.lateMorningEnd),
    lateAfternoon: makeWindow(t.lateAfternoonStart, t.softLightStartEvening),

    // Soft light: warm directional light just outside the strict golden
    // hour. Morning runs from sun-at-6° (golden hour ends) up to sun-at-12°
    // (light goes neutral). Evening is the reverse: from sun-at-12°
    // (warmth begins) down to sun-at-6° (golden hour starts) — this is the
    // "evening pre-golden" window users often shoot in too.
    softLightMorning: makeWindow(t.goldenHourEnd, t.softLightEndMorning),
    softLightEvening: makeWindow(t.softLightStartEvening, t.goldenHour),

    // Morning golden hour brackets the period after the sun has fully cleared
    // the horizon (`sunriseEnd`) and before it climbs past the ~6° altitude
    // at which the warm directional light gives way to "regular" daylight.
    goldenHourMorning: makeWindow(t.sunriseEnd, t.goldenHourEnd),

    // Evening golden hour is the reverse — from when the sun drops back below
    // ~6° to when its bottom edge touches the horizon.
    goldenHourEvening: makeWindow(t.goldenHour, t.sunsetStart),

    // Blue hour: between civil twilight and sun-on-horizon.
    blueHourMorning: makeWindow(t.dawn, t.sunrise),
    blueHourEvening: makeWindow(t.sunset, t.dusk),

    civilDawn: nullIfInvalid(t.dawn),
    civilDusk: nullIfInvalid(t.dusk),
    nauticalDawn: nullIfInvalid(t.nauticalDawn),
    nauticalDusk: nullIfInvalid(t.nauticalDusk),
    astroDawn: nullIfInvalid(t.nightEnd),
    astroDusk: nullIfInvalid(t.night),
  };
}

/**
 * Convenience: given an ISO `yyyy-mm-dd` string, build a `Date` that lands
 * unambiguously on that calendar day everywhere in the world. We anchor at
 * 12:00 UTC because no IANA timezone has an offset large enough to push a
 * noon-UTC instant into a different civil day. That makes this safe to feed
 * into `computeSolarTimes` regardless of the pin's local timezone.
 */
export function isoDateToNoonUtc(iso: string): Date {
  // Expect "YYYY-MM-DD"; constructing with `T12:00:00Z` is portable across
  // Date implementations and avoids parsing-ambiguity warnings.
  return new Date(`${iso}T12:00:00Z`);
}
