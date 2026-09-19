import type { MapLibreMap } from 'maplibre-gl';

/**
 * Returns true if the MapLibre map instance is backed by an active WebGL2 context.
 * When a browser or device falls back to WebGL1, MapLibre's canvas context
 * will not be an instance of WebGL2RenderingContext.
 */
export function isWebGL2Supported(
  map: Pick<MapLibreMap, 'getCanvas'> & {
    painter?: { context?: { gl?: unknown } };
  },
): boolean {
  if (typeof window === 'undefined' || typeof window.WebGL2RenderingContext === 'undefined') {
    return false;
  }
  try {
    const painterGl = map.painter?.context?.gl;
    if (painterGl) {
      return painterGl instanceof window.WebGL2RenderingContext;
    }
    const canvas = map.getCanvas?.();
    if (!canvas) return false;
    const gl = canvas.getContext('webgl2');
    return gl instanceof window.WebGL2RenderingContext;
  } catch {
    return false;
  }
}
