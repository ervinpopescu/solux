// ==============================================================================
// useHorizon — async pipeline from a pin to an obstruction-aware horizon profile
// ==============================================================================
//
// State machine:
//
//      pin = null          → 'idle'
//      pin set, cache hit  → 'ready' (profile from localStorage) → obstructions fill in
//      pin set, cache miss → 'loading' → 'ready' | 'error'
//
// The hook abort-controls in-flight fetches when the pin moves, and persists
// each successful profile back into localStorage so the next visit to the
// same area is instant.
//
// It also returns the raw `obstructions` that the profile was built from. These
// drive the ground-shadow layer, which needs full footprints (the profile is a
// lossy 360-bucket reduction). We deliberately fetch obstructions even on a
// profile cache hit: the profile cache saves the *rebuild*, but shadows still
// need the footprints, and map feature-queries can't supply them reliably in a
// pitched 3D view (far tiles load at a zoom without the building layer). A
// session-scoped in-memory memo keeps repeat pins in the same area instant.

import { useEffect, useRef, useState } from 'react';
import type { Obstruction, HorizonProfile, LatLng } from '../types';
import { loadProfile, saveProfile, gridCell } from '../buildings/cache';
import { fetchObstructions } from '../buildings/overpass';
import { buildHorizonProfile } from '../buildings/horizon';

const DEFAULT_RADIUS_M = 1000;

export type HorizonStatus = 'idle' | 'loading' | 'ready' | 'error';

export type HorizonState = {
  status: HorizonStatus;
  profile: HorizonProfile | null;
  /** Raw footprints the profile came from; used by the shadow layer. */
  obstructions: Obstruction[] | null;
  error: string | null;
};

// Session-scoped obstruction cache (grid cell + radius → footprints). Obstructions
// can be megabytes, so we keep them in memory only rather than localStorage; a cold
// reload refetches, which is acceptable for data that changes on the order of months.
const obstructionMemo = new Map<string, Obstruction[]>();

function memoKey(pin: LatLng, radius: number): string {
  const c = gridCell(pin);
  return `${c.lat.toFixed(3)},${c.lng.toFixed(3)},${radius}`;
}

export function useHorizon(pin: LatLng | null, radius: number = DEFAULT_RADIUS_M): HorizonState {
  const [state, setState] = useState<HorizonState>({
    status: 'idle',
    profile: null,
    obstructions: null,
    error: null,
  });

  // Track the most recently requested pin so a late-arriving fetch for an
  // older pin doesn't overwrite a newer result.
  const reqRef = useRef(0);

  useEffect(() => {
    if (!pin) {
      setState({ status: 'idle', profile: null, obstructions: null, error: null });
      return;
    }

    const myReq = ++reqRef.current;
    const cachedProfile = loadProfile(pin, radius);
    const memoedObstructions = obstructionMemo.get(memoKey(pin, radius));

    // Fast path: both profile and obstructions already available in memory/cache.
    if (cachedProfile && memoedObstructions) {
      setState({
        status: 'ready',
        profile: cachedProfile,
        obstructions: memoedObstructions,
        error: null,
      });
      return;
    }

    // Show the cached profile immediately if we have it; obstructions still load.
    setState({
      status: cachedProfile ? 'ready' : 'loading',
      profile: cachedProfile,
      obstructions: memoedObstructions ?? null,
      error: null,
    });

    // If obstructions are memoed but the profile isn't cached, rebuild it locally
    // without a network round-trip.
    if (memoedObstructions && !cachedProfile) {
      const center = gridCell(pin);
      const profile = buildHorizonProfile(pin, memoedObstructions, radius, center.lat, center.lng);
      saveProfile(pin, profile);
      setState({ status: 'ready', profile, obstructions: memoedObstructions, error: null });
      return;
    }

    // Otherwise fetch footprints from Overpass, then derive/keep the profile.
    const ctrl = new AbortController();
    (async () => {
      try {
        const obstructions = await fetchObstructions(pin, radius, ctrl.signal);
        if (myReq !== reqRef.current) return; // pin moved; discard stale
        obstructionMemo.set(memoKey(pin, radius), obstructions);

        const center = gridCell(pin);
        const profile =
          cachedProfile ?? buildHorizonProfile(pin, obstructions, radius, center.lat, center.lng);
        if (!cachedProfile) saveProfile(pin, profile);

        if (myReq !== reqRef.current) return;
        setState({ status: 'ready', profile, obstructions, error: null });
      } catch (err) {
        if (myReq !== reqRef.current) return;
        if ((err as { name?: string }).name === 'AbortError') return;
        setState({
          status: 'error',
          profile: cachedProfile,
          obstructions: null,
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
