// Design tokens (UI-T02; docs/UI.md "Design system"): the one source for src/styles/tokens.css and
// src/styles/tokens.json (`npm run tokens` writes both; test/tokens.test.ts fails when either differs from this
// module). Values are the DS tables'. Two values the DS leaves open are chosen here and recorded in the PR: the
// blue/orange polarity tints (the DS gives only their foreground and mark colours) and the meter track (the DS pairs
// name its colour, the subtle border).

export type ThemeName = 'dark' | 'light';
export interface ThemeValue { dark: string; light: string }

/** Colour tokens, `--c-<name>`, dark (default) and light. */
export const COLOURS: Readonly<Record<string, ThemeValue>> = {
  // Neutral and surface tokens
  'bg-canvas': { dark: '#0b0c0e', light: '#f7f8fa' },
  'bg-surface-1': { dark: '#111317', light: '#ffffff' },
  'bg-surface-2': { dark: '#181b20', light: '#f1f3f6' },
  'bg-surface-3': { dark: '#1f232a', light: '#ffffff' },
  'bg-hover': { dark: '#15181c', light: '#f0f2f5' },
  'bg-selected': { dark: '#1b2333', light: '#e8eefc' },
  'border-subtle': { dark: '#23272e', light: '#e6e8ec' },
  'border-default': { dark: '#323740', light: '#d5d9df' },
  'border-control': { dark: '#666d78', light: '#7d8490' },
  'border-strong': { dark: '#4a505b', light: '#8f96a1' },
  'fg-primary': { dark: '#eceef1', light: '#16181d' },
  'fg-secondary': { dark: '#b3b9c3', light: '#454b55' },
  'fg-tertiary': { dark: '#8d939e', light: '#5f6672' },
  'fg-disabled': { dark: '#5d636d', light: '#9aa0a9' },
  scrim: { dark: 'rgba(0,0,0,0.62)', light: 'rgba(16,18,22,0.36)' },
  // Semantic tokens
  accent: { dark: '#7aa7ff', light: '#2f5fd0' },
  'accent-tint': { dark: '#152038', light: '#e5ecfb' },
  'on-accent': { dark: '#0a1020', light: '#ffffff' },
  pos: { dark: '#3fcf8e', light: '#137a48' },
  'pos-tint': { dark: '#0f2a1e', light: '#e3f4ea' },
  'pos-mark': { dark: '#22a06b', light: '#1e8f57' },
  neg: { dark: '#ff7a7a', light: '#c42b34' },
  'neg-tint': { dark: '#2e1416', light: '#fbe7e8' },
  'neg-mark': { dark: '#e5545a', light: '#d6363f' },
  warn: { dark: '#f2b84b', light: '#8a5a00' },
  'warn-tint': { dark: '#2b220f', light: '#fbf0d9' },
  'warn-fill': { dark: '#f2b84b', light: '#f2b84b' },
  'on-warn': { dark: '#1a1203', light: '#1a1203' },
  danger: { dark: '#ff6b6b', light: '#c0262e' },
  'danger-fill': { dark: '#ff6b6b', light: '#c0262e' },
  'on-danger': { dark: '#1a0505', light: '#ffffff' },
  info: { dark: '#6cb6ff', light: '#1f62b8' },
  paper: { dark: '#4fd1e0', light: '#0b7285' },
  'paper-tint': { dark: '#0d2629', light: '#e0f3f6' },
  'paper-fill': { dark: '#4fd1e0', light: '#0b7285' },
  'on-paper': { dark: '#05181b', light: '#ffffff' },
  live: { dark: '#e05cf0', light: '#a21caf' },
  'live-tint': { dark: '#2a0f2e', light: '#f8e4fb' },
  'live-fill': { dark: '#e05cf0', light: '#a21caf' },
  'on-live': { dark: '#16061a', light: '#ffffff' },
  // Offline mode uses neutrals (outline and bar)
  'offline-outline': { dark: '#666d78', light: '#7d8490' },
  'offline-bar': { dark: '#181b20', light: '#f1f3f6' },
  // Focus ring, text selection (accent at 30% alpha), meters
  focus: { dark: '#7aa7ff', light: '#2f5fd0' },
  selection: { dark: 'rgba(122,167,255,0.3)', light: 'rgba(47,95,208,0.3)' },
  'meter-track': { dark: '#23272e', light: '#e6e8ec' },
  'warn-meter': { dark: '#f2b84b', light: '#b07400' },
  // Data visualisation: gridlines, axis, categorical slots 1-8
  grid: { dark: '#1d2127', light: '#eceef1' },
  axis: { dark: '#3a3f48', light: '#c4c9d1' },
  'cat-1': { dark: '#3987e5', light: '#2a78d6' },
  'cat-2': { dark: '#d95926', light: '#eb6834' },
  'cat-3': { dark: '#199e70', light: '#1baf7a' },
  'cat-4': { dark: '#c98500', light: '#eda100' },
  'cat-5': { dark: '#d55181', light: '#e87ba4' },
  'cat-6': { dark: '#008300', light: '#008300' },
  'cat-7': { dark: '#9085e9', light: '#4a3aa7' },
  'cat-8': { dark: '#e66767', light: '#e34948' },
};

