import { useCallback, useRef, useState, type ReactNode } from 'react';
import type { BacktestReport, CalendarMonth, ChartsView, DashboardApi, DayRecord, DecisionRecord, FunnelView, Mode, PositionRecord, StatsView, TradeRecord, WorkerStatus } from '../api/contract.ts';
import { hasSample, MODE_LABEL } from '../api/modes.ts';
import { reportData } from '../api/reportSchema.ts';
import { schemaFor } from '../api/schemas.ts';
import { useEndpoint, type Loaded } from '../api/useEndpoint.ts';
import { Sheet } from '../components/Sheet.tsx';
import { Empty, Section } from '../components/ui.tsx';
import { formatUsdExact, toneOf } from '../lib/money.ts';
import { BacktestReportView } from './BacktestReport.tsx';
import { Boundary } from './Boundary.tsx';
import { PnlCalendar } from './Calendar.tsx';
import { CostsChart, CumulativeChart, DailyPnlChart, FunnelChart, RDistribution } from './Charts.tsx';
import { DecisionDetail, Funnel, Journal, ModeTag, NOT_ENOUGH, OpenPosition, RiskList, Stats, StatusCard } from './Sections.tsx';
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

  const loaded: Loads = {
    status: useEndpoint(mode, 'status', schemaFor('status', mode), () => api.status(mode)),
    funnel: useEndpoint(mode, 'funnel', schemaFor('funnel', mode), () => api.funnel(mode)),
    decisions: useEndpoint(mode, 'decisions', schemaFor('decisions', mode), () => api.decisions(mode)),
    position: useEndpoint(mode, 'position', schemaFor('position', mode), () => api.position(mode)),
    calendar: useEndpoint(mode, `calendar/${month}`, schemaFor('calendar', mode), () => api.calendar(mode, month)),
    trades: useEndpoint(mode, 'trades', schemaFor('trades', mode), () => api.trades(mode)),
    charts: useEndpoint(mode, 'charts', schemaFor('charts', mode), () => api.charts(mode)),
    stats: useEndpoint(mode, 'stats', schemaFor('stats', mode), () => api.stats(mode)),
    report: useEndpoint('backtest', 'report', reportData, () => api.backtestReport()),
  };
  return <DashboardBody mode={mode} month={month} setMonth={setMonth} loaded={loaded} session={session} />;
}

/** What each section has loaded, one endpoint each. */
export interface Loads {
  status: Loaded<WorkerStatus>;
  funnel: Loaded<FunnelView>;
  decisions: Loaded<DecisionRecord[]>;
  position: Loaded<PositionRecord | null>;
  calendar: Loaded<CalendarMonth>;
  trades: Loaded<TradeRecord[]>;
  charts: Loaded<ChartsView>;
  stats: Loaded<StatsView>;
  report: Loaded<BacktestReport | null>;
}

