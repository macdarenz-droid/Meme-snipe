// UI-T01 blank shell in a browser: it renders under the production CSP with no console error, passes axe, and reflows
// at phone widths.
import { expect, test } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll, watchConsole } from './helpers.ts';

test('the blank shell renders under the CSP with no console errors and no axe violations', async ({ page }) => {
  const done = watchConsole(page);
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();
  await expectAccessible(page);
  done();
});

for (const width of [360, 390, 400]) {
  test(`the blank shell has no horizontal scroll at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await page.goto('/');
    await expect(page.getByRole('main')).toBeVisible();
    await expectNoHorizontalScroll(page);
  });
}
