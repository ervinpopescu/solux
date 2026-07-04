import { defineConfig, devices } from '@playwright/test';

// End-to-end tests run against a production build served by `vite preview`,
// so we exercise the same bundle users get rather than the dev server. All
// external network (Nominatim, Overpass, map tiles) is mocked per-test in
// e2e/helpers.ts, so these tests are hermetic and need no API access.

const PORT = 4173;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  // Retry on CI to absorb rare map/WebGL init hiccups; never locally, so a
  // flake is visible immediately.
  retries: process.env.CI ? 2 : 0,
  // The map is heavy; a single worker keeps WebGL contexts from contending on
  // CI runners. Local runs can parallelise.
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // MapLibre GL needs a WebGL context. Headless Chromium only exposes
        // one through SwiftShader, which recent builds gate behind this flag.
        launchOptions: {
          args: ['--use-gl=angle', '--enable-unsafe-swiftshader'],
        },
      },
    },
  ],

  // Build once and serve the static output. The webServer owns the build so a
  // bare `npm run test:e2e` works locally without a separate build step; CI
  // relies on the same command.
  webServer: {
    command: `npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
