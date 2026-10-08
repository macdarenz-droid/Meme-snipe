// UI-T02 tokens in a browser: polarity (acceptance 2), reduced motion (acceptance 3), OS theme switch without reload
// (acceptance 4), density, forced colours, and axe on the swatch page in four theme/polarity combinations.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, watchConsole } from './helpers.ts';

const cssVar = (page: Page, name: string): Promise<string> =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

/** The computed background of a new element styled `background: var(<token>)`. */
const backgroundOf = (page: Page, token: string): Promise<string> => page.evaluate((t) => {
  const el = document.createElement('div');
  el.style.background = `var(${t})`;
  document.body.append(el);
  const value = getComputedStyle(el).backgroundColor;
  el.remove();
  return value;
}, token);

/** Transitions running on the motion demo drawer after it is opened, by property. */
async function drawerTransitions(page: Page): Promise<string[]> {
  await page.getByRole('button', { name: 'Open drawer' }).click();
  return page.evaluate(() => (document.getElementById('motion-demo-drawer') as HTMLElement).getAnimations()
    .map((a) => (a as CSSTransition).transitionProperty).sort());
}

test('acceptance 2: with the blue-orange polarity, --c-pos-mark renders #3987e5 in dark and #2a78d6 in light', async ({ page }) => {
  await page.goto('/catalogue?section=tokens&theme=dark&polarity=blue-orange');
  expect(await backgroundOf(page, '--c-pos-mark')).toBe('rgb(57, 135, 229)');
  await page.goto('/catalogue?section=tokens&theme=light&polarity=blue-orange');
  expect(await backgroundOf(page, '--c-pos-mark')).toBe('rgb(42, 120, 214)');
  await page.goto('/catalogue?section=tokens&theme=dark');
  expect(await backgroundOf(page, '--c-pos-mark')).toBe('rgb(34, 160, 107)');
});

test('acceptance 4: with theme System, an OS switch to light applies the light tokens without a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/catalogue?section=tokens');
  await page.evaluate(() => { (window as unknown as { marker: number }).marker = 1; });
  expect(await cssVar(page, '--c-bg-canvas')).toBe('#0b0c0e');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('dark');
  await page.emulateMedia({ colorScheme: 'light' });
  expect(await cssVar(page, '--c-bg-canvas')).toBe('#f7f8fa');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(247, 248, 250)');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).colorScheme)).toBe('light');
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
});

test('an explicit Dark theme ignores the OS light preference', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/catalogue?section=tokens&theme=dark');
  expect(await cssVar(page, '--c-bg-canvas')).toBe('#0b0c0e');
});

test.describe('acceptance 3: reduced motion', () => {
  test('OS reduced motion: opening the drawer runs no transform animation, only the opacity fade', async ({ page }) => {
    await page.goto('/catalogue?section=tokens');
    expect(await drawerTransitions(page)).toEqual(['opacity']);
    expect(await cssVar(page, '--d-slow')).toBe('0ms');
    expect(await cssVar(page, '--d-fast')).toBe('100ms');
  });

  test.describe('without the OS setting', () => {
    test.use({ reducedMotion: 'no-preference' });
    test('control: the drawer slides (transform transition) when motion is not reduced', async ({ page }) => {
      await page.goto('/catalogue?section=tokens');
      expect(await drawerTransitions(page)).toEqual(['opacity', 'transform']);
    });
    test('the in-app reduced-motion setting removes the slide too', async ({ page }) => {
      await page.goto('/catalogue?section=tokens&motion=reduced');
      expect(await drawerTransitions(page)).toEqual(['opacity']);
    });
  });
});

test('density sets the table row height token', async ({ page }) => {
  for (const [density, px] of [['compact', '28px'], ['standard', '32px'], ['comfortable', '40px']]) {
    await page.goto(`/catalogue?section=tokens&density=${density as string}`);
    expect(await cssVar(page, '--row-h')).toBe(px);
  }
});

test('forced colours: borders and focus use system colours', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' });
  await page.goto('/catalogue?section=tokens&theme=light');
  expect(await cssVar(page, '--c-border-control')).toBe('CanvasText');
  expect(await cssVar(page, '--c-focus')).toBe('Highlight');
});

for (const theme of ['dark', 'light']) {
  for (const polarity of ['default', 'blue-orange']) {
    test(`the swatch page passes axe (${theme}, ${polarity})`, async ({ page }) => {
      const done = watchConsole(page);
      await page.goto(`/catalogue?section=tokens&theme=${theme}&polarity=${polarity}`);
      await expect(page.getByRole('heading', { level: 2, name: 'Tokens' })).toBeVisible();
      await expectAccessible(page);
      done();
    });
  }
}
