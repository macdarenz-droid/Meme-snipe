// UI-T03 fonts and numbers in a browser: Inter and JetBrains Mono load from the dashboard's own origin (no CDN), the
// Latin Inter file is preloaded, the metric-matched fallback moves text by less than 1% when Inter arrives, the OFL
// texts are served, and the number gallery passes axe in both themes.
import { expect, test } from '@playwright/test';
import { expectAccessible, watchConsole } from './helpers.ts';

test('fonts load from the dashboard origin only, and the Inter Latin file is preloaded', async ({ page, baseURL }) => {
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await page.goto('/catalogue?section=typography');
  await page.evaluate(() => document.fonts.ready);
  expect(await page.evaluate(() => document.fonts.check('400 14px "Inter Variable"') && document.fonts.check('400 13px "JetBrains Mono Variable"'))).toBe(true);
  expect(requests.filter((u) => !u.startsWith(baseURL as string) && !u.startsWith('data:'))).toEqual([]);
  expect(requests.some((u) => /\/assets\/inter-latin-opsz-normal-[0-9a-f]{10}\.woff2$/.test(u))).toBe(true);
  expect(await page.locator('link[rel="preload"][as="font"]').count()).toBe(1);
});

test('the Inter Fallback face changes a paragraph of UI text (11-15 px) by less than 1% and keeps the line box', async ({ page }) => {
  // A paragraph, not single labels: one scale factor matches the average letter width, while a short label can differ by
  // up to about 2.5% (recorded in fonts.css). The text differs from the sample the size adjustment was measured on.
  const paragraph = [
    'Disconnected from bot, showing data as of 14:02:11 UTC, reconnecting (attempt 3, next in 4s).',
    'Trading continues on the server under its own risk limits. No open positions; bot running in paper mode;',
    'last candidate 2m ago. Risk status is stale, so raise-limit actions are disabled until the next update.',
    'Mode: paper trading, simulated. Copy diagnostics: VM-12, field usage_bps, HTTP 503, seq 18446744073709551615.',
  ].join(' ');
  await page.goto('/catalogue?section=typography');
  await page.evaluate(() => document.fonts.ready);
  const result = await page.evaluate(async (text) => {
    await document.fonts.load('400 14px "Inter Fallback"');
    return [11, 12, 13, 14, 15].map((px) => {
      const measure = (family: string): [number, number] => {
        const el = document.createElement('span');
        el.style.font = `400 ${px}px ${family}`;
        el.style.whiteSpace = 'nowrap';
        el.textContent = text;
        document.body.append(el);
        const r = el.getBoundingClientRect();
        el.remove();
        return [r.width, r.height];
      };
      const [wi, hi] = measure('"Inter Variable"');
      const [wf, hf] = measure('"Inter Fallback"');
      return { px, shift: Math.abs(wf - wi) / wi, dh: Math.abs(hf - hi) };
    });
  }, paragraph);
  expect(result).toHaveLength(5);
  for (const r of result) {
    expect(r.shift, `${r.px}px`).toBeLessThan(0.01);
    expect(r.dh, `${r.px}px`).toBeLessThanOrEqual(1);
  }
});

test('the OFL texts are served with the fonts', async ({ request }) => {
  for (const f of ['inter-OFL.txt', 'jetbrains-mono-OFL.txt']) {
    const res = await request.get(`/licenses/${f}`);
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('SIL Open Font License, Version 1.1');
  }
});

for (const theme of ['dark', 'light']) {
  test(`the typography specimen and number gallery pass axe (${theme})`, async ({ page }) => {
    const done = watchConsole(page);
    await page.goto(`/catalogue?theme=${theme}`);
    await expect(page.getByRole('heading', { level: 2, name: 'Numbers' })).toBeVisible();
    await expectAccessible(page, '#typography');
    await expectAccessible(page, '#numbers');
    done();
  });
}

test('screen readers get the unabbreviated label, not the subscript text', async ({ page }) => {
  await page.goto('/catalogue?section=numbers');
  const cell = page.locator('tbody tr').filter({ hasText: '"0.000004321"' }).locator('.num');
  await expect(cell).toHaveText('0.0₅43210.000004321');
  expect(await cell.locator('[aria-hidden="true"]').textContent()).toBe('0.0₅4321');
  const snapshot = await page.locator('tbody tr').filter({ hasText: '"-4500000"' }).locator('.num').ariaSnapshot();
  expect(snapshot).toContain('minus 0.0045 SOL');
  expect(snapshot).not.toContain('−');
});