/** The CVD-safe polarity alternative (D-UI-02, `[data-polarity="blue-orange"]`): replaces the pos/neg tokens. */
export const POLARITY_ALT: Readonly<Record<string, ThemeValue>> = {
  pos: { dark: '#6cb6ff', light: '#1f62b8' },
  'pos-mark': { dark: '#3987e5', light: '#2a78d6' },
  'pos-tint': { dark: '#152038', light: '#e5ecfb' },
  neg: { dark: '#ff9e5c', light: '#b54708' },
  'neg-mark': { dark: '#d95926', light: '#eb6834' },
  'neg-tint': { dark: '#2d1a0f', light: '#fdeee3' },
};

/** Elevation shadows (e3 floating, e4 modal = e3 plus the modal shadow). */
export const SHADOWS: Readonly<Record<string, ThemeValue>> = {
  e3: { dark: '0 8px 24px rgba(0,0,0,0.40)', light: '0 8px 24px rgba(16,18,22,0.10)' },
  e4: { dark: '0 8px 24px rgba(0,0,0,0.40), 0 16px 48px rgba(0,0,0,0.55)', light: '0 8px 24px rgba(16,18,22,0.10), 0 16px 48px rgba(16,18,22,0.16)' },
};

export const FONT_SANS = '"Inter Variable", "Inter Fallback", system-ui, sans-serif';
export const FONT_MONO = '"JetBrains Mono Variable", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';

export interface TypeToken { size: number; line: number; weight: number; tracking: string; mono?: true }

/** Type scale, `--t-<name>` (font shorthand) and `--t-<name>-ls` (tracking). */
export const TYPE: Readonly<Record<string, TypeToken>> = {
  micro: { size: 11, line: 16, weight: 500, tracking: '0.01em' },
  mini: { size: 12, line: 16, weight: 400, tracking: '0' },
  small: { size: 13, line: 20, weight: 400, tracking: '-0.003em' },
  body: { size: 14, line: 20, weight: 400, tracking: '-0.006em' },
  label: { size: 13, line: 20, weight: 500, tracking: '-0.003em' },
  'title-sm': { size: 15, line: 22, weight: 600, tracking: '-0.01em' },
  title: { size: 18, line: 24, weight: 600, tracking: '-0.012em' },
  heading: { size: 24, line: 32, weight: 600, tracking: '-0.018em' },
  stat: { size: 28, line: 36, weight: 600, tracking: '-0.02em' },
  hero: { size: 40, line: 48, weight: 600, tracking: '-0.022em' },
  'mono-sm': { size: 12, line: 16, weight: 400, tracking: '0', mono: true },
  mono: { size: 13, line: 20, weight: 400, tracking: '0', mono: true },
};

/** Theme-independent tokens: spacing, radius, border, z-index, motion. */
export const SCALE: Readonly<Record<string, string>> = {
  '--s-0': '0', '--s-1': '2px', '--s-2': '4px', '--s-3': '6px', '--s-4': '8px', '--s-5': '12px', '--s-6': '16px',
  '--s-7': '20px', '--s-8': '24px', '--s-9': '32px', '--s-10': '40px', '--s-11': '48px', '--s-12': '64px',
  '--r-1': '4px', '--r-2': '6px', '--r-3': '8px', '--r-4': '12px', '--r-pill': '9999px', '--b-hair': '1px',
  '--z-sticky': '10', '--z-header': '100', '--z-drawer': '400', '--z-popover': '600', '--z-command': '650',
  '--z-dialog': '700', '--z-toast': '800', '--z-tooltip': '1100', '--z-mode-frame': '1300',
  '--d-instant': '0ms', '--d-fast': '100ms', '--d-base': '160ms', '--d-slow': '240ms', '--d-value-flash': '800ms',
  '--e-standard': 'cubic-bezier(.4,0,.2,1)', '--e-enter': 'cubic-bezier(.2,0,0,1)', '--e-exit': 'cubic-bezier(.4,0,1,1)',
  '--hold-to-confirm': '1000ms',
};

