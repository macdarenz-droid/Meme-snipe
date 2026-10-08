// UI-T05 universal states in a browser: loading timing on the real clock (acceptances 1 and 2), the stale risk panel
// (acceptance 3), replay freshness on the simulation clock (acceptance 4), polite announcements and one alert for a
// lost connection, axe in both themes, and reflow at phone width.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll, watchConsole } from './helpers.ts';

const open = async (page: Page, query: string): Promise<void> => {
  await page.goto(`/catalogue?${query}`);
  await page.evaluate(() => document.fonts.ready);
};

test('acceptance 1: a request that resolves in 150 ms flashes no skeleton', async ({ page }) => {
  await open(page, 'section=states');
  const timing = page.getByRole('region', { name: 'Timing demo' });
  const flashed = await page.evaluate(() => {
    const region = document.querySelector('[aria-label="Timing demo"]') as HTMLElement;
    let seen = false;
    new MutationObserver(() => { if (region.querySelector('.skeleton') !== null) seen = true; }).observe(region, { childList: true, subtree: true });
    (window as unknown as { skeletonSeen: () => boolean }).skeletonSeen = () => seen;
    return seen;
  });
  expect(flashed).toBe(false);
  await page.getByRole('button', { name: 'Load in 150 ms' }).click();
  await expect(timing).toHaveText('Loaded');
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as unknown as { skeletonSeen: () => boolean }).skeletonSeen())).toBe(false);
  await expect(page.locator('output[data-shown-at]')).toHaveAttribute('data-shown-at', '');
});

test('acceptance 2: a request that resolves in 250 ms shows the skeleton from 200 ms to at least 600 ms', async ({ page }) => {
  await open(page, 'section=states');
  await page.getByRole('button', { name: 'Load in 250 ms' }).click();
  const out = page.locator('output[data-shown-at]');
  await expect(out).not.toHaveAttribute('data-hidden-at', '');
  const shown = Number(await out.getAttribute('data-shown-at'));
  const hidden = Number(await out.getAttribute('data-hidden-at'));
  expect(shown).toBeGreaterThanOrEqual(200);
  expect(shown).toBeLessThan(300);
  expect(hidden).toBeGreaterThanOrEqual(600);
  expect(hidden - shown).toBeGreaterThanOrEqual(400);
  await expect(page.getByRole('region', { name: 'Timing demo' })).toHaveText('Loaded');
});

test('acceptance 3: VM-12 data 6 s old shows Stale · 6s and disables raising a limit with the reason', async ({ page }) => {
  await open(page, 'section=states');
  const panel = page.locator('.panel');
  await expect(panel.locator('.freshness__text')).toHaveText('Stale · 6s');
  await expect(panel.getByRole('alert')).toContainText('Risk status unknown');
  const raise = panel.getByRole('button', { name: 'Raise limit' });
  await expect(raise).toHaveAttribute('aria-disabled', 'true');
  await expect(raise).toHaveAccessibleDescription('Risk status is stale');
  await raise.focus();
  await expect(page.getByRole('tooltip').filter({ hasText: 'Risk status is stale' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Lower limit' })).not.toHaveAttribute('aria-disabled', 'true');
});

test('acceptance 4: replay data freshness follows the simulation clock while the connection uses the wall clock', async ({ page }) => {
  await open(page, 'section=states');
  const replay = page.locator('.demo').filter({ has: page.getByRole('heading', { name: 'Replay' }) });
  await expect(replay.locator('.freshness__text')).toHaveText('Live · 1s');
  await expect(replay.locator('.connection')).toContainText('Reconnecting · attempt 1 · next in 2s');
});

test('state changes are polite status messages; a lost connection is one alert whose details are outside it', async ({ page }) => {
  await open(page, 'section=states');
  await expect(page.getByRole('status').filter({ hasText: 'Risk limits: stale' })).toHaveCount(2);
  const banner = page.locator('.state--disconnected .banner');
  await expect(banner.getByRole('alert')).toHaveText('Disconnected from bot');
  await expect(banner.locator('.banner__body')).toContainText('reconnecting (attempt 3, next in 4s)');
  await expect(banner.locator('.banner__body')).not.toHaveAttribute('role');
});

for (const theme of ['dark', 'light']) {
  test(`axe: every state passes (${theme})`, async ({ page }) => {
    const done = watchConsole(page);
    await open(page, `section=states&theme=${theme}`);
    await expectAccessible(page);
    done();
  });
}

test('the states reflow at 360 px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page, 'section=states');
  await expectNoHorizontalScroll(page);
});
