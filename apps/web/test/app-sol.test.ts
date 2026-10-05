// APP-SOL (owner, 2026-10-05): success is counted in SOL. Every money figure shows SOL first, exact from the worker's
// lamports, with dollars only as a small line under it at the current SOL price; Return is net lamports ÷ entry lamports.
// A worker that serves no lamports still shows dollars, as before.
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CalendarMonth, ChartsView, PositionRecord, RiskMeter, StatsView, TradeRecord } from '../src/api/contract.ts';
import { Money, SolPriceContext } from '../src/components/Money.tsx';
import { fixturePosition, fixtureTrades } from '../src/dev/dashboardFixtures.ts';
import { PnlCalendar, monthTotals } from '../src/dashboard/Calendar.tsx';
import { CostsChart, CumulativeChart, DailyPnlChart } from '../src/dashboard/Charts.tsx';
import { OpenPosition, RiskList, Stats } from '../src/dashboard/Sections.tsx';
import { TradeDetail, TradeTable, tradeReturn } from '../src/dashboard/Trades.tsx';
import { formatSol, lamportsAtPrice, returnLamports } from '../src/lib/money.ts';
import { findBanned } from './banned-copy.ts';

const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const PRICE = '150';
const at = (el: ReactElement, price: string | null = PRICE) => renderToStaticMarkup(h(SolPriceContext.Provider, { value: price }, el));

describe('SOL, exact from lamports', () => {
  it('four decimals, rounded half away from zero; under 0.0001 SOL four significant digits, never 0.0000', () => {
    expect(formatSol('12300000')).toBe('0.0123 SOL');
    expect(formatSol('12300000', true)).toBe('+0.0123 SOL');
    expect(formatSol('-1234567890')).toBe('−1.2346 SOL');
    expect(formatSol('-1234550000')).toBe('−1.2346 SOL');
    expect(formatSol('1234549999')).toBe('1.2345 SOL');
    expect(formatSol('0', true)).toBe('0.0000 SOL');
    expect(formatSol('5000')).toBe('0.000005 SOL');
    expect(formatSol('12345')).toBe('0.00001235 SOL');
    expect(formatSol('-1', true)).toBe('−0.000000001 SOL');
    expect(formatSol('99999')).toBe('0.0001 SOL');
    expect(formatSol('100000')).toBe('0.0001 SOL');
    expect(formatSol('1234567000000000000')).toBe('1,234,567,000.0000 SOL');
    expect(() => formatSol('1.5')).toThrow();
  });

  it('the dollar line is the lamports at the current SOL price; Return is lamports over lamports', () => {
    expect(lamportsAtPrice('1000000000', PRICE)).toBe('$150.00');
    expect(lamportsAtPrice('-12300000', PRICE, true)).toBe('−$1.85');
    expect(returnLamports('2000000', '20000000')).toBe(1000n);
    expect(returnLamports('-1', '3')).toBe(-3333n);
    expect(returnLamports('5', '0')).toBeNull();
  });

  it('Money: SOL first and the dollars in a small untoned line under it; no price, no dollar line; no lamports, dollars', () => {
    const html = at(h(Money, { lamports: '12300000', usd: '9.99', signed: true }));
    expect(html).toBe('<span class="money"><span>+0.0123 SOL</span><span class="money-usd">+$1.85</span></span>');
    expect(at(h(Money, { lamports: '12300000', usd: '9.99' }), null)).toBe('<span class="money"><span>0.0123 SOL</span></span>');
    expect(at(h(Money, { lamports: undefined, usd: '9.99', signed: true }))).toBe('+$9.99');
  });
});

