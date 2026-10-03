import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
const rule = (selector: string): string => {
  const m = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  return m?.[1] ?? '';
};

describe('safe-area insets', () => {
  it('reads env() only where the --inset-* variables are defined, so the Android values apply everywhere', () => {
    const outside = css.replace(/--inset-[a-z]+:[^;]*;/g, '');
    expect(outside).not.toMatch(/env\(safe-area/);
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(css).toMatch(new RegExp(`--inset-${side}: max\\(env\\(safe-area-inset-${side}, 0px\\), var\\(--safe-area-inset-${side}, 0px\\)\\)`));
    }
  });

  it('keeps the header, tab bar, page padding and sheets clear of the system bars', () => {
    expect(rule('.mobile-head')).toContain('var(--inset-top)');
    expect(rule('.tabs')).toContain('var(--inset-bottom)');
    expect(css).toMatch(/\.main \{[^}]*var\(--inset-bottom\)/);
    expect(rule('.sheet-full')).toContain('var(--inset-top)');
    expect(rule('.sheet-foot')).toContain('var(--inset-bottom)');
  });

  it('turns off selection and the long-press callout on controls', () => {
    expect(css).toMatch(/button,[^{]*\{[^}]*user-select: none[^}]*-webkit-touch-callout: none/);
  });

  it('lets the page draw behind the bars (viewport-fit=cover)', () => {
    const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');
    expect(html).toContain('viewport-fit=cover');
  });
});
