# Solux

A map-driven golden hour calculator for photographers. Click anywhere on the map and instantly see every solar phase for that location on any date — expressed in the **local time of the pinned location**, not your browser clock.

## Features

- **Click-to-pin** — drop a marker anywhere on the world map; clicking again moves it
- **Full solar timeline** — every phase from astronomical dawn to astronomical dusk, in chronological order:
  - Astronomical / nautical / civil dawn
  - Blue hour (AM)
  - Sunrise · Golden hour · Soft light · Late morning
  - Solar noon
  - Late afternoon · Soft light · Golden hour · Sunset
  - Blue hour (PM) · Civil / nautical / astronomical dusk
- **Building-aware times** — fetches OSM building footprints within 1 km via Overpass, constructs a 360° obstruction profile, and replaces every sun-direct phase with the moment it actually clears the surrounding skyline; adjusted values are tinted and tappable to reveal the geometric baseline
- **Explicit timezone disclosure** — the pinned location's IANA zone and UTC offset are always shown; a secondary note appears when your browser is in a different zone
- **Date picker + presets** — Today / Tomorrow / +7 days computed in the pin's timezone
- **Four display modes** — floating card, bottom drawer, side panel, pin popup; user-selectable and persisted
- **Mobile-first** — forces bottom drawer on narrow viewports, collapses it by default so the map is immediately tappable, larger touch targets throughout
- **3D buildings** — OpenFreeMap vector tiles extrude nearby buildings; tilt and rotate the map freely
- **Sun path arc** — a coloured 3D arc floats above the pin showing the day's path; segments are tinted by phase (deep blue → blue hour → amber golden hour → white midday)
- **Time slider** — drag to any time of day to preview the sun's position; an amber dot shows when it's tracking the real current time (updates every 60 s)
- **Offline support** — installable as a Progressive Web App (PWA); timezone lookup uses an embedded offline polygon table, and core map assets are cached
- **Persistence** — pin, date, display mode, and building profiles survive page reload via `localStorage`

## Stack

| Concern | Library |
|---|---|
| Build | Vite 5 + TypeScript + Vite PWA |
| UI | React 18 |
| Map | MapLibre GL JS + OpenFreeMap (vector tiles, no API key) |
| 3D / sun arc | Three.js (custom WebGL layer inside MapLibre) |
| Solar math | SunCalc (NOAA algorithm) |
| Timezone | tz-lookup (offline) |
| Date formatting | date-fns + date-fns-tz |
| Building data | OpenStreetMap via Overpass API |
| Tests | Vitest + React Testing Library |

## Getting started

```sh
npm install
npm run dev
```

### HTTPS Support (for Geolocation)

The Geolocation API requires a secure context (HTTPS). You can use the included Nginx reverse proxy (requires Docker):

1. Start the dev server with `wss` protocol:
   ```sh
   VITE_HMR_PROTOCOL=wss npm run dev
   ```
2. Start the HTTPS proxy:
   ```sh
   npm run serve:https
   ```
3. Open [https://localhost:8443](https://localhost:8443) (you will need to accept the self-signed certificate).

Alternatively, use **ngrok**:
```sh
npm run serve:ngrok
```

Open the URL printed by Vite, click anywhere on the map.

```sh
npm test          # run unit tests
npm run build     # production bundle
```

## How the building-horizon works

1. On each new pin, `useHorizon` POSTs an Overpass QL query for `way["building"]` within 1 km
2. Each building's footprint vertices are projected from the pin's eye position (1.7 m) to produce an azimuth + altitude angle
3. A 360-element `Float32Array` records the maximum obstruction altitude per degree
4. The profile is persisted in `localStorage` keyed by a ~500 m grid cell (30-day TTL) so revisiting a nearby spot is instant
5. `applyHorizonToSolarTimes` clips every sun-direct phase window to the sub-interval where the sun's altitude exceeds the profile at its instantaneous azimuth; fully-blocked phases return `null`

Twilight and blue-hour times are **not** adjusted — they're atmospheric scattering phenomena, not direct-sun events.

## Caveats

- Only OSM-tagged buildings are considered; trees, billboards, and untagged structures are ignored
- Buildings without `height` or `building:levels` tags are skipped rather than defaulted (better to under-report than invent tall buildings)
- Terrain / hills are not accounted for
