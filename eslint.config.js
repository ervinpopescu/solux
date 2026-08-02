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
