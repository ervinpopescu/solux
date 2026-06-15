// ==============================================================================
// MapView
// ==============================================================================
//
// Full-screen Leaflet map. Single responsibility: render the world, accept
// clicks, and emit `(lat, lng)` upward. The marker icon and the optional
// popup are also rendered here, but the *content* of the popup is composed
// outside this component so the SolarInfo block stays display-mode-agnostic.
//
// ## Marker icon
//
// Leaflet's default marker tries to load PNG assets via relative URLs that
// break under Vite's asset pipeline. We sidestep that entirely by passing
// an inline SVG data URL — no asset resolution required.

import L from 'leaflet';
import { useMemo, type ReactNode } from 'react';
import { MapContainer, Marker, Popup, TileLayer, useMapEvents } from 'react-leaflet';
import type { LatLng } from '../types';

// Inline SVG pin: amber for "golden hour" branding, with a subtle outline
// that survives over both light and dark map tiles.
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
</svg>
`.trim();

const PIN_ICON = L.icon({
  iconUrl: `data:image/svg+xml;utf8,${encodeURIComponent(PIN_SVG)}`,
  iconSize: [32, 44],
  iconAnchor: [16, 42],
  popupAnchor: [0, -38],
});

// Round lat/lng to a sensible precision: 6 decimals = ~11 cm. The solar
// math is insensitive well past that, but it keeps localStorage and the
// UI label clean.
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

type ClickReporterProps = { onPin: (latLng: LatLng) => void };

// Tiny child component so we can use Leaflet's hook (which only works inside
// a MapContainer) without polluting MapView itself.
function ClickReporter({ onPin }: ClickReporterProps) {
  useMapEvents({
    click(e) {
      onPin({ lat: round6(e.latlng.lat), lng: round6(e.latlng.lng) });
    },
  });
  return null;
}

type MapViewProps = {
  pin: LatLng | null;
  onPin: (latLng: LatLng) => void;
  /**
   * Content to render inside the marker's popup. When omitted, no popup is
   * rendered. When provided, the popup auto-opens on each pin placement
   * (because we re-key the marker — see below).
   */
  popupContent?: ReactNode;
};

export default function MapView({ pin, onPin, popupContent }: MapViewProps) {
  // Center on the existing pin if there is one; otherwise show the whole
  // world at a low zoom so the user can pan to wherever they care about.
  //
  // Zoom level 12 gives a city-wide view (~5 km across at mid-latitudes) —
  // enough to recognize a neighbourhood when restoring a saved pin, without
  // being so tight that nearby landmarks scroll off-screen. With no pin we
  // open at zoom 2 to show the whole world for site-picking.
  const initialCenter = useMemo<[number, number]>(
    () => (pin ? [pin.lat, pin.lng] : [20, 0]),
    [pin],
  );
  const initialZoom = pin ? 12 : 2;

  return (
    <MapContainer
      center={initialCenter}
      zoom={initialZoom}
      worldCopyJump
      // Full-viewport map. The wrapper styles handle this via `position: fixed`.
      style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh' }}
      attributionControl
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxZoom={19}
      />
      <ClickReporter onPin={onPin} />
      {pin && (
        <Marker
          // Re-keying on lat/lng forces React-Leaflet to re-mount the marker
          // at the new coordinates rather than animating an in-place move,
          // which gives a more deliberate "drop" feel AND re-fires the
          // `add` handler below — which is how we auto-open the popup.
          key={`${pin.lat},${pin.lng}`}
          position={[pin.lat, pin.lng]}
          icon={PIN_ICON}
          // When there's no popup mode, the marker is non-interactive — its
          // 32×44 px footprint would otherwise swallow taps that the user
          // intended to use to MOVE the pin to a nearby spot. Letting taps
          // fall through to the map means "tap anywhere, pin moves there",
          // which is what every photographer expects.
          interactive={!!popupContent}
          eventHandlers={
            popupContent
              ? {
                  add: (e) => {
                    // The marker has just been added to the map. Open its
                    // popup so the SolarInfo content appears immediately,
                    // without requiring the user to click the pin again.
                    e.target.openPopup();
                  },
                }
              : undefined
          }
        >
          {popupContent && (
            <Popup
              autoPan
              closeOnClick={false}
              autoClose={false}
              keepInView
              // Slightly wider than Leaflet's default so the SolarInfo grid
              // doesn't wrap awkwardly inside the popup.
              maxWidth={320}
              minWidth={280}
            >
              {popupContent}
            </Popup>
          )}
        </Marker>
      )}
    </MapContainer>
  );
}
