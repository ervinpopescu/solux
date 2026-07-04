# CI pipeline — design

**Date:** 2026-07-04
**Status:** Approved (pending spec review)
**Repo:** `ervinpopescu/solux` (GitHub)

## Goal

Add a GitHub Actions CI pipeline that guards `main` and every pull
request with the full quality gate: linting, formatting, type checking,
unit tests, and end-to-end tests. The project currently has no CI, no
linter, and no Playwright tests, so this spec covers introducing those
tools in addition to wiring the workflow.

## Scope

In scope:

- A single `.github/workflows/ci.yml` workflow.
- ESLint (flat config) + Prettier setup, with existing violations fixed
  so `main` starts green.
- Playwright end-to-end tests covering core user flows, with external
  network calls mocked for determinism.
- Node version pinned via `.nvmrc`.

Out of scope (TODO for later):

- Deployment / release automation.
- Coverage reporting and thresholds.
- Visual-regression (pixel) testing of the map.

## Decisions

These were settled during brainstorming:

- **Pipeline coverage:** full — build + unit tests + lint + e2e.
- **E2e depth:** core flows (not just a smoke test, not config-only).
- **Lint tooling:** ESLint + Prettier (not Biome, not ESLint-only).
- **Node version:** 24, pinned in `.nvmrc` to match the local dev
  environment.
- **Lint strictness:** `typescript-eslint` recommended ruleset, with all
  existing violations fixed now rather than starting lenient.

## Triggers & runtime

The workflow runs on:

- `push` to `main`
- `pull_request` targeting `main`

All jobs use `actions/setup-node` reading `.nvmrc`, with npm caching
enabled, and install via `npm ci` for deterministic, lockfile-exact
installs.

## Job structure

Three jobs so that a failure in one area does not mask another and the
fast checks return quickly:

| Job    | Purpose                        | Steps                                             |
| ------ | ------------------------------ | ------------------------------------------------- |
| `lint` | Style + formatting             | `npm run lint`, `npm run format:check`            |
| `test` | Type safety + unit correctness | `npx tsc -b`, `npm run test`                      |
| `e2e`  | Core user flows                | `npm run build`, then Playwright against the preview server |

`lint` and `test` are independent and run in parallel. `e2e` is heavier
(browser download) and runs as its own job with the Playwright browser
binaries cached.

Rationale for including `tsc -b` in the `test` job rather than its own:
type checking and unit tests both validate the source's correctness and
share the same setup; keeping them together avoids a third near-identical
install. It lives in `test` rather than `lint` because a type error is a
correctness failure, not a style one.

## Lint / format setup

New dev dependencies (added via the project's package manager):

- `eslint`, `typescript-eslint`, `@eslint/js`
- `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`
  (the standard Vite + React + TS pairing)
- `prettier`, `eslint-config-prettier` (turns off ESLint rules that
  would fight Prettier)

New files:

- `eslint.config.js` — flat config. `typescript-eslint` recommended
  rules, React Hooks rules, React Refresh rule, `dist/` and config files
  ignored. `eslint-config-prettier` applied last so formatting is
  Prettier's job alone.
- `.prettierrc` (or `prettier.config.js`) — explicit formatting config.
- `.prettierignore` — excludes `dist/`, `node_modules/`, lockfiles,
  `tmp/`.

New `package.json` scripts:

- `lint` — `eslint .`
- `lint:fix` — `eslint . --fix`
- `format` — `prettier --write .`
- `format:check` — `prettier --check .`

**Migration risk:** the codebase has never been linted or
Prettier-formatted, so the first run will surface violations. Plan:
run `lint:fix` and `format` to auto-resolve the mechanical majority,
then manually fix any remaining rule violations so `main` starts green.
This may touch many files; those formatting/lint-fix changes are
expected and reviewed as part of landing this work.

## E2e setup

New files:

- `playwright.config.ts` — starts `vite preview` (serving the production
  `build`) via the `webServer` option, points `baseURL` at it, runs the
  `chromium` project. CI-friendly settings: retries on CI, single worker
  if flakiness appears, trace on first retry.
- `e2e/` directory holding the specs and network fixtures.

New `package.json` scripts:

- `test:e2e` — `playwright test`
- `test:e2e:ui` — `playwright test --ui` (local debugging)

### Network determinism

The app makes three kinds of external request. In e2e they are
intercepted with Playwright `page.route()` so tests never depend on live
services or rate limits:

- **Nominatim** (`nominatim.openstreetmap.org/search`) → a fixed search
  result, so a query deterministically places a known pin.
- **Overpass** (`overpass-api.de/api/interpreter`) → a fixed building
  set, so the shadow/exposure computation is deterministic.
- **Map tiles / style** (`tiles.openfreemap.org`) → blocked or stubbed.
  Assertions target the DOM (search results, pin, exposure badge), not
  rendered map pixels, so tests stay hermetic and fast and do not need
  real tiles.

Fixtures live alongside the specs in `e2e/fixtures/`.

### Flows covered

1. **Place search → pin:** typing a query shows results; selecting one
   drops a pin at the mocked coordinates.
2. **Time-of-day slider → instant:** moving the slider changes the
   evaluated instant (asserted via the reflected time/UI state).
3. **Exposure badge:** with mocked buildings and a controlled instant,
   the exposure badge reflects the computed sun/shadow state.

### Test hooks

Stable selectors are needed for the search input, the results list, the
time-of-day slider, and the exposure badge. Where the existing markup
lacks a stable hook, add minimal `data-testid` attributes to
`SearchBox`, the time-of-day control, and the exposure badge element.
No behavioural changes to those components.

## Success criteria

- `ci.yml` runs on push to `main` and on PRs; all three jobs pass on a
  clean checkout.
- `npm run lint`, `npm run format:check`, `npx tsc -b`, `npm run test`,
  and `npm run test:e2e` all pass locally.
- E2e tests pass with no live network access to Nominatim, Overpass, or
  the tile server.
- `main` is green after the lint/format migration.
