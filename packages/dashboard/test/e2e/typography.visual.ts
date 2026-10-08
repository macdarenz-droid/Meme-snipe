// UI-T03 visual: the typography specimen and the number gallery in both themes, and the gallery at 390 px.
import { expect, test } from '@playwright/test';

for (const section of ['typography', 'numbers']) {
  for (const theme of ['dark', 'light']) {
    test(`${section} ${theme}`, async ({ page }) => {
      await page.goto(`/catalogue?section=${section}&theme=${theme}`);
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator(`#${section}`)).toBeVisible();
      await expect(page).toHaveScreenshot(`${section}-${theme}.png`, { fullPage: true });
    });
  }
}

test('numbers at 390 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/catalogue?section=numbers&theme=dark');
  await page.evaluate(() => document.fonts.ready);
  await expect(page).toHaveScreenshot('numbers-390-dark.png', { fullPage: true });
});
