import { renderHook } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useSolarData } from './useSolarData';

const LONDON = { lat: 51.5074, lng: -0.1278 };

describe('useSolarData', () => {
  it('returns null without a pin', () => {
    const { result } = renderHook(() => useSolarData(null, '2024-06-21'));
    expect(result.current).toBeNull();
  });

  it('returns null without a date', () => {
    const { result } = renderHook(() => useSolarData(LONDON, ''));
    expect(result.current).toBeNull();
  });

  it('computes solar times for a pin and date', () => {
    const { result } = renderHook(() => useSolarData(LONDON, '2024-06-21'));
    expect(result.current).not.toBeNull();
    expect(result.current?.sunrise).toBeInstanceOf(Date);
    expect(result.current?.solarNoon).toBeInstanceOf(Date);
  });

  it('memoizes: the same pin reference and date yield a stable result', () => {
    // The memo keys on the pin object reference (plus lat/lng and date), so a
    // re-render with the identical inputs must not recompute.
    const { result, rerender } = renderHook(({ date }) => useSolarData(LONDON, date), {
      initialProps: { date: '2024-06-21' },
    });
    const first = result.current;
    rerender({ date: '2024-06-21' });
    expect(result.current).toBe(first);
  });
});
