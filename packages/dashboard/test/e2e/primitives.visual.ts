// UI-T04 visual: every primitive state in both themes. Density changes only table rows (--row-h), so the three
// densities must render the primitives identically: each compares against the same baseline. Open overlays, the
// open menu with its submenu, the open popover, and the primitives at 390 px.
import { expect, test, type Page } from '@playwright/test';

const open = async (page: Page, query: string): Promise<void> => {
  await page.goto(`/catalogue?${query}`);
  await page.evaluate(() => document.fonts.ready);
};

for (const theme of ['dark', 'light']) {
  for (const density of ['compact', 'standard', 'comfortable']) {
    test(`primitives ${theme} ${density}`, async ({ page }) => {
      await open(page, `section=primitives&theme=${theme}&density=${density}`);
      await expect(page).toHaveScreenshot(`primitives-${theme}.png`, { fullPage: true });
    });
  }
  test(`overlays ${theme}`, async ({ page }) => {
    await open(page, `section=overlays&theme=${theme}`);
    await expect(page.getByRole('tooltip').first()).toBeVisible();
    await expect(page).toHaveScreenshot(`overlays-${theme}.png`);
  });
  test(`menu with an open submenu ${theme}`, async ({ page }) => {
    await open(page, `section=menu-open&theme=${theme}`);
    await page.getByRole('menuitem', { name: 'Export' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menuitem', { name: 'As CSV' })).toBeFocused();
    await expect(page).toHaveScreenshot(`menu-open-${theme}.png`);
  });
  test(`popover open ${theme}`, async ({ page }) => {
    await open(page, `section=popover-open&theme=${theme}`);
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page).toHaveScreenshot(`popover-open-${theme}.png`);
  });
}

test('primitives at 390 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'section=primitives&theme=light');
  await expect(page).toHaveScreenshot('primitives-390-light.png', { fullPage: true });
});
