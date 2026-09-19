import * as SunCalc from 'suncalc';
import type { LatLng, SolarTimes, TimeWindow } from '../types';
import { ianaZoneFor } from '../timezone/lookup';

// Visual radius of the arc in metres from the pin. At city zoom + 45° pitch
// this floats the arc at a comfortable height above rooftop level.
const ARC_RADIUS_M = 400;

// Sampling interval. 5-minute steps give 288 points max for a full-day arc,
// which is enough for smooth curvature without excessive geometry.
const STEP_MIN = 5;
const RAD = Math.PI / 180;

/** Convert SunCalc 2's degree/compass output to the radians used by map geometry. */
function sunPositionRadians(date: Date, pin: LatLng): { azimuth: number; altitude: number } {
  const { azimuth, altitude } = SunCalc.getPosition(date, pin.lat, pin.lng);
  return {
    // Internal geometry retains the legacy SunCalc convention: south=0,
    // east=-PI/2, west=PI/2. SunCalc 2 reports compass bearings instead.
    azimuth: azimuth * RAD - Math.PI,
    altitude: altitude * RAD,
  };
}

export type ArcPhase = 'twilight' | 'blue_hour' | 'golden_hour' | 'soft_light' | 'late' | 'midday';

// Per-phase arc colour — a photographer's light scale. The arc's colour *is*
// the data: each hue is the actual quality of light at that moment, so the
// warm gold of golden hour and the cool wash of blue hour read at a glance.
// Twilight is lifted off pure navy so it stays visible on the dark basemap.
export const PHASE_COLORS: Record<ArcPhase, number> = {
  twilight: 0x2a3a66,
  blue_hour: 0x4f8fe6,
  golden_hour: 0xff9e2c,
  soft_light: 0xe8c79a,
  late: 0xf0ddc8,
  midday: 0xfdf6e3, // warm white, not clinical
};

export type ArcSample = {
  /** Metres east of pin (positive = east). */
  xM: number;
  /** Metres above ground (positive = up). */
  yM: number;
  /** Metres south of pin (positive = south, negative = north). */
  zM: number;
  phase: ArcPhase;
  minuteOfDay: number;
};

// ── Coordinate conversion ──────────────────────────────────────────────────
//
// Internal sun azimuth convention: 0 = south, -PI/2 = east, PI/2 = west, ±PI = north.
// Three.js space (before MapLibre's coordinate transform): X = east, Y = up,
// Z = south (so -Z points north). The MapLibre custom layer transform
// (rotateX(PI/2) + scale(s, -s, s)) maps this to mercator space correctly.

/**
 * Converts a SunCalc position to Three.js-space XYZ offsets in metres.
 * The origin is the pin; Y is altitude above ground.
 */
export function sunToThreeXYZ(
  suncalcAzimuth: number, // radians, SunCalc convention: south=0, west=PI/2
  suncalcAltitude: number, // radians above horizon
  radiusM: number = ARC_RADIUS_M,
): [number, number, number] {
  // Convert SunCalc azimuth (from south) to compass bearing (from north):
  // south=0 + PI → south=PI; east=-PI/2 + PI → east=PI/2. ✓
  const bearing = suncalcAzimuth + Math.PI;
  const horizDist = radiusM * Math.cos(suncalcAltitude);
  const x = horizDist * Math.sin(bearing); // east
  const y = radiusM * Math.sin(suncalcAltitude); // altitude
  const z = -horizDist * Math.cos(bearing); // south (-cos because bearing=0 is north)
  return [x, y, z];
}

// ── Phase classification ───────────────────────────────────────────────────

function inWindow(t: Date, w: TimeWindow | null): boolean {
  return w !== null && t >= w.start && t <= w.end;
}

