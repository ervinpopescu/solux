export type TileShadowRefreshGate = {
  generation: number;
  completedGeneration: number;
};

export function createTileShadowRefreshGate(): TileShadowRefreshGate {
  return { generation: 0, completedGeneration: -1 };
}

/** Start a new bounded refresh generation for a completed camera move. */
export function beginTileShadowMove(gate: TileShadowRefreshGate): number {
  gate.generation++;
  return gate.generation;
}

/** Source completion should only schedule until this generation converts once. */
export function shouldScheduleTileShadowSource(gate: TileShadowRefreshGate): boolean {
  return gate.completedGeneration !== gate.generation;
}

export function completeTileShadowRefresh(
  gate: TileShadowRefreshGate,
  generation: number,
): boolean {
  if (generation !== gate.generation || gate.completedGeneration === generation) return false;
  gate.completedGeneration = generation;
  return true;
}
