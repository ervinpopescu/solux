# 3D MapLibre + Sun Path Arc — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Leaflet with MapLibre GL JS, add 3D building extrusions from OpenFreeMap vector tiles, and render a coloured Three.js sun-path arc above the pinned location, with a time-of-day slider and a live-updating sun-position sphere.

**Architecture:** A new `MapLibreView` component replaces `MapView` with the same prop interface. Arc geometry is computed in a pure-function module (`arcGeometry.ts`) that is fully unit-tested without Three.js. A `CustomLayerInterface` wrapper (`sunPathLayer.ts`) consumes those functions and renders into MapLibre's shared WebGL context.

**Tech Stack:** `maplibre-gl` 4.x, `three` 0.170+, `date-fns`/`date-fns-tz` (already present), `suncalc` (already present). OpenFreeMap tiles — no API key required.

---

## File map

| Action | Path | Purpose |
|---|---|---|
| **New** | `src/hooks/useTimeOfDay.ts` | Minutes-since-midnight in pin's zone, ticks every 60 s |
| **New** | `src/map/arcGeometry.ts` | Pure math: sun→XYZ, phase classification, arc sample building |
| **New** | `src/map/arcGeometry.test.ts` | Unit tests for arcGeometry |
| **New** | `src/map/MapLibreView.tsx` | MapLibre map component (replaces MapView) |
| **New** | `src/map/MapLibreView.module.css` | Map fill styles |
| **New** | `src/map/layers/sunPathLayer.ts` | Three.js custom layer for arc + sphere |
| **Delete** | `src/components/MapView.tsx` | Replaced by MapLibreView |
| **Delete** | `src/components/MapView.module.css` | (if it exists) |
| **Modify** | `src/App.tsx` | Swap MapView → MapLibreView; add `timeMinutes` / `dayStartUtc` |
| **Modify** | `src/components/Controls.tsx` | Add time slider + live indicator |
| **Modify** | `src/components/Controls.module.css` | Slider styles |
| **Modify** | `src/styles/global.css` | Swap Leaflet CSS rules for MapLibre equivalents |
| **Modify** | `src/main.tsx` | Swap CSS import |
| **Modify** | `AGENTS.md` | Update stack description and file tree |
| **Modify** | `README.md` | Update stack table |

---

## Task 1: Install MapLibre GL JS and Three.js

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add the new runtime dependencies**

```bash
npm add maplibre-gl three @types/three
```

Expected: packages resolve successfully. No existing tests break.

- [ ] **Step 2: Verify existing tests still pass**

```bash
npm test
```

Expected: all 71 tests pass. Leaflet is still installed; nothing has changed yet.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add maplibre-gl and three for 3D map"
```

---

## Task 2: `useTimeOfDay` hook

Returns the current time as minutes since midnight (0–1439) in the given IANA zone. Updates every 60 seconds.

**Files:**
- Create: `src/hooks/useTimeOfDay.ts`
- Create: `src/hooks/useTimeOfDay.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/hooks/useTimeOfDay.test.ts`:

```ts
import { renderHook, act } from '@testing-library/react';
import { vi, describe, it, expect, afterEach } from 'vitest';
import { useTimeOfDay } from './useTimeOfDay';

afterEach(() => vi.useRealTimers());

