// Catalogue sections "Typography" and "Numbers" (UI-T03): the type specimen, and a gallery of every quantity of the
// DS formatting table with its display text, exact tooltip text and accessible label.
import { createElement as h, type ReactElement } from 'react';
import { Num } from '../../components/num.ts';
import { SAMPLE_ADDRESS, SAMPLE_MINT } from '../../fixtures.ts';
import {
  formatAge, formatBps, formatDuration, formatFeeLamports, formatLamports, formatMicroLamportsPerCu, formatPrice, formatSlot, formatSol,
  formatTime, formatTokenAmount, formatUsdE6, sanitizeUntrusted, truncateMiddle, type Formatted,
} from '../../lib/money.ts';
import { TYPE } from '../../theme/tokens.ts';
import type { Section } from '../catalogue.ts';

const AS_OF = '2026-10-06T14:02:11.123Z';
const NOW = Date.parse('2026-10-06T14:06:23.123Z');

/** [quantity, wire value, formatted] rows of the number gallery. */
export const GALLERY: ReadonlyArray<readonly [string, string, Formatted]> = [
  ['SOL balance', '"1234567890123"', formatSol('1234567890123')],
  ['SOL, rounds to zero', '"1"', formatSol('1')],
  ['SOL, u64 maximum', '"18446744073709551615"', formatSol('18446744073709551615')],
  ['SOL, compact', '"12400000000000000"', formatSol('12400000000000000', { compact: true })],
  ['PnL, profit', '"12300000"', formatSol('12300000', { signed: true })],
  ['PnL, loss', '"-4500000"', formatSol('-4500000', { signed: true })],
  ['PnL, zero', '"0"', formatSol('0', { signed: true })],
  ['PnL, i64 minimum', '"-9223372036854775808"', formatSol('-9223372036854775808', { signed: true })],
  ['Fee per signature', '"5000"', formatFeeLamports('5000')],
  ['Priority fee', '"2500001"', formatFeeLamports('2500001')],
  ['Lamports', '"1"', formatLamports('1')],
  ['Compute-unit price', '"1500"', formatMicroLamportsPerCu('1500')],
  ['Token amount', '"123456789", 6', formatTokenAmount('123456789', 6)],
  ['Token amount, 18 decimals', '"18446744073709551615", 18', formatTokenAmount('18446744073709551615', 18)],
  ['Token amount, compact', '"12400000000000", 6', formatTokenAmount('12400000000000', 6, { compact: true })],
  ['Price', '"0.000004321"', formatPrice('0.000004321')],
  ['Price', '"0.000000000123"', formatPrice('0.000000000123')],
  ['Price', '"12.3456"', formatPrice('12.3456')],
  ['USD', '"1234560000"', formatUsdE6('1234560000', { approx: true })],
  ['USD, under one cent', '"4999"', formatUsdE6('4999')],
  ['USD PnL', '"-1234567891"', formatUsdE6('-1234567891', { signed: true })],
  ['Fee rate', '35', formatBps(35, { as: 'bps' })],
  ['Win rate', '5234', formatBps(5234, { as: 'pct' })],
  ['Return', '-1250', formatBps(-1250, { as: 'pct', signed: true })],
  ['Latency', '0.4', formatDuration(0.4)],
  ['Latency', '85.4', formatDuration(85.4)],
  ['Latency', '1200', formatDuration(1200)],
  ['Age', `"${AS_OF}"`, formatAge(AS_OF, NOW, 0)],
  ['Time (UTC)', `"${AS_OF}"`, formatTime(AS_OF)],
  ['Slot', '"312345678"', formatSlot('312345678')],
  ['Unknown', 'null', formatSol(null)],
];

function Gallery(): ReactElement {
  const symbols = ['BONK', 'US\u202EDC Тест very long symbol'].map((s) => sanitizeUntrusted(s, 12));
  const mint = SAMPLE_MINT;
  return h('div', { className: 'gallery' },
    h('table', { className: 'gallery__table' },
      h('thead', null, h('tr', null, ['Quantity', 'Wire value', 'Shown', 'Exact (tooltip)'].map((c) => h('th', { key: c, scope: 'col' }, c)))),
      h('tbody', null, GALLERY.map(([q, wire, f], i) => h('tr', { key: i },
        h('td', null, q), h('td', null, h('code', null, wire)), h('td', { className: 'gallery__shown' }, h(Num, { value: f })), h('td', null, f.tooltip))))),
    h('p', { className: 'gallery__ids' },
      h('code', { title: mint }, truncateMiddle(mint)),
      symbols.map((s) => h('span', { key: s.full }, ' ', s.text, s.nonLatin ? h('span', { className: 'gallery__flag' }, ' ? mixed scripts') : null))));
}

function Typography(): ReactElement {
  return h('div', { className: 'typography' },
    Object.keys(TYPE).map((t) => h('p', { key: t, className: 'typography__sample', style: { font: `var(--t-${t})`, letterSpacing: `var(--t-${t}-ls)` } },
      h('code', { className: 'typography__token' }, `--t-${t}`), ' Realised PnL after costs')),
    h('p', { className: 'typography__figures num' }, '0123456789 1,111.1111 SOL'),
    h('p', { className: 'typography__figures typography__fallback' }, 'Inter Fallback: Realised PnL after costs 0123456789'),
    h('p', { className: 'typography__figures' }, h('code', null, SAMPLE_ADDRESS)));
}

export const typographySection: Section = { id: 'typography', title: 'Typography', render: () => h(Typography) };
export const numbersSection: Section = { id: 'numbers', title: 'Numbers', render: () => h(Gallery) };
