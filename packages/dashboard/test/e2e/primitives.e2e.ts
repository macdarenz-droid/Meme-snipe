// UI-T04 primitives in a browser: acceptance 1 (loading width and name), 3 (disabled option reason on hover and focus,
// announced) and 4 (keyboard tour: a 2px focus ring on every control, never obscured), the WAI-ARIA keyboard patterns
// for Select (combobox), Menu and Tabs (UI-F42), and axe on every primitive state in both themes.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll, watchConsole } from './helpers.ts';

const open = async (page: Page, query: string): Promise<void> => {
  await page.goto(`/catalogue?${query}`);
  await page.evaluate(() => document.fonts.ready);
};

test('acceptance 1: a loading button keeps its idle width and accessible name, with aria-busy', async ({ page }) => {
  await open(page, 'section=primitives');
  const save = page.getByRole('button', { name: 'Save changes' });
  const before = (await save.boundingBox())?.width;
  await expect(save).not.toHaveAttribute('aria-busy', 'true');
  await save.click();
  await expect(save).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: 'Save changes' })).toHaveCount(1);
  expect((await save.boundingBox())?.width).toBe(before);
});

/** The active option's id, text and description, read through aria-activedescendant. */
async function activeOption(combo: Locator): Promise<{ text: string; disabled: string | null; description: string | null }> {
  return combo.evaluate((el) => {
    const opt = document.getElementById(el.getAttribute('aria-activedescendant') ?? '') as HTMLElement;
    const described = opt.getAttribute('aria-describedby');
    return { text: opt.firstChild?.nextSibling?.textContent ?? '', disabled: opt.getAttribute('aria-disabled'), description: described === null ? null : document.getElementById(described)?.textContent ?? null };
  });
}

test('acceptance 3: a disabled option shows and announces its reason when focused by keyboard or hovered', async ({ page }) => {
  await open(page, 'section=primitives');
  const combo = page.getByRole('combobox', { name: /^Strategy/ }).first();
  await combo.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  expect(await activeOption(combo)).toEqual({ text: 'Launch breakout', disabled: 'true', description: 'Disabled in paper mode until the readiness gates pass' });
  const tip = page.getByRole('tooltip').filter({ hasText: 'Disabled in paper mode' });
  await expect(tip).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Unavailable: Disabled in paper mode until the readiness gates pass' })).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(combo).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowUp');
  await expect(tip).toBeHidden();
  await page.getByRole('option', { name: /Launch breakout/ }).hover();
  await expect(tip).toBeVisible();
  expect((await activeOption(combo)).disabled).toBe('true');
});

test('acceptance 4: tabbing through the primitives shows a 2px focus ring on every control, never obscured', async ({ page }) => {
  await open(page, 'section=primitives');
  await page.locator('h1').click();
  const seen: string[] = [];
  for (let i = 0; i < 200; i += 1) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (el === null || el === document.body) return null;
      const ring = (n: Element | null): boolean => n !== null && getComputedStyle(n).outlineStyle === 'solid' && getComputedStyle(n).outlineWidth === '2px';
      const holder = ring(el) ? el : ring(el.closest('.field__control')) ? el.closest('.field__control')
        : ring(el.nextElementSibling) ? el.nextElementSibling : null;
      const r = el.getBoundingClientRect();
      const target = el.matches('.segmented__input') ? (el.nextElementSibling as HTMLElement) : el;
      const t = target.getBoundingClientRect();
      const hit = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
      const inView = r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
      const covered = hit === null || !(target.contains(hit) || hit.contains(target) || hit.closest('label') === target.closest('label'));
      return { name: `${el.tagName.toLowerCase()} ${el.getAttribute('aria-label') ?? el.textContent?.slice(0, 24) ?? ''}`, ring: holder !== null, inView, covered };
    });
    if (info === null) break;
    if (seen.includes(info.name) && seen.length > 60) break;
    seen.push(info.name);
    expect(info.ring, `focus ring on ${info.name}`).toBe(true);
    expect(info.inView, `${info.name} in view`).toBe(true);
    expect(info.covered, `${info.name} not obscured`).toBe(false);
  }
  expect(seen.length).toBeGreaterThan(60);
});

