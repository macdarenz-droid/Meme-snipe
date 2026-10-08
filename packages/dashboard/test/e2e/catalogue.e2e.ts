// The component catalogue in a browser (UI-T01 onwards): every section renders under the CSP with no console error,
// passes axe, and has no horizontal scroll at phone widths (owner: every primitive works at 360-400 px).
import { expect, test } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll, watchConsole } from './helpers.ts';

test('the catalogue renders under the CSP with no console errors and no axe violations', async ({ page }) => {
  const done = watchConsole(page);
  await page.goto('/catalogue');
  await expect(page.getByRole('heading', { level: 1, name: 'Catalogue' })).toBeVisible();
  await expectAccessible(page);
  done();
});

for (const width of [360, 400]) {
  test(`the catalogue has no horizontal scroll at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/catalogue');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
}
