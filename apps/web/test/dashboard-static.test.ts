import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseThemes } from '../src/theme/contrast.ts';

/**
 * Source rules for the dashboard (UI-2): money is never turned into a float
 * for arithmetic, sums across records only go through the mode-checked
 * helpers in src/api/modes.ts, and dashboard.css uses only checked theme tokens.
 */
const src = fileURLToPath(new URL('../src', import.meta.url));
const filesIn = (dir: string) => readdirSync(join(src, dir)).filter((f) => /\.tsx?$/.test(f)).map((f) => [`${dir}/${f}`, readFileSync(join(src, dir, f), 'utf8')] as const);
const code = [...filesIn('dashboard'), ...filesIn('api'), ['screens/Snipe.tsx', readFileSync(join(src, 'screens/Snipe.tsx'), 'utf8')] as const];

describe('dashboard source rules', () => {
  it('never parses money as a float', () => {
    const hits = code.flatMap(([f, s]) => [...s.matchAll(/(?:parseFloat|parseInt|Number)\([^)]*Usd\b/g)].map((m) => `${f}: ${m[0]}`));
    expect(hits).toEqual([]);
  });

  it('sums money only through the mode-checked totals', () => {
    const hits = code
      .filter(([f]) => f !== 'api/modes.ts')
      .flatMap(([f, s]) => [...s.matchAll(/\b(addUsd|subUsd|fromMicro\([^)]*\+)|reduce\([\s\S]{0,80}?Usd/g)].map((m) => `${f}: ${m[0]}`));
    expect(hits).toEqual([]);
  });

  it('the checks themselves catch seeded mistakes', () => {
    expect('const n = Number(t.netUsd) + 1;').toMatch(/(?:parseFloat|parseInt|Number)\([^)]*Usd\b/);
    expect('days.reduce((s, d) => s + d.netUsd, 0)').toMatch(/reduce\([\s\S]{0,80}?Usd/);
  });

  it('dashboard.css uses only theme tokens the contrast test checks', () => {
    const css = readFileSync(join(src, 'dashboard/dashboard.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|oklch\(|:\s*(white|black|transparent)\b/i);
    const used = new Set([...css.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]));
    const paper = parseThemes(readFileSync(join(src, 'theme/tokens.css'), 'utf8'))['paper'] ?? {};
    const checked = ['--bg', '--surface', '--raised', '--border', '--text', '--text-2', '--accent', '--gain', '--loss'];
    for (const t of used) {
      expect(checked, `${t} is not a checked token`).toContain(t);
      expect(Object.keys(paper)).toContain(t);
    }
  });

  it('text sizes stay readable in every stylesheet, phone widths included', () => {
    for (const f of ['dashboard/dashboard.css', 'styles.css']) {
      const css = readFileSync(join(src, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      // Every font-size is in whole px, so none escapes the check; and the check is never empty.
      const all = [...css.matchAll(/font-size:\s*([^;}]+)/g)].map((m) => m[1]!.trim());
      expect(all.length, f).toBeGreaterThan(0);
      for (const v of all) expect(v, `${f}: font-size ${v}`).toMatch(/^\d+px$/);
      expect(Math.min(...all.map((v) => parseInt(v, 10))), f).toBeGreaterThanOrEqual(11);
    }
  });
});
