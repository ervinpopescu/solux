import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { useHorizon } from './useHorizon';
import { saveProfile } from '../buildings/cache';
import type { Obstruction, HorizonProfile } from '../types';

// Mock the network boundary. Everything else (localStorage cache, profile
// builder, in-memory memo) runs for real so the state machine is exercised
// end to end.
vi.mock('../buildings/overpass', () => ({ fetchObstructions: vi.fn() }));
import { fetchObstructions } from '../buildings/overpass';
const mockFetchObstructions = vi.mocked(fetchObstructions);

// Distinct coordinates per test so the module-scoped obstructionMemo (which the
// hook never clears) can't leak a hit from one test into another.
const PIN_FETCH = { lat: 10, lng: 10 };
const PIN_CACHED = { lat: 20, lng: 20 };
const PIN_ERROR = { lat: 30, lng: 30 };

function makeProfile(overrides: Partial<HorizonProfile> = {}): HorizonProfile {
  return {
    bucketsRad: new Float32Array(360).fill(0),
    buildingCount: 7,
    treeCount: 0,
    insideForest: false,
    radiusMeters: 1000,
    centerLat: PIN_CACHED.lat,
    centerLng: PIN_CACHED.lng,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  mockFetchObstructions.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('useHorizon', () => {
  it('is idle with no pin and never fetches', () => {
    const { result } = renderHook(() => useHorizon(null));
    expect(result.current.status).toBe('idle');
    expect(result.current.profile).toBeNull();
    expect(result.current.obstructions).toBeNull();
    expect(mockFetchObstructions).not.toHaveBeenCalled();
  });

  it('goes loading → ready on a cache miss, fetching footprints', async () => {
    const obstructions: Obstruction[] = [];
    mockFetchObstructions.mockResolvedValue(obstructions);

    const { result } = renderHook(() => useHorizon(PIN_FETCH));
    // No cached profile, no memoed obstructions → starts loading.
    expect(result.current.status).toBe('loading');

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.profile).not.toBeNull();
    expect(result.current.obstructions).toEqual(obstructions);
    expect(mockFetchObstructions).toHaveBeenCalledOnce();
  });

  it('shows a cached profile immediately as ready', async () => {
    saveProfile(PIN_CACHED, makeProfile({ buildingCount: 7 }));
    mockFetchObstructions.mockResolvedValue([]);

    const { result } = renderHook(() => useHorizon(PIN_CACHED));
    // Cached profile short-circuits straight to ready without waiting.
    expect(result.current.status).toBe('ready');
    expect(result.current.profile?.buildingCount).toBe(7);

    // Obstructions still load in the background; status stays ready.
    await waitFor(() => expect(result.current.obstructions).not.toBeNull());
    expect(result.current.status).toBe('ready');
  });

  it('surfaces an error when the fetch fails', async () => {
    mockFetchObstructions.mockRejectedValue(new Error('Overpass HTTP 500'));

    const { result } = renderHook(() => useHorizon(PIN_ERROR));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('Overpass HTTP 500');
    expect(result.current.obstructions).toBeNull();
  });
});
