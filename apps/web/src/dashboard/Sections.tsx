import type { ReactNode } from 'react';
import { type CheckResult, type DecisionRecord, type FunnelView, MODES, type Mode, type PositionRecord, type RiskMeter, type StatsView, type StatusFlag, type WorkerStatus } from '../api/contract.ts';
import { MODE_LABEL, hasSample, requiredTrades } from '../api/modes.ts';
import { Badge, Empty } from '../components/ui.tsx';
import { shortAddress } from '../lib/format.ts';
import { formatPriceDec, formatR, formatShare, formatSolExact, formatUsdExact, toMicro, toneOf } from '../lib/money.ts';
import { ALERT_LABEL, CHECK_LABEL, EXIT_RULE_LABEL, FLAG_ALERT, FLAG_LABEL, HALT_LABEL, REGIME_INPUT_LABEL, REGIME_REASON_LABEL, RISK_LABEL, STAGE_LABEL, VENUE_LABEL, WAIVED_LABEL } from './labels.ts';
import { melDateTime } from './time.ts';

export const NOT_ENOUGH = 'Not enough trades';

export function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className="segmented-options dash-modes" role="radiogroup" aria-label="Mode">
      {MODES.map((m) => (
        <button key={m} type="button" role="radio" aria-checked={mode === m} className="segmented-option" onClick={() => onChange(m)}>
          {MODE_LABEL[m]}
        </button>
      ))}
    </div>
  );
}

/** The mode a section's numbers belong to. */
export function ModeTag({ mode }: { mode: Mode }) {
  return (
    <span className="badge badge-neutral mode-tag" data-mode={mode}>
      {MODE_LABEL[mode]}
    </span>
  );
}

export function StatusFlags({ status }: { status: WorkerStatus }) {
  if (!status.connected) return <span className="badge badge-neutral">Worker not connected</span>;
  if (status.flags.length === 0) return <span className="muted small">No alerts</span>;
  return (
    <ul className="dash-flags" aria-label="Worker state">
      {status.flags.map((f) => (
        <li key={f} className={`dash-flag ${FLAG_ALERT.has(f) ? 'dash-flag-alert' : ''}`}>
          {FLAG_LABEL[f]}
        </li>
      ))}
    </ul>
  );
}

/** Flags that stop new entries, and the reason each prints after "Off:". */
const ENTRY_OFF: readonly (readonly [StatusFlag, string])[] = [
  ['paused', 'paused'],
  ['stale-data', 'stale data'],
  ['regime-off', 'regime'],
  ['waiting-for-evidence', 'no evidence'],
];
const ALERT_FLAGS: readonly StatusFlag[] = ['unknown-tx-result', 'low-fee-reserve', 'rate-limited'];

const label = <K extends string>(labels: Readonly<Record<K, string>>, k: unknown): string | null =>
  typeof k === 'string' && Object.hasOwn(labels, k) ? labels[k as K] : null;
const unique = (xs: readonly (string | null)[]): string[] => [...new Set(xs.filter((x): x is string => x !== null))];
const list = <T,>(v: unknown): readonly T[] | null => (Array.isArray(v) ? (v as T[]) : null);

export interface StatusRow {
  readonly label: 'Entries' | 'Regime' | 'Candidates' | 'Exits' | 'Alerts';
  readonly value: string;
  readonly alert: boolean;
}

/**
 * The worker card's rows. A row appears only when a served field proves it: the flags, and (API-1) the halt reasons,
 * exit readiness, critical alerts and the latest regime evaluation. A field the worker does not serve, or a value
 * this app does not know, adds nothing. "Entries: On" needs the halt reasons empty, the regime on and no stopping flag.
 */
