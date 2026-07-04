import { renderHook } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useTimezone } from './useTimezone';
import { UTC_FALLBACK } from '../timezone/lookup';

describe('useTimezone', () => {
  it('falls back to UTC when no pin is set', () => {
    const { result } = renderHook(() => useTimezone(null));
    expect(result.current).toBe(UTC_FALLBACK);
  });

  it('resolves the IANA zone for a coordinate', () => {
    const { result } = renderHook(() => useTimezone({ lat: 51.5074, lng: -0.1278 }));
    expect(result.current).toBe('Europe/London');
  });

  it('recomputes when the pin moves to a new zone', () => {
    const { result, rerender } = renderHook(({ pin }) => useTimezone(pin), {
      initialProps: { pin: { lat: 51.5074, lng: -0.1278 } },
    });
    expect(result.current).toBe('Europe/London');

    rerender({ pin: { lat: 40.7128, lng: -74.006 } });
    expect(result.current).toBe('America/New_York');
  });
});
