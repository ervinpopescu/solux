// ==============================================================================
// useHorizon — async pipeline from a pin to a building-aware horizon profile
// ==============================================================================
//
// State machine:
//
//      pin = null          → 'idle'
//      pin set, cache hit  → 'ready' (profile from localStorage) → buildings fill in
//      pin set, cache miss → 'loading' → 'ready' | 'error'
//
// The hook abort-controls in-flight fetches when the pin moves, and persists
// each successful profile back into localStorage so the next visit to the
// same area is instant.
//
// It also returns the raw `buildings` that the profile was built from. These
// drive the ground-shadow layer, which needs full footprints (the profile is a
// lossy 360-bucket reduction). We deliberately fetch buildings even on a
// profile cache hit: the profile cache saves the *rebuild*, but shadows still
// need the footprints, and map feature-queries can't supply them reliably in a
// pitched 3D view (far tiles load at a zoom without the building layer). A
// session-scoped in-memory memo keeps repeat pins in the same area instant.

import { useEffect, useRef, useState } from 'react';
import type { Building, HorizonProfile, LatLng } from '../types';
import { loadProfile, saveProfile, gridCell } from '../buildings/cache';
import { fetchBuildings } from '../buildings/overpass';
import { buildHorizonProfile } from '../buildings/horizon';

const DEFAULT_RADIUS_M = 1000;

export type HorizonStatus = 'idle' | 'loading' | 'ready' | 'error';

export type HorizonState = {
  status: HorizonStatus;
  profile: HorizonProfile | null;
  /** Raw footprints the profile came from; used by the shadow layer. */
  buildings: Building[] | null;
  error: string | null;
};

// Session-scoped building cache (grid cell + radius → footprints). Buildings can
// be megabytes, so we keep them in memory only rather than localStorage; a cold
// reload refetches, which is acceptable for data that changes on the order of
// months.
const buildingMemo = new Map<string, Building[]>();

function memoKey(pin: LatLng, radius: number): string {
  const c = gridCell(pin);
  return `${c.lat.toFixed(3)},${c.lng.toFixed(3)},${radius}`;
}

export function useHorizon(
  pin: LatLng | null,
  radius: number = DEFAULT_RADIUS_M,
): HorizonState {
  const [state, setState] = useState<HorizonState>({
    status: 'idle',
    profile: null,
    buildings: null,
    error: null,
  });

  // Track the most recently requested pin so a late-arriving fetch for an
  // older pin doesn't overwrite a newer result.
  const reqRef = useRef(0);

  useEffect(() => {
    if (!pin) {
      setState({ status: 'idle', profile: null, buildings: null, error: null });
      return;
    }

    const myReq = ++reqRef.current;
    const cachedProfile = loadProfile(pin, radius);
    const memoedBuildings = buildingMemo.get(memoKey(pin, radius));

    // Fast path: both profile and buildings already available in memory/cache.
    if (cachedProfile && memoedBuildings) {
      setState({ status: 'ready', profile: cachedProfile, buildings: memoedBuildings, error: null });
      return;
    }

    // Show the cached profile immediately if we have it; buildings still load.
    setState({
      status: cachedProfile ? 'ready' : 'loading',
      profile: cachedProfile,
      buildings: memoedBuildings ?? null,
      error: null,
    });

    // If buildings are memoed but the profile isn't cached, rebuild it locally
    // without a network round-trip.
    if (memoedBuildings && !cachedProfile) {
      const center = gridCell(pin);
      const profile = buildHorizonProfile(pin, memoedBuildings, radius, center.lat, center.lng);
      saveProfile(pin, profile);
      setState({ status: 'ready', profile, buildings: memoedBuildings, error: null });
      return;
    }

    // Otherwise fetch footprints from Overpass, then derive/keep the profile.
    const ctrl = new AbortController();
    (async () => {
      try {
        const buildings = await fetchBuildings(pin, radius, ctrl.signal);
        if (myReq !== reqRef.current) return; // pin moved; discard stale
        buildingMemo.set(memoKey(pin, radius), buildings);

        const center = gridCell(pin);
        const profile =
          cachedProfile ??
          buildHorizonProfile(pin, buildings, radius, center.lat, center.lng);
        if (!cachedProfile) saveProfile(pin, profile);


        if (myReq !== reqRef.current) return;
        setState({ status: 'ready', profile, buildings, error: null });
      } catch (err) {
        if (myReq !== reqRef.current) return;
        if ((err as { name?: string }).name === 'AbortError') return;
        setState({
          status: 'error',
          profile: cachedProfile,
          buildings: null,
          error: err instanceof Error ? err.message : 'Unknown error',
        });
      }
    })();

    return () => {
      ctrl.abort();
    };
  }, [pin?.lat, pin?.lng, pin, radius]);

  return state;
}
