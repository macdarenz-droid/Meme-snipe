import type { BacktestReport } from '../api/contract.ts';
import { Badge } from '../components/ui.tsx';
import { formatUsdExact, toneOf } from '../lib/money.ts';
import { UNIVERSES } from './labels.ts';
import { melDate } from './time.ts';

const GATE_NAME: Record<BacktestReport['gates'][number]['gate'], string> = { G0: 'Data and engine', G1: 'Walk-forward', G2: 'Holdout' };
const GATE_STATE: Record<BacktestReport['gates'][number]['state'], string> = { pass: 'Passed', fail: 'Failed', 'not-run': 'Not run' };
const HOLDOUT_STATE: Record<BacktestReport['holdout']['state'], string> = { sealed: 'Sealed', opened: 'Opened', burned: 'Burned', 'not-run': 'Not run' };

const span = (w: { from: string; to: string }) => `${melDate(w.from)} to ${melDate(w.to)}`;

/** The proof only counts when G2 passed on an opened holdout (§14). */
export const proven = (r: BacktestReport) => r.holdout.state === 'opened' && r.gates.some((g) => g.gate === 'G2' && g.state === 'pass');

export function BacktestReportView({ report }: { report: BacktestReport }) {
  const h = report.holdout;
  const engineOk = report.replays.identical && report.crashes === 0 && report.illegalStates === 0 && report.unreconciledIntents === 0;
  return (
    <div className="dash-report">
      <div className="dash-verdict">
        <span className={`dash-verdict-text ${proven(report) ? 'gain' : ''}`}>{proven(report) ? 'Proven' : 'Not proven yet'}</span>
      </div>
      <dl className="kv kv-wide">
        <div>
          <dt>Run</dt>
          <dd className="mono">{report.runId}</dd>
        </div>
        <div>
          <dt>Engine</dt>
          <dd className="mono">
            {report.engineVersion} · {report.policyVersion}
          </dd>
        </div>
        <div>
          <dt>Dataset</dt>
          <dd className="mono dash-hash" title={report.datasetHash}>
            {report.datasetHash}
          </dd>
        </div>
        <div>
          <dt>Walk-forward</dt>
          <dd className="num">{span(report.window)}</dd>
        </div>
        <div>
          <dt>Holdout</dt>
          <dd className="num">{span(report.holdoutWindow)}</dd>
        </div>
        <div>
          <dt>Replays</dt>
          <dd className={`num ${report.replays.identical ? '' : 'loss'}`}>
            {report.replays.runs} runs, {report.replays.identical ? 'identical' : 'different'}
          </dd>
        </div>
        <div>
          <dt>Crashes, illegal states, unreconciled</dt>
          <dd className={`num ${engineOk ? '' : 'loss'}`}>
            {report.crashes} · {report.illegalStates} · {report.unreconciledIntents}
          </dd>
        </div>
        <div>
          <dt>Candidates, entries</dt>
          <dd className="num">
            {report.candidates.toLocaleString('en-US')} · {report.entries.toLocaleString('en-US')}
          </dd>
        </div>
      </dl>

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

      <h3 className="dash-sub">Walk-forward folds</h3>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Fold</th>
              <th scope="col">Window</th>
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

      <h3 className="dash-sub">
        Holdout <Badge>{HOLDOUT_STATE[h.state]}</Badge>
      </h3>
      <dl className="kv">
        {UNIVERSES.filter((u) => h.entries[u] !== undefined).map((u) => (
          <div key={u}>
            <dt>{u} trades</dt>
            <dd className="num">
              {h.entries[u]}
              {h.required !== null ? ` of ${h.required}` : ''}
            </dd>
          </div>
        ))}
        {h.state === 'opened' ? (
          <>
            <div>
              <dt>Average net</dt>
              <dd className={`num ${h.meanNetUsd ? toneOf(h.meanNetUsd) : ''}`}>{h.meanNetUsd ? formatUsdExact(h.meanNetUsd, true) : '—'}</dd>
            </div>
            <div>
              <dt>95% interval</dt>
              <dd className="num">{h.ci95 ? `${formatUsdExact(h.ci95.lowUsd, true)} to ${formatUsdExact(h.ci95.highUsd, true)}` : '—'}</dd>
            </div>
          </>
        ) : (
          <div>
            <dt>Result</dt>
            <dd className="muted">{h.state === 'burned' ? 'Burned, needs a new window' : h.state === 'sealed' ? 'Sealed until every universe has its trades' : 'Not run'}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}
