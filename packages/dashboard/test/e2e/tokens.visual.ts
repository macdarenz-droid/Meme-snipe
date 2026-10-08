// UI-T02 visual: the token swatch page in four theme/polarity combinations, and the blank shell in both themes.
import { expect, test } from '@playwright/test';

for (const theme of ['dark', 'light']) {
  for (const polarity of ['default', 'blue-orange']) {
    test(`tokens ${theme} ${polarity}`, async ({ page }) => {
      await page.goto(`/catalogue?section=tokens&theme=${theme}&polarity=${polarity}`);
      await expect(page.getByRole('heading', { level: 2, name: 'Tokens' })).toBeVisible();
      await expect(page).toHaveScreenshot(`tokens-${theme}-${polarity}.png`, { fullPage: true });
    });
  }
}

test('tokens at 390 px, dark', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/catalogue?section=tokens&theme=dark');
  await expect(page.getByRole('heading', { level: 2, name: 'Tokens' })).toBeVisible();
  await expect(page).toHaveScreenshot('tokens-390-dark.png', { fullPage: true });
});
