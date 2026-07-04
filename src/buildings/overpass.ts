// ==============================================================================
// Overpass API — building polygons + heights
// ==============================================================================
//
// We pull building footprints around the user's pin from OpenStreetMap via
// the public Overpass interpreter. The result is parsed into a list of
// `Building` records that the horizon builder can consume directly.
//
// Why Overpass and not vector tiles? Overpass returns raw OSM tags, which
// is what we need to derive heights — vector tile providers usually
// generalize/extrude buildings and discard the original tags. Overpass is
// also free and CORS-enabled, which keeps Solux a pure SPA.
//
// Limitations we accept on purpose:
//   - Many OSM buildings lack any height info. We default conservatively
//     (see `defaultHeightMeters`) and flag whether the height was a tag or
//     a fallback so the UI can be honest about uncertainty.
//   - Only `way` features with `building=*` are queried. Relations (multi-
//     polygon buildings — usually large complexes) are intentionally
//     skipped; they're rare and would complicate the polygon parser.
//   - Vegetation, towers, billboards, etc. are not considered.

import type { Building, LatLng } from '../types';

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

/** Metres per building level when only `building:levels` is set. */
const METRES_PER_LEVEL = 3.5;

/**
 * Fallback height when no tag exists. Set to `null` to ignore untagged
 * buildings entirely. We default to `null` (skip) — it's better to under-
 * report obstruction than to claim a tall building exists when OSM doesn't
 * say so.
 */
const FALLBACK_HEIGHT_METRES: number | null = null;

export type OverpassError = Error & { kind: 'overpass'; status?: number };

function overpassError(message: string, status?: number): OverpassError {
  const e = new Error(message) as OverpassError;
  e.kind = 'overpass';
  if (status !== undefined) e.status = status;
  return e;
}

/**
 * Fetch buildings within `radius` metres of `pin` from Overpass.
 *
 * Throws an `OverpassError` on network/HTTP failure. The caller should treat
 * this as non-fatal: the rest of the app continues to render geometric times.
 */
export async function fetchBuildings(
  pin: LatLng,
  radius: number,
  signal?: AbortSignal,
): Promise<Building[]> {
  // Overpass QL: pull every `way` tagged building=* whose centroid is within
  // the radius of the pin. `out geom` inlines the node coordinates so we
  // don't need a second request to resolve them.
  const query = `[out:json][timeout:25];
(
  way["building"](around:${radius},${pin.lat},${pin.lng});
);
out geom;`;

  const res = await fetch(OVERPASS_URL, {
    method: 'POST',
    body: 'data=' + encodeURIComponent(query),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    signal,
  });

  if (!res.ok) {
    throw overpassError(`Overpass HTTP ${res.status}`, res.status);
  }

  const data: unknown = await res.json();
  return parseBuildings(data);
}

// ==============================================================================
// Parsing
// ==============================================================================
//
// Overpass JSON shape (relevant slice):
//
//   { elements: [
//       {
//         type: "way",
//         tags: { building: "yes", height: "12", "building:levels": "4" },
//         geometry: [{ lat: ..., lon: ... }, ...],
//       },
//       ...
//   ]}

type Element = {
  type?: string;
  tags?: Record<string, string>;
  geometry?: { lat: number; lon: number }[];
};

export function parseBuildings(raw: unknown): Building[] {
  const elements = (raw as { elements?: Element[] } | undefined)?.elements;
  if (!Array.isArray(elements)) return [];

  const buildings: Building[] = [];
  for (const el of elements) {
    if (el.type !== 'way') continue;
    if (!el.geometry || el.geometry.length < 3) continue;

    const h = deriveHeight(el.tags ?? {});
    if (h === null) continue; // No tag, fallback disabled → skip

    buildings.push({
      geometry: el.geometry.map((p) => ({ lat: p.lat, lng: p.lon })),
      heightMeters: h.value,
      heightFromTag: h.fromTag,
    });
  }
  return buildings;
}

/**
 * Compute the height for a building from its tags, preferring an explicit
 * `height` value and falling back to `building:levels * METRES_PER_LEVEL`.
 *
 * Returns `null` when neither tag is present AND the fallback is disabled.
 */
function deriveHeight(
  tags: Record<string, string>,
): { value: number; fromTag: true } | { value: number; fromTag: false } | null {
  // Prefer explicit height. Tag values can include units, e.g. "12 m".
  const rawHeight = tags.height ?? tags['building:height'];
  if (rawHeight) {
    const v = parseFloat(rawHeight);
    if (Number.isFinite(v) && v > 0) return { value: v, fromTag: true };
  }

  // Fall back to building:levels × meters-per-level.
  const rawLevels = tags['building:levels'];
  if (rawLevels) {
    const n = parseFloat(rawLevels);
    if (Number.isFinite(n) && n > 0) {
      return { value: n * METRES_PER_LEVEL, fromTag: true };
    }
  }

  if (FALLBACK_HEIGHT_METRES !== null) {
    return { value: FALLBACK_HEIGHT_METRES, fromTag: false };
  }
  return null;
}