describe('useTimeOfDay', () => {
  it('returns the current minutes in the given zone', () => {
    vi.useFakeTimers();
    // 14:30 UTC = 15:30 in Europe/London (BST, UTC+1)
    vi.setSystemTime(new Date('2024-06-21T14:30:00Z'));
    const { result } = renderHook(() => useTimeOfDay('Europe/London'));
    expect(result.current).toBe(15 * 60 + 30); // 930
  });

  it('increments after 60 seconds', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-06-21T14:30:00Z'));
    const { result } = renderHook(() => useTimeOfDay('Europe/London'));
    expect(result.current).toBe(930);
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(result.current).toBe(931);
  });

  it('recalculates immediately when zone changes', () => {
    vi.useFakeTimers();
    // 14:30 UTC = 10:30 in America/New_York (EDT, UTC-4)
    vi.setSystemTime(new Date('2024-06-21T14:30:00Z'));
    const { result, rerender } = renderHook(
      ({ zone }) => useTimeOfDay(zone),
      { initialProps: { zone: 'UTC' } },
    );
    expect(result.current).toBe(14 * 60 + 30); // 870

    rerender({ zone: 'America/New_York' });
    expect(result.current).toBe(10 * 60 + 30); // 630
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npm test -- useTimeOfDay
```

Expected: FAIL — `useTimeOfDay` is not defined.

- [ ] **Step 3: Implement the hook**

Create `src/hooks/useTimeOfDay.ts`:

```ts
import { useState, useEffect } from 'react';
import { toZonedTime } from 'date-fns-tz';

/** Returns minutes since midnight (0–1439) in `zone`, refreshing every 60 s. */
export function useTimeOfDay(zone: string): number {
  function nowMinutes(): number {
    const zoned = toZonedTime(new Date(), zone);
    return zoned.getHours() * 60 + zoned.getMinutes();
  }

  const [minutes, setMinutes] = useState(nowMinutes);

  useEffect(() => {
    setMinutes(nowMinutes());
    const id = setInterval(() => setMinutes(nowMinutes()), 60_000);
    return () => clearInterval(id);
  }, [zone]);

  return minutes;
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npm test -- useTimeOfDay
```

Expected: 3 passing tests.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useTimeOfDay.ts src/hooks/useTimeOfDay.test.ts
git commit -m "feat(hooks): add useTimeOfDay — minutes-since-midnight in pin zone"
```

---

## Task 3: `arcGeometry.ts` — pure arc geometry functions

Pure functions: no Three.js, no MapLibre, no React. Converts sun azimuth + altitude into Three.js-space XYZ, classifies each sample into a phase, and builds the full list of arc samples for a day.

**Files:**
- Create: `src/map/arcGeometry.ts`
- Create: `src/map/arcGeometry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/map/arcGeometry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sunToThreeXYZ, classifyPhase, buildArcSamples } from './arcGeometry';
import type { SolarTimes } from '../types';

// ── sunToThreeXYZ ──────────────────────────────────────────────────────────
// SunCalc azimuth convention: 0 = south, -PI/2 = east, PI/2 = west, ±PI = north.
// Three.js output: X = east, Y = altitude (up), Z = south (negative = north).

describe('sunToThreeXYZ', () => {
  it('sun on the eastern horizon → +X, Y=0, Z=0', () => {
    // azimuth = -PI/2 (east), altitude = 0
    const [x, y, z] = sunToThreeXYZ(-Math.PI / 2, 0, 100);
    expect(x).toBeCloseTo(100, 1);
    expect(y).toBeCloseTo(0, 5);
    expect(z).toBeCloseTo(0, 5);
  });

  it('sun on the southern horizon → X=0, Y=0, +Z', () => {
    // azimuth = 0 (south), altitude = 0
    const [x, y, z] = sunToThreeXYZ(0, 0, 100);
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(0, 5);
    expect(z).toBeCloseTo(100, 1);
  });

  it('sun at zenith → X=0, +Y=radius, Z=0', () => {
    const [x, y, z] = sunToThreeXYZ(0, Math.PI / 2, 100);
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(100, 1);
    expect(z).toBeCloseTo(0, 5);
  });

  it('sun at the northern horizon → X=0, Y=0, -Z', () => {
    // azimuth = PI (north), altitude = 0
    const [x, y, z] = sunToThreeXYZ(Math.PI, 0, 100);
    expect(x).toBeCloseTo(0, 5);
    expect(y).toBeCloseTo(0, 5);
    expect(z).toBeCloseTo(-100, 1);
  });
});

// ── classifyPhase ──────────────────────────────────────────────────────────

function makeWindow(startH: number, endH: number): { start: Date; end: Date } {
  const base = new Date('2024-06-21T00:00:00Z');
  return {
    start: new Date(base.getTime() + startH * 3_600_000),
    end:   new Date(base.getTime() + endH   * 3_600_000),
  };
}

const TIMES: SolarTimes = {
  sunrise: new Date('2024-06-21T03:43:00Z'),
  sunset:  new Date('2024-06-21T20:21:00Z'),
  solarNoon: new Date('2024-06-21T12:01:00Z'),
  blueHourMorning:   makeWindow(3.0, 3.72),  // ~03:00–03:43
  goldenHourMorning: makeWindow(3.72, 5.2),  // ~03:43–05:12
  softLightMorning:  makeWindow(5.2, 6.5),
  lateMorning:       makeWindow(6.5, 10.5),
  lateAfternoon:     makeWindow(13.5, 17.5),
  softLightEvening:  makeWindow(17.5, 18.8),
  goldenHourEvening: makeWindow(18.8, 20.35),
  blueHourEvening:   makeWindow(20.35, 21.0),
  civilDawn:  new Date('2024-06-21T03:00:00Z'),
  civilDusk:  new Date('2024-06-21T21:00:00Z'),
  nauticalDawn: null, nauticalDusk: null,
  astroDawn: null,    astroDusk: null,
};

describe('classifyPhase', () => {
  it('classifies inside golden hour morning', () => {
    const t = new Date('2024-06-21T04:30:00Z');
    expect(classifyPhase(t, TIMES)).toBe('golden_hour');
  });

  it('classifies inside blue hour morning', () => {
    const t = new Date('2024-06-21T03:10:00Z');
    expect(classifyPhase(t, TIMES)).toBe('blue_hour');
  });

  it('classifies before civil dawn as twilight', () => {
    const t = new Date('2024-06-21T02:00:00Z');
    expect(classifyPhase(t, TIMES)).toBe('twilight');
  });

  it('classifies midday', () => {
    const t = new Date('2024-06-21T12:00:00Z');
    expect(classifyPhase(t, TIMES)).toBe('midday');
  });
});

// ── buildArcSamples ────────────────────────────────────────────────────────

describe('buildArcSamples', () => {
  const LONDON = { lat: 51.5074, lng: -0.1278 };
  // London 2024-06-21 midnight UTC (UTC+1, so local midnight = 23:00 UTC prev day)
  const DAY_START = new Date('2024-06-20T23:00:00Z');

  it('returns only above-horizon samples', () => {
    const samples = buildArcSamples(LONDON, DAY_START, TIMES);
    // Every sample must have positive altitude
    expect(samples.every(s => s.yM > 0)).toBe(true);
  });

  it('returns samples spread across the day', () => {
    const samples = buildArcSamples(LONDON, DAY_START, TIMES);
    // London midsummer has ~17 h of daylight; at 5-min steps that is ~204 samples
    expect(samples.length).toBeGreaterThan(100);
    expect(samples.length).toBeLessThan(290); // max possible is 288
  });

  it('assigns phases from the provided SolarTimes', () => {
    const samples = buildArcSamples(LONDON, DAY_START, TIMES);
    const phases = new Set(samples.map(s => s.phase));
    // Should see at least golden hour and midday on a long summer day
    expect(phases.has('golden_hour')).toBe(true);
    expect(phases.has('midday')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npm test -- arcGeometry
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `arcGeometry.ts`**

Create `src/map/arcGeometry.ts`:

```ts
import SunCalc from 'suncalc';
import type { LatLng, SolarTimes, TimeWindow } from '../types';

// Visual radius of the arc in metres from the pin. At city zoom + 45° pitch
// this floats the arc at a comfortable height above rooftop level.
const ARC_RADIUS_M = 400;

// Sampling interval. 5-minute steps give 288 points max for a full-day arc,
// which is enough for smooth curvature without excessive geometry.
const STEP_MIN = 5;

export type ArcPhase =
  | 'twilight'
  | 'blue_hour'
  | 'golden_hour'
  | 'soft_light'
  | 'late'
  | 'midday';

/** Three.js hex colour for each arc phase (matches CSS custom properties). */
export const PHASE_COLORS: Record<ArcPhase, number> = {
  twilight:     0x1a2a4a,
  blue_hour:    0x5fa8e0, // --blue
  golden_hour:  0xf5a623, // --accent
  soft_light:   0xd4b896,
  late:         0xe8d5c0,
  midday:       0xffffff,
};

export type ArcSample = {
  /** Metres east of pin (positive = east). */
  xM: number;
  /** Metres above ground (positive = up). */
  yM: number;
  /** Metres south of pin (positive = south, negative = north). */
  zM: number;
  phase: ArcPhase;
  minuteOfDay: number;
};

// ── Coordinate conversion ──────────────────────────────────────────────────
//
// SunCalc azimuth convention: 0 = south, -PI/2 = east, PI/2 = west, ±PI = north.
// Three.js space (before MapLibre's coordinate transform): X = east, Y = up,
// Z = south (so -Z points north). The MapLibre custom layer transform
// (rotateX(PI/2) + scale(s, -s, s)) maps this to mercator space correctly.

/**
 * Converts a SunCalc position to Three.js-space XYZ offsets in metres.
 * The origin is the pin; Y is altitude above ground.
 */
export function sunToThreeXYZ(
  suncalcAzimuth: number,  // radians, SunCalc convention: south=0, west=PI/2
  suncalcAltitude: number, // radians above horizon
  radiusM: number = ARC_RADIUS_M,
): [number, number, number] {
  // Convert SunCalc azimuth (from south) to compass bearing (from north):
  // south=0 + PI → south=PI; east=-PI/2 + PI → east=PI/2. ✓
  const bearing = suncalcAzimuth + Math.PI;
  const horizDist = radiusM * Math.cos(suncalcAltitude);
  const x =  horizDist * Math.sin(bearing); // east
  const y =  radiusM   * Math.sin(suncalcAltitude); // altitude
  const z = -horizDist * Math.cos(bearing); // south (-cos because bearing=0 is north)
  return [x, y, z];
}

// ── Phase classification ───────────────────────────────────────────────────

function inWindow(t: Date, w: TimeWindow | null): boolean {
  return w !== null && t >= w.start && t <= w.end;
}

/** Returns the solar phase the sun is in at time `t` for the given day. */
export function classifyPhase(t: Date, times: SolarTimes): ArcPhase {
  // Check specific phase windows from narrowest (most distinctive) to widest.
  if (inWindow(t, times.blueHourMorning) || inWindow(t, times.blueHourEvening))
    return 'blue_hour';
  if (inWindow(t, times.goldenHourMorning) || inWindow(t, times.goldenHourEvening))
    return 'golden_hour';
  if (inWindow(t, times.softLightMorning) || inWindow(t, times.softLightEvening))
    return 'soft_light';
  if (inWindow(t, times.lateMorning) || inWindow(t, times.lateAfternoon))
    return 'late';
  // Before civil dawn or after civil dusk the sky is still dark twilight.
  if (times.civilDawn && t < times.civilDawn) return 'twilight';
  if (times.civilDusk && t > times.civilDusk) return 'twilight';
  return 'midday';
}

// ── Arc sample building ────────────────────────────────────────────────────

/**
 * Samples the sun's position every `STEP_MIN` minutes across the day and
 * returns one `ArcSample` per above-horizon position.
 *
 * @param dayStartUtc - UTC instant corresponding to local midnight at the pin.
 */
export function buildArcSamples(
  pin: LatLng,
  dayStartUtc: Date,
  solarTimes: SolarTimes,
): ArcSample[] {
  const samples: ArcSample[] = [];

  for (let m = 0; m < 1440; m += STEP_MIN) {
    const t = new Date(dayStartUtc.getTime() + m * 60_000);
    const pos = SunCalc.getPosition(t, pin.lat, pin.lng);
    if (pos.altitude <= 0) continue;

    const [xM, yM, zM] = sunToThreeXYZ(pos.azimuth, pos.altitude);
    samples.push({
      xM, yM, zM,
      phase: classifyPhase(t, solarTimes),
      minuteOfDay: m,
    });
  }

  return samples;
}

/**
 * Returns the (xM, yM, zM) position of the sun at `minuteOfDay`, or null
 * if the sun is below the horizon at that time.
 */
export function sunPositionAtMinute(
  pin: LatLng,
  dayStartUtc: Date,
  minuteOfDay: number,
): [number, number, number] | null {
  const t = new Date(dayStartUtc.getTime() + minuteOfDay * 60_000);
  const pos = SunCalc.getPosition(t, pin.lat, pin.lng);
  if (pos.altitude <= 0) return null;
  return sunToThreeXYZ(pos.azimuth, pos.altitude);
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npm test -- arcGeometry
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/map/arcGeometry.ts src/map/arcGeometry.test.ts
git commit -m "feat(map): add arcGeometry — pure sun-position and phase-classification functions"
```

---

## Task 4: `MapLibreView` component + wire into App

Replaces `MapView` with the same external interface. Handles click-to-pin, marker, and the popup display mode. No 3D features yet — those are added in Tasks 5 and 6.

**Files:**
- Create: `src/map/MapLibreView.tsx`
- Create: `src/map/MapLibreView.module.css`
- Delete: `src/components/MapView.tsx`
- Modify: `src/App.tsx` (import swap)
- Modify: `src/main.tsx` (CSS import swap)
- Modify: `src/styles/global.css` (remove Leaflet rules, add MapLibre equivalents)

- [ ] **Step 1: Create `MapLibreView.module.css`**

Create `src/map/MapLibreView.module.css`:

```css
.map {
  position: fixed;
  inset: 0;
  cursor: crosshair;
}

/* Restore grab cursor while panning */
.map :global(.maplibregl-canvas-container.maplibregl-interactive) {
  cursor: crosshair;
}
.map :global(.maplibregl-canvas-container.maplibregl-interactive:active) {
  cursor: grabbing;
}
```

- [ ] **Step 2: Create `MapLibreView.tsx`**

Create `src/map/MapLibreView.tsx`:

```tsx
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { type ReactNode, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { LatLng } from '../types';
import styles from './MapLibreView.module.css';

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
};

export default function MapLibreView({ pin, onPin, popupContent }: MapLibreViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef       = useRef<maplibregl.Map | null>(null);
  const markerRef    = useRef<maplibregl.Marker | null>(null);
  const popupRef     = useRef<maplibregl.Popup | null>(null);
  const popupRootRef = useRef<Root | null>(null);

  // ── Map initialisation (once) ──────────────────────────────────────────
  useEffect(() => {
    if (!containerRef.current) return;

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: [0, 20],
      zoom: 2,
      attributionControl: { compact: false },
    });
    mapRef.current = map;

    map.on('click', (e) => {
      onPin({ lat: round6(e.lngLat.lat), lng: round6(e.lngLat.lng) });
    });

    return () => {
      popupRootRef.current?.unmount();
      map.remove();
      mapRef.current = null;
    };
  // onPin is stable from usePrefs; no need to re-run when it changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Marker: update when pin changes ───────────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    markerRef.current?.remove();
    if (!map || !pin) return;

    const el = document.createElement('div');
    el.innerHTML = PIN_SVG;
    // Offset so the bottom tip of the SVG sits on the coordinate.
    el.style.cssText = 'width:32px;height:44px;cursor:pointer;margin-top:-42px;margin-left:-16px';

    const marker = new maplibregl.Marker({ element: el, anchor: 'top-left' })
      .setLngLat([pin.lng, pin.lat])
      .addTo(map);
    markerRef.current = marker;

    // Fly to pin with a 3D pitch so buildings are visible.
    map.flyTo({ center: [pin.lng, pin.lat], zoom: 15, pitch: 50, duration: 1000 });
  }, [pin?.lat, pin?.lng]);

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
  }, [popupContent, pin?.lat, pin?.lng]);

  return <div ref={containerRef} className={styles.map} />;
}
```

- [ ] **Step 3: Update `src/main.tsx` — swap CSS import**

Replace line 3:

```ts
// Before:
import 'leaflet/dist/leaflet.css';

// After: (MapLibre CSS is imported inside MapLibreView.tsx itself)
```

Remove the leaflet CSS import entirely. The file should look like:

```ts
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/global.css';
import App from './App';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Missing #root element in index.html');

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 4: Update `src/styles/global.css` — replace Leaflet rules**

Remove the entire block from `/* Leaflet attribution control */` to the end of the file (lines 73–106 in the current file). Replace with:

```css
/* MapLibre attribution: readable on dark theme */
.maplibregl-ctrl-attrib {
  background: rgba(11, 13, 18, 0.7) !important;
  color: var(--fg-muted) !important;
}
.maplibregl-ctrl-attrib a { color: var(--accent) !important; }

/* Push MapLibre zoom controls below the Solux controls bar on mobile. */
@media (max-width: 640px) {
  .maplibregl-ctrl-top-left,
  .maplibregl-ctrl-top-right {
    top: 108px;
  }
}
```

- [ ] **Step 5: Update `src/App.tsx` — swap import**

Change line 4:

```ts
// Before:
import MapView from './components/MapView';

// After:
import MapLibreView from './map/MapLibreView';
```

Change line 112:

```tsx
// Before:
<MapView pin={pin} onPin={setPin} popupContent={popupContent} />

// After:
<MapLibreView pin={pin} onPin={setPin} popupContent={popupContent} />
```

- [ ] **Step 6: Remove Leaflet packages and the old MapView**

```bash
npm remove leaflet react-leaflet @types/leaflet
```

Then delete `src/components/MapView.tsx`:

```bash
git rm src/components/MapView.tsx
```

- [ ] **Step 7: Run type-check and tests**

```bash
npx tsc -b
npm test
```

Expected: zero type errors; all tests pass (the MapView tests, if any, are gone; the rest are unchanged).

- [ ] **Step 8: Verify in the browser**

```bash
npm run dev
```

Open the dev URL, click on the map — the amber pin should appear and the SolarInfo panel should populate. 3D buildings are not visible yet (that is Task 5). The popup display mode should work: switch to "Pin popup" in Controls, click the map, verify SolarInfo appears inside a popup bubble.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(map): replace Leaflet with MapLibre GL JS

Migrates the interactive map from react-leaflet + OSM raster tiles to
MapLibre GL JS on OpenFreeMap vector tiles. The component interface
(pin, onPin, popupContent) is unchanged so all display-mode wrappers
work without modification.

The popup display mode now uses MapLibre's Popup API with a React
portal via createRoot so the SolarInfo tree renders inside the bubble
with full React context.

Removed: leaflet, react-leaflet, @types/leaflet."
```

---

## Task 5: 3D building extrusions

Adds a `fill-extrusion` layer to MapLibreView on `style.load`. The OpenFreeMap Liberty style includes `render_height` on its `building` source-layer, so no extra data fetch is needed.

**Files:**
- Modify: `src/map/MapLibreView.tsx`

- [ ] **Step 1: Add the 3D building layer inside `MapLibreView.tsx`**

After the `map.on('click', ...)` line inside the `useEffect`, add a `style.load` handler:

```ts
map.on('style.load', () => {
  // Extrude buildings using the height data already present in OpenFreeMap's
  // vector tiles (OpenMapTiles schema: source 'openmaptiles', layer 'building',
  // property 'render_height'). We add our own layer rather than modifying the
  // Liberty style's existing flat building fill so we can control colour and
  // opacity independently.
  if (map.getLayer('building')) {
    // Hide the flat 2D building fill that the Liberty style adds by default
    // so it doesn't z-fight with our extrusion.
    map.setLayoutProperty('building', 'visibility', 'none');
  }

  map.addLayer({
    id: 'solux-buildings-3d',
    type: 'fill-extrusion',
    source: 'openmaptiles',
    'source-layer': 'building',
    paint: {
      'fill-extrusion-color': '#1e2438',
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 0],
      'fill-extrusion-base':   ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.85,
    },
  });
});
```

- [ ] **Step 2: Verify in the browser**

```bash
npm run dev
```

Drop a pin on a city (e.g. London — lat 51.5, lng -0.12). The map should fly to zoom 15 with a 50° pitch and buildings should extrude in the dark blue-grey colour.

If buildings do not appear: open DevTools console. A common issue is that the source name or source-layer name differs in the actual style JSON. To diagnose, add a temporary `console.log('sources', map.getStyle().sources)` after `style.load` and check the keys. The correct source ID will be visible there. Remove the console.log after fixing.

- [ ] **Step 3: Commit**

```bash
git add src/map/MapLibreView.tsx
git commit -m "feat(map): add 3D building extrusions via OpenFreeMap fill-extrusion layer"
```

---

## Task 6: Sun path arc — Three.js custom layer

Creates the `SunPathLayerHandle` (arc tube + sun sphere in a MapLibre `CustomLayerInterface`) and wires it into `MapLibreView`.

**Files:**
- Create: `src/map/layers/sunPathLayer.ts`
- Modify: `src/map/MapLibreView.tsx`

- [ ] **Step 1: Create `src/map/layers/sunPathLayer.ts`**

```ts
import * as THREE from 'three';
import maplibregl, { type CustomLayerInterface } from 'maplibre-gl';
import type { LatLng, SolarTimes } from '../../types';
import {
  buildArcSamples,
  sunPositionAtMinute,
  PHASE_COLORS,
  type ArcPhase,
  type ArcSample,
} from '../arcGeometry';

