// Flat ESLint config for the Vite + React + TypeScript app.
//
// Rule sources, in order:
//   - @eslint/js recommended        → core JS correctness
//   - typescript-eslint recommended → TS-aware correctness
//   - react-hooks recommended       → Rules of Hooks
//   - react-refresh (Vite preset)   → keep components Fast-Refresh-safe
//   - eslint-config-prettier LAST   → disable stylistic rules that would
//     fight Prettier, so formatting is exclusively Prettier's job.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  // Generated output, dependencies, scratch files, and build metadata are
  // never linted.
  {
    ignores: [
      'dist/',
      'node_modules/',
      'tmp/',
      'playwright-report/',
      'coverage/',
      '**/*.tsbuildinfo',
    ],
  },

  // Application + test source: browser runtime, TS-aware rules.
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs['recommended-latest'].rules,
      ...reactRefresh.configs.vite.rules,
      // react-hooks 7 promotes the React-Compiler-oriented
      // `set-state-in-effect` rule to an error. This codebase intentionally
      // uses setState inside effects to re-synchronise state when a dependency
      // changes — e.g. re-reading matchMedia on query change (useMediaQuery),
      // re-clocking on zone change (useTimeOfDay), resetting to idle when the
      // pin clears (useHorizon), and snapping the slider back on each tick
      // (App). These are correct external-sync patterns, not bugs, so we keep
      // the rule advisory (warn) — matching how `exhaustive-deps` ships —
      // rather than failing CI or restructuring correct code.
      'react-hooks/set-state-in-effect': 'warn',
    },
  },

  // Node-context config files (Vite, Vitest, Playwright, ESLint itself) run
  // under Node globals rather than the browser.
  {
    files: ['*.config.{js,ts}', 'playwright.config.ts', 'e2e/**/*.ts'],
    languageOptions: {
      globals: globals.node,
    },
  },

  prettier,
);
