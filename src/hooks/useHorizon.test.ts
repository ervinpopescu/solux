import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { useHorizon } from './useHorizon';
import { loadProfile, saveProfile } from '../buildings/cache';
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
const PIN_ABORT = { lat: 40, lng: 40 };
const PIN_RETRY = { lat: 50, lng: 50 };
const PIN_DIRECT_RETRY = { lat: 60, lng: 60 };
const PIN_MEMO_REBUILD = { lat: 70, lng: 70 };
const PIN_UNKNOWN_ERROR = { lat: 80, lng: 80 };
const PIN_ABORT_ERROR = { lat: 90, lng: 90 };

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

  it('reuses memoed obstructions and rebuilds a missing profile without refetching', async () => {
    mockFetchObstructions.mockResolvedValue([]);

    const first = renderHook(() => useHorizon(PIN_MEMO_REBUILD));
    await waitFor(() => expect(first.result.current.status).toBe('ready'));
    expect(mockFetchObstructions).toHaveBeenCalledOnce();
    first.unmount();

    // With both caches populated, a repeat request is ready synchronously and
    // performs no effect work.
    const cached = renderHook(() => useHorizon({ ...PIN_MEMO_REBUILD }));
    expect(cached.result.current.status).toBe('ready');
    expect(cached.result.current.obstructions).toEqual([]);
    expect(mockFetchObstructions).toHaveBeenCalledOnce();
    cached.unmount();

    // Removing only the persisted profile exercises the in-memory rebuild path.
    // Unmounting before its microtask runs must cancel that pending rebuild.
    window.localStorage.clear();
    const cancelled = renderHook(() => useHorizon({ ...PIN_MEMO_REBUILD }));
    expect(cancelled.result.current.status).toBe('loading');
    cancelled.unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadProfile(PIN_MEMO_REBUILD, 1000)).toBeNull();

    const rebuilt = renderHook(() => useHorizon({ ...PIN_MEMO_REBUILD }));
    expect(rebuilt.result.current.status).toBe('loading');
    await waitFor(() => expect(rebuilt.result.current.status).toBe('ready'));
    expect(rebuilt.result.current.profile).not.toBeNull();
    expect(rebuilt.result.current.obstructions).toEqual([]);
    expect(mockFetchObstructions).toHaveBeenCalledOnce();
    rebuilt.unmount();
  });

  it('surfaces an error when the fetch fails', async () => {
    mockFetchObstructions.mockRejectedValue(new Error('Overpass HTTP 500'));

    const { result } = renderHook(() => useHorizon(PIN_ERROR));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('Overpass HTTP 500');
    expect(result.current.obstructions).toBeNull();
  });

  it('normalizes a non-Error rejection', async () => {
    mockFetchObstructions.mockRejectedValue('network unavailable');

    const { result } = renderHook(() => useHorizon(PIN_UNKNOWN_ERROR));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.error).toBe('Unknown error');
  });

  it('ignores an AbortError rejection while the request remains mounted', async () => {
    mockFetchObstructions.mockRejectedValue({ name: 'AbortError' });

    const { result } = renderHook(() => useHorizon(PIN_ABORT_ERROR));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe('loading');
    expect(result.current.error).toBeNull();
  });

  it('starts a fresh request when a failed pin is cleared and restored', async () => {
    let resolveRetry!: (obstructions: Obstruction[]) => void;
    mockFetchObstructions
      .mockRejectedValueOnce(new Error('Overpass HTTP 500'))
      .mockImplementationOnce(
        () =>
          new Promise<Obstruction[]>((resolve) => {
            resolveRetry = resolve;
          }),
      );

    const { result, rerender } = renderHook(
      ({ pin }: { pin: typeof PIN_RETRY | null }) => useHorizon(pin),
      { initialProps: { pin: PIN_RETRY } as { pin: typeof PIN_RETRY | null } },
    );
    await waitFor(() => expect(result.current.status).toBe('error'));

    rerender({ pin: null });
    expect(result.current.status).toBe('idle');

    rerender({ pin: PIN_RETRY });
    expect(result.current.status).toBe('loading');
    expect(result.current.error).toBeNull();

    await act(async () => {
      resolveRetry([]);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(mockFetchObstructions).toHaveBeenCalledTimes(2);
  });

  it('starts a fresh request when failed coordinates are repinned directly', async () => {
    let resolveRetry!: (obstructions: Obstruction[]) => void;
    mockFetchObstructions
      .mockRejectedValueOnce(new Error('Overpass HTTP 500'))
      .mockImplementationOnce(
        () =>
          new Promise<Obstruction[]>((resolve) => {
            resolveRetry = resolve;
          }),
      );

    const { result, rerender } = renderHook(({ pin }) => useHorizon(pin), {
      initialProps: { pin: PIN_DIRECT_RETRY },
    });
    await waitFor(() => expect(result.current.status).toBe('error'));

    rerender({ pin: { ...PIN_DIRECT_RETRY } });
    expect(result.current.status).toBe('loading');
    expect(result.current.error).toBeNull();
    expect(mockFetchObstructions).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveRetry([]);
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
  });

  it('stays idle when an aborted request resolves after the pin is cleared', async () => {
    let resolveFetch!: (obstructions: Obstruction[]) => void;
    mockFetchObstructions.mockImplementation(
      () =>
        new Promise<Obstruction[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    const { result, rerender } = renderHook(
      ({ pin }: { pin: typeof PIN_ABORT | null }) => useHorizon(pin),
      { initialProps: { pin: PIN_ABORT } as { pin: typeof PIN_ABORT | null } },
    );
    expect(result.current.status).toBe('loading');

    rerender({ pin: null });
    expect(result.current.status).toBe('idle');

    await act(async () => {
      resolveFetch([]);
      await Promise.resolve();
    });
    expect(result.current.status).toBe('idle');
  });
});