// Cross-section radius of the tube geometry in metres.
const TUBE_RADIUS_M = 8;
// Sphere radius for the current-position marker in metres.
const SPHERE_RADIUS_M = 14;

export interface SunPathLayerHandle {
  customLayer: CustomLayerInterface;
  /** Update the sun sphere to the given minute of day (0–1439). */
  setTimeMinutes: (minutes: number) => void;
}

/**
 * Builds a MapLibre custom layer that renders the day's sun path arc and a
 * sphere marking the current time-of-day position.
 *
 * The Three.js scene shares MapLibre's WebGL context so buildings correctly
 * occlude the arc via the shared depth buffer.
 *
 * Coordinate system: Three.js Y-up, X = east, Z = south. The MapLibre model
 * matrix (rotateX(PI/2) + scale(s, -s, s)) converts this to mercator space.
 */
export function createSunPathLayer(
  pin: LatLng,
  dayStartUtc: Date,
  solarTimes: SolarTimes,
): SunPathLayerHandle {
  // Mercator origin and per-metre scale factor — computed once from the pin.
  const origin = maplibregl.MercatorCoordinate.fromLngLat(
    { lng: pin.lng, lat: pin.lat },
    0,
  );
  const scale = origin.meterInMercatorCoordinateUnits();

  // Three.js objects — initialised in onAdd, referenced in render + setTimeMinutes.
  let renderer: THREE.WebGLRenderer;
  let scene: THREE.Scene;
  let camera: THREE.Camera;
  let sphere: THREE.Mesh | null = null;
  let storedMap: maplibregl.Map;

  // Pre-build arc samples (pure, no Three.js).
  const samples = buildArcSamples(pin, dayStartUtc, solarTimes);

  // Split samples into contiguous same-phase segments so each segment can be
  // a separately-coloured tube mesh.
  type Segment = { points: THREE.Vector3[]; phase: ArcPhase };

  function buildSegments(): Segment[] {
    const segments: Segment[] = [];
    let current: Segment | null = null;

    for (const s of samples) {
      const point = new THREE.Vector3(s.xM * scale, s.yM * scale, s.zM * scale);
      if (!current || current.phase !== s.phase) {
        if (current) segments.push(current);
        current = { points: [point], phase: s.phase };
      } else {
        current.points.push(point);
      }
    }
    if (current) segments.push(current);
    return segments;
  }

  const customLayer: CustomLayerInterface = {
    id: 'sun-path-layer',
    type: 'custom',
    renderingMode: '3d',

    onAdd(map, gl) {
      storedMap = map;

      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas() as HTMLCanvasElement,
        context: gl as WebGL2RenderingContext,
        antialias: true,
      });
      // autoClear must be false: we must not clear MapLibre's framebuffer.
      renderer.autoClear = false;

      scene = new THREE.Scene();
      camera = new THREE.Camera();

      // ── Arc tube segments ──────────────────────────────────────────────
      for (const seg of buildSegments()) {
        if (seg.points.length < 2) continue;
        const curve = new THREE.CatmullRomCurve3(seg.points);
        const tube  = new THREE.TubeGeometry(
          curve,
          Math.max(seg.points.length * 3, 6),
          TUBE_RADIUS_M * scale,
          8,
          false,
        );
        scene.add(
          new THREE.Mesh(
            tube,
            new THREE.MeshBasicMaterial({
              color: PHASE_COLORS[seg.phase],
              transparent: true,
              opacity: 0.9,
              depthWrite: false,
            }),
          ),
        );
      }

      // ── Sun position sphere ────────────────────────────────────────────
      sphere = new THREE.Mesh(
        new THREE.SphereGeometry(SPHERE_RADIUS_M * scale, 16, 16),
        new THREE.MeshBasicMaterial({ color: 0xffdd44 }),
      );
      sphere.visible = false;
      scene.add(sphere);
    },

    render(_gl, matrix) {
      // Standard MapLibre + Three.js coordinate transform. rotateX(PI/2)
      // converts Three.js Y-up to MapLibre's Z-up mercator space; scale(s,-s,s)
      // applies the metre→mercator conversion and flips Y (mercator Y increases
      // southward).
      const rotX = new THREE.Matrix4().makeRotationAxis(
        new THREE.Vector3(1, 0, 0),
        Math.PI / 2,
      );
      const modelMatrix = new THREE.Matrix4()
        .makeTranslation(origin.x, origin.y, origin.z ?? 0)
        .scale(new THREE.Vector3(scale, -scale, scale))
        .multiply(rotX);

      camera.projectionMatrix = new THREE.Matrix4()
        .fromArray(matrix)
        .multiply(modelMatrix);

      renderer.resetState();
      renderer.render(scene, camera);
    },

    onRemove() {
      scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach((m) => m.dispose());
        }
      });
      renderer.dispose();
    },
  };

  const handle: SunPathLayerHandle = {
    customLayer,

    setTimeMinutes(minutes: number) {
      if (!sphere) return;

      const pos = sunPositionAtMinute(pin, dayStartUtc, minutes);
      if (pos) {
        const [xM, yM, zM] = pos;
        sphere.position.set(xM * scale, yM * scale, zM * scale);
        sphere.visible = true;
      } else {
        sphere.visible = false;
      }

      storedMap?.triggerRepaint();
    },
  };

  return handle;
}
```

- [ ] **Step 2: Wire the layer into `MapLibreView`**

Add the following props to `MapLibreViewProps`:

```ts
export type MapLibreViewProps = {
  pin: LatLng | null;
  onPin: (latLng: LatLng) => void;
  popupContent?: ReactNode;
  // 3D arc props — optional so the component degrades gracefully if not provided
  solarTimes?: SolarTimes | null;
  dayStartUtc?: Date | null;
  timeMinutes?: number;
};
```

Add the import at the top of `MapLibreView.tsx`:

```ts
import type { SolarTimes } from '../types';
import { createSunPathLayer, type SunPathLayerHandle } from './layers/sunPathLayer';
```

Inside the component, add refs:

```ts
const sunPathRef = useRef<SunPathLayerHandle | null>(null);
const styleLoadedRef = useRef(false);
```

In the map initialisation `useEffect`, extend the `style.load` handler to set the flag:

```ts
map.on('style.load', () => {
  styleLoadedRef.current = true;
  // ... existing building layer code ...
});
```

Add a new `useEffect` for the arc (after the marker effect):

```ts
// ── Sun path arc: rebuild when pin, date, or solar times change ──────────
useEffect(() => {
  const map = mapRef.current;
  if (!map || !pin || !solarTimes || !dayStartUtc) return;

  function addArc() {
    // Remove the previous layer from MapLibre before re-adding.
    if (sunPathRef.current) {
      if (map!.getLayer('sun-path-layer')) map!.removeLayer('sun-path-layer');
      sunPathRef.current = null;
    }
    const handle = createSunPathLayer(pin!, dayStartUtc!, solarTimes!);
    map!.addLayer(handle.customLayer);
    if (timeMinutes !== undefined) handle.setTimeMinutes(timeMinutes);
    sunPathRef.current = handle;
  }

  // The style must be loaded before layers can be added.
  if (styleLoadedRef.current) {
    addArc();
  } else {
    map.once('style.load', addArc);
  }
}, [pin?.lat, pin?.lng, dayStartUtc?.getTime(), solarTimes]);
```

Add a separate effect to move the sphere without rebuilding the arc:

```ts
// ── Sun sphere: update position on time tick / slider ─────────────────────
useEffect(() => {
  if (timeMinutes !== undefined) {
    sunPathRef.current?.setTimeMinutes(timeMinutes);
  }
}, [timeMinutes]);
```

Also clean up the arc layer in the map teardown (inside the initial useEffect return):

```ts
return () => {
  popupRootRef.current?.unmount();
  if (sunPathRef.current && mapRef.current?.getLayer('sun-path-layer')) {
    mapRef.current?.removeLayer('sun-path-layer');
  }
  map.remove();
  mapRef.current = null;
};
```

- [ ] **Step 3: Type-check**

```bash
npx tsc -b
```

Expected: zero errors.

- [ ] **Step 4: Verify in the browser**

```bash
npm run dev
```

Drop a pin on London. Tilt the camera (right-click drag on desktop). You should see:
- Extruded buildings in dark blue-grey
- A coloured arc floating above the pin (amber for golden hour, white for midday, blue for blue hour)
- A small yellow sphere on the arc indicating the current time

- [ ] **Step 5: Commit**

```bash
git add src/map/layers/sunPathLayer.ts src/map/MapLibreView.tsx
git commit -m "feat(map): add Three.js sun path arc as MapLibre custom WebGL layer

