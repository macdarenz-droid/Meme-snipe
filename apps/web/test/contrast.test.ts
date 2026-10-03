import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CALENDAR_TINT_MAX, checkTheme, contrastRatio, mix, parseThemes, withDerived } from '../src/theme/contrast.ts';

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

  it('mixes like CSS color-mix in srgb', () => {
    expect(mix('#000000', '#FFFFFF', 50)).toBe('#808080');
    expect(mix('#FF0000', '#0000FF', 25)).toBe('#4000BF');
  });

  it('checks text on the strongest calendar tint', () => {
    expect(Object.keys(withDerived(themes['paper'] ?? {}))).toEqual(expect.arrayContaining(['--tint-gain-max', '--tint-loss-max']));
    // Secondary text on the strongest tint is the pair the review caught; it must fail if used.
    const t = withDerived(themes['black'] ?? {});
    expect(contrastRatio(t['--text-2'] ?? '', t['--tint-gain-max'] ?? '')).toBeLessThan(4.5);
    expect(CALENDAR_TINT_MAX).toBe(32);
  });

  it('fails a seeded tint that drowns the calendar text', () => {
    // As if the day numbers kept secondary text: the tinted pair must fail.
    const bad = { ...themes['black'], '--text': themes['black']?.['--text-2'] ?? '' };
    expect(checkTheme(bad).some((f) => f.bg === '--tint-gain-max')).toBe(true);
  });

  it('fails when a token is missing', () => {
    const bad: Record<string, string> = { ...themes['black'] };
    delete bad['--loss'];
    expect(checkTheme(bad).some((f) => f.fg === '--loss')).toBe(true);
  });
});
