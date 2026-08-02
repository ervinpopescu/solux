import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { useMediaQuery } from './useMediaQuery';

// jsdom doesn't implement matchMedia, so we install a controllable stub and
// keep a handle to fire synthetic `change` events.
function stubMatchMedia(initialMatches: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: initialMatches,
    media: '',
    addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => listeners.add(cb),
    removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) =>
      listeners.delete(cb),
  };
  window.matchMedia = vi.fn().mockReturnValue(mql) as unknown as typeof window.matchMedia;
  return {
    listenerCount: () => listeners.size,
    fire: (matches: boolean) => {
      mql.matches = matches;
      listeners.forEach((cb) => cb({ matches } as MediaQueryListEvent));
    },
  };
}

afterEach(() => {
  // Remove the stub so it can't leak into other suites.
  delete (window as { matchMedia?: unknown }).matchMedia;
  vi.restoreAllMocks();
});

describe('useMediaQuery', () => {
  it('returns false when matchMedia is unavailable', () => {
    delete (window as { matchMedia?: unknown }).matchMedia;

    const { result, unmount } = renderHook(() => useMediaQuery('(max-width: 640px)'));
    expect(result.current).toBe(false);
    unmount();
  });

  it('uses a stable false snapshot during server rendering', () => {
    stubMatchMedia(true);
    const Probe = () => (useMediaQuery('(max-width: 640px)') ? 'matches' : 'no match');

    expect(renderToString(createElement(Probe))).toContain('no match');
  });

  it('reflects the initial match state', () => {
    stubMatchMedia(true);
    const { result } = renderHook(() => useMediaQuery('(max-width: 640px)'));
    expect(result.current).toBe(true);
  });

  it('updates when the media query flips', () => {
    const media = stubMatchMedia(false);
    const { result } = renderHook(() => useMediaQuery('(max-width: 640px)'));
    expect(result.current).toBe(false);

    act(() => media.fire(true));
    expect(result.current).toBe(true);
  });

  it('reads the current match immediately when the query changes', () => {
    window.matchMedia = vi.fn((query: string) => {
      const matches = query === '(min-width: 1000px)';
      return {
        matches,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      } as unknown as MediaQueryList;
    });
    const { result, rerender } = renderHook(({ query }) => useMediaQuery(query), {
      initialProps: { query: '(max-width: 640px)' },
    });
    expect(result.current).toBe(false);

    rerender({ query: '(min-width: 1000px)' });

    expect(result.current).toBe(true);
  });

  it('detaches its listener on unmount', () => {
    const media = stubMatchMedia(false);
    const { unmount } = renderHook(() => useMediaQuery('(max-width: 640px)'));
    expect(media.listenerCount()).toBe(1);

    unmount();
    expect(media.listenerCount()).toBe(0);
  });
});
