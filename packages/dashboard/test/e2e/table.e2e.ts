// UI-T06 DataTable in a browser: acceptance 1 (5,000 and 10,000 rows keep at most 60 rows in the DOM; the scroll frame
// rate is recorded as a non-gating trend, gating only with DASHBOARD_PERF_GATE=1), 2 (streamed inserts above a focused
// row keep focus and the view, and count in the "3 new" pill), 3 (tabular figures: equal digit widths, aligned right
// edges), 4 (sort, resize and column visibility by keyboard only), row keys, copy as JSON with big integers as strings,
// the 20-per-second cell (flash throttled, text current), untrusted text, pinning, density row heights, axe in both
// themes, and reflow at 360 px.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll, watchConsole } from './helpers.ts';

const RESULTS = join(dirname(fileURLToPath(import.meta.url)), '../../test-results');

const open = async (page: Page, query: string): Promise<void> => {
  await page.goto(`/catalogue?${query}`);
  await page.evaluate(() => document.fonts.ready);
};

/** Presses Tab until `target` has focus (keyboard only), failing after 60 presses. */
async function tabTo(page: Page, target: Locator): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('target never received focus');
}

const bodyRows = (page: Page): Locator => page.locator('tbody tr[data-row-id]');
const focusedRowId = (page: Page): Promise<string | undefined> => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset['rowId']);

interface ScrollRun { frames: number; seconds: number; fps: number; worstFrameMs: number; maxDomRows: number }

/** Scrolls the table body by `stepPx` every animation frame for `count` frames; measures frame times and DOM rows. */
function scrollRun(page: Page, stepPx: number, count: number): Promise<ScrollRun> {
  return page.evaluate(([step, n]) => new Promise<ScrollRun>((resolve) => {
    const el = document.querySelector('.dt__scroll') as HTMLElement;
    const times: number[] = [];
    let maxDomRows = 0;
    const frame = (t: number): void => {
      times.push(t);
      maxDomRows = Math.max(maxDomRows, el.querySelectorAll('tbody tr[data-row-id]').length);
      el.scrollTop += step as number;
      if (times.length < (n as number)) { requestAnimationFrame(frame); return; }
      const gaps = times.slice(1).map((v, i) => v - (times[i] as number));
      const seconds = ((times.at(-1) as number) - (times[0] as number)) / 1000;
      resolve({ frames: gaps.length, seconds, fps: gaps.length / seconds, worstFrameMs: Math.max(...gaps), maxDomRows });
    };
    requestAnimationFrame(frame);
  }), [stepPx, count]);
}

test('acceptance 1: 5,000 rows scroll with at most 60 rows in the DOM; the frame rate is recorded', async ({ page }) => {
  const done = watchConsole(page);
  await open(page, 'section=table-perf');
  await expect(page.getByText('5000 rows')).toBeVisible();
  expect(await page.locator('table').getAttribute('aria-rowcount')).toBe('5001');
  expect(await bodyRows(page).count()).toBeLessThanOrEqual(60);
  const run = await scrollRun(page, 96, 240);
  expect(run.maxDomRows).toBeLessThanOrEqual(60);
  expect(run.maxDomRows).toBeGreaterThan(10);
  // The rows in the DOM are the ones in view: the last frame's first row is far down the list.
  const firstIndex = Number(await bodyRows(page).first().getAttribute('aria-rowindex'));
  expect(firstIndex).toBeGreaterThan(500);
  // Non-gating trend (docs/UI.md UI-T06 DoD): written to test-results and the CI job summary.
  mkdirSync(RESULTS, { recursive: true });
  writeFileSync(join(RESULTS, 'table-perf.json'), `${JSON.stringify({ rows: 5000, ...run }, null, 2)}\n`);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '') {
    appendFileSync(summary, `DataTable scroll, 5,000 rows: ${run.fps.toFixed(1)} fps, worst frame ${run.worstFrameMs.toFixed(1)} ms, at most ${run.maxDomRows} rows in the DOM (non-gating)\n`);
  }
  console.log(`DataTable scroll, 5,000 rows: ${JSON.stringify(run)}`);
  if (process.env['DASHBOARD_PERF_GATE'] === '1') expect(run.fps).toBeGreaterThanOrEqual(55);
  done();
});

