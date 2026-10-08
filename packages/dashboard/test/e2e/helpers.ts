// Shared browser-test helpers (UI-T01): axe with the WCAG 2.0/2.1/2.2 A and AA rule tags (UI.md, common Definition of
// done 4), and a console watch that fails a test on any error, including a CSP violation.
import { AxeBuilder } from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'];

/** Runs axe on the page (or `include`) and expects no violations. */
export async function expectAccessible(page: Page, include?: string): Promise<void> {
  const builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  const results = await (include === undefined ? builder : builder.include(include)).analyze();
  expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

/** Collects console errors and page errors; call the returned function at the end to expect none. */
export function watchConsole(page: Page): () => void {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  return () => expect(errors).toEqual([]);
}

/** Expects the page to have no horizontal scroll at the current viewport (WCAG 1.4.10 reflow; owner: 360-400 px). */
export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const [scroll, client] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(scroll).toBeLessThanOrEqual(client as number);
}
