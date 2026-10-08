// UI-T01 visual baseline of the blank shell at the desktop and phone sizes, in both themes (UI.md common Definition of
// done 3). The app follows the OS colour scheme (theme System, UI-T02).
import { expect, test } from '@playwright/test';

for (const scheme of ['dark', 'light'] as const) {
  for (const [w, h] of [[1440, 900], [390, 844]] as const) {
    test(`blank shell ${scheme} ${w}x${h}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width: w, height: h });
      await page.goto('/');
      await expect(page.getByRole('main')).toBeVisible();
      await expect(page).toHaveScreenshot(`shell-${scheme}-${w}x${h}.png`);
    });
  }
}
