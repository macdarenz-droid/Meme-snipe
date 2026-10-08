// UI-T07 in a browser: acceptance 1 (case-sensitive typed phrase), 2 (hold released at 700 ms), 3 (LIVE: title,
// announced as the dialog's accessible name), 4 (Esc returns focus to the trigger); the focus trap, initial focus,
// HALT by keyboard, disconnected and mode-change edge cases, axe in both themes and in paper and live, and reflow.
import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, expectNoHorizontalScroll, watchConsole } from './helpers.ts';

const open = async (page: Page, query: string): Promise<void> => {
  await page.goto(`/catalogue?section=dialog-open&${query}`);
  await page.evaluate(() => document.fonts.ready);
};
const out = (page: Page) => page.locator('output[data-confirms]');
/** Waits for the open dialog's entry fade to end (axe reads colours, and a fading dialog is part transparent). */
const settled = async (page: Page): Promise<void> => {
  await page.getByRole('alertdialog').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
};

test('acceptance 1: typing `live-small 0.25` for `LIVE-SMALL 0.25` keeps confirm disabled and shows the case mismatch', async ({ page }) => {
  const done = watchConsole(page);
  await open(page, 'mode=live_small');
  await page.getByRole('button', { name: 'Switch to LIVE-SMALL' }).click();
  const dialog = page.getByRole('alertdialog');
  const confirm = dialog.getByRole('button', { name: /Switch mode/ });
  const input = dialog.getByLabel('Type LIVE-SMALL 0.25 to confirm');
  await input.fill('live-small 0.25');
  await expect(confirm).toHaveAttribute('aria-disabled', 'true');
  await expect(input).toHaveAccessibleDescription(/Letter case does not match\. The phrase is case-sensitive\./);
  await expect(dialog.locator('.phrase__char--case')).toHaveCount(9);
  await confirm.click({ force: true });
  await expect(out(page)).toHaveAttribute('data-confirms', '0');
  await input.fill('LIVE-SMALL 0.25');
  await expect(confirm).not.toHaveAttribute('aria-disabled', 'true');
  await confirm.click();
  await expect(out(page)).toHaveAttribute('data-last', 'typed');
  done();
});

test('acceptance 2: a HoldButton released at 700 ms fires no confirm; held for 1000 ms it confirms', async ({ page }) => {
  await open(page, 'mode=paper');
  const hold = page.getByRole('button', { name: 'Halt', exact: true });
  const box = await hold.boundingBox();
  if (box === null) throw new Error('no hold button');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await expect(hold).toHaveAttribute('data-state', 'holding');
  await page.waitForTimeout(700);
  await page.mouse.up();
  await expect(hold).toHaveAttribute('data-state', 'released-early');
  await page.waitForTimeout(1200);
  await expect(out(page)).toHaveAttribute('data-confirms', '0');
  await expect(hold).toHaveAttribute('data-state', 'idle');
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await page.mouse.down();
  await page.waitForTimeout(1150);
  await page.mouse.up();
  await expect(out(page)).toHaveAttribute('data-confirms', '1');
  await expect(out(page)).toHaveAttribute('data-last', 'hold');
});

test('a touch hold cancelled by the browser rewinds and confirms nothing', async ({ page }) => {
  await open(page, 'mode=paper');
  const hold = page.getByRole('button', { name: 'Halt', exact: true });
  await hold.dispatchEvent('pointerdown', { button: 0, pointerId: 7, pointerType: 'touch', isPrimary: true });
  await page.waitForTimeout(400);
  await hold.dispatchEvent('pointercancel', { pointerId: 7, pointerType: 'touch' });
  await page.waitForTimeout(1000);
  await expect(out(page)).toHaveAttribute('data-confirms', '0');
});

test('HALT by keyboard: Enter on the HoldButton opens the HALT dialog with focus on "Halt now", and Enter confirms', async ({ page }) => {
  await open(page, 'mode=paper');
  const hold = page.getByRole('button', { name: 'Halt', exact: true });
  await hold.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', { name: 'Paper: Halt trading' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Halt now' })).toBeFocused();
  await expect(out(page)).toHaveAttribute('data-confirms', '0');
  await page.keyboard.press('Enter');
  await expect(out(page)).toHaveAttribute('data-last', 'halt-dialog');
  await expect(hold).toBeFocused();
  await page.keyboard.press('Space');
  await expect(dialog).toBeVisible();
});

test('acceptance 3: in live, a money-affecting dialog\'s title starts with "LIVE:" and is its accessible name', async ({ page }) => {
  await open(page, 'mode=live_small');
  await page.getByRole('button', { name: 'Close position' }).click();
  const dialog = page.getByRole('alertdialog', { name: /^LIVE: / });
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName('LIVE: Close position');
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog).toHaveAccessibleDescription('Sell 1,234,567 BONK at market now.');
  const border = await dialog.evaluate((el) => getComputedStyle(el).borderTopColor);
  const live = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--c-live)';
    document.body.append(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    return c;
  });
  expect(border).toBe(live);
});