test('10,000 rows: at most 60 rows in the DOM, and End reaches the last row by keyboard', async ({ page }) => {
  await open(page, 'section=table-perf&rows=10000');
  await expect(page.getByText('10000 rows')).toBeVisible();
  const run = await scrollRun(page, 400, 60);
  expect(run.maxDomRows).toBeLessThanOrEqual(60);
  // The scroll has left row 1 out of the DOM: the first rendered row takes the tab stop.
  await tabTo(page, page.locator('tbody tr[tabindex="0"]'));
  expect(Number(await page.locator('tbody tr[tabindex="0"]').getAttribute('aria-rowindex'))).toBeGreaterThan(100);
  await page.keyboard.press('End');
  await expect.poll(() => focusedRowId(page)).toBe('P009999');
  expect(await bodyRows(page).count()).toBeLessThanOrEqual(60);
  await page.keyboard.press('Home');
  await expect.poll(() => focusedRowId(page)).toBe('P000000');
});

for (const count of [50, 5000]) {
  test(`acceptance 2: focus on row 10 and 3 streamed inserts keep focus and the view, with a "3 new" pill (${count} rows)`, async ({ page }) => {
    await open(page, `section=table-perf&rows=${count}`);
    await page.getByRole('button', { name: 'Stream 3 rows in 2 s' }).click();
    const row10 = bodyRows(page).nth(9);
    await row10.click();
    const id = await row10.getAttribute('data-row-id');
    expect(id).toBe('P000009');
    const before = (await row10.boundingBox())?.y;
    await expect(page.getByRole('button', { name: '3 new' })).toBeVisible({ timeout: 4000 });
    expect(await focusedRowId(page)).toBe(id);
    const row = page.locator(`tr[data-row-id="${id as string}"]`);
    expect((await row.boundingBox())?.y).toBe(before);
    expect(await row.getAttribute('aria-rowindex')).toBe('14');
    // The pill shows the new rows.
    await page.getByRole('button', { name: '3 new' }).click();
    await expect(page.getByRole('button', { name: '3 new' })).toHaveCount(0);
    await expect(bodyRows(page).first()).toHaveAttribute('data-row-id', /^01K6Z/);
    await expect(bodyRows(page).first()).toHaveClass(/dt__row--new/);
  });
}

test('acceptance 2 on the Positions fixture page: a focused position keeps focus through 3 streamed inserts', async ({ page }) => {
  await open(page, 'section=positions');
  await expect(bodyRows(page)).toHaveCount(8);
  await page.getByRole('button', { name: 'Stream 3 new positions in 2 s' }).click();
  const row = bodyRows(page).nth(4);
  await row.click();
  const id = await row.getAttribute('data-row-id');
  await expect(page.getByRole('button', { name: '3 new' })).toBeVisible({ timeout: 4000 });
  expect(await focusedRowId(page)).toBe(id);
  await expect(bodyRows(page)).toHaveCount(11);
});

test('acceptance 3: numeric columns use tabular figures: every digit has the same width and right edges align', async ({ page }) => {
  await open(page, 'section=table');
  const table = page.locator('.dt-wrap').first();
  const widths = await table.evaluate((root) => {
    const cells = [...root.querySelectorAll('tbody tr[data-row-id] td.dt__td--num')] as HTMLElement[];
    const size = (text: string): number => {
      const probe = document.createElement('span');
      probe.textContent = text;
      (cells[0] as HTMLElement).append(probe);
      const w = probe.getBoundingClientRect().width;
      probe.remove();
      return w;
    };
    const digits = '0123456789'.split('').map((d) => size(d.repeat(8)));
    // Right edges of the number text in the Size column (the second numeric column of each row is Entry cost).
    const rights = [...root.querySelectorAll('tbody tr[data-row-id]')].map((tr) => {
      const num = tr.querySelectorAll('td.dt__td--num')[0]?.querySelector('.num') as HTMLElement | null;
      return num === null ? null : Math.round(num.getBoundingClientRect().right);
    }).filter((v): v is number => v !== null);
    return { digits, rights, numeric: getComputedStyle(cells[0] as HTMLElement).fontVariantNumeric };
  });
  expect(widths.numeric).toContain('tabular-nums');
  expect(new Set(widths.digits).size).toBe(1);
  expect(new Set(widths.rights).size).toBe(1);
  await expect(page.getByText('1,111.1111', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('8,888.8888', { exact: true }).first()).toBeVisible();
});

test('acceptance 4: sort, resize and column visibility work by keyboard only', async ({ page }) => {
  const done = watchConsole(page);
  await open(page, 'section=positions');
  await expect(bodyRows(page)).toHaveCount(8);
  const sizeHeader = page.locator('th', { has: page.getByRole('button', { name: 'Size' }) });
  // Sort: Enter cycles ascending, descending, none.
  await tabTo(page, page.getByRole('button', { name: 'Size', exact: true }));
  await page.keyboard.press('Enter');
  await expect(sizeHeader).toHaveAttribute('aria-sort', 'ascending');
  await expect(bodyRows(page).first()).toContainText('1.0000');
  await page.keyboard.press('Enter');
  await expect(sizeHeader).toHaveAttribute('aria-sort', 'descending');
  await expect(bodyRows(page).first()).toContainText('MAX');
  await page.keyboard.press('Enter');
  await expect(sizeHeader).toHaveAttribute('aria-sort', 'none');
  await expect(bodyRows(page).first()).toContainText('BONK');
  // Resize: arrows by 8 px, Shift by 32 px, Home and End to the bounds.
  const handle = page.getByRole('separator', { name: 'Resize Size' });
  await tabTo(page, handle);
  await expect(handle).toHaveAttribute('aria-valuenow', '168');
  await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '176');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '208');
  expect(Math.round((await sizeHeader.boundingBox())?.width ?? 0)).toBe(208);
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '200');
  await page.keyboard.press('Home');
  await expect(handle).toHaveAttribute('aria-valuenow', '64');
  await page.keyboard.press('End');
  await expect(handle).toHaveAttribute('aria-valuenow', '480');
  // Column visibility: the menu opens on Enter, Space toggles, Escape closes and returns focus.
  const columns = page.getByRole('button', { name: 'Columns of Open positions' });
  await page.keyboard.press('Shift+Tab');
  await tabTo(page, columns);
  await page.keyboard.press('Enter');
  const name = page.getByRole('menuitemcheckbox', { name: 'Name' });
  await expect(name).toBeFocused();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Token' })).toHaveCount(0);
  await page.keyboard.press('Space');
  await expect(name).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('th', { hasText: /^Name/ })).toHaveCount(0);
  await expect(page.getByTestId('positions-out')).toContainText('hidden name');
  await page.keyboard.press('Space');
  await expect(page.locator('th', { hasText: /^Name/ })).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(columns).toBeFocused();
  done();
});

