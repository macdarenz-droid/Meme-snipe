export type ThemeName = 'paper' | 'black';
export type Tokens = Record<string, string>;

/** WCAG 2.2 relative luminance of a #RRGGBB colour. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m?.[1]) throw new Error(`Not a #RRGGBB colour: ${hex}`);
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Strongest P&L calendar tint, in percent of gain/loss mixed into the surface. */
export const CALENDAR_TINT_MAX = 32;

/** CSS color-mix(in srgb, a p%, b): straight interpolation of the encoded channels. */
export function mix(a: string, b: string, percentA: number): string {
  const ch = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [ch(a), ch(b)];
  const p = percentA / 100;
  return `#${x.map((v, i) => Math.round(v * p + (y[i] ?? 0) * (1 - p)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

/** Adds the surfaces the app derives from tokens, so their text pairs are checked too. */
export function withDerived(tokens: Tokens): Tokens {
  const out = { ...tokens };
  const surface = tokens['--surface'];
  for (const tone of ['gain', 'loss']) {
    const c = tokens[`--${tone}`];
    if (c && surface) out[`--tint-${tone}-max`] = mix(c, surface, CALENDAR_TINT_MAX);
  }
  return out;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export interface Pair {
  fg: string;
  bg: string;
  /** 4.5 for text (WCAG 1.4.3), 3 for chart marks and focus rings (WCAG 1.4.11). */
  min: number;
  use: string;
}

const SURFACES = ['--bg', '--surface', '--raised'];
const TEXT = ['--text', '--text-2', '--accent', '--gain', '--loss'];
const MARKS = ['--text', '--text-2', '--accent', '--gain', '--loss'];

/** Every foreground/background pair the app draws. */
export function pairs(): Pair[] {
  const out: Pair[] = [];
  for (const bg of SURFACES) {
    for (const fg of TEXT) out.push({ fg, bg, min: 4.5, use: 'text' });
    for (const fg of MARKS) out.push({ fg, bg, min: 3, use: 'chart mark' });
  }
  out.push({ fg: '--accent-fg', bg: '--accent', min: 4.5, use: 'button text' });
  for (const bg of ['--tint-gain-max', '--tint-loss-max']) out.push({ fg: '--text', bg, min: 4.5, use: 'calendar text' });
  return out;
}

export interface Failure extends Pair {
  ratio: number;
}

export function checkTheme(base: Tokens): Failure[] {
  const tokens = withDerived(base);
  const failures: Failure[] = [];
  for (const p of pairs()) {
    const fg = tokens[p.fg];
    const bg = tokens[p.bg];
    if (!fg || !bg) {
      failures.push({ ...p, ratio: 0 });
      continue;
    }
    const ratio = contrastRatio(fg, bg);
    if (ratio < p.min) failures.push({ ...p, ratio });
  }
  return failures;
}

/** Reads `:root[data-theme='x'] { --name: #hex; }` blocks from a stylesheet. */
export function parseThemes(css: string): Record<string, Tokens> {
  const themes: Record<string, Tokens> = {};
  const block = /:root\[data-theme=['"]?(\w+)['"]?\]\s*\{([^}]*)\}/g;
  for (const m of css.matchAll(block)) {
    const name = m[1] ?? '';
    const tokens: Tokens = {};
    for (const d of (m[2] ?? '').matchAll(/(--[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
      if (d[1] && d[2]) tokens[d[1]] = d[2];
    }
    themes[name] = tokens;
  }
  return themes;
}
