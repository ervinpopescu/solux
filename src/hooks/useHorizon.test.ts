import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { useHorizon } from './useHorizon';
import { saveProfile } from '../buildings/cache';
import type { Building, HorizonProfile } from '../types';

// Mock the network boundary. Everything else (localStorage cache, profile
// builder, in-memory memo) runs for real so the state machine is exercised
// end to end.
vi.mock('../buildings/overpass', () => ({ fetchBuildings: vi.fn() }));
import { fetchBuildings } from '../buildings/overpass';
const mockFetchBuildings = vi.mocked(fetchBuildings);

// Distinct coordinates per test so the module-scoped buildingMemo (which the
// hook never clears) can't leak a hit from one test into another.
const PIN_FETCH = { lat: 10, lng: 10 };
const PIN_CACHED = { lat: 20, lng: 20 };
const PIN_ERROR = { lat: 30, lng: 30 };

function makeProfile(overrides: Partial<HorizonProfile> = {}): HorizonProfile {
  return {
    bucketsRad: new Float32Array(360).fill(0),
    buildingCount: 7,
    radiusMeters: 1000,
    centerLat: PIN_CACHED.lat,
    centerLng: PIN_CACHED.lng,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  mockFetchBuildings.mockReset();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('useHorizon', () => {
  it('is idle with no pin and never fetches', () => {
    const { result } = renderHook(() => useHorizon(null));
    expect(result.current.status).toBe('idle');
    expect(result.current.profile).toBeNull();
    expect(result.current.buildings).toBeNull();
    expect(mockFetchBuildings).not.toHaveBeenCalled();
  });

  it('goes loading → ready on a cache miss, fetching footprints', async () => {
    const buildings: Building[] = [];
    mockFetchBuildings.mockResolvedValue(buildings);

    const { result } = renderHook(() => useHorizon(PIN_FETCH));
    // No cached profile, no memoed buildings → starts loading.
    expect(result.current.status).toBe('loading');

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.profile).not.toBeNull();
    expect(result.current.buildings).toEqual(buildings);
    expect(mockFetchBuildings).toHaveBeenCalledOnce();
  });

  it('shows a cached profile immediately as ready', async () => {
    saveProfile(PIN_CACHED, makeProfile({ buildingCount: 7 }));
    mockFetchBuildings.mockResolvedValue([]);

    const { result } = renderHook(() => useHorizon(PIN_CACHED));
    // Cached profile short-circuits straight to ready without waiting.
    expect(result.current.status).toBe('ready');
    expect(result.current.profile?.buildingCount).toBe(7);

    // Buildings still load in the background; status stays ready.
    await waitFor(() => expect(result.current.buildings).not.toBeNull());
    expect(result.current.status).toBe('ready');
  });

  it('surfaces an error when the fetch fails', async () => {
    mockFetchBuildings.mockRejectedValue(new Error('Overpass HTTP 500'));

    const { result } = renderHook(() => useHorizon(PIN_ERROR));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('Overpass HTTP 500');
    expect(result.current.buildings).toBeNull();
  });
});
