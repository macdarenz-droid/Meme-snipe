// UI-T07 visual: every dialog-family state in paper and live (in-place frames), in both themes and at 390 px, and the
// open modal dialogs (A3 typed confirmation in live, HALT in paper) over the page.
import { expect, test, type Page } from '@playwright/test';

const ready = async (page: Page): Promise<void> => { await page.evaluate(() => document.fonts.ready); };

for (const theme of ['dark', 'light']) {
  test(`dialogs ${theme}`, async ({ page }) => {
    await page.goto(`/catalogue?section=dialogs&theme=${theme}`);
    await ready(page);
    await expect(page).toHaveScreenshot(`dialogs-${theme}.png`, { fullPage: true });
  });
}

test('dialogs at 390 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/catalogue?section=dialogs&theme=dark');
  await ready(page);
  await expect(page).toHaveScreenshot('dialogs-390-dark.png', { fullPage: true });
});

for (const theme of ['dark', 'light']) {
  test(`open typed confirmation, live (${theme})`, async ({ page }) => {
    await page.goto(`/catalogue?section=dialog-open&mode=live_small&theme=${theme}`);
    await ready(page);
    await page.getByRole('button', { name: 'Switch to LIVE-SMALL' }).click();
    await page.getByRole('alertdialog').getByLabel(/Type LIVE-SMALL/).fill('live-small 0.25');
    await expect(page).toHaveScreenshot(`dialog-open-live-${theme}.png`);
  });

  test(`open HALT dialog, paper (${theme})`, async ({ page }) => {
    await page.goto(`/catalogue?section=dialog-open&mode=paper&theme=${theme}`);
    await ready(page);
    await page.getByRole('button', { name: 'Halt', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alertdialog')).toBeVisible();
    await expect(page).toHaveScreenshot(`dialog-open-halt-paper-${theme}.png`);
  });
}
