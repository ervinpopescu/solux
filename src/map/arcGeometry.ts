import SunCalc from 'suncalc';
import type { LatLng, SolarTimes, TimeWindow } from '../types';

// Visual radius of the arc in metres from the pin. At city zoom + 45° pitch
// this floats the arc at a comfortable height above rooftop level.
const ARC_RADIUS_M = 400;

// Sampling interval. 5-minute steps give 288 points max for a full-day arc,
// which is enough for smooth curvature without excessive geometry.
const STEP_MIN = 5;

export type ArcPhase =
  | 'twilight'
  | 'blue_hour'
  | 'golden_hour'
  | 'soft_light'
  | 'late'
  | 'midday';

// Per-phase arc colour — a photographer's light scale. The arc's colour *is*
// the data: each hue is the actual quality of light at that moment, so the
// warm gold of golden hour and the cool wash of blue hour read at a glance.
// Twilight is lifted off pure navy so it stays visible on the dark basemap.
export const PHASE_COLORS: Record<ArcPhase, number> = {
  twilight:     0x2a3a66,
  blue_hour:    0x4f8fe6,
  golden_hour:  0xff9e2c,
  soft_light:   0xe8c79a,
  late:         0xf0ddc8,
  midday:       0xfdf6e3, // warm white, not clinical
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
// SunCalc azimuth convention: 0 = south, -PI/2 = east, PI/2 = west, ±PI = north.
// Three.js space (before MapLibre's coordinate transform): X = east, Y = up,
// Z = south (so -Z points north). The MapLibre custom layer transform
// (rotateX(PI/2) + scale(s, -s, s)) maps this to mercator space correctly.

/**
 * Converts a SunCalc position to Three.js-space XYZ offsets in metres.
 * The origin is the pin; Y is altitude above ground.
 */
export function sunToThreeXYZ(
  suncalcAzimuth: number,  // radians, SunCalc convention: south=0, west=PI/2
  suncalcAltitude: number, // radians above horizon
  radiusM: number = ARC_RADIUS_M,
): [number, number, number] {
  // Convert SunCalc azimuth (from south) to compass bearing (from north):
  // south=0 + PI → south=PI; east=-PI/2 + PI → east=PI/2. ✓
  const bearing = suncalcAzimuth + Math.PI;
  const horizDist = radiusM * Math.cos(suncalcAltitude);
  const x =  horizDist * Math.sin(bearing); // east
  const y =  radiusM   * Math.sin(suncalcAltitude); // altitude
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
  if (inWindow(t, times.blueHourMorning) || inWindow(t, times.blueHourEvening))
    return 'blue_hour';
  if (inWindow(t, times.goldenHourMorning) || inWindow(t, times.goldenHourEvening))
    return 'golden_hour';
  if (inWindow(t, times.softLightMorning) || inWindow(t, times.softLightEvening))
    return 'soft_light';
  if (inWindow(t, times.lateMorning) || inWindow(t, times.lateAfternoon))
    return 'late';
  // Before civil dawn or after civil dusk the sky is still dark twilight.
  if (times.civilDawn && t < times.civilDawn) return 'twilight';
  if (times.civilDusk && t > times.civilDusk) return 'twilight';
  // When civilDawn/civilDusk are null (polar summer), times outside all phase
  // windows fall through to 'midday'. Callers must not classify below-horizon
  // times; buildArcSamples guards altitude > 0 before calling this function.
  return 'midday';
}

// ── Arc sample building ────────────────────────────────────────────────────

/**
 * Samples the sun's position every `STEP_MIN` minutes across the day and
 * returns one `ArcSample` per above-horizon position.
 *
 * @param dayStartUtc - UTC instant corresponding to local midnight at the pin.
 *   Must be the start of the local day (midnight), not noon or any other offset;
 *   the function samples exactly 1440 minutes (24 h) forward from this instant.
 */
export function buildArcSamples(
  pin: LatLng,
  dayStartUtc: Date,
  solarTimes: SolarTimes,
): ArcSample[] {
  const samples: ArcSample[] = [];

  for (let m = 0; m < 1440; m += STEP_MIN) {
    const t = new Date(dayStartUtc.getTime() + m * 60_000);
    const pos = SunCalc.getPosition(t, pin.lat, pin.lng);
    if (pos.altitude <= 0) continue;

    const [xM, yM, zM] = sunToThreeXYZ(pos.azimuth, pos.altitude);
    samples.push({
      xM, yM, zM,
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
): [number, number, number] | null {
  const t = new Date(dayStartUtc.getTime() + minuteOfDay * 60_000);
  const pos = SunCalc.getPosition(t, pin.lat, pin.lng);
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
export function buildArcMarkers(
  pin: LatLng,
  dayStartUtc: Date,
  solarTimes: SolarTimes,
): ArcMarker[] {
  const markers: ArcMarker[] = [];
  const add = (when: Date | null, kind: ArcMarkerKind, clampToHorizon: boolean) => {
    if (!when) return;
    const pos = SunCalc.getPosition(when, pin.lat, pin.lng);
    const altitude = clampToHorizon ? Math.max(pos.altitude, 0) : pos.altitude;
    if (altitude < 0) return; // noon below horizon (deep polar winter) → skip
    markers.push({ pos: sunToThreeXYZ(pos.azimuth, altitude), kind });
  };
  add(solarTimes.sunrise, 'sunrise', true);
  add(solarTimes.solarNoon, 'noon', false);
  add(solarTimes.sunset, 'sunset', true);
  return markers;
}