The arc samples the sun's position every 5 minutes across the day
using SunCalc and colours each segment by phase (blue → amber → white
→ amber → blue). A sphere marks the current time-of-day position.

Three.js shares MapLibre's WebGL context via CustomLayerInterface so
buildings correctly occlude the arc through the shared depth buffer.
The coordinate transform (rotateX(PI/2) + scale(s,-s,s)) converts
Three.js Y-up space to MapLibre's mercator space."
```

---

## Task 7: Time slider in Controls + wire `timeMinutes` in App

Adds a time-of-day range input to the Controls bar, wires `timeMinutes` state in App, and passes it down to MapLibreView.

**Files:**
- Modify: `src/components/Controls.tsx`
- Modify: `src/components/Controls.module.css`
- Modify: `src/App.tsx`

- [ ] **Step 1: Extend `Controls` props and add the slider**

In `src/components/Controls.tsx`, extend `ControlsProps`:

```ts
type ControlsProps = {
  date: string;
  onDateChange: (iso: string) => void;
  displayMode: DisplayMode;
  onDisplayModeChange: (mode: DisplayMode) => void;
  pinZone: string;
  hideDisplayMode?: boolean;
  // ── New ──────────────────────────────────────────────────────────────
  /** Current time of day in minutes (0–1439). */
  timeMinutes: number;
  /** Called when the user drags the slider. */
  onTimeMinutesChange: (minutes: number) => void;
  /** The "live" time (from useTimeOfDay). Used to show the live indicator. */
  liveMinutes: number;
};
```

Add a helper to format minutes as HH:mm:

```ts
function minutesToLabel(minutes: number): string {
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}
```

Add the slider below the preset buttons group, before the display-mode select group:

```tsx
<div className={styles.group}>
  <label className={styles.label} htmlFor="solux-time">Time</label>
  <span
    className={styles.liveDot}
    title={Math.abs(timeMinutes - liveMinutes) <= 1 ? 'Live' : 'Manual'}
    aria-label={Math.abs(timeMinutes - liveMinutes) <= 1 ? 'Live time' : 'Manual time'}
    data-live={Math.abs(timeMinutes - liveMinutes) <= 1}
  />
  <input
    id="solux-time"
    type="range"
    min={0}
    max={1439}
    step={1}
    value={timeMinutes}
    onChange={(e) => onTimeMinutesChange(Number(e.target.value))}
    className={styles.timeSlider}
    aria-label={`Time of day: ${minutesToLabel(timeMinutes)}`}
  />
  <span className={styles.timeLabel}>{minutesToLabel(timeMinutes)}</span>