/** The sections for loaded data; no requests of its own. */
export function DashboardBody({ mode, month, setMonth, loaded, session }: { mode: Mode; month: string; setMonth: (m: string) => void; loaded: Loads; session?: ReactNode }) {
  const { status, funnel, decisions, position, calendar, trades, charts, stats, report } = loaded;
  const [open, setOpen] = useState<Open>(null);
  const close = useCallback(() => setOpen(null), []);
  // Keep the last content while the sheet animates out.
  const last = useRef<Open>(null);
  if (open) last.current = open;
  const shown = open ?? last.current;
  const tradeById = new Map(trades.state === 'ready' ? trades.data.map((t) => [t.id, t]) : []);

  let title = '';
  let sheetKey = '';
  let body: ReactNode = null;
  if (shown?.kind === 'day') {
    title = titleOfDay(shown.day.date);
    sheetKey = `day:${shown.day.date}`;
    const list = shown.day.tradeIds.map((id) => tradeById.get(id)).filter((t): t is TradeRecord => !!t);
    body = (
      <>
        <p className={`day-net num ${toneOf(shown.day.netUsd)}`}>{formatUsdExact(shown.day.netUsd, true)}</p>
        <TradeTable trades={list} onSelect={(trade) => setOpen({ kind: 'trade', trade, from: shown.day })} />
      </>
    );
  } else if (shown?.kind === 'trade') {
    title = `${shown.trade.symbol} trade`;
    sheetKey = `trade:${shown.trade.id}`;
    body = <TradeDetail trade={shown.trade} />;
  } else if (shown?.kind === 'decision') {
    title = `${shown.decision.symbol} decision`;
    sheetKey = `decision:${shown.decision.id}`;
    body = <DecisionDetail decision={shown.decision} />;
  }

  const enough = stats.state === 'ready' && hasSample(stats.data);
  // Every section, and every sheet opened from one, names the mode its numbers belong to.
  const tag = <ModeTag mode={mode} />;
  const backtest = mode === 'backtest';

  return (
    <>
      <Section aside={tag} title="Worker" className="span-2 dash-status">
        <Load loaded={status} rows={1}>
          {(s) => <StatusCard status={s} />}
        </Load>
      </Section>

      {backtest ? (
        <Section aside={tag} title="Backtest report" className="span-2">
          <Load loaded={report} isEmpty={(r) => r === null} empty={<Empty title="No backtest yet" />} rows={6}>
            {(r) => r && <BacktestReportView report={r} />}
          </Load>
        </Section>
      ) : (
        <>
          {session}
          <Section aside={tag} title="Open trade">
            <Load loaded={position} isEmpty={(p) => p === null} empty={<Empty title="No open trade" />}>
              {(p) => p && <OpenPosition position={p} />}
            </Load>
          </Section>
        </>
      )}

      <Section aside={tag} title="Candidates">
        <Load loaded={funnel} isEmpty={(f) => (f.stages[0]?.count ?? 0) === 0} empty={<Empty title="No candidates seen" />} rows={5}>
          {(f) => <Funnel funnel={f} />}
        </Load>
      </Section>

      <Section aside={tag} title={backtest ? 'Candidates per day' : 'Risk'}>
        {backtest ? (
          <Load loaded={funnel} isEmpty={(f) => f.perDay.length === 0} empty={<Empty title="No candidates seen" />}>
            {(f) => <FunnelChart perDay={f.perDay} />}
          </Load>
        ) : (
          <Load loaded={status} empty={<Empty title="No limits" />}>{(s) => <RiskList meters={s.risk} />}</Load>
        )}
      </Section>

      <Section aside={tag} title="Decision journal" className="span-2">
        <Load loaded={decisions} isEmpty={(d) => d.length === 0} empty={<Empty title="No decisions recorded" />} rows={5}>
          {(d) => <Journal decisions={d} onOpen={(decision) => setOpen({ kind: 'decision', decision })} />}
        </Load>
      </Section>

      <Section aside={tag} title="Results" className="span-2">
        <Load loaded={stats} empty={<Empty title="No trades" />}>{(s) => <Stats stats={s} />}</Load>
      </Section>

      <Section aside={tag} title="Daily P&L">
        <Load loaded={calendar} rows={6} empty={<Empty title="No closed trades" />}>
          {(c) => (
            <PnlCalendar cal={c} onPrev={() => setMonth(shiftMonth(month, -1))} onNext={() => setMonth(shiftMonth(month, 1))} onSelectDay={(day) => setOpen({ kind: 'day', day })} />
          )}
        </Load>
      </Section>

      <Section aside={tag} title="Net P&L">
        <Load loaded={charts} rows={6} empty={<Empty title="No closed trades" />}>
          {(c) => <CumulativeChart points={c.cumulative} />}
        </Load>
      </Section>

      <Section aside={tag} title="P&L by day">
        <Load loaded={charts} empty={<Empty title="No closed trades" />}>{(c) => <DailyPnlChart daily={c.daily} />}</Load>
      </Section>

      <Section aside={tag} title="R per trade">
        <Load loaded={charts} empty={<Empty title="No closed trades" />}>
          {(c) => (c.rBuckets.length === 0 ? <Empty title="No closed trades" /> : enough ? <RDistribution buckets={c.rBuckets} /> : <Empty title={NOT_ENOUGH} />)}
        </Load>
      </Section>

      <Section aside={tag} title="Costs" className={backtest ? 'span-2' : ''}>
        <Load loaded={charts} empty={<Empty title="No costs yet" />}>{(c) => <CostsChart view={c} mode={mode} />}</Load>
      </Section>

      {!backtest && (
        <Section aside={tag} title="Candidates per day">
          <Load loaded={funnel} isEmpty={(f) => f.perDay.length === 0} empty={<Empty title="No candidates seen" />}>
            {(f) => <FunnelChart perDay={f.perDay} />}
          </Load>
        </Section>
      )}

      <Section aside={tag} title="Trades" className="span-2">
        <Load loaded={trades} rows={6} isEmpty={(t) => t.length === 0} empty={<Empty title="No trades" />}>
          {(t) => <TradeTable trades={t} onSelect={(trade) => setOpen({ kind: 'trade', trade })} />}
        </Load>
      </Section>

      <Sheet
        open={open !== null}
        title={title && `${title} · ${MODE_LABEL[mode]}`}
        onClose={close}
        footer={
          shown?.kind === 'trade' && shown.from ? (
            <button type="button" className="button" onClick={() => shown.from && setOpen({ kind: 'day', day: shown.from })}>
              Back to day
            </button>
          ) : undefined
        }
      >
        <Boundary key={sheetKey}>{body}</Boundary>
      </Sheet>
    </>
  );
}
