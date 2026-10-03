import { useCallback, useRef, useState } from 'react';
import { MIN_TRADES, TIME_ZONE, type BacktestReport, type CalendarMonth, type DayRecord, type ReportGroup, type ReportResult } from '../api/contract.ts';
import { Sheet } from '../components/Sheet.tsx';
import { Badge, Empty } from '../components/ui.tsx';
import { formatUsdExact, toneOf } from '../lib/money.ts';
import { Boundary } from './Boundary.tsx';
import { PnlCalendar } from './Calendar.tsx';
import { CumulativeChart } from './Charts.tsx';
import { NOT_ENOUGH } from './Sections.tsx';
import { melDate, melDateTime, melDay, shiftMonth } from './time.ts';
import { TradeTable } from './Trades.tsx';

const PART: Record<BacktestReport['part'], string> = { 'walk-forward': 'Walk-forward', research: 'Research' };
const GATE_NAME: Record<BacktestReport['gates'][number]['gate'], string> = { G0: 'Data and engine', G1: 'Walk-forward' };
const GATE_STATE: Record<BacktestReport['gates'][number]['state'], string> = { pass: 'Passed', fail: 'Failed', 'not-run': 'Not run' };
const GROUP_LABEL: Record<ReportGroup, string> = { U1: 'U1', U2: 'U2', U3: 'U3', S0: 'S0 random' };

const span = (w: { from: string; to: string }) => `${melDate(w.from)} to ${melDate(w.to)}`;