</div>
```

- [ ] **Step 2: Add slider styles to `Controls.module.css`**

Append to `src/components/Controls.module.css`:

```css
/* ── Time slider ─────────────────────────────────────────────── */
.timeSlider {
  width: 120px;
  accent-color: var(--accent);
  cursor: pointer;
  /* Prevent iOS from zooming the page on touch */
  touch-action: none;
}

.timeLabel {
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--fg-muted);
  min-width: 36px;
  text-align: right;
}

/* A small dot that glows amber when displaying the live (current) time,
 * and dims when the slider has been manually moved away from now. */
.liveDot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--fg-faint);
  flex-shrink: 0;
  transition: background 200ms;
}
.liveDot[data-live='true'] {
  background: var(--accent);
  box-shadow: 0 0 4px var(--accent);
}

@media (max-width: 640px) {
  .timeSlider {
    width: 90px;
  }
}
```

- [ ] **Step 3: Wire `timeMinutes` in `App.tsx`**

Add imports at the top of `App.tsx`:

```ts
import { useTimeOfDay } from './hooks/useTimeOfDay';
import { startOfDay } from 'date-fns';
import { toZonedTime, fromZonedTime } from 'date-fns-tz';
import { isoDateToNoonUtc } from './solar/calc';
```

After `const zone = useTimezone(pin);`, add:

```ts
// Live minutes in the pin's timezone; used as default for timeMinutes
// and to show the live indicator dot on the slider.
const liveMinutes = useTimeOfDay(pin ? zone : browserZone());

