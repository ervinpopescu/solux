import type { LatLng, Obstruction } from '../types';
import { lngLatToLocalMetres, prepareShadowBuilding } from './shadowGeometry';
import { selectNearestBounded, type RankedItem } from './shadowPreselection';
import { shadowBuildingGeometryKey, type ShadowCaster } from './shadowRenderBudget';

export const MAX_REMOTE_BUILDING_CASTERS_TO_PREPARE = 4_000;
export const MAX_REMOTE_TREE_CASTERS_TO_PREPARE = 5_000;
export const MAX_REMOTE_SHADOW_RING_POINTS = 512;

type IndexedObstruction = { obstruction: Obstruction; index: number };

function obstructionRank(
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
  let lng = 0;
  for (const point of obstruction.geometry) {
    if (!Number.isFinite(point.lat) || !Number.isFinite(point.lng)) return null;
    lat += point.lat;
    lng += point.lng;
  }
  lat /= obstruction.geometry.length;
  lng /= obstruction.geometry.length;
  const [x, z] = lngLatToLocalMetres(pin, { lat, lng });
  return {
    value,
    distanceSquared: x * x + z * z,
    key: `${obstruction.kind}:${lat.toFixed(7)},${lng.toFixed(7)}:${obstruction.heightMeters}:${obstruction.geometry.length}:${index}`,
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
