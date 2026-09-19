import type { LatLng, Obstruction } from '../types';
import { lngLatToLocalMetres, prepareShadowBuilding } from './shadowGeometry';
import { selectNearestBounded, type RankedItem } from './shadowPreselection';
import { shadowBuildingGeometryKey, type ShadowCaster } from './shadowRenderBudget';

export const MAX_REMOTE_BUILDING_CASTERS_TO_PREPARE = 4_000;
export const MAX_REMOTE_TREE_CASTERS_TO_PREPARE = 5_000;
export const MAX_REMOTE_SHADOW_RING_POINTS = 512;

type IndexedObstruction = { obstruction: Obstruction; index: number };

function unwrapLongitude(lng: number, referenceLng: number): number {
  let delta = (lng - referenceLng) % 360;
  if (delta > 180) delta -= 360;
  else if (delta < -180) delta += 360;
  return referenceLng + delta;
}

function canonicalLongitude(lng: number): number {
  let normalized = (lng + 180) % 360;
  if (normalized < 0) normalized += 360;
  const canonical = normalized - 180;
  return canonical === 0 ? 0 : canonical;
}

export function obstructionRank(
  pin: LatLng,
  value: IndexedObstruction,
): RankedItem<IndexedObstruction> | null {
  const { obstruction, index } = value;
  if (
    obstruction.geometry.length < 3 ||
    obstruction.geometry.length > MAX_REMOTE_SHADOW_RING_POINTS
  ) {
    return null;
  }
  let lat = 0;
  let unwrappedLngSum = 0;
  for (const point of obstruction.geometry) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
    lat += point.lat;
    unwrappedLngSum += unwrapLongitude(point.lng, pin.lng);
  }
  lat /= obstruction.geometry.length;
  const avgUnwrappedLng = unwrappedLngSum / obstruction.geometry.length;
  const [x, z] = lngLatToLocalMetres(pin, { lat, lng: avgUnwrappedLng });
  const canonicalLng = canonicalLongitude(avgUnwrappedLng);
  return {
    value,
    distanceSquared: x * x + z * z,
    key: `${obstruction.kind}:${lat.toFixed(7)},${canonicalLng.toFixed(7)}:${obstruction.heightMeters}:${obstruction.geometry.length}:${index}`,
  };
}

/**
 * Bound expensive projection and earcut work before preparing remote casters.
 * Buildings and nearest trees receive separate caps so dense vegetation cannot
 * displace the complete 1 km building set from preparation.
 */
export function prepareRemoteShadowCasters(
  pin: LatLng,
  obstructions: readonly Obstruction[],
): ShadowCaster[] {
  function* rankedKind(kind: Obstruction['kind']): Iterable<RankedItem<IndexedObstruction>> {
    for (let index = 0; index < obstructions.length; index++) {
      const o = obstructions[index];
      if (o.kind !== kind) continue;
      // Forest area ways represent wooded region boundaries, not solid 3D
      // structures. Extruding them creates giant solid shadow slabs across
      // parks. Point trees with synthesized canopies still cast individual
      // 3D tree shadows.
      if (o.forestArea) continue;
      const ranked = obstructionRank(pin, { obstruction: o, index });
      if (ranked) yield ranked;
    }
  }

  const selected = [
    ...selectNearestBounded(rankedKind('building'), MAX_REMOTE_BUILDING_CASTERS_TO_PREPARE),
    ...selectNearestBounded(rankedKind('tree'), MAX_REMOTE_TREE_CASTERS_TO_PREPARE),
  ];
  const output: ShadowCaster[] = [];
  for (const ranked of selected) {
    const obstruction = ranked.value.obstruction;
    const building = prepareShadowBuilding(pin, obstruction.geometry, obstruction.heightMeters);
    if (!building) continue;
    const geometryKey = shadowBuildingGeometryKey(building);
    const dedupKey = `${geometryKey}:height=${obstruction.heightMeters}:minHeight=0`;
    output.push({
      building,
      kind: obstruction.kind,
      source: 'remote',
      distanceSquared: ranked.distanceSquared,
      dedupKey,
      key: `remote:${obstruction.kind}:${dedupKey}`,
    });
  }
  return output;
}