// timeMinutes is initialised from liveMinutes and is updated both by the
// 60-second tick (via liveMinutes) and by slider drags. After a drag,
// the next tick from useTimeOfDay will snap it back to the real time.
const [timeMinutes, setTimeMinutes] = useState(liveMinutes);
useEffect(() => {
  setTimeMinutes(liveMinutes);
}, [liveMinutes]);

// The start of the day in the pin's local timezone, expressed as a UTC Date.
// This is the reference instant used to sample the arc (minute 0 = local midnight).
const dayStartUtc = useMemo<Date | null>(() => {
  if (!pin || !effectiveDate) return null;
  const noonUtc    = isoDateToNoonUtc(effectiveDate);
  const localNoon  = toZonedTime(noonUtc, zone);
  const localMidnight = startOfDay(localNoon);
  return fromZonedTime(localMidnight, zone);
}, [effectiveDate, zone, pin]);
```

Pass the new props to `MapLibreView`:

```tsx
<MapLibreView
  pin={pin}
  onPin={setPin}
  popupContent={popupContent}
  solarTimes={solarTimes}
  dayStartUtc={dayStartUtc}
  timeMinutes={timeMinutes}
/>
```

Pass the new props to `Controls`:

```tsx
<Controls
  date={effectiveDate}
  onDateChange={setDate}
  displayMode={displayMode}
  onDisplayModeChange={setDisplayMode}
  pinZone={pin ? zone : browserZone()}
  hideDisplayMode={isMobile}
  timeMinutes={timeMinutes}
  onTimeMinutesChange={setTimeMinutes}
  liveMinutes={liveMinutes}
