// Screenshots of every screen and the open Deposit sheet, in both themes, at
// 1440px and 390px, plus a reduced-motion check. Uses the machine's Playwright
// and Chromium (PLAYWRIGHT_BROWSERS_PATH); it is not a project dependency.
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { createServer } from 'vite';

const root = new URL('..', import.meta.url).pathname;
const out = join(root, 'screenshots');
mkdirSync(out, { recursive: true });

const require = createRequire(import.meta.url);
let playwright;
try {
  playwright = require('playwright');
} catch {
  playwright = require(join(execSync('npm root -g').toString().trim(), 'playwright'));
}
const executablePath = process.env.CHROMIUM_PATH ?? undefined;

const server = await createServer({ root, server: { port: 5199, strictPort: true }, logLevel: 'error' });
await server.listen();
const base = 'http://localhost:5199/';

const browser = await playwright.chromium.launch(executablePath ? { executablePath } : {});
const THEMES = ['paper', 'black'];
const WIDTHS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
  // Small phone: only the sheets, where long addresses must wrap.
  { name: 'small', width: 360, height: 780, only: ['deposit', 'withdraw', 'fixtures-withdraw'] },
];
const SHOTS = [
  { name: 'home', hash: '#/home' },
  { name: 'snipe', hash: '#/snipe' },
  { name: 'wallet', hash: '#/wallet' },
  { name: 'deposit', hash: '#/wallet', open: 'Deposit' },
  { name: 'withdraw', hash: '#/wallet', open: 'Withdraw' },
  { name: 'fixtures', hash: '#/dev/fixtures' },
  { name: 'trade-detail', hash: '#/dev/fixtures', openTrade: true },
  { name: 'fixtures-withdraw', hash: '#/dev/fixtures', open: 'Withdraw' },
];

const files = [];
const problems = [];
for (const theme of THEMES) {
  for (const w of WIDTHS) {
    const context = await browser.newContext({ viewport: { width: w.width, height: w.height }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    await context.addInitScript((t) => {
      try {
        localStorage.setItem('zeroed.theme', t);
      } catch {}
    }, theme);
    const page = await context.newPage();
    page.on('pageerror', (e) => problems.push(`${theme} ${w.name}: ${e.message}`));
    for (const s of SHOTS.filter((x) => !w.only || w.only.includes(x.name))) {
      await page.goto('about:blank');
      await page.goto(base + s.hash);
      await page.waitForSelector('.page-head h1');
      await page.evaluate(() => document.fonts.ready);
      if (s.open) await page.getByRole('button', { name: s.open, exact: true }).first().click();
      if (s.openTrade) await page.locator('.row-button').first().click();
      if (s.open || s.openTrade) await page.waitForSelector('[role="dialog"]');
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(400);
      const scroll = await page.evaluate(() => {
        const sheet = document.querySelector('.sheet-body');
        return Math.max(document.documentElement.scrollWidth - window.innerWidth, sheet ? sheet.scrollWidth - sheet.clientWidth : 0);
      });
      if (scroll > 0) problems.push(`${theme} ${w.name} ${s.name}: horizontal scroll ${scroll}px`);
      // Every address must fit inside its sheet column (catches nowrap even before the sheet scrolls).
      const overflowing = await page.evaluate(() =>
        [...document.querySelectorAll('.sheet-body .address')].flatMap((a) => {
          const body = a.closest('.sheet-body');
          const pad = parseFloat(getComputedStyle(body).paddingRight);
          const limit = body.getBoundingClientRect().right - pad;
          const right = Math.max(...[...a.getClientRects()].map((r) => r.right));
          return right > limit + 0.5 ? [`${a.textContent} ends at ${Math.round(right)}px, column ends at ${Math.round(limit)}px`] : [];
        }),
      );
      for (const o of overflowing) problems.push(`${theme} ${w.name} ${s.name}: address overflows: ${o}`);
      if (w.name !== 'desktop') {
        // Touch targets: every control at least 44px tall (skip link aside).
        const small = await page.evaluate(() =>
          [...document.querySelectorAll('button, a[href], input, [role="radio"]')]
            .filter((e) => !e.classList.contains('skip-link') && !e.closest('.table-wrap tbody td:not(:first-child)'))
            .map((e) => ({ e, r: e.getBoundingClientRect() }))
            .filter(({ r }) => r.width > 0 && r.height > 0 && r.height < 44)
            .map(({ e, r }) => `${e.tagName.toLowerCase()}.${e.className} "${(e.textContent ?? '').trim().slice(0, 24)}" ${Math.round(r.height)}px`),
        );
        for (const m of [...new Set(small)]) problems.push(`${theme} ${w.name} ${s.name}: small target ${m}`);
      }
      const file = `${s.name}-${theme}-${w.width}.png`;
      await page.screenshot({ path: join(out, file), fullPage: !(s.open || s.openTrade) });
      files.push(file);
    }
    await context.close();
  }
}

// Reduced motion: with the OS setting on, the sheet is in place on the first
// frame after opening (no slide); with it off, it is still moving.
async function sheetOffsetAfterOpen(reducedMotion) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion });
  const page = await context.newPage();
  await page.goto(base + '#/wallet');
  await page.waitForSelector('.page-head h1');
  await page.getByRole('button', { name: 'Deposit', exact: true }).click();
  await page.waitForSelector('[role="dialog"]');
  const offset = await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(new DOMMatrix(getComputedStyle(document.querySelector('[role="dialog"]')).transform).m41))),
      ),
  );
  if (reducedMotion === 'reduce') await page.screenshot({ path: join(out, 'reduced-motion-deposit-first-frame.png') });
  await context.close();
  return offset;
}
const reduced = await sheetOffsetAfterOpen('reduce');
const full = await sheetOffsetAfterOpen('no-preference');
const motion = { reducedMotionSheetOffsetPx: reduced, normalMotionSheetOffsetPx: full };
if (reduced !== 0) problems.push(`reduced motion: sheet offset ${reduced}px on the first frames, expected 0`);
if (!(full > 0)) problems.push(`normal motion: sheet offset ${full}px, expected it to be sliding in`);

writeFileSync(join(out, 'report.json'), JSON.stringify({ files, motion, problems }, null, 2) + '\n');
await browser.close();
await server.close();
console.log(JSON.stringify({ count: files.length, motion, problems }, null, 2));
if (problems.length) process.exit(1);
