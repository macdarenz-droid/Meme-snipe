import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkTheme, contrastRatio, parseThemes } from '../src/theme/contrast.ts';

const css = readFileSync(new URL('../src/theme/tokens.css', import.meta.url), 'utf8');
const themes = parseThemes(css);

describe('theme contrast', () => {
  it('defines exactly two themes, Paper and Silent Black', () => {
    expect(Object.keys(themes).sort()).toEqual(['black', 'paper']);
  });

  for (const name of ['paper', 'black']) {
    it(`${name}: every text and chart pair meets WCAG AA`, () => {
      const failures = checkTheme(themes[name] ?? {});
      expect(failures.map((f) => `${f.fg} on ${f.bg} (${f.use}) ${f.ratio.toFixed(2)} < ${f.min}`)).toEqual([]);
    });
  }

  it('computes known ratios', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });

  it('fails a seeded low-contrast theme', () => {
    const bad = { ...themes['paper'], '--text-2': '#B0B0B0' };
    const failures = checkTheme(bad);
    expect(failures.some((f) => f.fg === '--text-2' && f.use === 'text')).toBe(true);
  });

  it('fails when a token is missing', () => {
    const bad: Record<string, string> = { ...themes['black'] };
    delete bad['--loss'];
    expect(checkTheme(bad).some((f) => f.fg === '--loss')).toBe(true);
  });
});
