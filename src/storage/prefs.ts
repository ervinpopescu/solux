// ==============================================================================
// Persisted preferences
// ==============================================================================
//
// A tiny typed wrapper over `localStorage` so the rest of the app doesn't
// need to think about JSON, missing keys, or storage-disabled browsers.
//
// Safety properties:
//   - Read failures (parse errors, missing key, throwing access) → default.
//   - Write failures (quota exceeded, blocked storage) → silently ignored.
//     The app keeps working in-memory; the user just won't see persistence.
//
// We export both the generic load/save primitives and a domain-specific
// `Prefs` shape so call sites stay tidy.

import type { DisplayMode, LatLng, Prefs } from '../types';

const STORAGE_KEY = 'solux:prefs:v1';

export const DEFAULT_PREFS: Prefs = {
  pin: null,
  // Empty string means "use today in the appropriate timezone". The App
  // resolves this lazily at render time so a long-running tab doesn't get
  // stuck on yesterday's date after midnight.
  date: '',
  displayMode: 'card',
};

// Cheap shape validation. We accept anything that looks plausibly like a
// Prefs object and fall back to defaults for anything weird. This protects
// against e.g. a future schema change being read by an older client.
function isLatLng(v: unknown): v is LatLng {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as LatLng).lat === 'number' &&
    typeof (v as LatLng).lng === 'number' &&
    Number.isFinite((v as LatLng).lat) &&
    Number.isFinite((v as LatLng).lng)
  );
}

function isDisplayMode(v: unknown): v is DisplayMode {
  return v === 'card' || v === 'drawer' || v === 'panel' || v === 'popup';
}

function coercePrefs(raw: unknown): Prefs {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_PREFS;
  const r = raw as Record<string, unknown>;
  return {
    pin: isLatLng(r.pin) ? { lat: r.pin.lat, lng: r.pin.lng } : null,
    date: typeof r.date === 'string' ? r.date : '',
    displayMode: isDisplayMode(r.displayMode) ? r.displayMode : 'card',
  };
}

export function loadPrefs(): Prefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_PREFS;
    return coercePrefs(JSON.parse(raw));
  } catch {
    // Storage disabled, JSON malformed, or any other access error → defaults.
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: Prefs): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // Quota exceeded or storage blocked — fall through silently. The app
    // continues to work; the user just loses persistence for this session.
  }
}
