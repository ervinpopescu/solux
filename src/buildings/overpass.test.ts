import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchObstructions, parseObstructions, type OverpassError } from './overpass';

describe('parseObstructions', () => {
  it('returns an empty array for malformed input', () => {
    expect(parseObstructions(null)).toEqual([]);
    expect(parseObstructions({})).toEqual([]);
    expect(parseObstructions({ elements: 'nope' })).toEqual([]);
  });

  it('parses way features with explicit height tags', () => {
    const obs = parseObstructions({
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
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('building');
    expect(obs[0].heightMeters).toBe(12);
    expect(obs[0].heightFromTag).toBe(true);
    expect(obs[0].geometry).toEqual([
      { lat: 1, lng: 2 },
      { lat: 1, lng: 3 },
      { lat: 2, lng: 3 },
    ]);
  });

  it('derives height from building:levels when no explicit height', () => {
    const obs = parseObstructions({
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
    expect(obs).toHaveLength(1);
    // 4 levels × 3.5 m/level.
    expect(obs[0].heightMeters).toBe(14);
  });

  it('drops buildings with no height info and no fallback', () => {
    const obs = parseObstructions({
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
    expect(obs).toEqual([]);
  });

  it('skips unrecognized elements and degenerate geometries', () => {
    const obs = parseObstructions({
      elements: [
        { type: 'node', tags: { building: 'yes', height: '8' } },
        {
          type: 'way',
          tags: { building: 'yes', height: '8' },
          geometry: [{ lat: 0, lon: 0 }],
        },
      ],
    });
    expect(obs).toEqual([]);
  });
});

describe('fetchObstructions', () => {
  afterEach(() => vi.unstubAllGlobals());

  const PIN = { lat: 51.5074, lng: -0.1278 };

  it('POSTs an Overpass query and returns the parsed obstructions', async () => {
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

    const obs = await fetchObstructions(PIN, 1000);
    expect(obs).toHaveLength(1);
    expect(obs[0].heightMeters).toBe(9);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('overpass-api.de');
    expect(init.method).toBe('POST');

    const body = decodeURIComponent((init.body as string).replace('data=', ''));
    expect(body).toContain('way["building"]');
    expect(body).toContain('node["natural"="tree"]');
    expect(body).toContain('way["natural"="wood"]');
    expect(body).toContain('way["landuse"="forest"]');
  });

  it('throws an OverpassError carrying the HTTP status on a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    await expect(fetchObstructions(PIN, 1000)).rejects.toMatchObject({
      kind: 'overpass',
      status: 429,
    } satisfies Partial<OverpassError>);
  });
});

describe('parseObstructions — tree features', () => {
  it('parses a node with natural=tree and explicit height', () => {
    const obs = parseObstructions({
      elements: [
        {
          type: 'node',
          lat: 51.5,
          lon: -0.1,
          tags: { natural: 'tree', height: '15' },
        },
      ],
    });
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('tree');
    expect(obs[0].heightMeters).toBe(15);
    expect(obs[0].heightFromTag).toBe(true);
    // Canopy is synthesized: 8 vertices around the trunk point.
    expect(obs[0].geometry).toHaveLength(8);
  });

  it('looks up height from species tag (case-insensitive genus prefix)', () => {
    const obs = parseObstructions({
      elements: [
        {
          type: 'node',
          lat: 51.5,
          lon: -0.1,
          tags: { natural: 'tree', species: 'Quercus robur' },
        },
        {
          type: 'node',
          lat: 51.5,
          lon: -0.2,
          tags: { natural: 'tree', species: 'PINUS sylvestris' },
        },
      ],
    });
    expect(obs[0].heightMeters).toBe(20); // oak
    expect(obs[0].heightFromTag).toBe(true);
    expect(obs[1].heightMeters).toBe(25); // pine
    expect(obs[1].heightFromTag).toBe(true);
  });

  it('falls back to 12 m for a node with no height or species', () => {
    const obs = parseObstructions({
      elements: [{ type: 'node', lat: 51.5, lon: -0.1, tags: { natural: 'tree' } }],
    });
    expect(obs).toHaveLength(1);
    expect(obs[0].heightMeters).toBe(12);
    expect(obs[0].heightFromTag).toBe(false);
  });

  it('synthesizes a canopy polygon using crown_diameter when present', () => {
    const obs = parseObstructions({
      elements: [
        {
          type: 'node',
          lat: 0,
          lon: 0,
          tags: { natural: 'tree', height: '10', crown_diameter: '8' },
        },
      ],
    });
    // radius = 4 m; dLat = 4/111320 ≈ 0.0000359
    // vertex 0 is north: lat ≈ 0.0000359, lng ≈ 0
    expect(obs[0].geometry).toHaveLength(8);
    const northVertex = obs[0].geometry[0];
    expect(northVertex.lat).toBeCloseTo(4 / 111_320, 6);
    expect(northVertex.lng).toBeCloseTo(0, 6);
  });

  it('synthesizes a canopy using height * 0.25 when no crown_diameter', () => {
    const obs = parseObstructions({
      elements: [{ type: 'node', lat: 0, lon: 0, tags: { natural: 'tree', height: '20' } }],
    });
    // radius = 20 * 0.25 = 5 m; northVertex.lat ≈ 5/111320
    const northVertex = obs[0].geometry[0];
    expect(northVertex.lat).toBeCloseTo(5 / 111_320, 6);
  });

  it('parses a way with natural=wood as a tree area', () => {
    const obs = parseObstructions({
      elements: [
        {
          type: 'way',
          tags: { natural: 'wood' },
          geometry: [
            { lat: 51.5, lon: -0.1 },
            { lat: 51.6, lon: -0.1 },
            { lat: 51.6, lon: 0.0 },
          ],
        },
      ],
    });
    expect(obs).toHaveLength(1);
    expect(obs[0].kind).toBe('tree');
    expect(obs[0].heightMeters).toBe(18); // wooded-area fallback
    expect(obs[0].heightFromTag).toBe(false);
    expect(obs[0].geometry).toHaveLength(3);
  });

  it('parses a way with landuse=forest and explicit height', () => {
    const obs = parseObstructions({
      elements: [
        {
          type: 'way',
          tags: { landuse: 'forest', height: '25' },
          geometry: [
            { lat: 51.5, lon: -0.1 },
            { lat: 51.6, lon: -0.1 },
            { lat: 51.6, lon: 0.0 },
          ],
        },
      ],
    });
    expect(obs[0].kind).toBe('tree');
    expect(obs[0].heightMeters).toBe(25);
    expect(obs[0].heightFromTag).toBe(true);
  });

  it('parses mixed buildings and trees in one response', () => {
    const obs = parseObstructions({
      elements: [
        {
          type: 'way',
          tags: { building: 'yes', height: '10' },
          geometry: [
            { lat: 1, lon: 1 },
            { lat: 1, lon: 2 },
            { lat: 2, lon: 1 },
          ],
        },
        {
          type: 'node',
          lat: 51.5,
          lon: -0.1,
          tags: { natural: 'tree', height: '8' },
        },
        {
          type: 'way',
          tags: { natural: 'wood' },
          geometry: [
            { lat: 3, lon: 3 },
            { lat: 3, lon: 4 },
            { lat: 4, lon: 3 },
          ],
        },
      ],
    });
    expect(obs).toHaveLength(3);
    expect(obs[0].kind).toBe('building');
    expect(obs[1].kind).toBe('tree');
    expect(obs[2].kind).toBe('tree');
  });
});