/** Table row height by density (`[data-density]`); standard is the default. */
export const DENSITY: Readonly<Record<'compact' | 'standard' | 'comfortable', string>> = { compact: '28px', standard: '32px', comfortable: '40px' };

/** Reduced motion: every duration token becomes 0ms except `--d-fast`, which opacity fades keep. */
export const REDUCED_MOTION_KEEP = ['--d-fast'];

/** Forced colours (`forced-colors: active`): borders and focus use system colours. */
export const FORCED_COLOURS: Readonly<Record<string, string>> = {
  '--c-border-subtle': 'CanvasText', '--c-border-default': 'CanvasText', '--c-border-control': 'CanvasText',
  '--c-border-strong': 'CanvasText', '--c-focus': 'Highlight', '--c-accent': 'Highlight', '--c-offline-outline': 'CanvasText',
};

export type PairKind = 'text' | 'non-text' | 'exempt';
/** A colour pair from the DS contrast tables, with the ratio the DS states. `fg`/`bg` name tokens of COLOURS (or alt:<name> for POLARITY_ALT). */
export interface ContrastPair { theme: ThemeName; fg: string; bg: string; kind: PairKind; expected: number }

const SURFACES = ['bg-canvas', 'bg-surface-1', 'bg-surface-2', 'bg-surface-3'];
const textTable = (theme: ThemeName, rows: ReadonlyArray<[string, readonly number[]]>): ContrastPair[] =>
  rows.flatMap(([fg, ratios]) => ratios.map((expected, i) => ({ theme, fg, bg: SURFACES[i] as string, kind: fg === 'fg-disabled' ? 'exempt' as const : 'text' as const, expected })));
const pairs = (theme: ThemeName, kind: PairKind, rows: ReadonlyArray<[string, string, number]>): ContrastPair[] =>
  rows.map(([fg, bg, expected]) => ({ theme, fg, bg, kind, expected }));

