import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, it, expect } from 'vitest';
import { usePrefs } from './usePrefs';
import { DEFAULT_PREFS, loadPrefs, savePrefs } from '../storage/prefs';

afterEach(() => window.localStorage.clear());

describe('usePrefs', () => {
  it('initialises from defaults when storage is empty', () => {
    const { result } = renderHook(() => usePrefs());
    expect(result.current.prefs).toEqual(DEFAULT_PREFS);
  });

  it('lazily initialises from persisted preferences', () => {
    savePrefs({ pin: { lat: 48.8566, lng: 2.3522 }, date: '2024-06-21', displayMode: 'panel' });
    const { result } = renderHook(() => usePrefs());
    expect(result.current.prefs.pin).toEqual({ lat: 48.8566, lng: 2.3522 });
    expect(result.current.prefs.date).toBe('2024-06-21');
    expect(result.current.prefs.displayMode).toBe('panel');
  });

  it('setPin updates state and persists', () => {
    const { result } = renderHook(() => usePrefs());
    act(() => result.current.setPin({ lat: 40.7128, lng: -74.006 }));
    expect(result.current.prefs.pin).toEqual({ lat: 40.7128, lng: -74.006 });
    expect(loadPrefs().pin).toEqual({ lat: 40.7128, lng: -74.006 });
  });

  it('setDate and setDisplayMode update state and persist', () => {
    const { result } = renderHook(() => usePrefs());
    act(() => result.current.setDate('2025-01-02'));
    act(() => result.current.setDisplayMode('drawer'));
    expect(result.current.prefs.date).toBe('2025-01-02');
    expect(result.current.prefs.displayMode).toBe('drawer');

    const persisted = loadPrefs();
    expect(persisted.date).toBe('2025-01-02');
    expect(persisted.displayMode).toBe('drawer');
  });
});
