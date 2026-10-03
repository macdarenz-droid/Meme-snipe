import { readFileSync } from 'node:fs';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { CalendarMonth, StatsView } from '../src/api/contract.ts';
import { DataError } from '../src/api/modes.ts';
import { BacktestReportView, groupMonth } from '../src/dashboard/BacktestReport.tsx';
import { Boundary } from '../src/dashboard/Boundary.tsx';
import { monthTotals, PnlCalendar } from '../src/dashboard/Calendar.tsx';
import { Dashboard } from '../src/dashboard/Dashboard.tsx';
import { headline, Journal, OpenPosition, Stats, StatusFlags } from '../src/dashboard/Sections.tsx';
import { Load, OfflineContext } from '../src/dashboard/State.tsx';
import { TradeDetail, TradeTable } from '../src/dashboard/Trades.tsx';
import { fixtureApi, fixtureDays, fixtureDecisions, fixturePosition, fixtureReport, fixtureStats, fixtureTrades } from '../src/dev/dashboardFixtures.ts';
import { addUsd } from '../src/lib/money.ts';

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const text = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const noop = () => {};
// Server rendering has no window; sheets read one media query on first render.
Object.assign(globalThis, { window: { matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop }) } });

describe('results statistics', () => {
  it('shows "Not enough trades" instead of a win rate or average on a small sample', () => {
    const out = text(html(h(Stats, { stats: fixtureStats('paper') })));
    expect(fixtureStats('paper').trades).toBe(12);
    expect(out.match(/Not enough trades/g)).toHaveLength(4);
    expect(out).toContain('12 trades of 30 needed');
    expect(out).not.toMatch(/\d\.\d%/);
    expect(out).not.toMatch(/\d\.\d\dR/);
  });

  it('holds back statistics when the worker asks for fewer trades than the floor', () => {
    const stats: StatsView = { ...fixtureStats('backtest'), trades: 250, requiredTrades: 100 };
    expect(text(html(h(Stats, { stats })))).toContain('250 trades of 300 needed');
  });

  it('shows statistics once the sample exists', () => {
    const out = text(html(h(Stats, { stats: fixtureStats('backtest') })));
    expect(out).not.toContain('Not enough trades');
    expect(out).toMatch(/Win rate \d+\.\d%/);
    expect(out).toContain('420 trades · Backtest only');
  });
});

