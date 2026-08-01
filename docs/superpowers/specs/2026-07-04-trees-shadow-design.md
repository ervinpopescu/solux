# Trees as Shadow Generators — Design Spec

**Date:** 2026-07-04
**Branch:** feature/3d-map
**Status:** Approved

---

## Problem

The Overpass fetch currently only retrieves `way["building"]` features. Vegetation
(single trees, wooded areas, forests) is explicitly excluded, even though tall trees
can obstruct sunlight just as meaningfully as buildings. This spec adds trees to the
shadow-generator pipeline alongside buildings.

---

## Approach: Unified `Obstruction` type

A single Overpass query fetches buildings and trees together. Both are parsed into a
common `Obstruction` type (renamed from `Building`) with a `kind` discriminator. All
downstream code — the horizon builder, shadow geometry, WebGL layer — is unchanged
because it only cares about polygon + height. Only the counts exposed in
`HorizonProfile` and the UI label are extended.

---

## 1. Types (`src/types.ts`)

### `Obstruction` (replaces `Building`)

```ts
export type Obstruction = {
  kind: 'building' | 'tree';
  geometry: LatLng[];       // closed polygon; synthesized circle for point trees
  heightMeters: number;
  heightFromTag: boolean;
};
```

### `HorizonProfile` — added field

```ts
treeCount: number;  // alongside existing buildingCount
```

All existing callsites that reference `Building` receive a mechanical rename to
`Obstruction`.

---

## 2. Overpass fetch (`src/buildings/overpass.ts`)

### Query

One combined query (single round-trip):

```
[out:json][timeout:25];
(
  way["building"](around:R,LAT,LNG);
  node["natural"="tree"](around:R,LAT,LNG);
  way["natural"="wood"](around:R,LAT,LNG);
  way["landuse"="forest"](around:R,LAT,LNG);
);
out geom;
```

The public function is renamed `fetchObstructions`; `parseBuildings` becomes
`parseObstructions`.

### Parsing

Each element is routed by its tags:

| Element | Tags | Output |
|---------|------|--------|
| `way` | `building=*` | existing `deriveHeight` logic → `kind: 'building'` |
| `node` | `natural=tree` | `deriveTreeHeight` → synthesize 8-vertex canopy polygon → `kind: 'tree'` |
| `way` | `natural=wood` or `landuse=forest` | `deriveTreeHeight` → polygon from `geometry` → `kind: 'tree'` |

### `deriveTreeHeight(tags, featureKind)`

Priority:

1. `height` tag (explicit metres) → `heightFromTag: true`
2. `species` / `taxon` lookup table (~20 common species). Matching is a
   **case-insensitive prefix match on the genus** (first whitespace-delimited
   token of the tag value). E.g. `"Quercus robur"`, `"quercus"`, and
   `"QUERCUS SPP."` all match the oak entry.

   | Species | Height (m) |
   |---------|-----------|
   | Quercus (oak) | 20 |
   | Pinus (pine) | 25 |
   | Betula (birch) | 15 |
   | Acer (maple) | 15 |
   | Fagus (beech) | 25 |
   | Tilia (linden/lime) | 20 |
   | Fraxinus (ash) | 20 |
   | Populus (poplar) | 28 |
   | Salix (willow) | 10 |
   | Platanus (plane) | 25 |
   | Prunus (cherry/plum) | 8 |
   | Malus (apple) | 6 |
   | Robinia | 15 |
   | Eucalyptus | 30 |
   | Phoenix (palm) | 10 |
   | Cocos (coconut palm) | 25 |
   | Cedrus (cedar) | 30 |
   | Picea (spruce) | 25 |
   | Abies (fir) | 30 |
   | Larix (larch) | 25 |

   Returns `heightFromTag: true` (the species is a real datum, not a guess).

3. Global fallback: **12 m** for `node` (single street tree), **18 m** for `way`
   (wooded area) → `heightFromTag: false`

### Canopy synthesis for point trees

Single `natural=tree` nodes are points. We synthesize an 8-vertex regular polygon
(octagon) centred on the trunk:

- Radius = `parseFloat(crown_diameter) / 2` if the tag is present (handles
  values like `"8 m"` the same way building `height` does)
- Otherwise = `heightMeters * 0.25` (rough crown-spread heuristic)

8 vertices is sufficient; the horizon sampler walks edges densely anyway.

---

## 3. Horizon builder (`src/buildings/horizon.ts`)

`buildHorizonProfile` accepts `Obstruction[]`. The edge-sampling loop is unchanged.
The only addition is splitting the count:

```ts
let buildingCount = 0, treeCount = 0;
for (const o of obstructions) {
  if (o.kind === 'building') buildingCount++;
  else treeCount++;
  // … existing edge-sampling …
}
return { …, buildingCount, treeCount };
```

---

## 4. Cache (`src/buildings/cache.ts`)

- `Serialized` gains `treeCount: number`
- Cache prefix bumped **`v2` → `v3`** to discard old profiles that lack `treeCount`
  and were built without tree data

---

## 5. `useHorizon` hook (`src/hooks/useHorizon.ts`)

- `buildings: Building[] | null` → `obstructions: Obstruction[] | null`
- `buildingMemo` → `obstructionMemo`
- `fetchBuildings` → `fetchObstructions`
- Logic (abort-controller, fast-path, profile save) is structurally identical

---

## 6. Shadow layer + map view

- `prepareShadowBuildings` → `prepareShadowObstructions`, accepts `Obstruction[]`
- `shadowLayer.ts` and `shadowGeometry.ts` — no changes; they only see
  `ShadowBuilding` (local-metre ring + earcut indices)

---

## 7. UI (`src/components/SolarInfo.tsx`, `src/map/MapLibreView.tsx`)

The obstruction count label is updated to distinguish trees from buildings:

- "12 buildings, 3 trees" when both present
- "12 buildings" or "3 trees" when only one kind present
- No label when both zero

The `formatExposure` pin-badge hover title is updated to cover "buildings and/or
trees" when appropriate.

---

## 8. Testing

### `src/buildings/overpass.test.ts`

New cases for `parseObstructions`:
- `node` with explicit `height` → correct canopy polygon + height, `kind: 'tree'`
- `node` with known `species` → species-lookup height, `heightFromTag: true`
- `node` with no relevant tags → fallback 12 m, `heightFromTag: false`
- `way["natural"="wood"]` → polygon as-is, fallback 18 m
- `way["landuse"="forest"]` with `height=25` → exact height
- Mixed elements → correct `kind` on each output record

### `src/buildings/horizon.test.ts`

- Existing tests updated for `Obstruction` type
- New: mixed building + tree obstructions → correct `buildingCount` and `treeCount`

### `src/buildings/effective.test.ts`, `src/hooks/useHorizon.test.ts`

Mechanical updates: `Building` → `Obstruction`, fixture data adapted. No logic changes.

---

## Out of scope

- OSM relation features (multi-polygon forests) — same exclusion as multi-polygon buildings
- Seasonal tree height variation (deciduous canopy loss in winter)
- Per-tree shadow colour differentiation (both use the same shadow wash)
