import { describe, expect, it } from 'vitest';
import type { ShadowBuilding } from './shadowGeometry';
import {
  estimateShadowMeshVertices,
  MAX_SHADOW_MESH_BYTES,
  MAX_SHADOW_MESH_VERTICES,
  selectShadowCasters,
  shadowBuildingGeometryKey,
  type ShadowCaster,
} from './shadowRenderBudget';
import {
  MAX_TILE_SHADOW_PARTS_TO_PREPARE,
  tileBuildingFeaturesToShadowCasters,
} from './tileShadowBuildings';

const PIN = { lat: 44.4064076, lng: 26.1096245 };

function square(lng: number, lat: number, size = 0.0001): number[][] {
  return [
    [lng, lat],
    [lng + size, lat],
    [lng + size, lat + size],
    [lng, lat + size],
    [lng, lat],
  ];
}

function caster(
  key: string,
  kind: 'building' | 'tree',
  distanceSquared: number,
  vertices: number,
): ShadowCaster {
  // tris*2 + points*6. Use a triangle ring (18 edge vertices) and size tris
  // so the test can create exact estimated costs >= 24 vertices.
  const triangleCount = (vertices - 18) / 2;
  const building: ShadowBuilding = {
    ring: [0, 0, 1, 0, 0, 1],
    tris: Array.from({ length: triangleCount }, () => 0),
    height: 10,
  };
  return {
    key,
    kind,
    source: kind === 'building' ? 'tile' : 'remote',
    distanceSquared,
    dedupKey: key,
    building,
  };
}

describe('tileBuildingFeaturesToShadowCasters', () => {
  it('converts Polygon and MultiPolygon outer rings using render_height', () => {
    const casters = tileBuildingFeaturesToShadowCasters(PIN, [
      {
        id: 1,
        properties: { render_height: 12 },
        geometry: { type: 'Polygon', coordinates: [square(PIN.lng, PIN.lat)] },
      },
      {
        id: 2,
        properties: { render_height: '18' },
        geometry: {
          type: 'MultiPolygon',
          coordinates: [[square(PIN.lng + 0.001, PIN.lat)], [square(PIN.lng + 0.002, PIN.lat)]],
        },
      },
    ]);

    expect(casters).toHaveLength(3);
    expect(casters.map((caster) => caster.building.height)).toEqual([12, 18, 18]);
    expect(casters.every((caster) => caster.kind === 'building')).toBe(true);
  });

  it('ignores holes, invalid heights, hidden features, and non-polygons', () => {
    const outer = square(PIN.lng, PIN.lat);
    const hole = square(PIN.lng + 0.00002, PIN.lat + 0.00002, 0.00002);
    const casters = tileBuildingFeaturesToShadowCasters(PIN, [
      {
        properties: { render_height: 10 },
        geometry: { type: 'Polygon', coordinates: [outer, hole] },
      },
      {
        properties: { render_height: 0 },
        geometry: { type: 'Polygon', coordinates: [outer] },
      },
      {
        properties: { render_height: 10, render_min_height: 3 },
        geometry: { type: 'Polygon', coordinates: [outer] },
      },
      {
        properties: { render_height: 10, hide_3d: true },
        geometry: { type: 'Polygon', coordinates: [outer] },
      },
      {
        properties: { render_height: 10 },
        geometry: { type: 'Point', coordinates: [PIN.lng, PIN.lat] },
      },
      {
        properties: { render_height: 10 },
        geometry: { type: 'Polygon', coordinates: [[[NaN, NaN]]] },
      },
      {
        properties: { render_height: 10 },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [PIN.lng, PIN.lat],
              [PIN.lng, PIN.lat],
            ],
          ],
        },
      },
    ]);

    expect(casters).toHaveLength(1);
    expect(casters[0].building.ring).toHaveLength(8);
  });

  it('deduplicates the same geometry despite ring direction and feature ID changes', () => {
    const ring = square(PIN.lng, PIN.lat);
    const casters = tileBuildingFeaturesToShadowCasters(PIN, [
      {
        id: 100,
        properties: { render_height: 12 },
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
      {
        id: 200,
        properties: { render_height: 12 },
        geometry: { type: 'Polygon', coordinates: [[...ring].reverse()] },
      },
    ]);
    expect(casters).toHaveLength(1);
  });

  it('retains distinct clipped fragments carrying the same stable feature ID', () => {
    const casters = tileBuildingFeaturesToShadowCasters(PIN, [
      {
        id: 100,
        properties: { render_height: 12 },
        geometry: { type: 'Polygon', coordinates: [square(PIN.lng, PIN.lat)] },
      },
      {
        id: 100,
        properties: { render_height: 12 },
        geometry: { type: 'Polygon', coordinates: [square(PIN.lng + 0.001, PIN.lat)] },
      },
    ]);
    expect(casters).toHaveLength(2);
  });

  it('caps nearest tile parts before detailed preparation', () => {
    const features = Array.from({ length: MAX_TILE_SHADOW_PARTS_TO_PREPARE + 20 }, (_, index) => ({
      id: index,
      properties: { render_height: 12 },
      geometry: {
        type: 'Polygon' as const,
        coordinates: [square(PIN.lng + index * 0.00001, PIN.lat)],
      },
    }));
    const casters = tileBuildingFeaturesToShadowCasters(PIN, features);
    expect(casters).toHaveLength(MAX_TILE_SHADOW_PARTS_TO_PREPARE);
    expect(casters.some((caster) => caster.key.startsWith('tile:0:'))).toBe(true);
    expect(
      casters.some((caster) =>
        caster.key.startsWith(`tile:${MAX_TILE_SHADOW_PARTS_TO_PREPARE + 19}:`),
      ),
    ).toBe(false);
  });
});

