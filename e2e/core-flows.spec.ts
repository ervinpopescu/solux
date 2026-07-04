import { test, expect, type Page } from '@playwright/test';
import { mockNetwork, setRange } from './helpers';

// Core user flows for Solux, run against the production build with all external
// network mocked (see helpers.ts). Assertions target the DOM only, so the map's
// WebGL rendering is never on the critical path.

// Drop a pin by searching for the mocked place and selecting the single hit.
// Shared by the flows that need a pin already on the map.
async function placePin(page: Page): Promise<void> {
  await page.getByRole('searchbox', { name: 'Search for a location' }).fill('London');
  // Scope to the search dropdown's listbox: the display-mode <select> also
  // contributes option-role elements, so a bare getByRole('option') is
  // ambiguous. The result list is debounced (~600ms) then filled from the
  // fixture.
  await page
    .getByRole('listbox')
    .getByRole('option', { name: /London/ })
    .click();
  await expect(page.getByTestId('map-pin')).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await mockNetwork(page);
  await page.goto('/');
});

test('search selects a place and drops a pin', async ({ page }) => {
  // Search results live in the dropdown's listbox; scope to it so the
  // display-mode <select>'s options don't count as matches.
  const search = page.getByRole('searchbox', { name: 'Search for a location' });
  const results = page.getByRole('listbox').getByRole('option');

  // Typing fewer than 3 chars must not fire a search (no listbox appears).
  await search.fill('Lo');
  await expect(results).toHaveCount(0);

  await search.fill('London');
  const option = results.filter({ hasText: 'London' });
  await expect(option).toBeVisible();

  await option.click();
  await expect(page.getByTestId('map-pin')).toBeVisible();
});

test('time-of-day slider updates the reflected instant', async ({ page }) => {
  await placePin(page);

  const slider = page.getByRole('slider');
  const label = page.getByTestId('time-label');

  await setRange(slider, 0);
  await expect(label).toHaveText('00:00');

  await setRange(slider, 720);
  await expect(label).toHaveText('12:00');

  await setRange(slider, 1439);
  await expect(label).toHaveText('23:59');
});

test('exposure badge reflects the computed sun/shadow state', async ({ page }) => {
  await placePin(page);

  // Pin the date so the sun geometry is deterministic regardless of run date.
  // 2024-06-20 is midsummer: London noon sun is high, midnight is well down.
  await page.getByLabel('Date').fill('2024-06-20');

  const slider = page.getByRole('slider');
  const badge = page.getByTestId('exposure-badge');

  // Local midnight → sun below the horizon.
  await setRange(slider, 0);
  await expect(badge).toHaveText('☾ Sun down');

  // Local noon → sun well above the (empty) building horizon → sunlit.
  await setRange(slider, 720);
  await expect(badge).toHaveText('☀ In sun');
});