/** Averages and intervals need the backtest sample (§14); below it the table says so. */
function ResultsTable({ results }: { results: ReportResult[] }) {
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">Group</th>
            <th scope="col" className="num">Trades</th>
            <th scope="col" className="num">Net</th>
            <th scope="col" className="num">Max drawdown</th>
            <th scope="col" className="num">Win rate</th>
            <th scope="col" className="num">Average net</th>
            <th scope="col" className="num">95% interval</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => {
            const enough = r.trades >= MIN_TRADES.backtest;
            return (
              <tr key={r.group}>
                <td>{GROUP_LABEL[r.group]}</td>
                <td className="num">{r.trades}</td>
                <td className={`num ${toneOf(r.netUsd)}`}>{formatUsdExact(r.netUsd, true)}</td>
                <td className={`num ${toneOf(r.maxDrawdownUsd)}`}>{formatUsdExact(r.maxDrawdownUsd)}</td>
                <td className={`num ${enough ? '' : 'muted'}`}>{enough ? `${((r.wins / r.trades) * 100).toFixed(1)}%` : NOT_ENOUGH}</td>
                <td className={`num ${enough && r.meanNetUsd ? toneOf(r.meanNetUsd) : 'muted'}`}>{enough && r.meanNetUsd ? formatUsdExact(r.meanNetUsd, true) : enough ? '—' : NOT_ENOUGH}</td>
                <td className={`num ${enough ? '' : 'muted'}`}>
                  {enough ? (r.ci95 ? `${formatUsdExact(r.ci95.lowUsd, true)} to ${formatUsdExact(r.ci95.highUsd, true)}` : '—') : NOT_ENOUGH}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** A month of one group's days, in the calendar's shape. */
export function groupMonth(report: BacktestReport, group: ReportGroup, month: string): CalendarMonth {
  const result = report.results.find((r) => r.group === group);
  const ids = new Map<string, string[]>();
  for (const t of report.trades) {
    if (t.group !== group) continue;
    const d = melDay(t.closedAt);
    ids.set(d, [...(ids.get(d) ?? []), t.id]);
  }
  return {
    mode: 'backtest',
    month,
    timeZone: TIME_ZONE,
    days: (result?.days ?? []).filter((d) => d.date.startsWith(month)).map((d) => ({ ...d, pauses: 0, tradeIds: ids.get(d.date) ?? [] })),
  };
}

export function BacktestReportView({ report }: { report: BacktestReport }) {
  const groups = report.results.map((r) => r.group);
  const [group, setGroup] = useState<ReportGroup>(groups[0] ?? 'U1');
  const result = report.results.find((r) => r.group === group);
  const lastDay = result?.days[result.days.length - 1]?.date;
  const [month, setMonth] = useState<string | null>(null);
  const shownMonth = month ?? lastDay?.slice(0, 7) ?? report.dataset.to.slice(0, 7);
  const [day, setDay] = useState<DayRecord | null>(null);
  const close = useCallback(() => setDay(null), []);
  const lastOpen = useRef<DayRecord | null>(null);
  if (day) lastOpen.current = day;
  const shownDay = day ?? lastOpen.current;
  const trades = report.trades.filter((t) => t.group === group);
  const engineOk = report.engine.identicalReplays && report.engine.crashes === 0 && report.engine.illegalStates === 0 && report.engine.unreconciledIntents === 0;

  return (
    <div className="dash-report">
      <div className="dash-verdict">
        <Badge>Backtest</Badge>
        <span className="dash-verdict-text">{PART[report.part]}</span>
        <span className="muted small">{melDateTime(report.generatedAt)}</span>
      </div>
      <dl className="kv kv-wide">
        <div>
          <dt>Run</dt>
          <dd className="mono">{report.runId}</dd>
        </div>
        <div>
          <dt>Code</dt>
          <dd className="mono">{report.codeCommit.slice(0, 12)}</dd>
        </div>
        <div>
          <dt>Dataset</dt>
          <dd className="mono">{report.dataset.id}</dd>
        </div>
        <div>
          <dt>Dates</dt>
          <dd className="num">{span(report.dataset)}</dd>
        </div>
        <div>
          <dt>Policy</dt>
          <dd className="mono dash-hash">{report.policyHash}</dd>
        </div>
        <div>
          <dt>Replays</dt>
          <dd className={`num ${report.engine.identicalReplays ? '' : 'loss'}`}>
            {report.engine.replays} runs, {report.engine.identicalReplays ? 'identical' : 'different'}
          </dd>
        </div>
        <div>
          <dt>Crashes, illegal states, unreconciled</dt>
          <dd className={`num ${engineOk ? '' : 'loss'}`}>
            {report.engine.crashes} · {report.engine.illegalStates} · {report.engine.unreconciledIntents}
          </dd>
        </div>
        <div>
          <dt>Candidates, entries</dt>
          <dd className="num">
            {report.candidates.toLocaleString('en-US')} · {report.entries.toLocaleString('en-US')}
          </dd>
        </div>
      </dl>

      <h3 className="dash-sub">Results</h3>
      <ResultsTable results={report.results} />

      <h3 className="dash-sub">Gates</h3>
      <ul className="dash-gates">
        {report.gates.map((g) => (
          <li key={g.gate}>
            <div className="dash-gate-head">
              <span>
                {g.gate} {GATE_NAME[g.gate]}
              </span>
              <span className={g.state === 'fail' ? 'loss small' : g.state === 'pass' ? 'gain small' : 'muted small'}>{GATE_STATE[g.state]}</span>
            </div>
            {g.checks.length > 0 && (
              <table className="table dash-gate-checks">
                <tbody>
                  {g.checks.map((c) => (
                    <tr key={c.label}>
                      <td>{c.label}</td>
                      <td className={`num ${c.pass ? '' : 'loss'}`}>{c.value}</td>
                      <td className="num muted">{c.limit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </li>
        ))}
      </ul>

      {report.folds.length > 0 && (
        <>
          <h3 className="dash-sub">Walk-forward folds</h3>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Fold</th>
                  <th scope="col">Dates</th>
                  <th scope="col" className="num">Trades</th>
                  <th scope="col" className="num">Average net</th>
                  <th scope="col" className="num">Lower bound</th>
                </tr>
              </thead>
              <tbody>
                {report.folds.map((f) => (
                  <tr key={f.id}>
                    <td>{f.id}</td>
                    <td className="num">{span(f)}</td>
                    <td className="num">{f.trades}</td>
                    <td className={`num ${toneOf(f.meanNetUsd)}`}>{formatUsdExact(f.meanNetUsd, true)}</td>
                    <td className={`num ${toneOf(f.lowUsd)}`}>{formatUsdExact(f.lowUsd, true)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {groups.length > 0 && (
        <>
          <div className="dash-sub dash-group-head">
            <span>By group</span>
            <div className="segmented-options" role="radiogroup" aria-label="Group">
              {groups.map((g) => (
                <button
                  key={g}
                  type="button"
                  role="radio"
                  aria-checked={group === g}
                  className="segmented-option"
                  onClick={() => {
                    setGroup(g);
                    setMonth(null);
                  }}
                >
                  {GROUP_LABEL[g]}
                </button>
              ))}
            </div>
          </div>
          <div className="dash-report-grid">
            <div>
              <h4 className="chart-sub">Net P&L</h4>
              <CumulativeChart points={result?.equity ?? []} />
            </div>
            <div>
              <h4 className="chart-sub">Daily P&L</h4>
              <PnlCalendar
                cal={groupMonth(report, group, shownMonth)}
                onPrev={() => setMonth(shiftMonth(shownMonth, -1))}
                onNext={() => setMonth(shiftMonth(shownMonth, 1))}
                onSelectDay={setDay}
              />
            </div>
          </div>
          <h4 className="chart-sub">Trades</h4>
          {trades.length ? <TradeTable trades={[...trades].reverse()} /> : <Empty title="No trades" />}
        </>
      )}

      <Sheet open={day !== null} title={shownDay ? `${GROUP_LABEL[group]} · ${shownDay.date}` : ''} onClose={close}>
        {shownDay && (
          <Boundary key={shownDay.date}>
            <p className={`day-net num ${toneOf(shownDay.netUsd)}`}>{formatUsdExact(shownDay.netUsd, true)}</p>
            <TradeTable trades={trades.filter((t) => shownDay.tradeIds.includes(t.id))} />
          </Boundary>
        )}
      </Sheet>
    </div>
  );
}