/** Every pair of the DS contrast tables (Contrast results, and the CVD-safe polarity alternative). */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...textTable('dark', [
    ['fg-primary', [16.83, 16.00, 14.85, 13.56]], ['fg-secondary', [9.92, 9.43, 8.75, 7.99]], ['fg-tertiary', [6.34, 6.02, 5.59, 5.10]],
    ['fg-disabled', [3.23, 3.07, 2.85, 2.61]], ['accent', [8.20, 7.79, 7.23, 6.61]], ['pos', [9.81, 9.32, 8.65, 7.90]],
    ['neg', [7.75, 7.36, 6.84, 6.24]], ['warn', [10.93, 10.39, 9.65, 8.81]], ['danger', [7.05, 6.70, 6.22, 5.68]],
    ['info', [9.11, 8.65, 8.03, 7.34]], ['paper', [10.74, 10.21, 9.48, 8.65]], ['live', [6.48, 6.16, 5.72, 5.22]],
  ]),
  ...textTable('light', [
    ['fg-primary', [16.71, 17.76, 15.98, 17.76]], ['fg-secondary', [8.27, 8.78, 7.90, 8.78]], ['fg-tertiary', [5.44, 5.78, 5.20, 5.78]],
    ['fg-disabled', [2.48, 2.63, 2.37, 2.63]], ['accent', [5.39, 5.72, 5.15, 5.72]], ['pos', [5.06, 5.38, 4.84, 5.38]],
    ['neg', [5.28, 5.61, 5.05, 5.61]], ['warn', [5.58, 5.93, 5.33, 5.93]], ['danger', [5.55, 5.90, 5.31, 5.90]],
    ['info', [5.65, 6.00, 5.40, 6.00]], ['paper', [5.26, 5.59, 5.02, 5.59]], ['live', [5.95, 6.32, 5.69, 6.32]],
  ]),
  ...pairs('dark', 'text', [
    ['on-live', 'live-fill', 6.47], ['on-paper', 'paper-fill', 10.00], ['on-danger', 'danger-fill', 7.09], ['on-accent', 'accent', 7.94],
    ['on-warn', 'warn-fill', 10.37], ['pos', 'pos-tint', 7.68], ['neg', 'neg-tint', 6.77], ['warn', 'warn-tint', 8.77],
    ['paper', 'paper-tint', 8.69], ['live', 'live-tint', 5.77], ['accent', 'bg-selected', 6.59], ['fg-primary', 'bg-selected', 13.53],
    ['fg-primary', 'bg-surface-2', 14.85],
  ]),
  ...pairs('light', 'text', [
    ['on-live', 'live-fill', 6.32], ['on-paper', 'paper-fill', 5.59], ['on-danger', 'danger-fill', 5.90], ['on-accent', 'accent', 5.72],
    ['on-warn', 'warn-fill', 10.37], ['pos', 'pos-tint', 4.71], ['neg', 'neg-tint', 4.73], ['warn', 'warn-tint', 5.24],
    ['paper', 'paper-tint', 4.87], ['live', 'live-tint', 5.26], ['accent', 'bg-selected', 4.92], ['fg-primary', 'bg-selected', 15.28],
    ['fg-primary', 'bg-surface-2', 15.98],
  ]),
  ...pairs('dark', 'non-text', [
    ['border-control', 'bg-surface-1', 3.56], ['border-control', 'bg-surface-2', 3.31], ['focus', 'bg-canvas', 8.20], ['focus', 'bg-surface-3', 6.61],
    ['live', 'bg-canvas', 6.48], ['paper', 'bg-canvas', 10.74], ['pos-mark', 'bg-surface-1', 5.59], ['neg-mark', 'bg-surface-1', 5.09],
    ['warn-meter', 'meter-track', 8.37], ['danger-fill', 'meter-track', 5.40],
  ]),
  ...pairs('light', 'non-text', [
    ['border-control', 'bg-surface-1', 3.77], ['border-control', 'bg-canvas', 3.54], ['focus', 'bg-surface-1', 5.72],
    ['live', 'bg-canvas', 5.95], ['paper', 'bg-canvas', 5.26], ['pos-mark', 'bg-surface-1', 4.10], ['neg-mark', 'bg-surface-1', 4.71],
    ['warn-meter', 'meter-track', 3.20], ['danger-fill', 'meter-track', 4.81],
  ]),
  // CVD-safe polarity alternative (DS Colour, "CVD-safe polarity alternative")
  ...pairs('dark', 'text', [['alt:pos', 'bg-surface-1', 8.65], ['alt:neg', 'bg-surface-1', 9.12]]),
  ...pairs('light', 'text', [['alt:pos', 'bg-surface-1', 6.00], ['alt:neg', 'bg-surface-1', 5.43]]),
  ...pairs('dark', 'non-text', [['alt:pos-mark', 'bg-surface-1', 5.11], ['alt:neg-mark', 'bg-surface-1', 4.79]]),
  ...pairs('light', 'non-text', [['alt:pos-mark', 'bg-surface-1', 4.42], ['alt:neg-mark', 'bg-surface-1', 3.20]]),
];

/** The value of token `name` (or `alt:<name>`) in `theme`. Throws for an unknown token. */
export function tokenValue(name: string, theme: ThemeName): string {
  const [table, key] = name.startsWith('alt:') ? [POLARITY_ALT, name.slice(4)] : [COLOURS, name];
  const value = table[key];
  if (value === undefined) throw new Error(`tokens: unknown colour token ${name}`);
  return value[theme];
}

/** sRGB relative luminance of `#rrggbb` (WCAG 2.2 definition, UI-F28). */
export function relativeLuminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`tokens: ${hex} is not #rrggbb`);
  const channel = (i: number): number => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG 2.2 contrast ratio `(L1 + 0.05) / (L2 + 0.05)`, lighter over darker. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The WCAG minimum for a pair kind (SC 1.4.3 text 4.5:1, SC 1.4.11 non-text 3:1); exempt pairs (disabled) have none. */
export function minimumRatio(kind: PairKind): number {
  return kind === 'text' ? 4.5 : kind === 'non-text' ? 3 : 0;
}

