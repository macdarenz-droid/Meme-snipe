// UI-T05 visual: every state (state views, skeletons with motion reduced, freshness, connection, risk panel) in both
// themes, and at 390 px.
import { expect, test } from '@playwright/test';

for (const theme of ['dark', 'light']) {
  test(`states ${theme}`, async ({ page }) => {
    await page.goto(`/catalogue?section=states&theme=${theme}`);
    await page.evaluate(() => document.fonts.ready);
    await expect(page).toHaveScreenshot(`states-${theme}.png`, { fullPage: true });
  });
}

test('states at 390 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/catalogue?section=states&theme=dark');
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot('states-390-dark.png', { fullPage: true });
});
