# Solux — 3D Map + Sun Path Arc

**Date**: 2026-06-17  
**Status**: Approved  

---

## Overview

Replace the current Leaflet raster map with MapLibre GL JS, add 3D building
extrusions, and render the day's sun path as a coloured 3D arc floating above
the pinned location using a Three.js custom WebGL layer.

This feature is additive: all solar math, horizon calculation, timezone
resolution, display-mode wrappers, and the SolarInfo panel are untouched.

---

## Motivation

- Photographers need to know *where on the skyline* the sun rises/sets relative
  to nearby streets and buildings, not just the clock time.
- A 3D extruded-building view with a coloured arc instantly shows which building
  will block morning golden hour without reading the adjusted times panel.
- The existing building-horizon pipeline already computes this obstruction
  numerically; this feature makes it visually obvious.

---

## Architecture

### Map: Leaflet → MapLibre GL JS

`src/components/MapView.tsx` is replaced by `src/map/MapLibreView.tsx`. The
React component interface is unchanged: `onPin(latLng)`, `pin`, `popupContent`
props. Internally the map is managed imperatively via `useRef<maplibregl.Map>`
inside a `useEffect`.

**No React wrapper library** (e.g. `react-map-gl`) is used. MapLibre's
imperative API is straightforward for this use case and avoids an extra
abstraction that would need to be learned and kept in sync.

**Tile provider**: OpenFreeMap (`https://tiles.openfreemap.org/styles/liberty`).
Free, no API key, MapLibre-native style JSON, vector tiles follow the
OpenMapTiles schema (includes `render_height` on building features). This
satisfies the project constraint of "no build-time secrets".

### 3D Building Extrusions

On `map.on('style.load')`, the Liberty style's existing `building` layer is
replaced with a `fill-extrusion` layer:

```json
{
  "id": "3d-buildings",
  "type": "fill-extrusion",
  "source": "openmaptiles",
  "source-layer": "building",
  "paint": {
    "fill-extrusion-color": "#334",
    "fill-extrusion-height": ["get", "render_height"],
    "fill-extrusion-base": ["get", "render_min_height"],
    "fill-extrusion-opacity": 0.8
  }
}
```

The Overpass API horizon pipeline (`src/buildings/`) is **not** replaced — it
drives the adjusted solar time clipping and that logic is independent of what
tile provider renders buildings visually.

### Sun Path Arc — Three.js Custom Layer

#### Integration strategy

MapLibre's `CustomLayerInterface` (`map.addLayer(customLayer)`) exposes a
`render(gl, matrix)` callback called on every map repaint. Three.js is
configured to use MapLibre's WebGL rendering context rather than creating its
own. This gives:

- Correct depth-buffer sharing: buildings can occlude the arc.
- No parallax: the arc is in the same coordinate space as the map tiles.
- No extra canvas element.

The alternative (overlay canvas with independent Three.js renderer) was
rejected because building occlusion of the arc is important for the app's core
use case.

#### Coordinate system

The arc is anchored to the pinned location. All Three.js geometry is expressed
in **metre-scale mercator units** relative to that origin:

```ts
const origin = maplibregl.MercatorCoordinate.fromLngLat(pin, 0);
const scale = origin.meterInMercatorCoordinateUnits();
// A point at azimuth `az`, altitude `alt`, visual radius R metres:
const x = origin.x + R * scale * Math.sin(az) * Math.cos(alt);
const y = origin.y - R * scale * Math.cos(az) * Math.cos(alt); // y is south
const z = origin.z + R * scale * Math.sin(alt);                 // z is up
```

Three.js camera projection is driven by the mercator matrix from
`map.transform`:

```ts
camera.projectionMatrix.fromArray(matrix); // matrix passed to render()
scene.matrixAutoUpdate = false;
scene.matrix.fromArray(modelMatrix);       // built from origin + scale
```

#### Arc geometry

- **Sample rate**: SunCalc queried at every 5 minutes across the day → 288
  `(azimuth, altitude)` pairs.
- **Filter**: samples with `altitude ≤ 0` (below horizon) are omitted; the arc
  only spans the sun's visible arc.
- **Curve**: points fed into a `THREE.CatmullRomCurve3`, extruded as a
  `THREE.TubeGeometry` with r = 8 m (visual width ≈ 1–2 px at city zoom).
- **Visual radius R**: 400 m. At the default zoom + 45° pitch this puts the
  arc comfortably above rooftop level without clipping into the sky box.

#### Phase colouring

Each tube segment is coloured according to which solar phase the sun occupies
at that moment. Phase boundaries come from the existing `SolarTimes` value
passed into the layer:

| Phase | Colour |
|---|---|
| Below horizon | (omitted) |
| Astronomical / nautical / civil twilight | `#1a2a4a` (deep blue) |
| Blue hour | `var(--blue)` → `#3a6fc4` |
| Golden hour | `var(--accent)` → `#f0a030` |
| Soft light / late morning / late afternoon | `#d4b896` (warm white) |
| Midday | `#ffffff` |

