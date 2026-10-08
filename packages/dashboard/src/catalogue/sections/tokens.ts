// Catalogue section "Tokens" (UI-T02): every colour token as a swatch, the text tokens on each surface, the type,
// spacing, radius and elevation scales, and a drawer that slides with the motion tokens (reduced motion: no slide).
import { createElement as h, useState, type ReactElement } from 'react';
import { COLOURS, POLARITY_ALT, SCALE, TYPE } from '../../theme/tokens.ts';
import type { Section } from '../catalogue.ts';

const GROUPS: ReadonlyArray<[string, (name: string) => boolean]> = [
  ['Neutrals', (n) => n.startsWith('bg-') || n.startsWith('border-') || n.startsWith('fg-') || n === 'scrim'],
  ['Data visualisation', (n) => n.startsWith('cat-') || n === 'grid' || n === 'axis'],
  ['Semantic', () => true],
];

/** Token names by swatch group, each name in exactly one group (the first that matches). */
export function swatchGroups(names: readonly string[]): Array<[string, string[]]> {
  const left = [...names];
  return GROUPS.map(([title, match]) => [title, left.filter(match).map((n) => { left.splice(left.indexOf(n), 1); return n; })]);
}

function Swatch(props: { name: string }): ReactElement {
  const value = COLOURS[props.name] as { dark: string; light: string };
  const alt = POLARITY_ALT[props.name];
  return h('li', { className: 'swatch' },
    h('span', { className: 'swatch__chip', style: { background: `var(--c-${props.name})` } }),
    h('code', { className: 'swatch__name' }, `--c-${props.name}`),
    h('span', { className: 'swatch__value' }, `${value.dark} / ${value.light}`),
    alt === undefined ? null : h('span', { className: 'swatch__value' }, `blue-orange: ${alt.dark} / ${alt.light}`));
}

const TEXT_TOKENS = ['fg-primary', 'fg-secondary', 'fg-tertiary', 'accent', 'pos', 'neg', 'warn', 'danger', 'info', 'paper', 'live'];
const SURFACES = ['bg-canvas', 'bg-surface-1', 'bg-surface-2', 'bg-surface-3'];

/** A drawer that slides in with `--d-slow` and fades with `--d-fast`; under reduced motion only the fade runs. */
export function MotionDemo(): ReactElement {
  const [open, setOpen] = useState(false);
  return h('div', { className: 'motion-demo' },
    h('button', { type: 'button', className: 'motion-demo__toggle', 'aria-expanded': open, 'aria-controls': 'motion-demo-drawer', onClick: () => setOpen(!open) },
      open ? 'Close drawer' : 'Open drawer'),
    h('div', { id: 'motion-demo-drawer', className: 'motion-demo__drawer', 'data-open': open, role: 'region', 'aria-label': 'Drawer' }, 'Drawer content'));
}

function Tokens(): ReactElement {
  return h('div', { className: 'tokens' },
    swatchGroups(Object.keys(COLOURS)).map(([title, names]) => h('div', { key: title },
      h('h3', { className: 'tokens__heading' }, title),
      h('ul', { className: 'swatches' }, names.map((n) => h(Swatch, { key: n, name: n }))))),
    h('h3', { className: 'tokens__heading' }, 'Text on surfaces'),
    h('div', { className: 'text-grid' }, TEXT_TOKENS.map((fg) => SURFACES.map((bg) =>
      h('div', { key: `${fg}/${bg}`, className: 'text-grid__cell', style: { background: `var(--c-${bg})`, color: `var(--c-${fg})` } }, `${fg} on ${bg.replace('bg-', '')}`)))),
    h('h3', { className: 'tokens__heading' }, 'Type'),
    h('ul', { className: 'type-scale' }, Object.keys(TYPE).map((t) =>
      h('li', { key: t, style: { font: `var(--t-${t})`, letterSpacing: `var(--t-${t}-ls)` } }, `--t-${t} Realised PnL +0.0123 SOL`))),
    h('h3', { className: 'tokens__heading' }, 'Spacing'),
    h('ul', { className: 'space-scale' }, Object.keys(SCALE).filter((k) => k.startsWith('--s-')).map((k) =>
      h('li', { key: k }, h('code', null, k), h('span', { className: 'space-scale__bar', style: { width: `var(${k})` } })))),
    h('h3', { className: 'tokens__heading' }, 'Radius and elevation'),
    h('ul', { className: 'boxes' },
      ['--r-1', '--r-2', '--r-3', '--r-4', '--r-pill'].map((r) => h('li', { key: r, className: 'boxes__box', style: { borderRadius: `var(${r})` } }, r)),
      ['e1', 'e2', 'e3', 'e4'].map((e) => h('li', { key: e, className: `boxes__box boxes__box--${e}` }, e))),
    h('h3', { className: 'tokens__heading' }, 'Motion'),
    h(MotionDemo));
}

export const tokensSection: Section = { id: 'tokens', title: 'Tokens', render: () => h(Tokens) };
