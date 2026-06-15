// ==============================================================================
// usePrefs — single source of truth for persisted user preferences
// ==============================================================================
//
// We could spread the persistence across three independent `useState +
// useEffect` pairs, but consolidating them here keeps the storage write
// atomic (one JSON blob per change) and the App component lean.
//
// The hook initializes lazily from `localStorage`, then mirrors every
// updater call back out. Writes are best-effort; see `savePrefs` for the
// silent-failure rationale.

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_PREFS, loadPrefs, savePrefs } from '../storage/prefs';
import type { DisplayMode, LatLng, Prefs } from '../types';

export type PrefsApi = {
  prefs: Prefs;
  setPin: (pin: LatLng | null) => void;
  setDate: (iso: string) => void;
  setDisplayMode: (m: DisplayMode) => void;
};

export function usePrefs(): PrefsApi {
  // Lazy initializer: read localStorage exactly once, on mount.
  const [prefs, setPrefs] = useState<Prefs>(() => {
    if (typeof window === 'undefined') return DEFAULT_PREFS;
    return loadPrefs();
  });

  // Persist on every change. Cheap; the blob is small.
  useEffect(() => {
    savePrefs(prefs);
  }, [prefs]);

  const setPin = useCallback((pin: LatLng | null) => {
    setPrefs((p) => ({ ...p, pin }));
  }, []);

  const setDate = useCallback((iso: string) => {
    setPrefs((p) => ({ ...p, date: iso }));
  }, []);

  const setDisplayMode = useCallback((displayMode: DisplayMode) => {
    setPrefs((p) => ({ ...p, displayMode }));
  }, []);

  return { prefs, setPin, setDate, setDisplayMode };
}
