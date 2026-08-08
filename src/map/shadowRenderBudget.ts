import type { ShadowBuilding } from './shadowGeometry';

export type ShadowCasterKind = 'building' | 'tree';

export type ShadowCaster = {
  building: ShadowBuilding;
  kind: ShadowCasterKind;
  source: 'tile' | 'remote';
  /** Squared distance from the pin in local metres. */
  distanceSquared: number;
  /** Canonical geometry plus vertical properties, used for deduplication. */
  dedupKey: string;
  /** Stable tie-breaker and change-detection key. */
  key: string;
};

/**
 * Static shadow uploads are capped at 360k vertices (about 4.12 MiB).
 * This is large enough for the reduced Tineretului data set while preventing
 * a dense park from creating an unbounded monolithic WebGL buffer.
 */
export const MAX_SHADOW_MESH_VERTICES = 360_000;
export const FLOATS_PER_SHADOW_VERTEX = 3;
export const BYTES_PER_FLOAT = 4;
export const MAX_SHADOW_MESH_BYTES =
  MAX_SHADOW_MESH_VERTICES * FLOATS_PER_SHADOW_VERTEX * BYTES_PER_FLOAT;

export type ShadowRenderSelection = {
  casters: ShadowCaster[];
  buildings: ShadowBuilding[];
  estimatedVertices: number;
  estimatedBytes: number;
  selectedBuildingCount: number;
  selectedTreeCount: number;
  droppedBuildingCount: number;
  droppedTreeCount: number;
};

/** Exact vertex count emitted by buildStaticShadowMesh for one caster. */
export function estimateShadowMeshVertices(building: ShadowBuilding): number {
  return building.tris.length * 2 + (building.ring.length / 2) * 6;
}

function compareCasters(a: ShadowCaster, b: ShadowCaster): number {
  return a.distanceSquared - b.distanceSquared || a.key.localeCompare(b.key);
}

/**
 * Deterministically select a bounded shadow set. Candidates (both buildings and
 * trees) are ordered nearest to farthest from the pin. Oversized individual
 * casters are skipped so one malformed footprint cannot prevent smaller useful
 * casters from rendering.
 */
export function selectShadowCasters(
  candidates: readonly ShadowCaster[],
  maxVertices: number = MAX_SHADOW_MESH_VERTICES,
): ShadowRenderSelection {
  const limit = Math.max(0, Math.floor(maxVertices));
  const sorted = [...candidates].sort(compareCasters);
  const selected: ShadowCaster[] = [];
  let estimatedVertices = 0;
  let selectedBuildingCount = 0;
  let selectedTreeCount = 0;
  let droppedBuildingCount = 0;
  let droppedTreeCount = 0;

  for (const candidate of sorted) {
    const vertices = estimateShadowMeshVertices(candidate.building);
    if (!Number.isFinite(vertices) || vertices <= 0 || estimatedVertices + vertices > limit) {
      if (candidate.kind === 'building') droppedBuildingCount++;
      else droppedTreeCount++;
      continue;
    }
    selected.push(candidate);
    estimatedVertices += vertices;
    if (candidate.kind === 'building') selectedBuildingCount++;
    else selectedTreeCount++;
  }

  return {
    casters: selected,
    buildings: selected.map((candidate) => candidate.building),
    estimatedVertices,
    estimatedBytes: estimatedVertices * FLOATS_PER_SHADOW_VERTEX * BYTES_PER_FLOAT,
    selectedBuildingCount,
    selectedTreeCount,
    droppedBuildingCount,
    droppedTreeCount,
  };
}

function leastRotation(tokens: readonly string[]): number {
  const count = tokens.length;
  if (count < 2) return 0;
  let left = 0;
  let right = 1;
  let offset = 0;
  while (left < count && right < count && offset < count) {
    const a = tokens[(left + offset) % count];
    const b = tokens[(right + offset) % count];
    if (a === b) {
      offset++;
      continue;
    }
    if (a > b) {
      left += offset + 1;
      if (left === right) left++;
    } else {
      right += offset + 1;
      if (left === right) right++;
    }
    offset = 0;
  }
  return Math.min(left, right) % count;
}

function canonicalRotation(tokens: readonly string[]): string {
  const start = leastRotation(tokens);
  const output = new Array<string>(tokens.length);
  for (let index = 0; index < tokens.length; index++) {
    output[index] = tokens[(start + index) % tokens.length];
  }
  return output.join(';');
}

/**
 * Canonical geometry key in O(n), normalized for closing vertices, starting
 * vertex, and ring direction. Coordinates are quantized to 0.1 m, matching the
 * practical precision of loaded vector-tile geometry.
 */
export function shadowBuildingGeometryKey(building: ShadowBuilding): string {
  const tokens: string[] = [];
  for (let index = 0; index + 1 < building.ring.length; index += 2) {
    tokens.push(
      `${Math.round(building.ring[index] * 10)},${Math.round(building.ring[index + 1] * 10)}`,
    );
  }
  if (tokens.length > 1 && tokens[0] === tokens[tokens.length - 1]) tokens.pop();
  if (tokens.length === 0) return '';

  const forward = canonicalRotation(tokens);
  const reverse = canonicalRotation([...tokens].reverse());
  return forward < reverse ? forward : reverse;
}