describe('P&L calendar', () => {
  const cal = (mode: 'paper' | 'backtest', month: string): CalendarMonth => ({
    mode,
    month,
    timeZone: 'Australia/Melbourne',
    days: fixtureDays(mode).filter((d) => d.date.startsWith(month)),
  });

  it('prints each day and an exact month total for its own mode', () => {
    const c = cal('paper', '2026-09');
    const expected = addUsd('0', ...fixtureTrades.paper.map((t) => t.netUsd).filter((_, i) => c.days.some((d) => d.tradeIds.includes(fixtureTrades.paper[i]?.id ?? ''))));
    expect(monthTotals(c).netUsd).toBe(expected);
    expect(monthTotals(c).trades).toBe(c.days.reduce((s, d) => s + d.trades, 0));
    const out = html(h(PnlCalendar, { cal: c, onPrev: noop, onNext: noop, onSelectDay: noop }));
    expect(out).toContain('September 2026');
    expect(out).toContain('Melbourne time');
    expect(out.match(/class="calendar-button/g)).toHaveLength(c.days.length);
  });

  it('refuses to draw a month that holds a day from another mode', () => {
    const c = cal('paper', '2026-09');
    const first = c.days[0];
    if (!first) throw new Error('fixture has no days');
    const mixed: CalendarMonth = { ...c, days: [...c.days.slice(1), { ...first, mode: 'live' }] };
    expect(() => html(h(PnlCalendar, { cal: mixed, onPrev: noop, onNext: noop, onSelectDay: noop }))).toThrow(DataError);
  });
});

describe('trade history', () => {
  it('lists trades 25 at a time', () => {
    const out = text(html(h(TradeTable, { trades: fixtureTrades.backtest, onSelect: noop })));
    expect(out).toContain('25 of 420');
    expect(out).toContain('Show more');
  });

  it('shows every detail of a trade: entry, exit, fills, fees, rent, slippage, reasons and signatures', () => {
    const t = fixtureTrades.backtest[0];
    if (!t) throw new Error('no trade');
    const live = { ...t, mode: 'live' as const, fills: t.fills.map((f, i) => ({ ...f, mode: 'live' as const, signature: `FAKEsig${i}${'x'.repeat(80)}` })) };
    const out = html(h(TradeDetail, { trade: live }));
    for (const label of ['Entry', 'Exit', 'Venue fees', 'Creator fees', 'Priority fees', 'Tips', 'Network fees', 'Slippage', 'Rent paid', 'Rent returned', 'Fills', 'Reasons', 'Checks at entry', 'Planned R', 'Realized R', 'Best while open', 'Worst while open', 'Strategy', 'Policy']) {
      expect(out, label).toContain(label);
    }
    expect(out).toContain('https://solscan.io/tx/FAKEsig0');
    expect(out).toContain('bps');
    expect(text(html(h(TradeDetail, { trade: t })))).toContain('slot ');
    const paper = fixtureTrades.paper[0];
    if (!paper) throw new Error('no paper trade');
    expect(text(html(h(TradeDetail, { trade: paper })))).toContain('Paper');
  });
});

describe('decisions, position and status', () => {
  it('names each decision by its first failing check, with value and limit', () => {
    const rejected = fixtureDecisions('paper').find((d) => d.outcome === 'rejected');
    if (!rejected) throw new Error('no rejection');
    expect(headline(rejected)).toMatch(/: .+ \(needs .+\)$/);
    const out = text(html(h(Journal, { decisions: fixtureDecisions('paper'), onOpen: noop })));
    expect(out).toContain('Rejected');
    expect(out).toContain('Entered');
  });

  it('shows the open position with liquidation value and exit rules', () => {
    const out = text(html(h(OpenPosition, { position: fixturePosition })));
    for (const label of ['Liquidation value', 'Unrealized', 'Costs so far', 'Price stop', 'Take profit', 'Armed']) expect(out).toContain(label);
  });

  it('shows worker states, and an offline worker plainly', () => {
    expect(text(html(h(StatusFlags, { status: { mode: 'paper', connected: true, flags: ['exit-blocked', 'paused'], risk: [] } })))).toContain('Exit blocked Paused');
    expect(text(html(h(StatusFlags, { status: { mode: 'paper', connected: false, flags: [], risk: [] } })))).toContain('Worker not connected');
  });
});

describe('backtest report', () => {
  it('labels the report as Backtest with its part, and shows per-group results', () => {
    const out = text(html(h(BacktestReportView, { report: fixtureReport })));
    expect(out).toContain('Backtest Walk-forward');
    expect(out).toContain('S0 random');
    expect(out).toContain(fixtureReport.codeCommit.slice(0, 12));
    expect(out).toContain(fixtureReport.dataset.id);
    expect(out).not.toMatch(/holdout|G2/i);
  });

  it('holds back win rate, average and interval for a group below 300 trades', () => {
    const counts = fixtureReport.results.map((r) => r.trades);
    expect(counts.some((n) => n >= 300) || counts.every((n) => n < 300)).toBe(true);
    const small = { ...fixtureReport, results: fixtureReport.results.map((r) => ({ ...r, trades: 299 })) };
    const out = text(html(h(BacktestReportView, { report: small })));
    expect(out.match(/Not enough trades/g)).toHaveLength(3 * small.results.length);
    const big = { ...fixtureReport, results: fixtureReport.results.map((r) => ({ ...r, trades: 300, wins: 150 })) };
    expect(text(html(h(BacktestReportView, { report: big })))).toContain('50.0%');
  });

  it('builds the calendar month for one group from the report', () => {
    const month = fixtureReport.results[0]?.days[0]?.date.slice(0, 7) ?? '';
    const cal = groupMonth(fixtureReport, 'U1', month);
    expect(cal.mode).toBe('backtest');
    expect(cal.days.length).toBeGreaterThan(0);
    expect(cal.days.reduce((s, d) => s + d.tradeIds.length, 0)).toBe(cal.days.reduce((s, d) => s + d.trades, 0));
  });
});

describe('section error boundary', () => {
  it('turns a render error into the section error state', () => {
    expect(Boundary.getDerivedStateFromError()).toEqual({ failed: true });
    const b = new Boundary({ children: h('p', null, 'fine') });
    expect(text(html(h('div', null, b.render())))).toBe(' fine ');
    b.state = Boundary.getDerivedStateFromError();
    const out = text(html(h('div', null, b.render())));
    expect(out).toContain('Data failed checks');
    expect(out).not.toContain('fine');
  });

  it('wraps every loaded section and every sheet', () => {
    const src = (f: string) => readFileSync(new URL(`../src/dashboard/${f}`, import.meta.url), 'utf8');
    expect(src('State.tsx')).toMatch(/<Boundary key=\{loaded\.asOf\}>/);
    expect(src('Dashboard.tsx')).toMatch(/<Boundary key=\{sheetKey\}>\{body\}<\/Boundary>/);
    expect(src('BacktestReport.tsx')).toMatch(/<Boundary key=\{shownDay\.date\}>/);
    // Every section body on the dashboard goes through Load.
    const dash = src('Dashboard.tsx');
    expect((dash.match(/<Section /g) ?? []).length).toBe((dash.match(/<Section [^>]*>\s*(<Load|\{backtest \?)/g) ?? []).length);
  });
});

describe('section states', () => {
  const body = (d: string) => h('p', null, d);
  it('renders loading, error, stale and empty states', () => {
    expect(html(h(Load<string>, { loaded: { state: 'loading' }, children: body }))).toContain('aria-label="Loading"');
    expect(text(html(h(Load<string>, { loaded: { state: 'error', reason: 'offline' }, children: body })))).toContain('Offline');
    expect(text(html(h(Load<string>, { loaded: { state: 'error', reason: 'mixed-modes' }, children: body })))).toContain('Data from another mode');
    const stale = text(html(h(Load<string>, { loaded: { state: 'ready', data: 'x', asOf: new Date(Date.now() - 60_000).toISOString(), stale: true }, children: body })));
    expect(stale).toMatch(/Stale data · updated 1m ago x/);
    expect(text(html(h(Load<string>, { loaded: { state: 'ready', data: '', asOf: '', stale: false }, children: body, isEmpty: (d) => d === '', empty: 'Nothing' })))).toBe('Nothing');
  });

  it('offline: a section shows Offline with the last update, never its empty state', () => {
    const offline = { state: 'error' as const, reason: 'offline' as const };
    const noData = text(html(h(Load<string>, { loaded: offline, children: body, empty: 'No trades' })));
    expect(noData).not.toContain('No trades');
    expect(noData).toContain('Offline');
    expect(text(html(h(Load<string>, { loaded: offline, children: body })))).toContain('Offline');
    const known = h(OfflineContext.Provider, { value: { state: 'offline', lastOk: '2026-10-03T03:32:00.000Z' } }, h(Load<string>, { loaded: offline, children: body, empty: 'No open trade' }));
    expect(text(html(known)).trim()).toBe('Offline Last update 3 Oct, 13:32');
    const unset = h(OfflineContext.Provider, { value: { state: 'none', lastOk: null } }, h(Load<string>, { loaded: offline, children: body, empty: 'No open trade' }));
    expect(text(html(unset)).trim()).toBe('No server');
    expect(text(html(h(Load<string>, { loaded: { state: 'error', reason: 'mixed-modes' }, children: body, empty: 'No trades' })))).toContain('Data from another mode');
  });

  it('the dashboard starts every section in its loading state', () => {
    const out = html(h(Dashboard, { api: fixtureApi(), mode: 'paper' }));
    expect(out.match(/aria-label="Loading"/g)?.length).toBeGreaterThan(8);
    expect(out).not.toContain('Backtest report');
    expect(html(h(Dashboard, { api: fixtureApi(), mode: 'backtest' }))).toContain('Backtest report');
  });
});
