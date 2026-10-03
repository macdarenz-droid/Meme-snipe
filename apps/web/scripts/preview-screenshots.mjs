// Screenshots of the preview build (the bundle inside the APK) at 390px, in both themes.
// Run `pnpm build:preview` first. Simulated system-bar insets are set the way the Android shell sets them.
// Uses the machine's Playwright and Chromium (CHROMIUM_PATH); it is not a project dependency.
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { preview } from 'vite';

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

const server = await preview({ root, preview: { port: 5198, strictPort: true }, logLevel: 'error' });
const base = 'http://localhost:5198/';
const browser = await playwright.chromium.launch(executablePath ? { executablePath } : {});

const SHOTS = [
  { name: 'home', hash: '#/home' },
  { name: 'samples', hash: '#/dev/fixtures' },
  { name: 'samples-trade', hash: '#/dev/fixtures', openTrade: true },
];
const problems = [];
for (const theme of ['paper', 'black']) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  await context.addInitScript((t) => {
    try {
      localStorage.setItem('zeroed.theme', t);
    } catch {}
  }, theme);
  const page = await context.newPage();
  page.on('pageerror', (e) => problems.push(`${theme}: ${e.message}`));
  for (const s of SHOTS) {
    await page.goto('about:blank');
    await page.goto(base + s.hash);
    await page.waitForSelector('.page-head h1');
    await page.evaluate(() => {
      // What the Android shell injects: status bar 32px, gesture bar 24px.
      document.documentElement.style.setProperty('--safe-area-inset-top', '32px');
      document.documentElement.style.setProperty('--safe-area-inset-bottom', '24px');
    });
    await page.evaluate(() => document.fonts.ready);
    if (s.openTrade) {
      await page.locator('.row-button').first().click();
      await page.waitForSelector('[role="dialog"]');
    }
    await page.waitForTimeout(400);
    const hasMarker = await page.locator('.sample-marker').count();
    if (s.name.startsWith('samples') && hasMarker === 0) problems.push(`${theme} ${s.name}: no Sample data marker`);
    if (s.name === 'home' && hasMarker > 0) problems.push(`${theme} home: marker shown on a screen without sample numbers`);
    const scroll = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (scroll > 0) problems.push(`${theme} ${s.name}: horizontal page scroll ${scroll}px`);
    await page.screenshot({ path: join(out, `preview-${s.name}-${theme}-390.png`), fullPage: false });
  }
  await context.close();
}
await browser.close();
await server.close();
console.log(JSON.stringify({ problems }, null, 2));
if (problems.length) process.exit(1);
