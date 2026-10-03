import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { DashboardApi, DayRecord, DecisionRecord, Mode, TradeRecord } from '../api/contract.ts';
import { hasSample } from '../api/modes.ts';
import { useEndpoint } from '../api/useEndpoint.ts';
import { Sheet } from '../components/Sheet.tsx';
import { Empty, Section } from '../components/ui.tsx';
import { formatUsdExact, toneOf } from '../lib/money.ts';
import { BacktestReportView } from './BacktestReport.tsx';
import { PnlCalendar } from './Calendar.tsx';
import { CostsChart, CumulativeChart, DailyPnlChart, FunnelChart, RDistribution } from './Charts.tsx';
import { DecisionDetail, Funnel, Journal, NOT_ENOUGH, OpenPosition, RiskList, Stats, StatusFlags } from './Sections.tsx';
import { Load } from './State.tsx';
import { melMonth, shiftMonth } from './time.ts';
import { TradeDetail, TradeTable } from './Trades.tsx';
import './dashboard.css';

const dayTitle = new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const titleOfDay = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return dayTitle.format(new Date(Date.UTC(y, m - 1, d)));
};

type Open = { kind: 'day'; day: DayRecord } | { kind: 'trade'; trade: TradeRecord; from?: DayRecord } | { kind: 'decision'; decision: DecisionRecord } | null;

export interface DashboardProps {
  api: DashboardApi;
  mode: Mode;
  /** First calendar month per mode; defaults to this month in Melbourne. */
  months?: Partial<Record<Mode, string>>;
  /** Shown first in paper and live: the session card. */
  session?: ReactNode;
}

/**
 * The §17 data screens for one mode. Every section loads its own endpoint for
 * that mode only, and useEndpoint rejects any response holding a record of
 * another mode; switching mode drops all loaded data before anything is drawn.
 */