describe('every money figure in SOL', () => {
  const pos: PositionRecord = {
    ...fixturePosition, sizeUsd: '2', unrealizedUsd: '0.31', costsSoFarUsd: '0.012', pnlUsd: '0.298', markPriceUsd: null, markedAt: null,
    sizeLamports: '20000000', liquidationValueLamports: '22000000', unrealizedLamports: '2000000', costsSoFarLamports: '10000', pnlLamports: '1990000',
  };
  const cell = (html: string, label: string) => text(new RegExp(`<dt>${label.replace('&', '&amp;')}</dt><dd[^>]*>(.*?)</dd>`).exec(html)?.[1] ?? '');

  it('the open trade: SOL rows, and Return on lamports (not on dollars)', () => {
    const html = at(h(OpenPosition, { position: pos, now: Date.parse(pos.openedAt) }));
    expect(cell(html, 'Size')).toBe('0.0200 SOL $3.00');
    expect(cell(html, 'Unrealized')).toBe('+0.0020 SOL +$0.30');
    expect(cell(html, 'Costs so far')).toBe('0.00001 SOL $0.00');
    expect(cell(html, 'P&L')).toBe('+0.0020 SOL +$0.30');
    // 1,990,000 ÷ 20,000,000 = 9.95%; on dollars it would read 14.90%.
    expect(cell(html, 'Return')).toBe('+9.95%');
    expect(html).toMatch(/<dt>P&amp;L<\/dt><dd class="num gain">/);
    expect(findBanned(text(html))).toEqual([]);
  });

  it('trades: list and detail in SOL, Return on lamports', () => {
    const t: TradeRecord = {
      ...fixtureTrades.paper[0]!, sizeUsd: '2', netUsd: '0.5', grossUsd: '0.6', sizeLamports: '20000000', netLamports: '-1000000', grossLamports: '-900000',
      costs: { ...fixtureTrades.paper[0]!.costs, totalLamports: '100000', venueFeeLamports: '60000', creatorFeeLamports: '0', priorityFeeLamports: '20000', tipLamports: '0', networkFeeLamports: '15000', slippageLamports: '5000', rentPaidLamports: '0', rentReturnedLamports: '0' },
    };
    // The SOL result wins over the dollar one: a loss in SOL reads as a loss even when the dollars read a gain.
    expect(tradeReturn(t)).toBe(-500n);
    const list = at(h(TradeTable, { trades: [t] }));
    expect(text(list)).toContain('−0.0010 SOL');
    expect(list).toContain('<td class="num loss">−5.00%</td>');
    const detail = text(at(h(TradeDetail, { trade: t })));
    expect(detail).toContain('Net −0.0010 SOL');
    expect(detail).toContain('Gross −0.0009 SOL');
    expect(detail).toContain('Costs −0.0001 SOL');
    expect(detail).toContain('Venue fees 0.00006 SOL');
    expect(detail).toContain('Return −5.00%');
    expect(findBanned(detail)).toEqual([]);
  });

  it('Results, risk meters, calendar and charts', () => {
    const stats: StatsView = { mode: 'paper', trades: 2, requiredTrades: 30, netUsd: '1', netSol: '0.007', solMoveUsd: '0', maxDrawdownUsd: '0.5', winRate: null, meanNetUsd: '0.5', meanR: null, ci95: null, netLamports: '7000000', maxDrawdownLamports: '3000000', meanNetLamports: '3500000' };
    const s = text(at(h(Stats, { stats })));
    expect(s).toContain('Net result +0.0070 SOL');
    expect(s).toContain('Max drawdown 0.0030 SOL');
    const meters: RiskMeter[] = [{ mode: 'paper', kind: 'daily-loss', usedUsd: '0.3', limitUsd: '1', usedLamports: '2000000', limitLamports: '6666666' }];
    expect(text(at(h(RiskList, { meters })))).toContain('0.0020 SOL of 0.0067 SOL');
    const cal: CalendarMonth = { mode: 'paper', month: '2026-10', timeZone: 'Australia/Melbourne', days: [
      { mode: 'paper', date: '2026-10-04', netUsd: '1', netLamports: '-3000000', trades: 1, pauses: 0, tradeIds: ['a'] },
      { mode: 'paper', date: '2026-10-05', netUsd: '1', netLamports: '1000000', trades: 1, pauses: 0, tradeIds: ['b'] },
    ] };
    const c = at(h(PnlCalendar, { cal, onPrev: () => undefined, onNext: () => undefined, onSelectDay: () => undefined }));
    expect(c).toContain('aria-label="Sunday 4 October: −0.0030 SOL, 1 trade"');
    expect(c).toContain('calendar-loss');
    expect(text(c)).toContain('Month net −0.0020 SOL');
    const charts: ChartsView = {
      mode: 'paper', rBuckets: [],
      cumulative: [{ mode: 'paper', at: '2026-10-04T01:00:00.000Z', cumNetUsd: '1', cumNetLamports: '-3000000' }, { mode: 'paper', at: '2026-10-05T01:00:00.000Z', cumNetUsd: '2', cumNetLamports: '-2000000' }],
      daily: [{ mode: 'paper', date: '2026-10-04', netUsd: '1', netLamports: '-3000000' }],
      costsDaily: [{ mode: 'paper', date: '2026-10-04', totalUsd: '0.1', totalLamports: '100000' }],
      costsByKind: [{ mode: 'paper', kind: 'venueFeeUsd', amountUsd: '0.1', amountLamports: '100000' }],
    };
    expect(text(at(h(CumulativeChart, { points: charts.cumulative })))).toContain('2 trades · net −0.0020 SOL · largest drawdown −0.0030 SOL');
    expect(at(h(DailyPnlChart, { daily: charts.daily }))).toContain('0 up and 1 flat or down');
    expect(text(at(h(CostsChart, { view: charts, mode: 'paper' })))).toContain('Total 0.0001 SOL');
  });

  it('an empty calendar cannot establish a known zero SOL sum', () => {
    expect(monthTotals({ mode: 'paper', month: '2026-10', timeZone: 'Australia/Melbourne', days: [] }).netLamports).toBeNull();
  });

  it('a worker without lamports: dollars, as before', () => {
    const { sizeLamports: _s, liquidationValueLamports: _l, unrealizedLamports: _u, costsSoFarLamports: _c, pnlLamports: _p, ...older } = pos;
    const html = at(h(OpenPosition, { position: older as PositionRecord, now: Date.parse(pos.openedAt) }));
    expect(cell(html, 'P&L')).toBe('+$0.30');
    expect(cell(html, 'Return')).toBe('+14.90%');
    expect(html).not.toContain('SOL');
  });
});