export const statusRows = (status: WorkerStatus): StatusRow[] => {
  const has = new Set<string>(list<string>(status.flags) ?? []);
  const halts = list<{ code?: unknown }>(status.haltReasons);
  const regime = status.regime !== null && typeof status.regime === 'object' && (status.regime.state === 'on' || status.regime.state === 'off') ? status.regime : null;
  const rows: StatusRow[] = [];
  const waived = regime === null ? null : list<unknown>(regime.waived);

  const off = unique([...ENTRY_OFF.filter(([f]) => has.has(f)).map(([, why]) => why), ...(halts ?? []).map((h) => label(HALT_LABEL, h.code))]);
  if (off.length > 0 || (halts !== null && halts.length > 0)) rows.push({ label: 'Entries', value: off.length > 0 ? `Off: ${off.join(', ')}` : 'Off', alert: false });
  // On only with every stop served and none active (the account's risk stops are among the halts), and a regime
  // evaluation that is on and current (at most two candidate evaluation steps old: the worker's regimeMaxAgeMs).
  // Any part the S0 diagnostic set did not judge makes the regime's "on" practice only: never a plain "On".
  else if (halts !== null && regime?.state === 'on' && regime.current === true && waived !== null) rows.push({ label: 'Entries', value: waived.length > 0 ? 'On (practice)' : 'On', alert: false });

  if (regime !== null && regime.current !== true) rows.push({ label: 'Regime', value: 'Not checked lately', alert: false });
  else if (regime !== null && regime.state === 'on' && waived === null) rows.push({ label: 'Regime', value: 'Unknown', alert: false });
  else if (regime !== null && regime.state === 'on' && waived !== null && waived.length > 0) {
    const parts = unique(waived.map((w) => label(WAIVED_LABEL, w) ?? null));
    rows.push({ label: 'Regime', value: parts.length > 0 ? `On (practice: ${parts.join(', ')} not judged)` : 'On (practice)', alert: false });
  } else if (regime !== null) {
    const why = unique((list<{ code?: unknown; input?: unknown }>(regime.reasons) ?? []).map((r) => (r.code === 'unknown' ? (label(REGIME_INPUT_LABEL, r.input) ?? null) : label(REGIME_REASON_LABEL, r.code))));
    rows.push({ label: 'Regime', value: regime.state === 'on' ? 'On' : why.length > 0 ? `Off: ${why.join(', ')}` : 'Off', alert: false });
  }
  if (has.has('no-eligible-candidate')) rows.push({ label: 'Candidates', value: 'None yet', alert: false });

  if (has.has('exit-blocked')) rows.push({ label: 'Exits', value: 'Blocked', alert: true });
  else if (has.has('exit-pending')) rows.push({ label: 'Exits', value: 'Pending', alert: false });
  else if (status.exitCapable === true) rows.push({ label: 'Exits', value: 'Ready', alert: false });
  else if (status.exitCapable === false) rows.push({ label: 'Exits', value: 'Not ready', alert: true });

  const alerts = unique([...ALERT_FLAGS.filter((f) => has.has(f)).map((f) => FLAG_LABEL[f]), ...(list<{ code?: unknown }>(status.alerts) ?? []).map((a) => label(ALERT_LABEL, a.code))]);
  if (alerts.length > 0) rows.push({ label: 'Alerts', value: alerts.join(', '), alert: true });
  return rows;
};

