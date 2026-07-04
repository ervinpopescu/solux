# Hook test coverage + Codecov — design

**Date:** 2026-07-04
**Status:** Approved
**Repo:** `ervinpopescu/solux` (public)

## Goal

Increase automated test coverage of the untested data hooks and report
coverage to Codecov from CI. Builds on the CI pipeline added earlier
(`2026-07-04-ci-pipeline-design.md`).

## Decisions

- **Test focus:** the six untested hooks only. No component render tests
  (AGENTS.md: don't unit-test rendering; the e2e suite covers those
  flows).
- **Codecov auth:** upload token stored as the `CODECOV_TOKEN` repo
  secret.
- **Coverage gate:** report-only. Codecov comments/statuses on PRs but
  never fails CI.

## Coverage tooling

- Add `@vitest/coverage-v8`.
- Vitest coverage config: provider `v8`, reporters `text` (local) +
  `lcov` (for Codecov), output to `coverage/`.
- Denominator excludes non-logic files: `**/*.d.ts`, `src/main.tsx`,
  `src/types.ts`, `src/test/**`, `src/vite-env.d.ts`, and `e2e/**`.
  Components and map layers remain in the denominator (honest number);
  they are exercised by e2e, not unit tests.
- New script: `test:coverage` → `vitest run --coverage`.
- `coverage/` is git- and Prettier-ignored.

## New hook tests

All use `renderHook` from `@testing-library/react` in the existing jsdom
environment. Tests live beside each hook (`src/hooks/<name>.test.ts`),
matching the project convention.

- **`useTimezone`**, **`useSolarData`**, **`useEffectiveSolarTimes`** —
  pure memo hooks. Assert: null/empty input → null/fallback, valid input
  delegates to the underlying pure function, and the memoized result is
  referentially stable across re-renders with unchanged inputs. Small
  `SolarTimes` / `HorizonProfile` fixtures for the latter two.
- **`useMediaQuery`** — stub `window.matchMedia` (jsdom lacks it) with a
  controllable mock exposing `addEventListener`/`removeEventListener` and
  a dispatchable `change`. Assert initial match reflects the stub and a
  `change` event flips the returned value; listener is removed on
  unmount.
- **`usePrefs`** — assert lazy initialisation from `localStorage`, and
  that `setPin` / `setDate` / `setDisplayMode` update state and persist
  the JSON blob. `localStorage` is available in jsdom.
- **`useHorizon`** — the state machine. `vi.mock` `../buildings/overpass`
  to control `fetchBuildings`. Assert: `idle` for a null pin;
  `loading → ready` on a cache miss that fetches; `ready` immediately
  from a seeded `localStorage` profile; `error` when the fetch rejects
  (non-abort). **Isolation caveat:** the module-scoped `buildingMemo`
  persists across tests in the file, so each test uses a distinct
  coordinate (distinct `memoKey`) — or resets modules — to avoid
  cross-test memo hits. `localStorage` is cleared between tests.

## Codecov integration

- `codecov/codecov-action@v5` step in the `test` CI job, after coverage
  runs. Uploads `coverage/lcov.info` with
  `token: ${{ secrets.CODECOV_TOKEN }}` and `fail_ci_if_error: false`,
  so a missing/invalid token or a transient upload failure never breaks
  CI.
- `codecov.yml` at repo root, report-only:
  `coverage.status.project` and `coverage.status.patch` set
  `informational: true`. Codecov posts status/comment but the check is
  never failing.
- **Manual step (user):** add `CODECOV_TOKEN` as a repo Actions secret
  (value from codecov.io → repo → Settings). Until added, uploads no-op
  and CI stays green.

## CI touch-ups

- `test` job: replace `npm run test` with `npm run test:coverage`, then
  the Codecov upload step.
- Bump `actions/checkout` and `actions/setup-node` from `@v4` to `@v5`
  across all jobs, clearing the Node 20 deprecation warning.

## Success criteria

- `npm run test:coverage` passes locally and emits `coverage/lcov.info`.
- All six hooks have meaningful tests; the hook layer is covered.
- CI `test` job uploads coverage; the run stays green with or without
  the token present.
- No coverage threshold blocks any PR (report-only).
