import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import SunCalc from 'suncalc';
import { type ReactNode, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Building, LatLng, SolarTimes } from '../types';
import type { SunExposure } from '../solar/exposure';
import styles from './MapLibreView.module.css';
import {
  createSunPathLayer,
  type SunPathLayerHandle,
  SUN_PATH_LAYER_ID,
} from './layers/sunPathLayer';
import { createShadowLayer, type ShadowLayerHandle, SHADOW_LAYER_ID } from './layers/shadowLayer';
import { prepareShadowBuilding, type ShadowBuilding } from './shadowGeometry';

// Convert the Overpass footprints (see useHorizon) into shadow-ready meshes.
// We use Overpass rather than the map's own vector tiles because map feature
// queries can't return the full pin-centred set in a pitched 3D view: the far
// half of the frustum loads at a zoom where the building layer is absent, so
// queries only ever see near-camera buildings. Overpass gives a clean radius
// around the pin regardless of camera, and matches the horizon/exposure math.
function prepareShadowBuildings(pin: LatLng, buildings: Building[]): ShadowBuilding[] {
  const out: ShadowBuilding[] = [];
  for (const b of buildings) {
    const prepared = prepareShadowBuilding(pin, b.geometry, b.heightMeters);
    if (prepared) out.push(prepared);
  }
  return out;
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
        title:
          `Sunlit — ${e.clearanceDeg.toFixed(0)}° above the building horizon ` +
          `(sun altitude ${e.sunAltitudeDeg.toFixed(0)}°)`,
      };
    case 'shadow':
      return {
        text: '◐ In shadow',
        variant: 'shadow',
        title:
          `Blocked by buildings — sun sits ${e.deficitDeg.toFixed(0)}° below the ` +
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
  /** Nearby building footprints (Overpass), used to cast ground shadows. */
  buildings?: Building[] | null;
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
  // Latest prepared footprints, so a layer added after the fetch adopts them.
  const buildingsRef = useRef<ShadowBuilding[] | null>(null);
  const badgeElRef = useRef<HTMLDivElement | null>(null);

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
        id: 'solux-buildings-3d',
        type: 'fill-extrusion',
        source: 'openmaptiles',
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
  // The layer is created empty; the footprints arrive via the `buildings` prop
  // (Overpass, camera-independent) in the effect below. Same `isStyleLoaded()`
  // + cleanup discipline as the arc, for the same StrictMode reason.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !pin) return;

    let cancelled = false;

    function addShadows() {
      const m = mapRef.current;
      if (cancelled || !m) return;
      if (m.getLayer(SHADOW_LAYER_ID)) m.removeLayer(SHADOW_LAYER_ID);
      const handle = createShadowLayer(pin!);
      // Insert beneath the arc so the glowing path stays above the wash. When
      // the arc isn't present yet it's added on top and the arc, added later,
      // lands above it — either way the arc ends up on top.
      const beforeId = m.getLayer(SUN_PATH_LAYER_ID) ? SUN_PATH_LAYER_ID : undefined;
      m.addLayer(handle.customLayer, beforeId);
      shadowRef.current = handle;
      // Adopt the current sun + footprints immediately (both may already be set
      // by the time the layer is added, e.g. after style.load).
      if (sunRef.current) handle.setSun(sunRef.current.azimuth, sunRef.current.altitude);
      if (buildingsRef.current) handle.setBuildings(buildingsRef.current);
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

  // ── Building shadows: push footprints when the Overpass set changes ───────
  useEffect(() => {
    const prepared = pin && buildings ? prepareShadowBuildings(pin, buildings) : [];
    buildingsRef.current = prepared;
    shadowRef.current?.setBuildings(prepared);
  }, [pin, buildings]);

  // ── Building shadows: update sun direction on time tick / slider ──────────
  // Recomputing the mesh is cheap (a few ms), so we drive it straight off the
  // slider rather than debouncing; the offset is stored in `sunRef` so an
  // async-added layer can adopt it.
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

  return <div ref={containerRef} className={styles.map} />;
}