test('rows: J/K and arrows move the focused row, Home/End, Enter opens, Space selects (roving tabindex)', async ({ page }) => {
  await open(page, 'section=positions');
  await expect(bodyRows(page)).toHaveCount(8);
  await expect(page.locator('tbody tr[tabindex="0"]')).toHaveCount(1);
  await tabTo(page, bodyRows(page).first());
  const out = page.getByTestId('positions-out');
  const ids = await bodyRows(page).evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset['rowId']));
  await page.keyboard.press('j');
  expect(await focusedRowId(page)).toBe(ids[1]);
  await page.keyboard.press('ArrowDown');
  expect(await focusedRowId(page)).toBe(ids[2]);
  await page.keyboard.press('k');
  expect(await focusedRowId(page)).toBe(ids[1]);
  await page.keyboard.press('ArrowUp');
  expect(await focusedRowId(page)).toBe(ids[0]);
  await page.keyboard.press('End');
  expect(await focusedRowId(page)).toBe(ids[7]);
  await expect(page.locator('tbody tr[tabindex="0"]')).toHaveAttribute('data-row-id', ids[7] as string);
  await page.keyboard.press('Home');
  expect(await focusedRowId(page)).toBe(ids[0]);
  await page.keyboard.press('Enter');
  await expect(out).toContainText(`opened ${ids[0] as string}`);
  await page.keyboard.press('Space');
  await expect(out).toContainText('selected 1');
  await expect(bodyRows(page).first()).toHaveClass(/dt__row--selected/);
  await page.keyboard.press('Space');
  await expect(out).toContainText('selected 0');
  // Tab leaves the table body in one step.
  await page.keyboard.press('Tab');
  expect(await focusedRowId(page)).toBeUndefined();
});

test('"Copy row as JSON" copies the raw VM-05 entity with big integers as strings', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await open(page, 'section=positions');
  const max = bodyRows(page).filter({ hasText: 'MAX' });
  await max.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Open positions row' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Copy row as JSON' }).click();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  const entity = JSON.parse(text) as Record<string, unknown>;
  expect(entity['size_base']).toBe('18446744073709551615');
  expect(entity['unrealized_pnl_net_lamports']).toBe('-9223372036854775808');
  expect(entity['entry_fees']).toEqual(expect.objectContaining({ tip_lamports: expect.any(String) }));
  expect(text).toContain('"size_base": "18446744073709551615"');
  // By keyboard: the context-menu key on a focused row opens the same menu.
  await max.focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menu', { name: 'Open positions row' })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('a cell changing 20 times a second shows every value and flashes at most once a second', async ({ page }) => {
  await open(page, 'section=table-perf&rows=50');
  await page.getByRole('switch', { name: 'Fast updates' }).click();
  const counts = await page.evaluate(() => new Promise<{ texts: number; flashes: number }>((resolve) => {
    const tr = document.querySelector('tr[data-row-id="P000000"]') as HTMLElement;
    const pnlCell = (): HTMLElement => tr.querySelectorAll('td')[9] as HTMLElement;
    const seen = new Set<string>();
    let flashes = 0;
    const observer = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement && n.matches('td[data-flash]')) flashes += 1;
      seen.add(pnlCell().textContent ?? '');
    });
    observer.observe(tr, { childList: true, subtree: true, characterData: true });
    setTimeout(() => { observer.disconnect(); resolve({ texts: seen.size, flashes }); }, 2000);
  }));
  expect(counts.texts).toBeGreaterThanOrEqual(20);
  // Each changed cell flashes at most once a second: the PnL cell at most 3 times in 2 s (at 0, 1 and 2 s); other
  // cells of the row do not change.
  expect(counts.flashes).toBeLessThanOrEqual(3);
  expect(counts.flashes).toBeGreaterThanOrEqual(1);
  await page.getByRole('switch', { name: 'Fast updates' }).click();
  const pnl = page.locator('tr[data-row-id="P000000"] td').nth(9);
  const shown = await pnl.textContent();
  await page.waitForTimeout(200);
  expect(await pnl.textContent()).toBe(shown);
});

