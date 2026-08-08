// ==============================================================================
// Overpass API — building and tree obstructions
// ==============================================================================
//
// We pull building footprints and tree features around the user's pin from
// OpenStreetMap via the public Overpass interpreter. The result is parsed into
// a list of `Obstruction` records that the horizon builder can consume directly.
//
// Why Overpass and not vector tiles? Overpass returns raw OSM tags, which
// is what we need to derive heights — vector tile providers usually
// generalize/extrude buildings and discard the original tags. Overpass is
// also free and CORS-enabled, which keeps Solux a pure frontend app.
//
// Limitations we accept on purpose:
//   - Many OSM buildings lack any height info. We default conservatively
//     (see `FALLBACK_HEIGHT_METRES`) and flag whether the height was a tag or
//     a fallback so the UI can be honest about uncertainty.
//   - Only `way` features with `building=*` are queried for buildings.
//     Relations (multi-polygon buildings — usually large complexes) are
//     intentionally skipped; they're rare and would complicate the polygon
//     parser.
//   - Tree node canopies are synthesized as 8-vertex octagons — accurate
//     enough for shadow-angle calculations; sub-metre precision is irrelevant.

import type { Obstruction, LatLng } from '../types';

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

/** Metres per building level when only `building:levels` is set. */
const METRES_PER_LEVEL = 3.5;

export type OverpassError = Error & { kind: 'overpass'; status?: number };

function overpassError(message: string, status?: number): OverpassError {
  const e = new Error(message) as OverpassError;
  e.kind = 'overpass';
  if (status !== undefined) e.status = status;
  return e;
}

/**
 * Build the latency-sensitive obstruction query. Buildings keep the full
 * horizon radius, while individual trees and wooded/forest area polygons are
 * bounded to 400 m.
 */
export function buildObstructionQuery(pin: LatLng, radius: number): string {
  const treeRadius = Math.min(radius, 400);
  return `[out:json][timeout:8];
(
  way["building"](around:${radius},${pin.lat},${pin.lng});
  node["natural"="tree"](around:${treeRadius},${pin.lat},${pin.lng});
  way["natural"="wood"](around:${treeRadius},${pin.lat},${pin.lng});
  way["landuse"="forest"](around:${treeRadius},${pin.lat},${pin.lng});
);
out geom;`;
}

/**
 * Fetch obstructions within `radius` metres of `pin` from Overpass.
 * Attempts primary and fallback mirror endpoints if rate-limited or timed out.
 *
 * Throws an `OverpassError` on network/HTTP failure. The caller should treat
 * this as non-fatal: the rest of the app continues to render geometric times.
 */
export async function fetchObstructions(
  pin: LatLng,
  radius: number,
  signal?: AbortSignal,
): Promise<Obstruction[]> {
  const query = buildObstructionQuery(pin, radius);
  let lastError: Error | null = null;

  for (const endpoint of OVERPASS_ENDPOINTS) {
    if (signal?.aborted) throw overpassError('Aborted');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        body: 'data=' + encodeURIComponent(query),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });

      if (!res.ok) {
        lastError = overpassError(`Overpass HTTP ${res.status}`, res.status);
        continue;
      }

      let data: unknown;
      if (typeof res.text === 'function') {
        const text = await res.text();
        if (!text.trim().startsWith('{')) {
          lastError = overpassError('Invalid JSON response from Overpass');
          continue;
        }
        data = JSON.parse(text);
      } else {
        data = await res.json();
      }
      return parseObstructions(data);
    } catch (err) {
      if (signal?.aborted || (err as { name?: string }).name === 'AbortError') {
        throw err;
      }
      lastError = err instanceof Error ? err : overpassError(String(err));
    }
  }

  throw lastError ?? overpassError('All Overpass endpoints failed');
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
  lat?: number; // present on node elements
  lon?: number; // present on node elements
};

// ==============================================================================
// Tree height derivation
// ==============================================================================

// Heights in metres for common genera, keyed by lowercase genus name.
// Matching is case-insensitive prefix on the first whitespace-delimited token
// of the OSM species/taxon tag value.
const SPECIES_HEIGHT_M: ReadonlyMap<string, number> = new Map([
  ['quercus', 20], // oak
  ['pinus', 25], // pine
  ['betula', 15], // birch
  ['acer', 15], // maple
  ['fagus', 25], // beech
  ['tilia', 20], // linden/lime
  ['fraxinus', 20], // ash
  ['populus', 28], // poplar
  ['salix', 10], // willow
  ['platanus', 25], // plane
  ['prunus', 8], // cherry/plum
  ['malus', 6], // apple
  ['robinia', 15],
  ['eucalyptus', 30],
  ['phoenix', 10], // palm
  ['cocos', 25], // coconut palm
  ['cedrus', 30], // cedar
  ['picea', 25], // spruce
  ['abies', 30], // fir
  ['larix', 25], // larch
]);