test('acceptance 4: Esc closes the dialog and focus returns to the triggering control', async ({ page }) => {
  await open(page, 'mode=paper');
  const trigger = page.getByRole('button', { name: 'Close position' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(out(page)).toHaveAttribute('data-last', 'standard-escape');
});

test('focus is trapped: Tab and Shift+Tab cycle inside the dialog and the page behind is inert', async ({ page }) => {
  await open(page, 'mode=paper');
  await page.getByRole('button', { name: 'Switch to LIVE-SMALL' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  const inDialog = (): Promise<boolean> => page.evaluate(() => document.activeElement?.closest('dialog') !== null);
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Tab');
    expect(await inDialog()).toBe(true);
  }
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Shift+Tab');
    expect(await inDialog()).toBe(true);
  }
  await page.getByRole('button', { name: 'Close position' }).click({ force: true, timeout: 2000 }).catch(() => undefined);
  await expect(page.getByRole('alertdialog', { name: /Switch to LIVE-SMALL/ })).toBeVisible();
});

test('disconnected: a non-HALT dialog says so and its submit is disabled; HALT stays enabled', async ({ page }) => {
  await open(page, 'mode=paper&connection=disconnected');
  await page.getByRole('button', { name: 'Close position' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog.locator('.banner').getByText('Disconnected · cannot confirm current state')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Close position' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: 'Halt', exact: true }).focus();
  await page.keyboard.press('Enter');
  const halt = page.getByRole('alertdialog', { name: /Halt trading/ });
  await expect(halt.getByRole('button', { name: 'Halt now' })).not.toHaveAttribute('aria-disabled', 'true');
  await halt.getByRole('button', { name: 'Halt now' }).click();
  await expect(out(page)).toHaveAttribute('data-last', 'halt-dialog');
});

test('a mode change while open closes the dialog and says "Mode changed to LIVE-SMALL — review again"', async ({ page }) => {
  await open(page, 'mode=paper');
  const trigger = page.getByRole('button', { name: 'Switch to LIVE-SMALL' });
  await trigger.click();
  await expect(page.getByRole('alertdialog', { name: 'Paper: Switch to LIVE-SMALL' })).toBeVisible();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('catalogue:set-mode', { detail: 'live_small' })));
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('alert').filter({ hasText: 'Mode changed to LIVE-SMALL — review again' })).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(page.getByRole('alertdialog', { name: 'LIVE: Switch to LIVE-SMALL' })).toBeVisible();
});

test('reduced motion: the dialog opens with an opacity fade and no transform', async ({ page }) => {
  await open(page, 'mode=paper');
  await page.getByRole('button', { name: 'Close position' }).click();
  const name = await page.getByRole('alertdialog').evaluate((el) => getComputedStyle(el).animationName);
  expect(name).toBe('dialog-fade');
});

for (const theme of ['dark', 'light']) {
  test(`axe: every dialog state in paper and live (${theme})`, async ({ page }) => {
    const done = watchConsole(page);
    await page.goto(`/catalogue?section=dialogs&theme=${theme}`);
    await page.evaluate(() => document.fonts.ready);
    await expectAccessible(page);
    done();
  });
}

for (const mode of ['paper', 'live_small']) {
  test(`axe: open modal dialogs in ${mode}`, async ({ page }) => {
    await open(page, `mode=${mode}`);
    await page.getByRole('button', { name: 'Switch to LIVE-SMALL' }).click();
    await page.getByRole('alertdialog').getByLabel(/Type LIVE-SMALL/).fill('live');
    await settled(page);
    await expectAccessible(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Halt', exact: true }).focus();
    await page.keyboard.press('Enter');
    await settled(page);
    await expectAccessible(page);
  });
}

test('reflow at 360 px: dialogs and the gallery fit without horizontal scroll', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/catalogue?section=dialogs');
  await expectNoHorizontalScroll(page);
  await open(page, 'mode=live_small');
  await page.getByRole('button', { name: 'Switch to LIVE-SMALL' }).click();
  await expectNoHorizontalScroll(page);
  const box = await page.getByRole('alertdialog').boundingBox();
  expect(box?.width ?? 999).toBeLessThanOrEqual(360);
});

test('Z05 round 2: with the mode unknown or the stream reconnecting, a money confirm is disabled with its reason; HALT is not', async ({ page }) => {
  for (const [query, reason] of [['mode=unknown', 'Mode unknown · cannot confirm current state'], ['mode=live_small&connection=reconnecting', 'Reconnecting · cannot confirm current state']] as const) {
    await open(page, query);
    await page.getByRole('button', { name: 'Close position' }).click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog.locator('.banner').getByText(reason)).toBeVisible();
    const confirm = dialog.getByRole('button', { name: /^Close position/ });
    await expect(confirm).toHaveAttribute('aria-disabled', 'true');
    await expect(confirm).toHaveAccessibleDescription(reason);
    await confirm.click({ force: true });
    await expect(out(page)).toHaveAttribute('data-confirms', '0');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: 'Halt', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Halt now' }).click();
    await expect(out(page)).toHaveAttribute('data-last', 'halt-dialog');
  }
});

test('Z05 round 2: a change to an unknown mode while open closes the dialog with "Mode unknown — review again"', async ({ page }) => {
  await open(page, 'mode=paper');
  await page.getByRole('button', { name: 'Close position' }).click();
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('catalogue:set-mode', { detail: 'unknown' })));
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  await expect(page.getByRole('alert').filter({ hasText: 'Mode unknown — review again' })).toBeVisible();
});