test('untrusted text is cleaned and capped, with the full text in the tooltip; the pinned column stays put', async ({ page }) => {
  await open(page, 'section=positions');
  const usdc = bodyRows(page).nth(3);
  expect(await usdc.locator('td').first().textContent()).not.toContain('\u202E');
  await expect(usdc.locator('td').first()).toContainText('USDC');
  await expect(usdc.locator('.dt__flag')).toHaveAttribute('title', 'Contains non-Latin or mixed scripts');
  const long = bodyRows(page).nth(2).locator('td').first().locator('.dt__text');
  expect(await long.getAttribute('title')).toBe('X'.repeat(32));
  const shownText = await long.locator('[aria-hidden]').textContent();
  expect(shownText).toMatch(/^X+…$/);
  expect([...(shownText ?? '')].length).toBeLessThanOrEqual(12);
  // Pinned Token column: scrolling the table sideways leaves it at the left edge.
  const scroller = page.locator('.dt__scroll');
  const left = (await scroller.boundingBox())?.x ?? 0;
  await scroller.evaluate((el) => { el.scrollLeft = 400; });
  expect(await scroller.evaluate((el) => el.scrollLeft)).toBe(400);
  expect((await bodyRows(page).first().locator('td').first().boundingBox())?.x).toBe(left);
  expect((await page.locator('th').first().boundingBox())?.x).toBe(left);
  expect((await bodyRows(page).first().locator('td').nth(1).boundingBox())?.x).toBeLessThan(left);
});

test('row heights follow the density token: 32 px standard, 28 px dense and compact, 40 px comfortable', async ({ page }) => {
  await open(page, 'section=table');
  expect((await page.locator('#table tbody tr[data-row-id]').first().boundingBox())?.height).toBe(32);
  await open(page, 'section=table-dense');
  expect((await page.locator('#table-dense tbody tr[data-row-id]').first().boundingBox())?.height).toBe(28);
  for (const [density, px] of [['compact', 28], ['comfortable', 40]] as const) {
    await open(page, `section=table-perf&density=${density}`);
    expect((await bodyRows(page).first().boundingBox())?.height).toBe(px);
    const run = await scrollRun(page, 200, 10);
    expect(run.maxDomRows).toBeLessThanOrEqual(60);
    // The virtual body's height is the rows' height: the last row ends at the bottom of the scroll range.
    await page.locator('.dt__scroll').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect(bodyRows(page).last()).toHaveAttribute('data-row-id', 'P004999');
    const [rowBottom, scrollBottom] = await page.locator('.dt__scroll').evaluate((el) => [
      (el.querySelector('tr[data-row-id="P004999"]') as HTMLElement).getBoundingClientRect().bottom, el.getBoundingClientRect().bottom]);
    expect(Math.abs((rowBottom as number) - (scrollBottom as number))).toBeLessThanOrEqual(1);
  }
});

for (const theme of ['dark', 'light']) {
  test(`axe: table states, dense table, Positions and the performance page in the ${theme} theme`, async ({ page }) => {
    const done = watchConsole(page);
    for (const section of ['table', 'table-dense', 'positions', 'table-perf']) {
      await open(page, `section=${section}&theme=${theme}`);
      await expect(bodyRows(page).first()).toBeVisible();
      await expectAccessible(page);
    }
    done();
  });
}

test('reflow at 360 px: the table scrolls inside its frame and the page does not', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  for (const section of ['table', 'positions']) {
    await open(page, `section=${section}`);
    await expect(bodyRows(page).first()).toBeVisible();
    await expectNoHorizontalScroll(page);
  }
  await expect(page.getByRole('button', { name: 'Columns of Open positions' })).toBeInViewport();
});