/>
```

- [ ] **Step 4: Type-check + test**

```bash
npx tsc -b
npm test
```

Expected: zero type errors; all tests pass.

- [ ] **Step 5: Verify in the browser**

```bash
npm run dev
```

1. Drop a pin. A time slider appears in the controls bar with a glowing amber dot.
2. The sun sphere sits on the arc at the current local time.
3. Drag the slider — the sphere moves along the arc. The dot dims.
4. Wait 60 seconds — the sphere snaps back to the current time and the dot glows again.

- [ ] **Step 6: Commit**

```bash
git add src/components/Controls.tsx src/components/Controls.module.css src/App.tsx
git commit -m "feat(controls): add time-of-day slider with live indicator

Adds a range input (0–1439 minutes) below the date presets. The amber
dot indicates when the slider tracks real time; it dims on manual
override and snaps back after the next 60-second tick. The sphere on
the 3D arc updates immediately on drag."
```

---

## Task 8: Update documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`

- [ ] **Step 1: Update `AGENTS.md`**

Update the stack description and the file tree. The relevant sections to change:

In the **Commands** section, no change.

In the **Architecture** block, replace the `MapView.tsx` line:

```
    MapView.tsx         Leaflet map, click-to-pin, SVG marker
```

With:

```
    map/
      MapLibreView.tsx    MapLibre GL JS map, click-to-pin, 3D buildings, arc layer
      arcGeometry.ts      Pure functions: sun→XYZ, phase classification, arc samples
      arcGeometry.test.ts
      layers/
        sunPathLayer.ts   Three.js CustomLayerInterface: arc tube + sphere
```