test('Select follows the combobox pattern: arrows, Home, End, Enter, Escape, with focus on the combobox', async ({ page }) => {
  await open(page, 'section=primitives');
  const combo = page.getByRole('combobox', { name: /^Strategy/ }).first();
  await combo.focus();
  await page.keyboard.press('Enter');
  await expect(combo).toHaveAttribute('aria-expanded', 'true');
  expect((await activeOption(combo)).text).toBe('Mean reversion');
  await page.keyboard.press('End');
  expect((await activeOption(combo)).text).toBe('Arbitrage watch');
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  expect((await activeOption(combo)).text).toBe('Pool momentum');
  await expect(combo).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(combo).toHaveAttribute('aria-expanded', 'false');
  await expect(combo).toHaveText('Pool momentum');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await expect(combo).toHaveAttribute('aria-expanded', 'false');
  const search = page.getByRole('combobox', { name: 'Search strategies' });
  await search.fill('arb');
  await expect(page.getByRole('option')).toHaveCount(1);
  await page.keyboard.press('Enter');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
});

test('Menu follows the menu-button pattern: open, arrows, submenu, Escape returns focus to the trigger', async ({ page }) => {
  const done = watchConsole(page);
  await open(page, 'section=primitives');
  const trigger = page.getByRole('button', { name: 'Menu', exact: true });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu', { name: 'Menu' });
  await expect(menu).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /Copy mint/ })).toBeFocused();
  // Radix moves roving focus in a timeout after the keydown, so each key waits for the focus it moved.
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Open inspector' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Export' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menuitem', { name: 'As CSV' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('menuitem', { name: 'Export' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Export' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  done();
});

test('Tabs follow the tabs pattern: arrows select, Home and End, Tab moves into the panel', async ({ page }) => {
  await open(page, 'section=primitives');
  const first = page.getByRole('tab', { name: 'Overview' });
  await first.click();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /Risk checks/ })).toBeFocused();
  await expect(page.getByRole('tab', { name: /Risk checks/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveText('Risk checks panel');
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', { name: 'Price' })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Home');
  await expect(first).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tabpanel')).toBeFocused();
});

test('the context menu opens on right click and Escape closes it; tooltips open on focus at once', async ({ page }) => {
  const done = watchConsole(page);
  await open(page, 'section=primitives');
  await page.getByText('Context menu target').click({ button: 'right' });
  await expect(page.getByRole('menu', { name: 'Row actions' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toBeHidden();
  // C14: Escape returns focus to the trigger. Radix does that a moment after the menu leaves the DOM, so wait for it;
  // otherwise that late focus move takes focus from the next control (the CI failure on 32b8e4ed).
  await expect(page.getByText('Context menu target')).toBeFocused();
  await page.getByRole('button', { name: 'Tooltip' }).focus();
  await expect(page.getByRole('tooltip').filter({ hasText: 'Exact: 0.000000001 SOL' })).toBeVisible();
  done();
});

for (const theme of ['dark', 'light']) {
  test(`axe: every primitive state and overlay passes (${theme})`, async ({ page }) => {
    const done = watchConsole(page);
    for (const section of ['primitives', 'overlays', 'menu-open', 'popover-open', 'toast-stack']) {
      await open(page, `section=${section}&theme=${theme}`);
      await expect(page.locator('h2')).toBeVisible();
      await expectAccessible(page);
    }
    done();
  });
}

test('twelve danger toasts at 360 px: four show with "8 more", the stack stays in the viewport and scrolls (review M2)', async ({ page }) => {
  const done = watchConsole(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await open(page, 'section=toast-stack');
  const stack = page.locator('.toasts');
  const inViewport = async (): Promise<void> => {
    const box = await stack.boundingBox();
    expect(box?.y).toBeGreaterThanOrEqual(0);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(640);
  };
  await expect(stack.locator('.toast')).toHaveCount(4);
  await inViewport();
  // The page above the stack is not covered: the section heading takes the pointer.
  expect(await page.evaluate(() => document.elementFromPoint(24, 24)?.closest('.toasts') ?? null)).toBeNull();
  const more = page.getByRole('button', { name: '8 more' });
  await more.click();
  await expect(stack.locator('.toast')).toHaveCount(12);
  await expect(page.getByRole('button', { name: 'Show fewer' })).toHaveAttribute('aria-expanded', 'true');
  await inViewport();
  expect(await stack.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  // The newest toast, at the bottom of the scrolled stack, can be reached and dismissed.
  await stack.locator('.toast').last().getByRole('button', { name: 'Dismiss' }).click();
  await expect(stack.locator('.toast')).toHaveCount(11);
  await expectNoHorizontalScroll(page);
  await expectAccessible(page);
  done();
});

test('the primitives reflow at 360 px without page scroll', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await open(page, 'section=primitives');
  await expectNoHorizontalScroll(page);
});
