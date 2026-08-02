// ==============================================================================
// useHorizon — async pipeline from a pin to an obstruction-aware horizon profile
// ==============================================================================
//
// State transitions:
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

import { useEffect, useMemo, useState } from 'react';
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

type HorizonSnapshot = {
  requestKey: string | null;
  pin: LatLng | null;
  state: HorizonState;
  cachedProfile: HorizonProfile | null;
  memoedObstructions: Obstruction[] | null;
  operation: 'none' | 'build' | 'fetch';
};

type RequestIncarnation = {
  active: boolean;
};

type AsyncHorizonState = {
  snapshot: HorizonSnapshot;
  state: HorizonState;
};

// Session-scoped obstruction cache (grid cell + radius → footprints). Obstructions
// can be megabytes, so we keep them in memory only rather than localStorage; a cold
// reload refetches, which is acceptable for data that changes on the order of months.
const obstructionMemo = new Map<string, Obstruction[]>();

function memoKey(pin: LatLng, radius: number): string {
  const c = gridCell(pin);
  return `${c.lat.toFixed(3)},${c.lng.toFixed(3)},${radius}`;
}

const IDLE_STATE: HorizonState = {
  status: 'idle',
  profile: null,
  obstructions: null,
  error: null,
};

export function useHorizon(pin: LatLng | null, radius: number = DEFAULT_RADIUS_M): HorizonState {
  const lat = pin?.lat;
  const lng = pin?.lng;
  const [asyncState, setAsyncState] = useState<AsyncHorizonState | null>(null);

  const snapshot = useMemo<HorizonSnapshot>(() => {
    if (lat === undefined || lng === undefined) {
      return {
        requestKey: null,
        pin: null,
        state: IDLE_STATE,
        cachedProfile: null,
        memoedObstructions: null,
        operation: 'none',
      };
    }

    const currentPin = { lat, lng };
    const requestKey = JSON.stringify([lat, lng, radius]);
    const cachedProfile = loadProfile(currentPin, radius);
    const memoedObstructions = obstructionMemo.get(memoKey(currentPin, radius)) ?? null;

    return {
      requestKey,
      pin: currentPin,
      state: {
        status: cachedProfile ? 'ready' : 'loading',
        profile: cachedProfile,
        obstructions: memoedObstructions,
        error: null,
      },
      cachedProfile,
      memoedObstructions,
      operation: memoedObstructions ? (cachedProfile ? 'none' : 'build') : 'fetch',
    };
    // Pin identity is intentional: repinning the same coordinates retries a failed request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin, lat, lng, radius]);

  useEffect(() => {
    if (!snapshot.pin || !snapshot.requestKey || snapshot.operation === 'none') return;

    const currentPin = snapshot.pin;
    const incarnation: RequestIncarnation = { active: true };

    if (snapshot.operation === 'build') {
      void Promise.resolve().then(() => {
        if (!incarnation.active || !snapshot.memoedObstructions) return;
        const center = gridCell(currentPin);
        const profile = buildHorizonProfile(
          currentPin,
          snapshot.memoedObstructions,
          radius,
          center.lat,
          center.lng,
        );
        saveProfile(currentPin, profile);
        setAsyncState({
          snapshot,
          state: {
            status: 'ready',
            profile,
            obstructions: snapshot.memoedObstructions,
            error: null,
          },
        });
      });
      return () => {
        incarnation.active = false;
      };
    }

    const ctrl = new AbortController();
    void fetchObstructions(currentPin, radius, ctrl.signal).then(
      (obstructions) => {
        if (ctrl.signal.aborted) return;
        obstructionMemo.set(memoKey(currentPin, radius), obstructions);

        const center = gridCell(currentPin);
        const profile =
          snapshot.cachedProfile ??
          buildHorizonProfile(currentPin, obstructions, radius, center.lat, center.lng);
        if (!snapshot.cachedProfile) saveProfile(currentPin, profile);

        setAsyncState({
          snapshot,
          state: { status: 'ready', profile, obstructions, error: null },
        });
      },
      (err: unknown) => {
        if (ctrl.signal.aborted || (err as { name?: string }).name === 'AbortError') return;
        setAsyncState({
          snapshot,
          state: {
            status: 'error',
            profile: snapshot.cachedProfile,
            obstructions: null,
            error: err instanceof Error ? err.message : 'Unknown error',
          },
        });
      },
    );

    return () => {
      incarnation.active = false;
      ctrl.abort();
    };
  }, [snapshot, radius]);

  return asyncState?.snapshot === snapshot ? asyncState.state : snapshot.state;
}
