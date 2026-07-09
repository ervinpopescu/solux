// Shared domain types for Solux.
//
// These are intentionally pure data shapes — no React, no Leaflet — so they
// can be reused across the solar calculation, timezone, storage, and UI
// layers without dragging in unrelated dependencies.

export type LatLng = {
  lat: number;
  lng: number;
};

/** Which container the SolarInfo block is rendered in. User-selectable. */
export type DisplayMode = 'card' | 'drawer' | 'panel' | 'popup';

export const DISPLAY_MODES: ReadonlyArray<{ value: DisplayMode; label: string }> = [
  { value: 'card', label: 'Floating card' },
  { value: 'drawer', label: 'Bottom drawer' },
  { value: 'panel', label: 'Side panel' },
  { value: 'popup', label: 'Pin popup' },
];

/** A start/end window expressed in absolute UTC instants. */
export type TimeWindow = {
  start: Date;
  end: Date;
};

/**
 * Full set of solar events for a location/date.
 *
 * Every field is nullable because near the poles many of these phases do
 * not occur on a given date. The calculation layer normalizes SunCalc's
 * `Invalid Date` returns into `null` so the UI can render an explicit
 * "Sun does not …" message rather than `NaN:NaN`.
 */
export type SolarTimes = {
  sunrise: Date | null;
  sunset: Date | null;
  solarNoon: Date | null;

  /**
   * "Late morning / Late afternoon" — softer-than-midday but still well
   * above the strict warm-light bands. Sun is at roughly 12°–24°.
   */
  lateMorning: TimeWindow | null;
  lateAfternoon: TimeWindow | null;

  /**
   * "Soft light" — the still-warm directional light between the harsher
   * midday sun (sun above ~12°) and the strict golden hour (sun below 6°).
   * Photographers shoot this period too, especially the evening half, so
   * we surface it as its own phase. Endpoints are the sun-at-12° crossings.
   */
  softLightMorning: TimeWindow | null;
  softLightEvening: TimeWindow | null;

  goldenHourMorning: TimeWindow | null;
  goldenHourEvening: TimeWindow | null;

  blueHourMorning: TimeWindow | null;
  blueHourEvening: TimeWindow | null;

  civilDawn: Date | null;
  civilDusk: Date | null;
  nauticalDawn: Date | null;
  nauticalDusk: Date | null;
  astroDawn: Date | null;
  astroDusk: Date | null;
};

/** Persisted user preferences. */
export type Prefs = {
  pin: LatLng | null;
  /** ISO `yyyy-mm-dd` interpreted in the pinned location's timezone. */
  date: string;
  displayMode: DisplayMode;
};

// ==============================================================================
// Building-aware horizon (Overpass-driven)
// ==============================================================================

/** A single building footprint with a derived height. */
export type Building = {
  /** Closed polygon (first vertex repeated optional). Lat/lng of OSM nodes. */
  geometry: LatLng[];
  /** Effective height in metres above ground. Defaulted from levels when missing. */
  heightMeters: number;
  /** True if the height came from OSM tags; false if it was a fallback default. */
  heightFromTag: boolean;
};

/**
 * A horizon profile is the maximum sun-altitude angle (in radians) that is
 * blocked by surrounding obstructions, indexed by compass azimuth from the
 * observer's pin. The 360-element array uses 1° azimuth buckets aligned to
 * SunCalc's convention (0 = north, 90 = east, etc.).
 */
export type HorizonProfile = {
  /** `bucketsRad[d]` = max obstruction altitude in radians at azimuth `d` deg. */
  bucketsRad: Float32Array;
  /** How many buildings contributed (for UI). */
  buildingCount: number;
  /** Radius used when fetching, in metres. */
  radiusMeters: number;
  /** Centre of the fetched area (grid-rounded for caching purposes). */
  centerLat: number;
  centerLng: number;
  /** When the profile was built (ms since epoch). */
  fetchedAt: number;
};