export function Dashboard({ api, mode, months, session }: DashboardProps) {
  const [monthByMode, setMonthByMode] = useState<Partial<Record<Mode, string>>>(months ?? {});
  const month = monthByMode[mode] ?? melMonth();
  const setMonth = (m: string) => setMonthByMode((s) => ({ ...s, [mode]: m }));

  const status = useEndpoint(mode, 'status', () => api.status(mode));
  const funnel = useEndpoint(mode, 'funnel', () => api.funnel(mode));
  const decisions = useEndpoint(mode, 'decisions', () => api.decisions(mode));
  const position = useEndpoint(mode, 'position', () => api.position(mode));
  const calendar = useEndpoint(mode, `calendar/${month}`, () => api.calendar(mode, month));
  const trades = useEndpoint(mode, 'trades', () => api.trades(mode));
  const charts = useEndpoint(mode, 'charts', () => api.charts(mode));
  const stats = useEndpoint(mode, 'stats', () => api.stats(mode));
  const report = useEndpoint('backtest', 'report', () => api.backtestReport());

  const [open, setOpen] = useState<Open>(null);
  const close = useCallback(() => setOpen(null), []);
  // Keep the last content while the sheet animates out.
  const last = useRef<Open>(null);
  if (open) last.current = open;
  const shown = open ?? last.current;
  const tradeById = new Map(trades.state === 'ready' ? trades.data.map((t) => [t.id, t]) : []);

  let title = '';
  let body: ReactNode = null;
  if (shown?.kind === 'day') {
    title = titleOfDay(shown.day.date);
    const list = shown.day.tradeIds.map((id) => tradeById.get(id)).filter((t): t is TradeRecord => !!t);
    body = (
      <>
        <p className={`day-net num ${toneOf(shown.day.netUsd)}`}>{formatUsdExact(shown.day.netUsd, true)}</p>
        <TradeTable trades={list} onSelect={(trade) => setOpen({ kind: 'trade', trade, from: shown.day })} />
      </>
    );
  } else if (shown?.kind === 'trade') {
    title = `${shown.trade.symbol} trade`;
    body = <TradeDetail trade={shown.trade} />;
  } else if (shown?.kind === 'decision') {
    title = `${shown.decision.symbol} decision`;
    body = <DecisionDetail decision={shown.decision} />;
  }

  const enough = stats.state === 'ready' && hasSample(stats.data);
  const backtest = mode === 'backtest';

  return (
    <>
      <Section title="Worker" className="span-2 dash-status">
        <Load loaded={status} rows={1}>
          {(s) => <StatusFlags status={s} />}
        </Load>
      </Section>

      {backtest ? (
        <Section title="Backtest report" className="span-2">
          <Load loaded={report} isEmpty={(r) => r === null} empty={<Empty title="No backtest run" />} rows={6}>
            {(r) => r && <BacktestReportView report={r} />}
          </Load>
        </Section>
      ) : (
        <>
          {session}
          <Section title="Open trade">
            <Load loaded={position} isEmpty={(p) => p === null} empty={<Empty title="No open trade" />}>
              {(p) => p && <OpenPosition position={p} />}
            </Load>
          </Section>
        </>
      )}

      <Section title="Candidates">
        <Load loaded={funnel} isEmpty={(f) => (f.stages[0]?.count ?? 0) === 0} empty={<Empty title="No candidates seen" />} rows={5}>
          {(f) => <Funnel funnel={f} />}
        </Load>
      </Section>

      <Section title={backtest ? 'Candidates per day' : 'Risk'}>
        {backtest ? (
          <Load loaded={funnel} isEmpty={(f) => f.perDay.length === 0} empty={<Empty title="No candidates seen" />}>
            {(f) => <FunnelChart perDay={f.perDay} />}
          </Load>
        ) : (
          <Load loaded={status} empty={<Empty title="No limits" />}>{(s) => <RiskList meters={s.risk} />}</Load>
        )}
      </Section>

      <Section title="Decision journal" className="span-2">
        <Load loaded={decisions} isEmpty={(d) => d.length === 0} empty={<Empty title="No decisions recorded" />} rows={5}>
          {(d) => <Journal decisions={d} onOpen={(decision) => setOpen({ kind: 'decision', decision })} />}
        </Load>
      </Section>

      <Section title="Results" className="span-2">
        <Load loaded={stats} empty={<Empty title="No trades" />}>{(s) => <Stats stats={s} />}</Load>
      </Section>

      <Section title="Daily P&L">
        <Load loaded={calendar} rows={6} empty={<Empty title="No closed trades" />}>
          {(c) => (
            <PnlCalendar cal={c} onPrev={() => setMonth(shiftMonth(month, -1))} onNext={() => setMonth(shiftMonth(month, 1))} onSelectDay={(day) => setOpen({ kind: 'day', day })} />
          )}
        </Load>
      </Section>

      <Section title="Net P&L">
        <Load loaded={charts} rows={6} empty={<Empty title="No closed trades" />}>
          {(c) => <CumulativeChart points={c.cumulative} />}
        </Load>
      </Section>

      <Section title="P&L by day">
        <Load loaded={charts} empty={<Empty title="No closed trades" />}>{(c) => <DailyPnlChart daily={c.daily} />}</Load>
      </Section>

      <Section title="R per trade">
        <Load loaded={charts} empty={<Empty title="No closed trades" />}>
          {(c) => (c.rBuckets.length === 0 ? <Empty title="No closed trades" /> : enough ? <RDistribution buckets={c.rBuckets} /> : <Empty title={NOT_ENOUGH} />)}
        </Load>
      </Section>

      <Section title="Costs" className={backtest ? 'span-2' : ''}>
        <Load loaded={charts} empty={<Empty title="No costs yet" />}>{(c) => <CostsChart view={c} mode={mode} />}</Load>
      </Section>

      {!backtest && (
        <Section title="Candidates per day">
          <Load loaded={funnel} isEmpty={(f) => f.perDay.length === 0} empty={<Empty title="No candidates seen" />}>
            {(f) => <FunnelChart perDay={f.perDay} />}
          </Load>
        </Section>
      )}

      <Section title="Trades" className="span-2">
        <Load loaded={trades} rows={6} isEmpty={(t) => t.length === 0} empty={<Empty title="No trades" />}>
          {(t) => <TradeTable trades={t} onSelect={(trade) => setOpen({ kind: 'trade', trade })} />}
        </Load>
      </Section>

      <Sheet
        open={open !== null}
        title={title}
        onClose={close}
        footer={
          shown?.kind === 'trade' && shown.from ? (
            <button type="button" className="button" onClick={() => shown.from && setOpen({ kind: 'day', day: shown.from })}>
              Back to day
            </button>
          ) : undefined
        }
      >
        {body}
      </Sheet>
    </>
  );
}