describe('shadowBuildingGeometryKey', () => {
  const building = (ring: number[]): ShadowBuilding => ({ ring, tris: [0, 1, 2], height: 10 });

  it('normalizes ring rotation, direction, and a closing vertex', () => {
    const original = building([0, 0, 2, 0, 2, 2, 0, 2]);
    const rotated = building([2, 2, 0, 2, 0, 0, 2, 0]);
    const reversedClosed = building([0, 0, 0, 2, 2, 2, 2, 0, 0, 0]);
    expect(shadowBuildingGeometryKey(rotated)).toBe(shadowBuildingGeometryKey(original));
    expect(shadowBuildingGeometryKey(reversedClosed)).toBe(shadowBuildingGeometryKey(original));
  });

  it('handles empty rings and single-point rings in shadowBuildingGeometryKey', () => {
    expect(shadowBuildingGeometryKey(building([]))).toBe('');
    expect(shadowBuildingGeometryKey(building([1, 2]))).toBe('10,20');
  });

  it('keeps distinct geometry distinct', () => {
    expect(shadowBuildingGeometryKey(building([0, 0, 2, 0, 2, 2, 0, 2]))).not.toBe(
      shadowBuildingGeometryKey(building([0, 0, 3, 0, 2, 2, 0, 2])),
    );
  });
});

describe('selectShadowCasters', () => {
  it('breaks distance ties deterministically using key', () => {
    const a = caster('a', 'building', 10, 30);
    const b = caster('b', 'building', 10, 30);
    expect(selectShadowCasters([b, a]).casters.map(({ key }) => key)).toEqual(['a', 'b']);
  });

  it('selects candidates strictly by distance from the pin deterministically', () => {
    const candidates = [
      caster('tree-far', 'tree', 100, 30),
      caster('building-b', 'building', 20, 30),
      caster('tree-near', 'tree', 1, 30),
      caster('building-a', 'building', 10, 30),
    ];

    expect(selectShadowCasters(candidates, 90).casters.map(({ key }) => key)).toEqual([
      'tree-near',
      'building-a',
      'building-b',
    ]);
    expect(
      selectShadowCasters([...candidates].reverse(), 90).casters.map(({ key }) => key),
    ).toEqual(['tree-near', 'building-a', 'building-b']);
  });

  it('never exceeds the vertex or byte cap and retains nearby trees in a dense park', () => {
    const candidates = [caster('building', 'building', 0, 30)];
    for (let index = 0; index < 20_000; index++) {
      candidates.push(caster(`tree-${index.toString().padStart(5, '0')}`, 'tree', index + 1, 84));
    }

    const selection = selectShadowCasters(candidates);
    expect(selection.estimatedVertices).toBeLessThanOrEqual(MAX_SHADOW_MESH_VERTICES);
    expect(selection.estimatedBytes).toBeLessThanOrEqual(MAX_SHADOW_MESH_BYTES);
    expect(selection.selectedBuildingCount).toBe(1);
    expect(selection.selectedTreeCount).toBeGreaterThan(0);
    expect(selection.droppedTreeCount).toBeGreaterThan(0);
    expect(selection.estimatedVertices).toBe(
      selection.casters.reduce(
        (total, selected) => total + estimateShadowMeshVertices(selected.building),
        0,
      ),
    );
  });

  it('selects nearby trees ahead of far buildings when budget is constrained', () => {
    const candidates = [];
    for (let index = 0; index < 10; index++) {
      candidates.push(caster(`building-${index}`, 'building', index + 10, 30));
    }
    candidates.push(caster('nearest-tree', 'tree', 1, 30));
    candidates.push(caster('far-tree', 'tree', 2, 30));

    const selection = selectShadowCasters(candidates, 300);
    expect(selection.selectedTreeCount).toBe(2);
    expect(selection.estimatedVertices).toBeLessThanOrEqual(300);
    expect(selection.casters[0].key).toBe('nearest-tree');
    expect(selection.casters[1].key).toBe('far-tree');
  });

  it('skips an individually oversized caster and continues filling the budget', () => {
    const selection = selectShadowCasters(
      [caster('oversized', 'building', 0, 102), caster('small-tree', 'tree', 1, 30)],
      60,
    );
    expect(selection.casters.map(({ key }) => key)).toEqual(['small-tree']);
    expect(selection.estimatedVertices).toBe(30);
  });
});