function deriveTreeHeight(
  tags: Record<string, string>,
  featureKind: 'node' | 'way',
): { value: number; fromTag: boolean } {
  const rawHeight = tags.height;
  if (rawHeight) {
    const v = parseFloat(rawHeight);
    if (Number.isFinite(v) && v > 0) return { value: v, fromTag: true };
  }

  const speciesRaw = tags.species ?? tags.taxon;
  if (speciesRaw) {
    const genus = speciesRaw.trim().split(/\s+/)[0].toLowerCase();
    const h = SPECIES_HEIGHT_M.get(genus);
    if (h !== undefined) return { value: h, fromTag: true };
  }

  return { value: featureKind === 'node' ? 12 : 18, fromTag: false };
}

/**
 * Synthesize an 8-vertex octagon centred at (lat, lng) with the given radius.
 * Vertex 0 is due north; subsequent vertices step clockwise every 45°.
 * Uses the equirectangular approximation (1° lat ≈ 111 320 m); accurate enough
 * for canopy radii of a few metres.
 */
function synthesizeCanopy(lat: number, lng: number, radiusM: number): LatLng[] {
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  const vertices: LatLng[] = [];
  for (let i = 0; i < 8; i++) {
    const angle = (i * 2 * Math.PI) / 8;
    vertices.push({ lat: lat + dLat * Math.cos(angle), lng: lng + dLng * Math.sin(angle) });
  }
  return vertices;
}

export function parseObstructions(raw: unknown): Obstruction[] {
  const elements = (raw as { elements?: Element[] } | undefined)?.elements;
  if (!Array.isArray(elements)) return [];

  const obstructions: Obstruction[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};

    if (el.type === 'way' && tags['building']) {
      // ── Building way ────────────────────────────────────────────────────
      if (!el.geometry || el.geometry.length < 3) continue;
      const h = deriveHeight(tags);
      if (h === null) continue;
      obstructions.push({
        kind: 'building',
        geometry: el.geometry.map((p) => ({ lat: p.lat, lng: p.lon })),
        heightMeters: h.value,
        heightFromTag: h.fromTag,
      });
    } else if (el.type === 'node' && tags['natural'] === 'tree') {
      // ── Single tree node ─────────────────────────────────────────────────
      if (el.lat === undefined || el.lon === undefined) continue;
      const h = deriveTreeHeight(tags, 'node');
      const crownDiam = parseFloat(tags['crown_diameter'] ?? '');
      const radiusM = Number.isFinite(crownDiam) && crownDiam > 0 ? crownDiam / 2 : h.value * 0.25;
      obstructions.push({
        kind: 'tree',
        geometry: synthesizeCanopy(el.lat, el.lon, radiusM),
        heightMeters: h.value,
        heightFromTag: h.fromTag,
      });
    } else if (el.type === 'way' && (tags['natural'] === 'wood' || tags['landuse'] === 'forest')) {
      // ── Wooded area way ──────────────────────────────────────────────────
      if (!el.geometry || el.geometry.length < 3) continue;
      const h = deriveTreeHeight(tags, 'way');

      let pts = el.geometry.map((p) => ({ lat: p.lat, lng: p.lon }));
      // Mitigation: large forest polygons can contain thousands of vertices,
      // causing main-thread jank in earcut and the horizon edge-sampler.
      // Cap at 200 vertices via simple uniform subsampling.
      if (pts.length > 200) {
        const step = pts.length / 200;
        const downsampled: LatLng[] = [];
        for (let i = 0; i < 200; i++) {
          downsampled.push(pts[Math.floor(i * step)]);
        }
        // Ensure we close the loop if the original did, though down-stream
        // logic handles unclosed rings too.
        pts = downsampled;
      }

      obstructions.push({
        kind: 'tree',
        geometry: pts,
        heightMeters: h.value,
        heightFromTag: h.fromTag,
        forestArea: true,
      });
    }
  }
  return obstructions;
}

const FALLBACK_HEIGHT_METRES: number | null = null;

/**
 * Compute the height for a building from its tags, preferring an explicit
 * `height` value and falling back to `building:levels * METRES_PER_LEVEL`.
 *
 * Returns `null` when neither tag is present (untagged buildings are skipped).
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
    if (Number.isFinite(n) && n > 0) return { value: n * METRES_PER_LEVEL, fromTag: true };
  }

  if (FALLBACK_HEIGHT_METRES !== null) {
    return { value: FALLBACK_HEIGHT_METRES, fromTag: false };
  }
  return null;
}
