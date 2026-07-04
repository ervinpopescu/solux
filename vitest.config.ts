import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // Only collect unit tests under src. Without this, Vitest's default glob
    // also picks up the Playwright specs in e2e/ (*.spec.ts) and fails trying
    // to run them under its own runner.
    include: ['src/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      // text for local runs, lcov for the Codecov upload in CI.
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      // Coverage measures the unit-testable logic layer. Excluded:
      //   - test/entry/type-only files (no runtime logic to cover)
      //   - React components — AGENTS.md says don't unit-test rendering; the
      //     e2e suite exercises these flows instead
      //   - the map view + WebGL custom layers — need a real GL context, so
      //     they're impractical to unit-test and are covered by e2e
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'src/main.tsx',
        'src/types.ts',
        'src/test/**',
        'src/App.tsx',
        'src/components/**',
        'src/map/MapLibreView.tsx',
        'src/map/layers/**',
      ],
    },
  },
});