In the stack table comment at the top of the file (or add one if missing), update:

```
Map: MapLibre GL JS + OpenFreeMap vector tiles (3D buildings + sun path arc)
Three.js: custom WebGL layer inside MapLibre's rendering context
```

In the **Key conventions** section, add after the mobile layout block:

```
**3D arc layer**
`sunPathLayer.ts` shares MapLibre's WebGL context via `CustomLayerInterface`.
Never call `renderer.setSize()` or `renderer.autoClear = true` — MapLibre owns
the canvas and clearing it destroys the base map. Always call
`renderer.resetState()` at the start of each `render()` callback to restore
Three.js's state assumptions.

**Arc vs. horizon pipeline**
`arcGeometry.ts` uses raw `SolarTimes` (not `effectiveTimes`) for phase
classification, because the arc represents the geometric sun path regardless of
building obstruction. `effectiveTimes` is still used in `SolarInfo` to show
adjusted clock times.
```

- [ ] **Step 2: Update `README.md`**

Replace the Stack table row for Map:

```markdown
| Map | MapLibre GL JS + OpenFreeMap (vector tiles, no API key) |
| 3D / sun path | Three.js (custom WebGL layer inside MapLibre) |
```

Update the Features list to mention the 3D features and the time slider. Add after "Mobile-first":

```markdown
- **3D buildings** — OpenFreeMap vector tiles extrude nearby buildings in 3D; you can tilt and rotate the map freely
- **Sun path arc** — a coloured 3D arc floats above the pin, showing the sun's path from horizon to horizon; segments are tinted by phase (blue hour → amber → white → amber → blue hour)
- **Time slider** — drag to any time of day to see where the sun will be; a live indicator dot shows when it's tracking the real current time
```

Update the test count in the Getting started section (add 3 new tests: 1 useTimeOfDay + N arcGeometry).

- [ ] **Step 3: Run final verification**

```bash
npm test
npm run build
```

Expected: all tests pass; production build succeeds with zero TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md
git commit -m "docs: update AGENTS.md and README for MapLibre + 3D arc"
```

---

## Self-review checklist

### Spec coverage

| Spec requirement | Task |
|---|---|
| Replace Leaflet with MapLibre GL JS | Task 4 |
| OpenFreeMap tiles, no API key | Task 4 |
| 3D building extrusions | Task 5 |
| Three.js arc via CustomLayerInterface | Task 6 |
| Arc coloured by phase | Tasks 3 + 6 |
| Sun sphere at current time | Task 6 |
| Live time update every 60 s | Task 2 |
| Time slider in Controls | Task 7 |
| Live indicator dot | Task 7 |
| All existing tests unmodified | Tasks 1–8 (verified each task) |
| `npm run build` clean | Task 8 |

### Type consistency check

- `ArcSample.xM / yM / zM` defined in Task 3, consumed in Task 6 ✓
- `SunPathLayerHandle.setTimeMinutes(minutes: number)` defined in Task 6, called in Task 6 (arc effect) and Task 7 (timeMinutes effect) ✓
- `MapLibreViewProps.solarTimes?: SolarTimes | null` — `SolarTimes` is imported from `../types` in both `MapLibreView.tsx` and `sunPathLayer.ts` ✓
- `dayStartUtc` is `Date | null` in App, accepted as `Date | null` in MapLibreView props, typed `Date` in `sunPathLayer.ts` (guarded by `if (!dayStartUtc)`) ✓
- `useTimeOfDay` returns `number`; `liveMinutes` is `number`; `timeMinutes` state is `number` ✓

### Placeholder scan

No TBDs, TODOs, or "implement later" phrases found in the plan.
