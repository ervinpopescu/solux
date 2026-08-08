import type { LatLng } from '../types';
import { lngLatToLocalMetres, prepareShadowBuilding } from './shadowGeometry';
import { selectNearestBounded, type RankedItem } from './shadowPreselection';
import { shadowBuildingGeometryKey, type ShadowCaster } from './shadowRenderBudget';

export const MAX_TILE_SHADOW_PARTS_TO_PREPARE = 4_000;
export const MAX_TILE_SHADOW_RING_POINTS = 512;

type TilePolygonGeometry = {
  type: 'Polygon';
  coordinates: unknown;
};

type TileMultiPolygonGeometry = {
  type: 'MultiPolygon';
  coordinates: unknown;
};

export type TileBuildingFeature = {
  id?: string | number;
  properties?: Record<string, unknown> | null;
  geometry?:
    TilePolygonGeometry | TileMultiPolygonGeometry | { type?: string; coordinates?: unknown };
};

type TilePart = {
  ring: unknown;
  height: number;
  featureKey: string;
  polygonIndex: number;
};

function finiteHeight(value: unknown): number | null {
  const height =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(height) && height > 0 ? height : null;
}

function isHidden3d(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function asOuterRing(value: unknown): LatLng[] | null {
  if (!Array.isArray(value) || value.length > MAX_TILE_SHADOW_RING_POINTS) return null;
  const ring: LatLng[] = [];
  for (const coordinate of value) {
    if (!Array.isArray(coordinate) || coordinate.length < 2) return null;
    const lng = coordinate[0];
    const lat = coordinate[1];
    if (
      typeof lat !== 'number' ||
      typeof lng !== 'number' ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lng)
    ) {
      return null;
    }
    ring.push({ lat, lng });
  }
  return ring;
}

function rankTilePart(pin: LatLng, part: TilePart): RankedItem<TilePart> | null {
  if (
    !Array.isArray(part.ring) ||
    part.ring.length < 3 ||
    part.ring.length > MAX_TILE_SHADOW_RING_POINTS
  ) {
    return null;
  }
  let lat = 0;
  let lng = 0;
  for (const coordinate of part.ring) {
    if (!Array.isArray(coordinate) || coordinate.length < 2) return null;
    if (typeof coordinate[0] !== 'number' || typeof coordinate[1] !== 'number') return null;
    if (!Number.isFinite(coordinate[0]) || !Number.isFinite(coordinate[1])) return null;
    lng += coordinate[0];
    lat += coordinate[1];
  }
  lng /= part.ring.length;
  lat /= part.ring.length;
  const [x, z] = lngLatToLocalMetres(pin, { lat, lng });
  return {
    value: part,
    distanceSquared: x * x + z * z,
    key: `${lat.toFixed(7)},${lng.toFixed(7)}:${part.featureKey}:${part.polygonIndex}`,
  };
}

/**
 * Convert visible OpenMapTiles building features into prepared shadow casters.
 * A nearest-first preselection bounds projection and earcut work. Only outer
 * rings are used, and exact normalized geometry is deduplicated after
 * preparation. Distinct clipped fragments are retained even when they share a
 * vector-tile feature ID.
 *
 * Features with a positive render_min_height are conservatively skipped. The
 * current ground-prism mesh cannot represent elevated building parts without
 * falsely filling the open space below them.
 */
function* rankedTileParts(
  pin: LatLng,
  features: readonly TileBuildingFeature[],
): Iterable<RankedItem<TilePart>> {
  for (const feature of features) {
    const properties = feature.properties ?? {};
    const height = finiteHeight(properties.render_height);
    const minHeight = finiteHeight(properties.render_min_height) ?? 0;
    if (!height || minHeight > 0 || isHidden3d(properties.hide_3d)) continue;

    const geometry = feature.geometry;
    if (!geometry) continue;
    let polygons: unknown[];
    if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
      polygons = [geometry.coordinates];
    } else if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
      polygons = geometry.coordinates;
    } else {
      continue;
    }

    const featureKey = feature.id === undefined ? 'geometry' : String(feature.id);
    for (let polygonIndex = 0; polygonIndex < polygons.length; polygonIndex++) {
      const polygon = polygons[polygonIndex];
      if (!Array.isArray(polygon) || polygon.length === 0) continue;
      const ranked = rankTilePart(pin, {
        ring: polygon[0],
        height,
        featureKey,
        polygonIndex,
      });
      if (ranked) yield ranked;
    }
  }
}

export function tileBuildingFeaturesToShadowCasters(
  pin: LatLng,
  features: readonly TileBuildingFeature[],
): ShadowCaster[] {
  const selectedParts = selectNearestBounded(
    rankedTileParts(pin, features),
    MAX_TILE_SHADOW_PARTS_TO_PREPARE,
  );
  const output: ShadowCaster[] = [];
  const seenDedupKeys = new Set<string>();
  for (const ranked of selectedParts) {
    const part = ranked.value;
    const outerRing = asOuterRing(part.ring);
    if (!outerRing) continue;
    const building = prepareShadowBuilding(pin, outerRing, part.height);
    if (!building) continue;

    const geometryKey = shadowBuildingGeometryKey(building);
    const dedupKey = `${geometryKey}:height=${part.height}:minHeight=0`;
    if (seenDedupKeys.has(dedupKey)) continue;
    seenDedupKeys.add(dedupKey);
    output.push({
      building,
      kind: 'building',
      source: 'tile',
      distanceSquared: ranked.distanceSquared,
      dedupKey,
      key: `tile:${part.featureKey}:${part.polygonIndex}:${dedupKey}`,
    });
  }

  return output;
}
