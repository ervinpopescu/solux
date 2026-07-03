import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { useTimeOfDay } from './useTimeOfDay';

afterEach(() => vi.useRealTimers());

describe('useTimeOfDay', () => {
  it('returns the current minutes in the given zone', () => {
    vi.useFakeTimers();
    // 14:30 UTC = 15:30 in Europe/London (BST, UTC+1)
    vi.setSystemTime(new Date('2024-06-21T14:30:00Z'));
    const { result } = renderHook(() => useTimeOfDay('Europe/London'));
    expect(result.current).toBe(15 * 60 + 30); // 930
  });

  it('increments after 60 seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-21T14:30:00Z'));
    const { result } = renderHook(() => useTimeOfDay('Europe/London'));
    expect(result.current).toBe(930);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(result.current).toBe(931);
  });

  it('recalculates immediately when zone changes', () => {
    vi.useFakeTimers();
    // 14:30 UTC = 10:30 in America/New_York (EDT, UTC-4)
    vi.setSystemTime(new Date('2024-06-21T14:30:00Z'));
    const { result, rerender } = renderHook(
      ({ zone }) => useTimeOfDay(zone),
      { initialProps: { zone: 'UTC' } },
    );
    expect(result.current).toBe(14 * 60 + 30); // 870

    rerender({ zone: 'America/New_York' });
    expect(result.current).toBe(10 * 60 + 30); // 630
  });
});
