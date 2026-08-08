import { expect, test, type Locator, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { setRange } from './helpers';

const PIN = { lat: 44.4064076, lng: 26.1096245 };
const TILE_PATH = fileURLToPath(new URL('./fixtures/tineretului-buildings.pbf', import.meta.url));
const STYLE_PATH = fileURLToPath(new URL('./fixtures/tineretului-style.json', import.meta.url));

type Gate = { promise: Promise<void>; release: () => void };

function gate(): Gate {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function prepareTineretului(page: Page): Promise<void> {
  await page.addInitScript((pin) => {
    localStorage.setItem(
      'solux:prefs:v1',
      JSON.stringify({ pin, date: '2024-06-20', displayMode: 'card' }),
    );
  }, PIN);

  await page.route('**/tiles.openfreemap.org/styles/liberty', (route) =>
    route.fulfill({ path: STYLE_PATH, contentType: 'application/json' }),
  );
  await page.route('**/tiles.openfreemap.org/e2e/**/*.pbf', (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/15/18760/11863.pbf')) {
      return route.fulfill({ path: TILE_PATH, contentType: 'application/x-protobuf' });
    }
    return route.fulfill({ body: '', contentType: 'application/x-protobuf' });
  });
}

function denseRefinement(): { elements: unknown[] } {
  const treeCount = 5_200;
  const elements: unknown[] = [
    {
      type: 'way',
      tags: { building: 'yes', height: '16' },
      geometry: [
        { lat: PIN.lat - 0.0002, lon: PIN.lng - 0.0002 },
        { lat: PIN.lat - 0.0002, lon: PIN.lng + 0.0002 },
        { lat: PIN.lat + 0.0002, lon: PIN.lng + 0.0002 },
        { lat: PIN.lat + 0.0002, lon: PIN.lng - 0.0002 },
      ],
    },
  ];
  for (let index = 0; index < treeCount; index++) {
    const angle = (index * 2 * Math.PI) / treeCount;
    const radius = 0.0003 + (index % 30) * 0.00001;
    elements.push({
      type: 'node',
      lat: PIN.lat + Math.cos(angle) * radius,
      lon: PIN.lng + Math.sin(angle) * radius,
      tags: { natural: 'tree', height: String(8 + (index % 10)) },
    });
  }
  return { elements };
}

async function waitForTileDraw(map: Locator): Promise<number> {
  await expect(map).toHaveAttribute('data-shadow-source', 'tiles', { timeout: 5_000 });
  await expect
    .poll(async () => {
      const selected = Number(await map.getAttribute('data-shadow-vertices'));
      const drawn = Number(await map.getAttribute('data-shadow-draw-vertices'));
      return selected > 0 && drawn === selected ? drawn : 0;
    })
    .toBeGreaterThan(0);
  return Number(await map.getAttribute('data-shadow-casters'));
}

async function openAtNoon(page: Page): Promise<Locator> {
  await page.goto('/');
  await setRange(page.getByRole('slider'), 720);
  return page.getByTestId('shadow-map');
}

test('tile draw occurs before failed Overpass refinement and remains visible', async ({ page }) => {
  await prepareTineretului(page);
  const overpassGate = gate();
  let overpassCompleted = false;
  await page.route('**/*overpass*/**/interpreter**', async (route) => {
    await overpassGate.promise;
    overpassCompleted = true;
    await route.fulfill({ status: 504, body: 'gateway timeout' });
  });

  const map = await openAtNoon(page);
  const tileCasterCount = await waitForTileDraw(map);
  expect(overpassCompleted).toBe(false);
  overpassGate.release();

  await expect(page.getByText(/Could not fetch nearby obstructions/)).toBeVisible();
  await expect(map).toHaveAttribute('data-shadow-source', 'tiles');
  expect(Number(await map.getAttribute('data-shadow-casters'))).toBe(tileCasterCount);
});

test('dense Overpass data refines only after tile draw and exceeds the render budget', async ({
  page,
}) => {
  await prepareTineretului(page);
  const overpassGate = gate();
  await page.route('**/*overpass*/**/interpreter**', async (route) => {
    await overpassGate.promise;
    await route.fulfill({
      body: JSON.stringify(denseRefinement()),
      contentType: 'application/json',
    });
  });

  const map = await openAtNoon(page);
  const tileCount = await waitForTileDraw(map);
  overpassGate.release();

  await expect(map).toHaveAttribute('data-shadow-source', 'refined', { timeout: 8_000 });
  expect(Number(await map.getAttribute('data-shadow-remote-casters'))).toBeGreaterThan(5_000);
  expect(Number(await map.getAttribute('data-shadow-casters'))).toBeGreaterThan(tileCount);
  expect(Number(await map.getAttribute('data-shadow-vertices'))).toBeLessThanOrEqual(360_000);
  expect(Number(await map.getAttribute('data-shadow-bytes'))).toBeLessThanOrEqual(4_320_000);
  expect(Number(await map.getAttribute('data-shadow-trees'))).toBeGreaterThan(0);
  expect(Number(await map.getAttribute('data-shadow-dropped-trees'))).toBeGreaterThan(0);
});

test('successful empty Overpass response retains tile shadows', async ({ page }) => {
  await prepareTineretului(page);
  const overpassGate = gate();
  await page.route('**/*overpass*/**/interpreter**', async (route) => {
    await overpassGate.promise;
    await route.fulfill({
      body: JSON.stringify({ elements: [] }),
      contentType: 'application/json',
    });
  });

  const map = await openAtNoon(page);
  const tileCount = await waitForTileDraw(map);
  overpassGate.release();

  await expect(page.getByText(/Adjusted for/)).toBeVisible();
  await expect(map).toHaveAttribute('data-shadow-source', 'tiles');
  expect(Number(await map.getAttribute('data-shadow-remote-casters'))).toBe(0);
  expect(Number(await map.getAttribute('data-shadow-casters'))).toBe(tileCount);
});
