import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchBuildings, parseBuildings, type OverpassError } from './overpass';

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

describe('fetchBuildings', () => {
  afterEach(() => vi.unstubAllGlobals());

  const PIN = { lat: 51.5074, lng: -0.1278 };

  it('POSTs an Overpass query and returns the parsed buildings', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        elements: [
          {
            type: 'way',
            tags: { building: 'yes', height: '9' },
            geometry: [
              { lat: 1, lon: 2 },
              { lat: 1, lon: 3 },
              { lat: 2, lon: 3 },
            ],
          },
        ],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const buildings = await fetchBuildings(PIN, 1000);
    expect(buildings).toHaveLength(1);
    expect(buildings[0].heightMeters).toBe(9);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('overpass-api.de');
    expect(init.method).toBe('POST');
  });

  it('throws an OverpassError carrying the HTTP status on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }));

    await expect(fetchBuildings(PIN, 1000)).rejects.toMatchObject({
      kind: 'overpass',
      status: 429,
    } satisfies Partial<OverpassError>);
  });
});
