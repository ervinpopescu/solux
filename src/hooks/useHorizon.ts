// ==============================================================================
// useHorizon — async pipeline from a pin to a building-aware horizon profile
// ==============================================================================
//
// State machine:
//
//      pin = null          → 'idle'
//      pin set, cache hit  → 'ready' (profile from localStorage)
//      pin set, cache miss → 'loading' → 'ready' | 'error'
//
// The hook abort-controls in-flight fetches when the pin moves, and persists
// each successful profile back into localStorage so the next visit to the
// same area is instant.

import { useEffect, useRef, useState } from 'react';
import type { HorizonProfile, LatLng } from '../types';
import { loadProfile, saveProfile, gridCell } from '../buildings/cache';
import { fetchBuildings } from '../buildings/overpass';
import { buildHorizonProfile } from '../buildings/horizon';

const DEFAULT_RADIUS_M = 1000;

export type HorizonStatus = 'idle' | 'loading' | 'ready' | 'error';

export type HorizonState = {
  status: HorizonStatus;
  profile: HorizonProfile | null;
  error: string | null;
};

export function useHorizon(pin: LatLng | null, radius: number = DEFAULT_RADIUS_M): HorizonState {
  const [state, setState] = useState<HorizonState>({
    status: 'idle',
    profile: null,
    error: null,
  });

  // Track the most recently requested pin so a late-arriving fetch for an
  // older pin doesn't overwrite a newer result.
  const reqRef = useRef(0);

  useEffect(() => {
    if (!pin) {
      setState({ status: 'idle', profile: null, error: null });
      return;
    }

    const myReq = ++reqRef.current;

    // 1. Cache lookup — instant if we've been here before.
    const cached = loadProfile(pin, radius);
    if (cached) {
      setState({ status: 'ready', profile: cached, error: null });
      return;
    }

    // 2. Cache miss — fetch from Overpass. Show loading immediately.
    setState({ status: 'loading', profile: null, error: null });
    const ctrl = new AbortController();

    (async () => {
      try {
        const buildings = await fetchBuildings(pin, radius, ctrl.signal);
        if (myReq !== reqRef.current) return; // pin moved; discard stale
        const center = gridCell(pin);
        const profile = buildHorizonProfile(pin, buildings, radius, center.lat, center.lng);
        saveProfile(pin, profile);
        if (myReq !== reqRef.current) return;
        setState({ status: 'ready', profile, error: null });
      } catch (err) {
        if (myReq !== reqRef.current) return;
        // Abort is fine; anything else surfaces as a recoverable UI error.
        if ((err as { name?: string }).name === 'AbortError') return;
        setState({
          status: 'error',
          profile: null,
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
