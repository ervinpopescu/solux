import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useLiveTimeSelection } from './useLiveTimeSelection';
import type { TimeOfDayReading } from './useTimeOfDay';

const LIVE_TIME: TimeOfDayReading = { minutes: 600, minuteKey: 1000 };

describe('useLiveTimeSelection', () => {
  it('starts at the live time and allows a manual selection', () => {
    const { result } = renderHook(() => useLiveTimeSelection(LIVE_TIME));

    expect(result.current[0]).toBe(600);
    act(() => result.current[1](720));
    expect(result.current[0]).toBe(720);
  });

  it('snaps a manual selection to the next live minute', () => {
    const { result, rerender } = renderHook(({ liveTime }) => useLiveTimeSelection(liveTime), {
      initialProps: { liveTime: LIVE_TIME },
    });
    act(() => result.current[1](720));

    rerender({ liveTime: { minutes: 601, minuteKey: 1001 } });

    expect(result.current[0]).toBe(601);
  });

  it('snaps when a zone change alters the live time within the same minute', () => {
    const { result, rerender } = renderHook(({ liveTime }) => useLiveTimeSelection(liveTime), {
      initialProps: { liveTime: LIVE_TIME },
    });
    act(() => result.current[1](720));

    rerender({ liveTime: { minutes: 300, minuteKey: 1000 } });

    expect(result.current[0]).toBe(300);
  });
});