export function StatusCard({ status }: { status: WorkerStatus }) {
  if (!status.connected) return <span className="badge badge-neutral">Worker not connected</span>;
  const rows = statusRows(status);
  // No proven row: nothing. "No alerts" would claim what the flags cannot show.
  if (rows.length === 0) return null;
  return (
    <dl className="status-list" aria-label="Worker state">
      {rows.map((r) => (
        <div key={r.label}>
          <dt>{r.label}</dt>
          <dd className={r.alert ? 'dash-status-alert' : undefined}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RiskList({ meters }: { meters: RiskMeter[] }) {
  if (meters.length === 0) return <Empty title="No limits in this mode" />;
  return (
    <ul className="meters">
      {meters.map((m) => {
        const used = toMicro(m.usedUsd);
        const limit = m.limitUsd === null ? null : toMicro(m.limitUsd);
        const share = limit && limit > 0n ? Math.min(100, Number((used * 1000n) / limit) / 10) : 0;
        const text = m.limitUsd === null ? 'Limit not set' : `${formatUsdExact(m.usedUsd)} of ${formatUsdExact(m.limitUsd)}`;
        return (
          <li key={m.kind} className="meter">
            <div className="meter-label">
              <span>{RISK_LABEL[m.kind]}</span>
              <span className="num">{text}</span>
            </div>
            <div className="meter-track" role="meter" aria-label={RISK_LABEL[m.kind]} aria-valuemin={0} aria-valuemax={100} aria-valuenow={share} aria-valuetext={text}>
              <div className={`meter-fill ${share >= 80 ? 'meter-high' : ''}`} style={{ width: `${share}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function Funnel({ funnel }: { funnel: FunnelView }) {
  const seen = funnel.stages[0]?.count ?? 0;
  const rejected = [...funnel.rejects].sort((a, b) => b.count - a.count);
  return (
    <div className="dash-funnel">
      <ol className="dash-stages">
        {funnel.stages.map((s) => (
          <li key={s.stage}>
            <div className="dash-stage-row">
              <span>{STAGE_LABEL[s.stage]}</span>
              <span className="num">{s.count.toLocaleString('en-US')}</span>
            </div>
            <span className="dash-stage-bar" aria-hidden="true">
              <span style={{ width: `${seen ? Math.max(0.5, (s.count / seen) * 100) : 0}%` }} />
            </span>
          </li>
        ))}
      </ol>
      {rejected.length > 0 && (
        <>
          <h3 className="dash-sub">Rejected by</h3>
          <dl className="dash-rejects">
            {rejected.map((r) => (
              <div key={r.check}>
                <dt>
                  {CHECK_LABEL[r.check]} <span className="muted small">{r.check.startsWith('H') ? r.check : ''}</span>
                </dt>
                <dd className="num">{r.count.toLocaleString('en-US')}</dd>
              </div>
            ))}
          </dl>
        </>
      )}
      <p className="sample">
        {melDateTime(funnel.from)} to {melDateTime(funnel.to)}
      </p>
    </div>
  );
}

const OUTCOME: Record<DecisionRecord['outcome'], string> = { entered: 'Entered', rejected: 'Rejected', 'no-trade': 'No trade' };

/** The first failing check names the decision; entries show their first reason. */
export function headline(d: DecisionRecord): string {
  const failed = d.checks.find((c) => c.result !== 'pass');
  if (failed) return `${CHECK_LABEL[failed.check]}${failed.value ? `: ${failed.value}` : ''}${failed.limit ? ` (needs ${failed.limit})` : ''}`;
  return d.reasons[0] ?? 'All checks passed';
}

export function Journal({ decisions, onOpen }: { decisions: DecisionRecord[]; onOpen: (d: DecisionRecord) => void }) {
  return (
    <ul className="dash-journal">
      {decisions.map((d) => (
        <li key={d.id}>
          <button type="button" className="dash-journal-row" onClick={() => onOpen(d)}>
            <span className={`dash-outcome dash-outcome-${d.outcome}`}>{OUTCOME[d.outcome]}</span>
            <span className="dash-journal-main">
              <span>
                <span className="token-symbol">{d.symbol}</span> <span className="mono muted">{shortAddress(d.mint)}</span>
              </span>
              <span className="muted small dash-journal-why">{headline(d)}</span>
            </span>
            <span className="mono muted small">{melDateTime(d.at)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Checks({ checks }: { checks: CheckResult[] }) {
  if (checks.length === 0) return <p className="muted">No checks recorded</p>;
  return (
    <table className="table dash-checks">
      <thead>
        <tr>
          <th scope="col">Check</th>
          <th scope="col">Result</th>
          <th scope="col" className="num">Value</th>
          <th scope="col" className="num">Limit</th>
        </tr>
      </thead>
      <tbody>
        {checks.map((c) => (
          <tr key={c.check}>
            <td>
              {CHECK_LABEL[c.check]} {c.check.startsWith('H') && <span className="muted small">{c.check}</span>}
            </td>
            <td className={c.result === 'fail' ? 'loss' : c.result === 'unknown' ? 'loss' : ''}>{c.result === 'pass' ? 'Passed' : c.result === 'fail' ? 'Failed' : 'Unknown'}</td>
            <td className="num">{c.value ?? '—'}</td>
            <td className="num muted">{c.limit ?? '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function DecisionDetail({ decision }: { decision: DecisionRecord }) {
  return (
    <div className="detail">
      <dl className="detail-list">
        <div>
          <dt>Outcome</dt>
          <dd>{OUTCOME[decision.outcome]}</dd>
        </div>
        <div>
          <dt>Token</dt>
          <dd>
            <strong>{decision.symbol}</strong> <span className="mono muted">{shortAddress(decision.mint)}</span>
          </dd>
        </div>
        <div>
          <dt>Venue</dt>
          <dd>{VENUE_LABEL[decision.venue]}</dd>
        </div>
        <div>
          <dt>Time</dt>
          <dd className="mono">{melDateTime(decision.at)}</dd>
        </div>
        <div>
          <dt>Rule score</dt>
          <dd className="num">{decision.ruleScore ?? '—'}</dd>
        </div>
      </dl>
      {decision.reasons.length > 0 && (
        <>
          <h3>Reasons</h3>
          <ul className="dash-reasons">
            {decision.reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
      <h3>Checks</h3>
      <div className="table-wrap">
        <Checks checks={decision.checks} />
      </div>
    </div>
  );
}

const EXIT_STATE: Record<PositionRecord['exit'], string> = { none: 'Watching', pending: 'Exit pending', blocked: 'Exit blocked' };
const WORKER_STATE: Record<PositionRecord['worker'], string> = { watching: 'Watching', exiting: 'Exiting', reconciling: 'Reconciling' };

export function OpenPosition({ position }: { position: PositionRecord }) {
  const rows: [string, ReactNode, string?][] = [
    ['Token', <><strong>{position.symbol}</strong> <span className="mono muted">{shortAddress(position.mint)}</span></>],
    ['Venue', VENUE_LABEL[position.venue]],
    ['Opened', <span className="mono">{melDateTime(position.openedAt)}</span>],
    ['Entry price', formatPriceDec(position.entryPriceUsd), 'num'],
    ['Size', formatUsdExact(position.sizeUsd), 'num'],
    ['Liquidation value', formatUsdExact(position.liquidationValueUsd), 'num'],
    ['Unrealized', formatUsdExact(position.unrealizedUsd, true), `num ${toneOf(position.unrealizedUsd)}`],
    ['Costs so far', formatUsdExact(position.costsSoFarUsd), 'num'],
    ['Worker', WORKER_STATE[position.worker]],
  ];
  return (
    <div className="dash-position">
      <dl className="kv">
        {rows.map(([k, v, cls]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd className={cls}>{v}</dd>
          </div>
        ))}
      </dl>
      <h3 className="dash-sub">
        Exit rules <span className={position.exit === 'blocked' ? 'loss small' : 'muted small'}>{EXIT_STATE[position.exit]}</span>
      </h3>
      <ul className="dash-rules">
        {position.exitRules.map((r) => (
          <li key={r.rule}>
            <span>{EXIT_RULE_LABEL[r.rule]}</span>
            <span className="muted">{r.trigger}</span>
            <Badge tone={r.state === 'triggered' ? 'accent' : 'neutral'}>{r.state === 'triggered' ? 'Triggered' : 'Armed'}</Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Win rate, averages and intervals stay hidden until the sample §14 needs exists. */
export function Stats({ stats }: { stats: StatsView }) {
  const enough = hasSample(stats);
  const need = requiredTrades(stats);
  const shown = (v: string | null, f: (s: string) => string) => (enough && v !== null ? f(v) : NOT_ENOUGH);
  const items: { label: string; value: string; tone?: string }[] = [
    { label: 'Net result', value: stats.trades ? formatUsdExact(stats.netUsd, true) : '—', tone: toneOf(stats.netUsd) },
    { label: 'Net in SOL', value: stats.trades ? formatSolExact(stats.netSol, true) : '—' },
    { label: 'SOL price move', value: stats.trades ? formatUsdExact(stats.solMoveUsd, true) : '—', tone: toneOf(stats.solMoveUsd) },
    { label: 'Max drawdown', value: stats.trades ? formatUsdExact(stats.maxDrawdownUsd) : '—', tone: toneOf(stats.maxDrawdownUsd) },
    { label: 'Win rate', value: shown(stats.winRate, (s) => formatShare(s)) },
    { label: 'Average net', value: shown(stats.meanNetUsd, (s) => formatUsdExact(s, true)), ...(enough && stats.meanNetUsd ? { tone: toneOf(stats.meanNetUsd) } : {}) },
    { label: 'Average R', value: shown(stats.meanR, formatR) },
    { label: '95% interval', value: enough && stats.ci95 ? `${formatUsdExact(stats.ci95.lowUsd, true)} to ${formatUsdExact(stats.ci95.highUsd, true)}` : NOT_ENOUGH },
  ];
  return (
    <div className="results-stats">
      <dl className="stat-row">
        {items.map((i) => (
          <div className="stat" key={i.label}>
            <dt>{i.label}</dt>
            <dd className={`num ${i.tone ?? ''} ${i.value === NOT_ENOUGH ? 'muted-value' : ''} ${i.value.includes(' to ') ? 'dash-range' : ''}`}>{i.value}</dd>
          </div>
        ))}
      </dl>
      <p className="sample num">
        {stats.trades} {stats.trades === 1 ? 'trade' : 'trades'}
        {enough ? '' : ` of ${need} needed`} · {MODE_LABEL[stats.mode]} only
      </p>
    </div>
  );
}
