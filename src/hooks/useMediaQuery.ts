import { useCallback, useMemo, useSyncExternalStore } from 'react';

const serverSnapshot = () => false;

/**
 * Subscribe to a CSS media query. Re-renders when the match flips.
 *
 * SSR-safe: returns `false` when `window` is unavailable.
 */
export function useMediaQuery(query: string): boolean {
  const mediaQuery = useMemo(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return null;
    }
    return window.matchMedia(query);
  }, [query]);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!mediaQuery) return () => undefined;
      mediaQuery.addEventListener('change', onChange);
      return () => mediaQuery.removeEventListener('change', onChange);
    },
    [mediaQuery],
  );

  const getSnapshot = useCallback(() => mediaQuery?.matches ?? false, [mediaQuery]);

  return useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
}
