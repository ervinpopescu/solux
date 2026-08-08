import { describe, expect, it } from 'vitest';
import {
  MAX_REMOTE_SHADOW_RING_POINTS,
  MAX_REMOTE_TREE_CASTERS_TO_PREPARE,
  prepareRemoteShadowCasters,
} from './remoteShadowObstructions';
import { selectNearestBounded } from './shadowPreselection';
import {
  beginTileShadowMove,
  completeTileShadowRefresh,
  createTileShadowRefreshGate,
  shouldScheduleTileShadowSource,
} from './tileShadowRefresh';
import type { Obstruction } from '../types';

const PIN = { lat: 44.4064076, lng: 26.1096245 };

function tree(index: number): Obstruction {
  const lng = PIN.lng + index * 0.000001;
  return {
    kind: 'tree',
    geometry: [
      { lat: PIN.lat, lng },
      { lat: PIN.lat, lng: lng + 0.000001 },
      { lat: PIN.lat + 0.000001, lng: lng + 0.000001 },
      { lat: PIN.lat + 0.000001, lng },
    ],
    heightMeters: 12,
    heightFromTag: false,
  };
}

describe('selectNearestBounded', () => {
  it('returns empty array when limit is 0', () => {
    expect(selectNearestBounded([{ value: 1, distanceSquared: 10, key: 'a' }], 0)).toEqual([]);
  });

  it('skips non-finite distanceSquared and handles heap siftDown branches', () => {
    const input = [
      { value: 'nan', distanceSquared: NaN, key: 'nan' },
      { value: 'inf', distanceSquared: Infinity, key: 'inf' },
      { value: 'a', distanceSquared: 100, key: 'a' },
      { value: 'b', distanceSquared: 50, key: 'b' },
      { value: 'c', distanceSquared: 10, key: 'c' },
      { value: 'd', distanceSquared: 5, key: 'd' },
    ];
    const result = selectNearestBounded(input, 2);
    expect(result.map((item) => item.value)).toEqual(['d', 'c']);
  });

  it('retains a deterministic nearest subset without retaining the full input', () => {
    const input = Array.from({ length: 100 }, (_, index) => ({
      value: index,
      distanceSquared: 100 - index,
      key: index.toString().padStart(3, '0'),
    }));
    expect(selectNearestBounded(input, 3).map(({ value }) => value)).toEqual([99, 98, 97]);
    expect(selectNearestBounded([...input].reverse(), 3).map(({ value }) => value)).toEqual([
      99, 98, 97,
    ]);
  });
});

describe('prepareRemoteShadowCasters', () => {
  it('caps nearest remote trees before projection and triangulation', () => {
    const obstructions = Array.from(
      { length: MAX_REMOTE_TREE_CASTERS_TO_PREPARE + 20 },
      (_, index) => tree(index),
    );
    const casters = prepareRemoteShadowCasters(PIN, obstructions);
    expect(casters).toHaveLength(MAX_REMOTE_TREE_CASTERS_TO_PREPARE);
    expect(casters[0].distanceSquared).toBeLessThan(casters[casters.length - 1].distanceSquared);
  });

  it('skips forestArea ways, non-finite points, and degenerate rings', () => {
    const forest: Obstruction = {
      kind: 'tree',
      geometry: [
        { lat: PIN.lat, lng: PIN.lng },
        { lat: PIN.lat, lng: PIN.lng + 0.001 },
        { lat: PIN.lat + 0.001, lng: PIN.lng },
      ],
      heightMeters: 18,
      heightFromTag: false,
      forestArea: true,
    };
    const nonFinite: Obstruction = {
      kind: 'tree',
      geometry: [
        { lat: NaN, lng: PIN.lng },
        { lat: PIN.lat, lng: PIN.lng + 0.001 },
        { lat: PIN.lat + 0.001, lng: PIN.lng },
      ],
      heightMeters: 12,
      heightFromTag: false,
    };
    const degenerate: Obstruction = {
      kind: 'building',
      geometry: [
        { lat: PIN.lat, lng: PIN.lng },
        { lat: PIN.lat, lng: PIN.lng },
        { lat: PIN.lat, lng: PIN.lng },
      ],
      heightMeters: 10,
      heightFromTag: false,
    };

    expect(prepareRemoteShadowCasters(PIN, [forest, nonFinite, degenerate])).toEqual([]);
  });

  it('skips pathological rings before earcut', () => {
    const oversized: Obstruction = {
      ...tree(0),
      geometry: Array.from({ length: MAX_REMOTE_SHADOW_RING_POINTS + 1 }, (_, index) => ({
        lat: PIN.lat + index * 0.000001,
        lng: PIN.lng,
      })),
    };
    expect(prepareRemoteShadowCasters(PIN, [oversized])).toEqual([]);
  });
});

describe('tile shadow refresh gate', () => {
  it('allows one successful source refresh per camera generation', () => {
    const gate = createTileShadowRefreshGate();
    expect(shouldScheduleTileShadowSource(gate)).toBe(true);
    expect(completeTileShadowRefresh(gate, 0)).toBe(true);
    expect(shouldScheduleTileShadowSource(gate)).toBe(false);
    expect(completeTileShadowRefresh(gate, 0)).toBe(false);

    const generation = beginTileShadowMove(gate);
    expect(shouldScheduleTileShadowSource(gate)).toBe(true);
    expect(completeTileShadowRefresh(gate, generation - 1)).toBe(false);
    expect(completeTileShadowRefresh(gate, generation)).toBe(true);
    expect(shouldScheduleTileShadowSource(gate)).toBe(false);
  });
});
