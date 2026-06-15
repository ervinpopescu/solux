import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, loadPrefs, savePrefs } from './prefs';
import type { Prefs } from '../types';

afterEach(() => {
  window.localStorage.clear();
});

describe('prefs storage', () => {
  it('returns DEFAULT_PREFS when nothing is stored', () => {
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('round-trips a valid Prefs object', () => {
    const p: Prefs = {
      pin: { lat: 51.5074, lng: -0.1278 },
      date: '2026-06-14',
      displayMode: 'drawer',
    };
    savePrefs(p);
    expect(loadPrefs()).toEqual(p);
  });

  it('returns defaults when the stored JSON is malformed', () => {
    window.localStorage.setItem('solux:prefs:v1', '{not json');
    expect(loadPrefs()).toEqual(DEFAULT_PREFS);
  });

  it('coerces unknown displayMode values back to default', () => {
    window.localStorage.setItem(
      'solux:prefs:v1',
      JSON.stringify({ pin: null, date: '', displayMode: 'hologram' }),
    );
    expect(loadPrefs().displayMode).toBe('card');
  });

  it('drops a pin with non-numeric coordinates', () => {
    window.localStorage.setItem(
      'solux:prefs:v1',
      JSON.stringify({ pin: { lat: 'oops', lng: 0 }, date: '', displayMode: 'card' }),
    );
    expect(loadPrefs().pin).toBeNull();
  });
});
