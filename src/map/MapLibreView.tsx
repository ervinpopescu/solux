import maplibregl, { type MapSourceDataEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import SunCalc from 'suncalc';
import { type ReactNode, useCallback, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Obstruction, LatLng, SolarTimes } from '../types';
import type { SunExposure } from '../solar/exposure';
import styles from './MapLibreView.module.css';
import {
  createSunPathLayer,
  type SunPathLayerHandle,
  SUN_PATH_LAYER_ID,
} from './layers/sunPathLayer';
import { createShadowLayer, type ShadowLayerHandle, SHADOW_LAYER_ID } from './layers/shadowLayer';
import type { ShadowBuilding } from './shadowGeometry';
import { prepareRemoteShadowCasters } from './remoteShadowObstructions';
import { selectShadowCasters, type ShadowCaster } from './shadowRenderBudget';
import {
  tileBuildingFeaturesToShadowCasters,
  type TileBuildingFeature,
} from './tileShadowBuildings';
import {
  beginTileShadowMove,
  completeTileShadowRefresh,
  createTileShadowRefreshGate,
  shouldScheduleTileShadowSource,
} from './tileShadowRefresh';

const OPENMAPTILES_SOURCE_ID = 'openmaptiles';
const BUILDING_LAYER_ID = 'solux-buildings-3d';
const TILE_SHADOW_REFRESH_DEBOUNCE_MS = 150;

function pinKey(pin: LatLng): string {
  return `${pin.lat},${pin.lng}`;
}

// Map an exposure state to the pin badge's icon, label, accent class, and a
// detailed hover title. Kept beside the view because it's purely presentational.
function formatExposure(e: SunExposure): { text: string; variant: string; title: string } {
  switch (e.state) {
    case 'below_horizon':
      return {
        text: '☾ Sun down',
        variant: 'down',
        title: `Sun is ${Math.abs(e.sunAltitudeDeg).toFixed(0)}° below the horizon`,
      };
    case 'lit':
      return {
        text: '☀ In sun',
        variant: 'lit',
        title: `Sunlit — ${e.clearanceDeg.toFixed(0)}° above the obstruction horizon (sun altitude ${e.sunAltitudeDeg.toFixed(0)}°)`,
      };
    case 'shadow':
      return {
        text: '◐ In shadow',
        variant: 'shadow',
        title:
          `Blocked by nearby obstructions — sun sits ${e.deficitDeg.toFixed(0)}° below the ` +
          `${e.obstructionDeg.toFixed(0)}° obstruction in its direction`,
      };
  }
}

// Inline SVG pin — same design as the removed Leaflet version so the visual
// language is unchanged. Using a custom HTML element avoids MapLibre's default
// marker colour and gives us the exact anchor point we want.
const PIN_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="44" viewBox="0 0 32 44">
  <defs>
    <radialGradient id="pg" cx="50%" cy="35%" r="60%">
      <stop offset="0%" stop-color="#fff4c2"/>
      <stop offset="60%" stop-color="#f5a623"/>
      <stop offset="100%" stop-color="#a14e08"/>
    </radialGradient>
  </defs>
  <path d="M16 1 C7.7 1 1 7.7 1 16 c0 11 15 27 15 27 s15-16 15-27 C31 7.7 24.3 1 16 1 z"
        fill="url(#pg)" stroke="#0b0d12" stroke-width="1.5"/>
  <circle cx="16" cy="16" r="5.5" fill="#0b0d12"/>
</svg>`.trim();

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export type MapLibreViewProps = {
  pin: LatLng | null;
  onPin: (latLng: LatLng) => void;
  /** ReactNode rendered inside a MapLibre Popup when display mode is 'popup'. */
  popupContent?: ReactNode;
  // 3D arc props — optional so the component degrades gracefully
  solarTimes?: SolarTimes | null;
  dayStartUtc?: Date | null;
  timeMinutes?: number;
  /** Live sun/shadow status for the pin, shown as a badge above the marker. */
  exposure?: SunExposure | null;
  /** Nearby obstruction footprints (Overpass), used to cast ground shadows. */
  buildings?: Obstruction[] | null;
};

export default function MapLibreView({
  pin,
  onPin,
  popupContent,
  solarTimes,
  dayStartUtc,
  timeMinutes,
  exposure,
  buildings,
}: MapLibreViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerRef = useRef<maplibregl.Marker | null>(null);
  const popupRef = useRef<maplibregl.Popup | null>(null);
  const popupRootRef = useRef<Root | null>(null);
  const onPinRef = useRef(onPin);
  const sunPathRef = useRef<SunPathLayerHandle | null>(null);
  const shadowRef = useRef<ShadowLayerHandle | null>(null);
  // Latest sun position, so a shadow layer added asynchronously (after
  // style.load) can pick up the current sun without waiting for the next tick.
  const sunRef = useRef<{ azimuth: number; altitude: number } | null>(null);
  // Latest budgeted footprints, so a layer added after either source adopts them.
  const buildingsRef = useRef<ShadowBuilding[]>([]);
  const activePinKeyRef = useRef<string | null>(null);
  const tileCastersRef = useRef<ShadowCaster[]>([]);
  const remoteCastersRef = useRef<ShadowCaster[]>([]);
  const publishedShadowSignatureRef = useRef<string | null>(null);
  const badgeElRef = useRef<HTMLDivElement | null>(null);

  const publishShadowData = useCallback((requestPinKey: string) => {
    if (activePinKeyRef.current !== requestPinKey) return;

    // Prefer remote geometry on exact duplicates, while retaining tile-only
    // buildings (notably OSM footprints without height tags).
    const unique: ShadowCaster[] = [];
    const seen = new Set<string>();
    for (const candidate of [...remoteCastersRef.current, ...tileCastersRef.current]) {
      const dedupKey = `${candidate.kind}:${candidate.dedupKey}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      unique.push(candidate);
    }

    const selection = selectShadowCasters(unique);
    const signature = selection.casters.map((candidate) => candidate.key).join('|');
    buildingsRef.current = selection.buildings;
    if (signature !== publishedShadowSignatureRef.current) {
      publishedShadowSignatureRef.current = signature;
      shadowRef.current?.setBuildings(selection.buildings);
    }

    // Minimal production-safe diagnostics used by the hermetic browser tests
    // and useful when investigating field performance without WebGL readback.
    const container = containerRef.current;
    if (container) {
      const hasSelectedRemote = selection.casters.some(
        (candidate) => candidate.source === 'remote',
      );
      container.dataset.shadowSource =
        selection.casters.length === 0 ? 'none' : hasSelectedRemote ? 'refined' : 'tiles';
      container.dataset.shadowCasters = String(selection.casters.length);
      container.dataset.shadowTileCasters = String(tileCastersRef.current.length);
      container.dataset.shadowRemoteCasters = String(remoteCastersRef.current.length);
      container.dataset.shadowVertices = String(selection.estimatedVertices);
      container.dataset.shadowBytes = String(selection.estimatedBytes);
      container.dataset.shadowTrees = String(selection.selectedTreeCount);
      container.dataset.shadowDroppedTrees = String(selection.droppedTreeCount);
    }
  }, []);

  // Keep the ref current on every render so the click handler always has the
  // latest prop without being in the init useEffect's dependency array.
  useEffect(() => {
    onPinRef.current = onPin;
  });

  // ── Map initialisation (once) ──────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [0, 20],
      zoom: 2,
      maxPitch: 85,
      attributionControl: { compact: false },
    });
    mapRef.current = map;

    // Zoom +/- buttons (no compass — compass is a separate control below).
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    // Standalone compass needle. visualizePitch tilts the needle to show the
    // current pitch. Clicking resets both bearing and pitch to 0° (north-up).
    map.addControl(
      new maplibregl.NavigationControl({ showZoom: false, visualizePitch: true }),
      'top-right',
    );

    map.on('click', (e) => {
      onPinRef.current({ lat: round6(e.lngLat.lat), lng: round6(e.lngLat.lng) });
    });

    map.on('style.load', () => {
      // Hide the flat 2D building fill the Liberty style adds by default to avoid
      // z-fighting with our extrusion layer.
      if (map.getLayer('building')) {
        map.setLayoutProperty('building', 'visibility', 'none');
      }

      // Extrude buildings using height data already present in OpenFreeMap's vector
      // tiles (OpenMapTiles schema: source 'openmaptiles', layer 'building',
      // property 'render_height').
      map.addLayer({
        id: BUILDING_LAYER_ID,
        type: 'fill-extrusion',
        source: OPENMAPTILES_SOURCE_ID,
        'source-layer': 'building',
        paint: {
          'fill-extrusion-color': '#1e2438',
          'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 0],
          'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
          'fill-extrusion-opacity': 0.85,
        },
      });

      // MapLibre 5.x does not support the 'sky' layer type.
      // The sky area (above the horizon when pitched) shows the CSS background
      // of the container element — set in MapLibreView.module.css.
    });

    return () => {
      popupRootRef.current?.unmount();
      if (sunPathRef.current && mapRef.current?.getLayer(SUN_PATH_LAYER_ID)) {
        mapRef.current?.removeLayer(SUN_PATH_LAYER_ID);
      }
      map.remove();
      mapRef.current = null;
    };
    // init once — map lifecycle is managed imperatively
  }, []);

  // Clear all pin-relative geometry before the camera starts moving. This
  // prevents loaded features from the previous pin flashing at the new origin.
  useEffect(() => {
    const nextPinKey = pin ? pinKey(pin) : null;
    if (activePinKeyRef.current === nextPinKey) return;
    activePinKeyRef.current = nextPinKey;
    tileCastersRef.current = [];
    remoteCastersRef.current = [];
    buildingsRef.current = [];
    publishedShadowSignatureRef.current = null;
    shadowRef.current?.setBuildings([]);
    if (nextPinKey) publishShadowData(nextPinKey);
  }, [pin, publishShadowData]);

  // ── Marker: update when pin changes ───────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    markerRef.current?.remove();
    markerRef.current = null;
    if (!map || !pin) return;

    // Wrapper holds the pin plus a sun/shadow badge that floats above it. The
    // badge sits outside the 32×44 pin box (bottom:100%), so the marker's
    // centre anchor still lands the pin tip on the coordinate as before.
    const el = document.createElement('div');
    el.style.cssText = 'position:relative;width:32px;height:44px';
    // Stable hook for e2e tests; the CSS-module class names are hashed.
    el.dataset.testid = 'map-pin';

    const badge = document.createElement('div');
    badge.className = styles.exposureBadge;
    // Persists across the className reset in the exposure effect below.
    badge.dataset.testid = 'exposure-badge';
    badgeElRef.current = badge;

    const pinEl = document.createElement('div');
    pinEl.innerHTML = PIN_SVG;
    pinEl.style.cssText = 'width:32px;height:44px;cursor:pointer';

    el.appendChild(badge);
    el.appendChild(pinEl);

    const marker = new maplibregl.Marker({ element: el }).setLngLat([pin.lng, pin.lat]).addTo(map);
    markerRef.current = marker;

    // Fly to pin with a 3D pitch so buildings are visible.
    map.flyTo({ center: [pin.lng, pin.lat], zoom: 15, pitch: 60, duration: 1000 });
  }, [pin]);

  // ── Pin badge: update sun/shadow status when exposure (time) changes ──────
  // Separate from marker creation so scrubbing the time slider only rewrites
  // the badge's text/class rather than recreating the marker (which would
  // re-trigger the fly-to).
  useEffect(() => {
    const badge = badgeElRef.current;
    if (!badge) return;
    if (!exposure) {
      badge.style.display = 'none';
      return;
    }
    const { text, variant, title } = formatExposure(exposure);
    badge.textContent = text;
    badge.title = title;
    badge.style.display = '';
    // Reset to the base class, then add the active variant.
    badge.className = `${styles.exposureBadge} ${styles[variant]}`;
  }, [exposure]);

  // ── Popup: update when content or pin changes ──────────────────────────
  useEffect(() => {
    const map = mapRef.current;

    // Tear down any existing popup + React root.
    popupRef.current?.remove();
    popupRootRef.current?.unmount();
    popupRef.current = null;
    popupRootRef.current = null;

    if (!map || !pin || !popupContent) return;

    const el = document.createElement('div');
    const root = createRoot(el);
    root.render(popupContent);
    popupRootRef.current = root;

    popupRef.current = new maplibregl.Popup({
      closeOnClick: false,
      maxWidth: '320px',
      offset: [0, -44], // clear the marker tip
    })
      .setDOMContent(el)
      .setLngLat([pin.lng, pin.lat])
      .addTo(map);

    popupRef.current.on('close', () => {
      popupRootRef.current?.unmount();
      popupRootRef.current = null;
      popupRef.current = null;
    });
  }, [popupContent, pin]);

  // ── Building shadows: add/remove the layer when the pin changes ───────────
  //
  // The layer is created empty; tile footprints arrive after the camera move
  // and Overpass footprints refine them independently. Same `isStyleLoaded()`
  // + cleanup discipline as the arc, for the same StrictMode reason.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !pin) return;

    let cancelled = false;

    function addShadows() {
      const m = mapRef.current;
      if (cancelled || !m) return;
      if (m.getLayer(SHADOW_LAYER_ID)) m.removeLayer(SHADOW_LAYER_ID);
      const handle = createShadowLayer(pin!, (vertexCount) => {
        const container = containerRef.current;
        if (!container || activePinKeyRef.current !== pinKey(pin!)) return;
        const strCount = String(vertexCount);
        if (container.dataset.shadowDrawVertices !== strCount) {
          container.dataset.shadowDrawVertices = strCount;
        }
      });
      // Insert beneath the arc so the glowing path stays above the wash. When
      // the arc isn't present yet it's added on top and the arc, added later,
      // lands above it — either way the arc ends up on top.
      const beforeId = m.getLayer(SUN_PATH_LAYER_ID) ? SUN_PATH_LAYER_ID : undefined;
      m.addLayer(handle.customLayer, beforeId);
      shadowRef.current = handle;
      // Adopt the current sun + footprints immediately (both may already be set
      // by the time the layer is added, e.g. after style.load).
      if (sunRef.current) handle.setSun(sunRef.current.azimuth, sunRef.current.altitude);
      handle.setBuildings(buildingsRef.current);
    }

    if (map.isStyleLoaded()) addShadows();
    else map.once('style.load', addShadows);

    return () => {
      cancelled = true;
      map.off('style.load', addShadows);
      if (mapRef.current?.getLayer(SHADOW_LAYER_ID)) {
        mapRef.current.removeLayer(SHADOW_LAYER_ID);
      }
      shadowRef.current = null;
    };
    // buildings intentionally omitted — footprints are pushed by the effect
    // below so a new fetch doesn't rebuild the whole layer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.lat, pin?.lng]);

  // ── Fast shadows: loaded OpenMapTiles buildings after the pin camera move ─
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !pin) return;
    const activeMap = map;
    const requestPinKey = pinKey(pin);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const refreshGate = createTileShadowRefreshGate();

    function refreshTileShadows(generation: number) {
      if (cancelled || activePinKeyRef.current !== requestPinKey) return;
      if (
        activeMap.isMoving() ||
        !activeMap.getLayer(BUILDING_LAYER_ID) ||
        !activeMap.getSource(OPENMAPTILES_SOURCE_ID)
      ) {
        return;
      }
      const center = activeMap.getCenter();
      if (Math.abs(center.lat - pin!.lat) > 0.00001 || Math.abs(center.lng - pin!.lng) > 0.00001) {
        return;
      }
      if (!activeMap.isSourceLoaded(OPENMAPTILES_SOURCE_ID)) return;

      const features = activeMap.queryRenderedFeatures({ layers: [BUILDING_LAYER_ID] });
      tileCastersRef.current = tileBuildingFeaturesToShadowCasters(
        pin!,
        features as unknown as TileBuildingFeature[],
      );
      if (!completeTileShadowRefresh(refreshGate, generation)) return;
      publishShadowData(requestPinKey);
    }

    function scheduleRefresh(generation: number = refreshGate.generation) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => refreshTileShadows(generation), TILE_SHADOW_REFRESH_DEBOUNCE_MS);
    }

    function handleMoveEnd() {
      scheduleRefresh(beginTileShadowMove(refreshGate));
    }

    function handleSourceData(event: MapSourceDataEvent) {
      if (
        event.sourceId === OPENMAPTILES_SOURCE_ID &&
        event.isSourceLoaded &&
        shouldScheduleTileShadowSource(refreshGate)
      ) {
        scheduleRefresh();
      }
    }

    activeMap.on('moveend', handleMoveEnd);
    activeMap.on('sourcedata', handleSourceData);
    scheduleRefresh();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      activeMap.off('moveend', handleMoveEnd);
      activeMap.off('sourcedata', handleSourceData);
    };
  }, [pin, publishShadowData]);

  // ── Refined shadows: merge Overpass footprints without dropping tiles ─────
  useEffect(() => {
    if (!pin) return;
    const requestPinKey = pinKey(pin);
    if (activePinKeyRef.current !== requestPinKey) return;
    remoteCastersRef.current = buildings ? prepareRemoteShadowCasters(pin, buildings) : [];
    publishShadowData(requestPinKey);
  }, [pin, buildings, publishShadowData]);

  // ── Building shadows: update sun direction on time tick / slider ──────────
  // The static mesh is only rebuilt when source geometry changes. Slider and
  // clock updates only change shader uniforms, so they remain immediate.
  // The position is stored in `sunRef` so an async-added layer can adopt it.
  useEffect(() => {
    if (!pin || !dayStartUtc || timeMinutes === undefined) return;
    const instant = new Date(dayStartUtc.getTime() + timeMinutes * 60_000);
    const pos = SunCalc.getPosition(instant, pin.lat, pin.lng);
    sunRef.current = { azimuth: pos.azimuth, altitude: pos.altitude };
    shadowRef.current?.setSun(pos.azimuth, pos.altitude);
  }, [pin, dayStartUtc, timeMinutes]);

  // ── Sun path arc: rebuild when pin, date, or solar times change ───────────
  //
  // We deliberately rely on MapLibre's own `map.isStyleLoaded()` rather than a
  // component-level "style loaded" ref. Under React StrictMode the map-init
  // effect mounts a throwaway map, tears it down, then mounts the live one; a
  // persistent ref would carry the dead map's "loaded" state into the live
  // map's not-yet-loaded window and cause us to add the layer to a map that
  // never paints it. `isStyleLoaded()` always reflects the *current* map.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !pin || !solarTimes || !dayStartUtc) return;

    // Guards against the listener firing after this effect has been cleaned up
    // (pin/date changed, or StrictMode unmount) and adding an orphan layer.
    let cancelled = false;

    function addArc() {
      const m = mapRef.current;
      if (cancelled || !m) return;
      if (m.getLayer(SUN_PATH_LAYER_ID)) m.removeLayer(SUN_PATH_LAYER_ID);
      const handle = createSunPathLayer(pin!, dayStartUtc!, solarTimes!);
      m.addLayer(handle.customLayer);
      if (timeMinutes !== undefined) handle.setTimeMinutes(timeMinutes);
      sunPathRef.current = handle;
      m.triggerRepaint();
    }

    if (map.isStyleLoaded()) addArc();
    else map.once('style.load', addArc);

    return () => {
      cancelled = true;
      map.off('style.load', addArc);
      if (mapRef.current?.getLayer(SUN_PATH_LAYER_ID)) {
        mapRef.current.removeLayer(SUN_PATH_LAYER_ID);
      }
      sunPathRef.current = null;
    };
    // timeMinutes is intentionally omitted — sphere position is managed by the
    // separate effect below to avoid rebuilding the arc geometry on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.lat, pin?.lng, dayStartUtc?.getTime(), solarTimes]);

  // ── Sun sphere: update position on time tick / slider ─────────────────────
  useEffect(() => {
    if (timeMinutes !== undefined) {
      sunPathRef.current?.setTimeMinutes(timeMinutes);
    }
  }, [timeMinutes]);

  return <div ref={containerRef} className={styles.map} data-testid="shadow-map" />;
}
