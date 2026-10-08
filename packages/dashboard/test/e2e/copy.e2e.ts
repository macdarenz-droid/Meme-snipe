// Z05 round 2 (red team m1): no banned word in the text a reader gets, rendered: the app shell and every catalogue
// section (open overlays and dialogs included), as visible and assistive-technology text (text content, labels, titles,
// alternative text and placeholders). Catches a phrase built at run time or split over several strings.
import { expect, test, type Page } from '@playwright/test';
import { SECTIONS } from '../../src/catalogue/catalogue.ts';
import { findBanned } from '../copy/banned-copy.ts';

async function readerText(page: Page): Promise<string[]> {
  await page.evaluate(() => document.fonts.ready);
  return page.evaluate(() => {
    const out = [document.title, document.body.textContent ?? ''];
    for (const el of document.querySelectorAll('[aria-label], [title], [alt], [placeholder], [aria-description]')) {
      for (const a of ['aria-label', 'title', 'alt', 'placeholder', 'aria-description']) {
        const v = el.getAttribute(a);
        if (v !== null) out.push(v);
      }
    }
    return out;
  });
}

const hits = (texts: readonly string[]): string[] => texts.flatMap((t) => findBanned(t).map((l) => `${l}: "${t.slice(0, 120)}"`));

test('the app shell has no banned word', async ({ page }) => {
  await page.goto('/');
  expect(hits(await readerText(page))).toEqual([]);
});

for (const section of SECTIONS) {
  test(`catalogue section ${section.id} has no banned word`, async ({ page }) => {
    await page.goto(`/catalogue?section=${section.id}`);
    expect(hits(await readerText(page))).toEqual([]);
  });
}

test('the open dialogs and the HALT flow have no banned word', async ({ page }) => {
  for (const mode of ['paper', 'live_small', 'unknown']) {
    await page.goto(`/catalogue?section=dialog-open&mode=${mode}&connection=reconnecting`);
    for (const name of ['Switch to LIVE-SMALL', 'Close position']) {
      await page.getByRole('button', { name, exact: true }).click();
      expect(hits(await readerText(page))).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('alertdialog')).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Halt', exact: true }).focus();
    await page.keyboard.press('Enter');
    expect(hits(await readerText(page))).toEqual([]);
  }
});
