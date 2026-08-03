# Agent instructions

## Project overview

Solux is a pure-frontend Progressive Web App (Vite + React 18 + TypeScript) that calculates
solar phase times for any location on an interactive map. MapLibre GL JS
renders the vector-tile map with 3D buildings; Three.js provides a custom
WebGL layer for the 3D sun path arc. No backend, no accounts, no build-time
secrets.

## Commands

```sh
npm run dev      # dev server (http://localhost:5173)
npm test         # vitest unit tests — run before every commit
npm run build    # tsc -b && vite build — must succeed with zero errors
npx tsc -b       # type-check only (faster than a full build)
```

Always run `npm test` and `npx tsc -b` before considering a task done.

## Architecture

```
src/
  types.ts              shared domain types (LatLng, SolarTimes, Prefs, …)
  solar/calc.ts         pure SunCalc wrapper → SolarTimes; no React, no I/O
  timezone/lookup.ts    tz-lookup wrapper → IANA zone string
  storage/prefs.ts      typed localStorage adapter
  util/zoneDate.ts      date-fns-tz helpers (isoDateInZone, formatTimeInZone, …)
  buildings/
    overpass.ts         Overpass QL fetch → Building[]
    geo.ts              haversine distance + bearing
    horizon.ts          Building[] → HorizonProfile (Float32Array, 360 buckets)
    effective.ts        HorizonProfile + SolarTimes → visibility-clipped SolarTimes
    cache.ts            localStorage cache for HorizonProfile (~500 m grid, 30-day TTL)
  hooks/
    usePrefs.ts         persisted pin / date / displayMode state
    useSolarData.ts     memoised computeSolarTimes
    useTimezone.ts      memoised ianaZoneFor
    useHorizon.ts       async Overpass pipeline: idle → loading → ready | error
    useEffectiveSolarTimes.ts  memoised applyHorizonToSolarTimes
    useMediaQuery.ts    CSS media query subscription
  components/
    map/
      MapLibreView.tsx    MapLibre GL JS map, click-to-pin, popup, 3D buildings
      MapLibreView.module.css
      arcGeometry.ts      Pure functions: sun→XYZ, phase classification, arc samples
      arcGeometry.test.ts
      layers/
        sunPathLayer.ts   Three.js CustomLayerInterface: arc tube + sphere
    Controls.tsx        date picker + presets + view-mode selector
    SolarInfo.tsx       phase list with TZ disclosure + building-adjusted values
    display/            four layout wrappers (FloatingCard, BottomDrawer,
                          SidePanel, MarkerPopup)
  App.tsx               orchestrates all hooks and picks the active wrapper
```

## Key conventions

**Pure functions in `solar/` and `buildings/`**
`computeSolarTimes`, `buildHorizonProfile`, `applyHorizonToSolarTimes`, etc.
take plain data and return plain data. No React, no `Date.now()`, no I/O.
Keep them that way — it's what makes them fast to unit-test.

**Null for absent solar events**
SunCalc returns `Invalid Date` for phases that don't occur (polar night/day).
`nullIfInvalid` in `solar/calc.ts` normalises these to `null`. Every consumer
branches on presence, never on `isNaN`. Do not reintroduce `NaN` checks.

**Timezone in the pin's location, always**
Times are always formatted in the IANA zone of the *pinned coordinate*, not
the viewer's browser. `SolarInfo` surfaces this explicitly with a zone label
and — when zones differ — a secondary note. Do not add any logic that silently
falls back to the browser zone for displayed times.

**Twilight / blue-hour phases bypass building adjustment**
`applyHorizonToSolarTimes` in `effective.ts` passes civil/nautical/astronomical
dawn-dusk and blue-hour windows through unchanged. These are atmospheric
scattering phenomena; building silhouettes don't affect them. Do not add
horizon clipping to these fields.

**CSS modules, no Tailwind**
All component styles use `*.module.css`. Dark-theme CSS custom properties
are defined in `src/styles/global.css` (`--bg`, `--fg`, `--accent`, `--blue`,
`--border`, …). Use those variables; don't hard-code hex values in component
CSS.

**Mobile layout**
On `max-width: 640px`:
- `App` forces `displayMode = 'drawer'` regardless of stored prefs
- `Controls` hides the view-mode selector and the SOLUX brand label
- `BottomDrawer` starts collapsed (`startCollapsed` prop) so the map fills
  the screen on load
- Leaflet zoom controls are pushed to `top: 104px` to clear the floating bar
- All interactive elements have a minimum touch target of 36 px

**3D arc layer**
`sunPathLayer.ts` shares MapLibre's WebGL context via `CustomLayerInterface`
(`renderingMode: '3d'`). Never call `renderer.setSize()` or set
`renderer.autoClear = true` — MapLibre owns the canvas. Always call
`renderer.resetState()` at the start of each `render()` callback.

**Arc vs. horizon pipeline**
`arcGeometry.ts` uses raw `SolarTimes` (not `effectiveTimes`) for phase
classification because the arc shows the geometric sun path regardless of
building obstruction. `effectiveTimes` is still used in `SolarInfo` for the
adjusted clock times panel.

**MapLibre coordinate transform**
Three.js objects are placed in Y-up space (X=east, Y=altitude, Z=south).
The model matrix applied in `render()` — `rotateX(PI/2)` then
`scale(s, -s, s)` — converts this to MapLibre's mercator space. The scale
factor `s = MercatorCoordinate.meterInMercatorCoordinateUnits()` converts
metres to dimensionless mercator units.

**localStorage keys**
- `solux:prefs:v1` — user preferences (pin, date, displayMode)
- `solux:horizon:v1:<lat>,<lng>,<radius>` — cached HorizonProfile

Bump the version suffix if the stored shape changes in a breaking way.

## Testing

Tests live next to the module they cover (`calc.test.ts` beside `calc.ts`).
Vitest globals are enabled; no need to import `describe`/`it`/`expect`.

What to test:
- Pure functions exhaustively (edge cases, polar coordinates, malformed input)
- Storage round-trips, TTL expiry, and malformed-JSON recovery
- Horizon geometry against analytically-predictable synthetic buildings

What not to test here:
- Overpass network fetches (mock at the `fetch` boundary if needed)
- React component rendering (the pure-function layer is the meaningful logic)

## Adding a new solar phase

1. Add the field to `SolarTimes` in `src/types.ts`
2. Register the SunCalc elevation in `solar/calc.ts` with `SunCalc.addTime`
   and extend `ExtendedTimes` if it's a custom elevation
3. Map the new SunCalc keys in `computeSolarTimes`
4. Decide whether the phase is sun-direct or sky-only:
   - Sun-direct → add `effectiveWindow` / `effectiveInstant` call in
     `applyHorizonToSolarTimes` (`effective.ts`)
   - Sky-only → pass through unchanged (copy the field from `times`)
5. Add a row in `SolarInfo.tsx` in chronological order
6. Add test coverage in `solar/calc.test.ts`
