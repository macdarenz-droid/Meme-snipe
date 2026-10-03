import { useCallback, useRef, useState } from 'react';
import { Sheet } from '../components/Sheet.tsx';
import { Section } from '../components/ui.tsx';
import { formatUsd } from '../lib/format.ts';
import { CostBreakdown } from './CostBreakdown.tsx';
import { EquityCurve } from './EquityCurve.tsx';
import { PnlCalendar } from './PnlCalendar.tsx';
import { ResultsStats } from './ResultsStats.tsx';
import { TradeDetail, TradeHistory } from './TradeHistory.tsx';
import type { DayResultView, ResultsView, TradeView } from './types.ts';

const dayTitle = new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

type Open = { kind: 'day'; day: DayResultView } | { kind: 'trade'; trade: TradeView; from?: DayResultView } | null;

export function Results({ view }: { view: ResultsView }) {
  const [open, setOpen] = useState<Open>(null);
  const close = useCallback(() => setOpen(null), []);
  const byId = new Map(view.trades.map((t) => [t.id, t]));
  // Keep the last content while the sheet animates out.
  const last = useRef<Open>(null);
  if (open) last.current = open;
  const shown = open ?? last.current;

  let title = '';
  let body = null;
  if (shown?.kind === 'day') {
    const day = shown.day;
    const [y, m, d] = day.date.split('-').map(Number) as [number, number, number];
    title = dayTitle.format(new Date(Date.UTC(y, m - 1, d)));
    const trades = day.tradeIds.map((id) => byId.get(id)).filter((t): t is TradeView => !!t);
    body = (
      <>
        <p className={`day-net num ${day.netUsd > 0 ? 'gain' : day.netUsd < 0 ? 'loss' : ''}`}>{formatUsd(day.netUsd, true)}</p>
        <TradeHistory trades={trades} onSelect={(trade) => setOpen({ kind: 'trade', trade, from: day })} />
      </>
    );
  } else if (shown?.kind === 'trade') {
    title = `${shown.trade.symbol} trade`;
    body = <TradeDetail trade={shown.trade} />;
  }

  return (
    <>
      <Section title="Results" className="span-2">
        <ResultsStats stats={view.stats} />
      </Section>
      <Section title="Daily P&L">
        <PnlCalendar month={view.month} days={view.days} onSelectDay={(day) => setOpen({ kind: 'day', day })} />
      </Section>
      <Section title="Equity">
        <EquityCurve points={view.equity} />
      </Section>
      <Section title="Costs">
        <CostBreakdown costs={view.costs} />
      </Section>
      <Section title="Trades" className="span-2">
        <TradeHistory trades={view.trades} onSelect={(trade) => setOpen({ kind: 'trade', trade })} />
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