/** Returns the solar phase the sun is in at time `t` for the given day. */
export function classifyPhase(t: Date, times: SolarTimes): ArcPhase {
  // Check specific phase windows from narrowest (most distinctive) to widest.
  if (inWindow(t, times.blueHourMorning) || inWindow(t, times.blueHourEvening)) return 'blue_hour';
  if (inWindow(t, times.goldenHourMorning) || inWindow(t, times.goldenHourEvening))
    return 'golden_hour';
  if (inWindow(t, times.softLightMorning) || inWindow(t, times.softLightEvening))
    return 'soft_light';
  if (inWindow(t, times.lateMorning) || inWindow(t, times.lateAfternoon)) return 'late';
  // Before civil dawn or after civil dusk the sky is still dark twilight.
  if (times.civilDawn && t < times.civilDawn) return 'twilight';
  if (times.civilDusk && t > times.civilDusk) return 'twilight';
  // When civilDawn/civilDusk are null (polar summer), times outside all phase
  // windows fall through to 'midday'. Callers must not classify below-horizon
  // times; buildArcSamples guards altitude > 0 before calling this function.
  return 'midday';
}

// ── Arc sample building ────────────────────────────────────────────────────

interface ZoneOffsetHelper {
  getOffsetMs(date: Date): number;
  dateForMinuteOfDay(dayStartUtc: Date, minuteOfDay: number): Date;
}

function getZoneHelper(timeZone: string): ZoneOffsetHelper {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hour12: false,
  });

  function getOffsetMs(date: Date): number {
    const parts = dtf.formatToParts(date);
    let year = 0,
      month = 0,
      day = 0,
      hour = 0,
      minute = 0,
      second = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const val = parseInt(p.value, 10);
      switch (p.type) {
        case 'year':
          year = val;
          break;
        case 'month':
          month = val;
          break;
        case 'day':
          day = val;
          break;
        case 'hour':
          hour = val === 24 ? 0 : val;
          break;
        case 'minute':
          minute = val;
          break;
        case 'second':
          second = val;
          break;
      }
    }
    const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    return localAsUtc - date.getTime();
  }

  function getLocalDateParts(date: Date): { year: number; month: number; day: number } {
    const parts = dtf.formatToParts(date);
    let year = 0,
      month = 0,
      day = 0;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const val = parseInt(p.value, 10);
      if (p.type === 'year') year = val;
      else if (p.type === 'month') month = val;
      else if (p.type === 'day') day = val;
    }
    return { year, month, day };
  }

  function dateForMinuteOfDay(dayStartUtc: Date, minuteOfDay: number): Date {
    const { year, month, day } = getLocalDateParts(dayStartUtc);
    const baseLocalMs = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
    const targetLocalMs = baseLocalMs + minuteOfDay * 60_000;
    const offsetStart = getOffsetMs(dayStartUtc);
    let utcMs = targetLocalMs - offsetStart;
    const offset = getOffsetMs(new Date(utcMs));
    utcMs = targetLocalMs - offset;
    const refined = getOffsetMs(new Date(utcMs));
    if (refined !== offset) {
      utcMs = targetLocalMs - refined;
    }
    return new Date(utcMs);
  }

  return { getOffsetMs, dateForMinuteOfDay };
}

/**
 * Resolves a local wall-clock minute of day (0..1439) to the corresponding UTC Date instant,
 * correctly accounting for daylight saving time (DST) transitions (23-hour spring-forward
 * or 25-hour fall-back days).
 */
export function dateForMinuteOfDay(
  dayStartUtc: Date,
  minuteOfDay: number,
  timeZone?: string,
): Date {
  if (!timeZone || timeZone === 'UTC') {
    return new Date(dayStartUtc.getTime() + minuteOfDay * 60_000);
  }
  try {
    const helper = getZoneHelper(timeZone);
    const offsetStart = helper.getOffsetMs(dayStartUtc);
    const estEndUtc = new Date(dayStartUtc.getTime() + 25 * 3600_000);
    const offsetEnd = helper.getOffsetMs(estEndUtc);
    if (offsetStart === offsetEnd) {
      return new Date(dayStartUtc.getTime() + minuteOfDay * 60_000);
    }
    return helper.dateForMinuteOfDay(dayStartUtc, minuteOfDay);
  } catch {
    return new Date(dayStartUtc.getTime() + minuteOfDay * 60_000);
  }
}

/**
 * Creates a resolver mapping local wall-clock minuteOfDay to UTC Date instants,
 * short-circuiting to linear minute offsets on days without DST transitions.
 */
