import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';

// Resolve fixture files relative to this module so the paths hold regardless
// of the working directory Playwright is invoked from.
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

/**
 * Intercept every external request the app makes so the tests are hermetic.
 *
 * - Nominatim geocoding → a single fixed London hit, so searching deterministic-
 *   ally drops the pin at a known coordinate.
 * - Overpass buildings → an empty element set, so the horizon is flat and the
 *   sun/shadow result depends only on the (controlled) instant, not live OSM
 *   data.
 * - Map tiles / style → aborted. Assertions target the DOM (search results,
 *   marker, badge), never rendered map pixels, so no tiles are needed.
 *
 * Must be called before `page.goto` so the routes are in place when the app
 * fires its first requests.
 */
export async function mockNetwork(page: Page): Promise<void> {
  await page.route('**/nominatim.openstreetmap.org/search**', (route) =>
    route.fulfill({ path: fixture('nominatim.json'), contentType: 'application/json' }),
  );

  await page.route('**/overpass-api.de/api/interpreter**', (route) =>
    route.fulfill({ path: fixture('overpass.json'), contentType: 'application/json' }),
  );

  await page.route('**/tiles.openfreemap.org/**', (route) => route.abort());
}

/**
 * Set the value of a controlled React `<input type="range">`.
 *
 * A plain `.fill()` or assigning `.value` bypasses React's synthetic event
 * system, so the component's state never updates. We instead call the native
 * value setter React patches over, then dispatch the `input`/`change` events
 * React actually listens for.
 */
export async function setRange(slider: Locator, value: number): Promise<void> {
  await slider.evaluate((el, v) => {
    const input = el as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    setter?.call(input, String(v));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
