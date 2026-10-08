// UI-T06 visual: every table state (rows with selected, closing and disabled rows, sorted and pinned columns, grouped
// headers, a streamed row's marker, loading, empty, filtered empty, error, stale) in the standard and dense variants
// and both themes; the Positions fixture page in both themes and at 390 px; and acceptance 3's tabular digits.
import { expect, test, type Page } from '@playwright/test';

const open = async (page: Page, query: string): Promise<void> => {
  await page.goto(`/catalogue?${query}`);
  await page.evaluate(() => document.fonts.ready);
};

for (const theme of ['dark', 'light']) {
  for (const section of ['table', 'table-dense']) {
    test(`${section} ${theme}`, async ({ page }) => {
      await open(page, `section=${section}&theme=${theme}`);
      await expect(page.locator('.dt__placeholder .skeleton').first()).toBeVisible();
      await expect(page.locator('.dt__row--new')).toHaveCount(1);
      await expect(page).toHaveScreenshot(`${section}-${theme}.png`, { fullPage: true });
    });
  }
  test(`positions ${theme}`, async ({ page }) => {
    await open(page, `section=positions&theme=${theme}`);
    await expect(page.locator('tbody tr[data-row-id]')).toHaveCount(8);
    await expect(page).toHaveScreenshot(`positions-${theme}.png`, { fullPage: true });
  });
}

test('positions at 390 px', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'section=positions&theme=dark');
  await expect(page.locator('tbody tr[data-row-id]')).toHaveCount(8);
  await expect(page).toHaveScreenshot('positions-390-dark.png', { fullPage: true });
});

test('acceptance 3: digits align in a numeric column', async ({ page }) => {
  await open(page, 'section=table&theme=dark');
  await expect(page.locator('.dt-wrap').first()).toHaveScreenshot('table-digits.png');
});