export function createMinuteToUtcResolver(
  dayStartUtc: Date,
  timeZone?: string,
): (minuteOfDay: number) => Date {
  if (!timeZone || timeZone === 'UTC') {
    return (m: number) => new Date(dayStartUtc.getTime() + m * 60_000);
  }
  try {
    const helper = getZoneHelper(timeZone);
    const offsetStart = helper.getOffsetMs(dayStartUtc);
    const estEndUtc = new Date(dayStartUtc.getTime() + 25 * 3600_000);
    const offsetEnd = helper.getOffsetMs(estEndUtc);
    if (offsetStart === offsetEnd) {
      return (m: number) => new Date(dayStartUtc.getTime() + m * 60_000);
    }
    return (m: number) => helper.dateForMinuteOfDay(dayStartUtc, m);
  } catch {
    return (m: number) => new Date(dayStartUtc.getTime() + m * 60_000);
  }
}

/**
 * Samples the sun's position every `STEP_MIN` minutes across the day and
 * returns one `ArcSample` per above-horizon position.
 *
 * @param dayStartUtc - UTC instant corresponding to local midnight at the pin.
 * @param solarTimes - Solar phase timestamps for the day.
 * @param timeZone - Optional IANA timezone identifier; defaults to ianaZoneFor(pin).
 */
export function buildArcSamples(
  pin: LatLng,
  dayStartUtc: Date,
  solarTimes: SolarTimes,
  timeZone?: string,
): ArcSample[] {
  const zone = timeZone ?? ianaZoneFor(pin);
  const resolve = createMinuteToUtcResolver(dayStartUtc, zone);
  const samples: ArcSample[] = [];

  for (let m = 0; m < 1440; m += STEP_MIN) {
    const t = resolve(m);
    const pos = sunPositionRadians(t, pin);
    if (pos.altitude <= 0) continue;

    const [xM, yM, zM] = sunToThreeXYZ(pos.azimuth, pos.altitude);
    samples.push({
      xM,
      yM,
      zM,
      phase: classifyPhase(t, solarTimes),
      minuteOfDay: m,
    });
  }

  return samples;
}

/**
 * Returns the (xM, yM, zM) position of the sun at `minuteOfDay`, or null
 * if the sun is below the horizon at that time.
 */
export function sunPositionAtMinute(
  pin: LatLng,
  dayStartUtc: Date,
  minuteOfDay: number,
  timeZone?: string,
): [number, number, number] | null {
  const zone = timeZone ?? ianaZoneFor(pin);
  const t = dateForMinuteOfDay(dayStartUtc, minuteOfDay, zone);
  const pos = sunPositionRadians(t, pin);
  if (pos.altitude <= 0) return null;
  return sunToThreeXYZ(pos.azimuth, pos.altitude);
}

// ── Event waypoint markers ───────────────────────────────────────────────────

export type ArcMarkerKind = 'sunrise' | 'noon' | 'sunset';

export type ArcMarker = {
  /** Local-metre position on the arc (same frame as `ArcSample`). */
  pos: [number, number, number];
  kind: ArcMarkerKind;
};

/**
 * Positions of the sunrise, solar-noon, and sunset waypoints along the arc.
 *
 * Sunrise/sunset altitudes are clamped to 0 so their markers sit exactly on
 * the horizon ring — that's the informative bit for a photographer: the
 * compass direction where the sun clears / drops behind the skyline. Solar
 * noon uses its true (highest) altitude. Events that don't occur on the date
 * (polar day/night) are simply omitted.
 */
export function buildArcMarkers(pin: LatLng, solarTimes: SolarTimes): ArcMarker[] {
  const markers: ArcMarker[] = [];
  const add = (when: Date | null, kind: ArcMarkerKind, clampToHorizon: boolean) => {
    if (!when) return;
    const pos = sunPositionRadians(when, pin);
    const altitude = clampToHorizon ? Math.max(pos.altitude, 0) : pos.altitude;
    if (altitude < 0) return; // noon below horizon (deep polar winter) → skip
    markers.push({ pos: sunToThreeXYZ(pos.azimuth, altitude), kind });
  };
  add(solarTimes.sunrise, 'sunrise', true);
  add(solarTimes.solarNoon, 'noon', false);
  add(solarTimes.sunset, 'sunset', true);
  return markers;
}