const block = (selector: string, decls: ReadonlyArray<readonly [string, string]>, indent = ''): string =>
  `${indent}${selector} {\n${decls.map(([k, v]) => `${indent}  ${k}: ${v};`).join('\n')}\n${indent}}\n`;

const themeDecls = (theme: ThemeName): Array<[string, string]> => [
  ['color-scheme', theme],
  ...Object.entries(COLOURS).map(([k, v]): [string, string] => [`--c-${k}`, v[theme]]),
  ...Object.entries(SHADOWS).map(([k, v]): [string, string] => [`--shadow-${k}`, v[theme]]),
];
const altDecls = (theme: ThemeName): Array<[string, string]> => Object.entries(POLARITY_ALT).map(([k, v]) => [`--c-${k}`, v[theme]]);
const reducedDecls = (): Array<[string, string]> =>
  Object.keys(SCALE).filter((k) => k.startsWith('--d-') && !REDUCED_MOTION_KEEP.includes(k)).map((k) => [k, '0ms']);

/** The tokens stylesheet (src/styles/tokens.css). */
export function tokensCss(): string {
  const typeDecls = Object.entries(TYPE).flatMap(([k, t]): Array<[string, string]> => [
    [`--t-${k}`, `${t.weight} ${t.size}px/${t.line}px var(${t.mono === true ? '--font-mono' : '--font-sans'})`],
    [`--t-${k}-ls`, t.tracking],
  ]);
  return [
    '/* Design tokens (UI-T02). Generated from src/theme/tokens.ts by `npm run tokens`; do not edit. */\n',
    block(':root', [
      ...themeDecls('dark'), ['--font-sans', FONT_SANS], ['--font-mono', FONT_MONO], ...typeDecls,
      ...Object.entries(SCALE), ['--row-h', DENSITY.standard],
    ]),
    block(':root[data-theme="light"]', themeDecls('light')),
    `@media (prefers-color-scheme: light) {\n${block(':root[data-theme="system"]', themeDecls('light'), '  ')}}\n`,
    block(':root[data-polarity="blue-orange"]', altDecls('dark')),
    block(':root[data-theme="light"][data-polarity="blue-orange"]', altDecls('light')),
    `@media (prefers-color-scheme: light) {\n${block(':root[data-theme="system"][data-polarity="blue-orange"]', altDecls('light'), '  ')}}\n`,
    block(':root[data-density="compact"]', [['--row-h', DENSITY.compact]]),
    block(':root[data-density="comfortable"]', [['--row-h', DENSITY.comfortable]]),
    block(':root[data-motion="reduced"]', reducedDecls()),
    `@media (prefers-reduced-motion: reduce) {\n${block(':root', reducedDecls(), '  ')}}\n`,
    // `:root[data-theme]` matches the theme blocks' specificity and comes later, so forced colours win in every theme.
    `@media (forced-colors: active) {\n${block(':root,\n  :root[data-theme]', Object.entries(FORCED_COLOURS), '  ')}}\n`,
  ].join('\n');
}

export interface TokensJson {
  colours: Record<ThemeName, Record<string, string>>;
  polarityAlt: Record<ThemeName, Record<string, string>>;
  shadows: Record<ThemeName, Record<string, string>>;
  type: Record<string, TypeToken>;
  scale: Record<string, string>;
  density: Record<string, string>;
  reducedMotionKeep: string[];
  contrastPairs: ContrastPair[];
}

/** The machine-readable tokens (src/styles/tokens.json) the contrast test reads. */
export function tokensJson(): TokensJson {
  const byTheme = (table: Readonly<Record<string, ThemeValue>>, theme: ThemeName): Record<string, string> =>
    Object.fromEntries(Object.entries(table).map(([k, v]) => [k, v[theme]]));
  return {
    colours: { dark: byTheme(COLOURS, 'dark'), light: byTheme(COLOURS, 'light') },
    polarityAlt: { dark: byTheme(POLARITY_ALT, 'dark'), light: byTheme(POLARITY_ALT, 'light') },
    shadows: { dark: byTheme(SHADOWS, 'dark'), light: byTheme(SHADOWS, 'light') },
    type: { ...TYPE },
    scale: { ...SCALE },
    density: { ...DENSITY },
    reducedMotionKeep: [...REDUCED_MOTION_KEEP],
    contrastPairs: [...CONTRAST_PAIRS],
  };
}