The tube uses `THREE.MeshBasicMaterial` per segment (no lighting calculation
needed — the arc is self-luminous).

#### Sun position sphere

A `THREE.SphereGeometry` (r = 14 m) is placed at the arc point corresponding
to the current `timeMinutes` value. It is coloured to match the phase at that
time. On each MapLibre repaint the sphere's position is updated if
`timeMinutes` changed since the last frame.

---

## Time-of-Day State

### `useTimeOfDay` hook

```ts
// Returns minutes since midnight (0–1439) in the pin's IANA timezone.
// Updates every 60 s automatically.
function useTimeOfDay(zone: string): number
```

Implemented with `useState` + `setInterval(60_000)`. Computes current minutes
via `date-fns-tz` `toZonedTime`.

### Time slider in Controls

A `<input type="range" min="0" max="1439" step="1">` is added below the date
row. Its label shows the formatted time in the pin's zone (e.g. "14:32").
Dragging it sets `timeMinutes` in App, overriding the live value until the next
60 s tick (which snaps back to real time). A small "live" indicator dot appears
when the slider matches the actual current time (within ±1 min).

---

## Data Flow

```
App
 ├── pin, date → useSolarData → SolarTimes
 ├── pin       → useTimezone  → zone
 ├── zone      → useTimeOfDay → timeMinutes
 │
 ├── MapLibreView
 │     ├── on style.load: add 3d-buildings fill-extrusion layer
 │     ├── on style.load: add SunPathLayer (Three.js custom layer)
 │     │     props: pin, solarTimes, timeMinutes
 │     └── on click: onPin(latLng)
 │
 └── Controls
       props: ..., timeMinutes, onTimeChange, zone
```

`SunPathLayer` is re-initialised when `pin` or `date` changes (arc rebuild).
`timeMinutes` changes only move the sphere, not rebuild the arc.

---

## Package changes

```diff
- "leaflet": "^1.x",
- "react-leaflet": "^4.x",
+ "maplibre-gl": "^4.x",
+ "three": "^0.170.x",
+ "@types/three": "^0.170.x",
```

`maplibre-gl` includes its own CSS (`maplibre-gl/dist/maplibre-gl.css`).
Remove `leaflet/dist/leaflet.css` import from `src/main.tsx`.

---

## File inventory

| Action | Path |
|---|---|
| **New** | `src/map/MapLibreView.tsx` |
| **New** | `src/map/MapLibreView.module.css` |
| **New** | `src/map/layers/sunPathLayer.ts` |
| **New** | `src/hooks/useTimeOfDay.ts` |
| **Delete** | `src/components/MapView.tsx` |
| **Delete** | `src/components/MapView.module.css` |
| **Modify** | `src/App.tsx` — swap MapView → MapLibreView, thread `timeMinutes` |
| **Modify** | `src/components/Controls.tsx` — add time slider |
| **Modify** | `src/components/Controls.module.css` — slider styles |
| **Modify** | `src/styles/global.css` — swap Leaflet CSS, remove zoom-button offset |
| **Modify** | `src/main.tsx` — swap CSS import |
| **Modify** | `package.json` — update deps |
| **Modify** | `AGENTS.md` — update stack / file tree |
| **Modify** | `README.md` — update stack table |

---

## What does NOT change

- `src/solar/` — all solar math
- `src/buildings/` — Overpass fetch, horizon profile, effective times
- `src/timezone/` — tz-lookup
- `src/storage/` — prefs, caching
- `src/hooks/useHorizon.ts`, `useEffectiveSolarTimes.ts`, `usePrefs.ts`
- `src/components/SolarInfo.tsx` and all four display wrappers
- All existing unit tests

---

## Testing

- Existing unit tests (71 tests) must pass without modification.
- `npm run build` must succeed with no TypeScript errors.
- Manual verification:
  - 3D buildings render on first pin drop.
  - Arc appears above buildings, coloured by phase.
  - Time slider moves the sphere along the arc.
  - Live indicator dot is present when slider ≈ current time.
  - Dragging the map and tilting the camera keeps the arc correctly attached.
  - Clicking the map moves the pin and the arc rebuilds for the new location.
  - Display-mode wrappers (drawer, card, panel, popup) still work.
  - Mobile drawer layout is unaffected.

---

## Out of scope

- Terrain / elevation — the arc sits at a fixed visual radius; hills are not modelled.
- Arc animation (sphere travelling along arc continuously) — the sphere snaps
  to the current time-of-day position; no `requestAnimationFrame` loop beyond
  MapLibre's own render loop.
- Custom map style (dark mode) — Liberty style is used as-is.
- Sharing / exporting the 3D view.
