import { describe, expect, it } from 'vitest';
import { parseBuildings } from './overpass';

describe('parseBuildings', () => {
  it('returns an empty array for malformed input', () => {
    expect(parseBuildings(null)).toEqual([]);
    expect(parseBuildings({})).toEqual([]);
    expect(parseBuildings({ elements: 'nope' })).toEqual([]);
  });

  it('parses way features with explicit height tags', () => {
    const buildings = parseBuildings({
      elements: [
        {
          type: 'way',
          tags: { building: 'yes', height: '12' },
          geometry: [
            { lat: 1, lon: 2 },
            { lat: 1, lon: 3 },
            { lat: 2, lon: 3 },
          ],
        },
      ],
    });

    expect(buildings).toHaveLength(1);
    expect(buildings[0].heightMeters).toBe(12);
    expect(buildings[0].heightFromTag).toBe(true);
    expect(buildings[0].geometry).toEqual([
      { lat: 1, lng: 2 },
      { lat: 1, lng: 3 },
      { lat: 2, lng: 3 },
    ]);
  });

  it('derives height from building:levels when no explicit height', () => {
    const buildings = parseBuildings({
      elements: [
        {
          type: 'way',
          tags: { building: 'yes', 'building:levels': '4' },
          geometry: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 1 },
            { lat: 1, lon: 0 },
          ],
        },
      ],
    });

    expect(buildings).toHaveLength(1);
    // 4 levels × 3.5 m/level.
    expect(buildings[0].heightMeters).toBe(14);
  });

  it('drops buildings with no height info and no fallback', () => {
    const buildings = parseBuildings({
      elements: [
        {
          type: 'way',
          tags: { building: 'yes' },
          geometry: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 1 },
            { lat: 1, lon: 0 },
          ],
        },
      ],
    });

    expect(buildings).toEqual([]);
  });

  it('skips non-way elements and degenerate geometries', () => {
    const buildings = parseBuildings({
      elements: [
        { type: 'node', tags: { building: 'yes', height: '8' } },
        {
          type: 'way',
          tags: { building: 'yes', height: '8' },
          geometry: [{ lat: 0, lon: 0 }], // too few vertices
        },
      ],
    });

    expect(buildings).toEqual([]);
  });
});
