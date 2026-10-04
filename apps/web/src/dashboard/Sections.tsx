import { type ReactNode, useEffect, useState } from 'react';
import { type CheckResult, type DecisionRecord, type FunnelView, MODES, STALE_AFTER_SECONDS, type Mode, type PositionRecord, type RiskMeter, type StatsView, type StatusFlag, type WorkerStatus } from '../api/contract.ts';
import { MODE_LABEL, hasSample, requiredTrades } from '../api/modes.ts';
import { TokenActions } from '../components/TokenActions.tsx';
import { Badge, Empty } from '../components/ui.tsx';
import { formatDuration, shortAddress } from '../lib/format.ts';
import { formatPrice4, formatPriceDec, formatR, formatReturn, formatShare, formatUsdExact, returnHundredths, toMicro, toneOf, toneOfReturn } from '../lib/money.ts';
import { ALERT_LABEL, CHECK_LABEL, EXIT_RULE_LABEL, FLAG_ALERT, FLAG_LABEL, HALT_LABEL, REGIME_INPUT_LABEL, REGIME_REASON_LABEL, RISK_CODE_LABEL, RISK_LABEL, STAGE_LABEL, VENUE_LABEL, WAIVED_LABEL, WORKER_CODE_LABEL } from './labels.ts';
import { ago, melDateTime } from './time.ts';

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

/**
 * A worker that answers with connected false has no market feed connected (api.ts: reconciled and any feed up; its API
 * starts only after the reconcile), so it reads "Feeds down", never "Worker not connected" (APP-WIRE, supervisor ruling).
 */
export const NOT_CONNECTED = 'Feeds down';

export function StatusFlags({ status }: { status: WorkerStatus }) {
  if (!status.connected) return <span className="badge badge-neutral">{NOT_CONNECTED}</span>;
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
  if (!status.connected) return <span className="badge badge-neutral">{NOT_CONNECTED}</span>;
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
          <h3 className="dash-sub">Rejections</h3>
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
  // An entry that names no reason passed every check; a decision with no known reason says what it was (review N3).
  return decisionReasons(d.reasons)[0] ?? (d.outcome === 'entered' ? 'All checks passed' : OUTCOME[d.outcome]);
}

const own = (m: Record<string, string>, k: unknown): string | null => (typeof k === 'string' && Object.hasOwn(m, k) ? m[k]! : null);

/** One typed reason (gate and code) in words; null for one this app does not know. */
function reasonLabel(gate: unknown, code: unknown): string | null {
  if (typeof gate !== 'string') return null;
  if (/^H\d+$/.test(gate)) return own(CHECK_LABEL, gate);
  if (gate === 'regime') return code === 'unknown' ? 'Market regime unknown' : CHECK_LABEL.regime;
  if (/^R\d+$/.test(gate)) return own(RISK_CODE_LABEL, code);
  if (gate === 'worker' || gate === 'stop') return own(WORKER_CODE_LABEL, code) ?? (gate === 'stop' ? 'Stop distance' : null);
  return null;
}

/**
 * A decision's reasons in words (APP-WORDS a). The worker serves its journal lines; the app reads the typed ones (the
 * `gate_reasons` list, the S0 practice parts and a paper fill) and shows each label once. Free text and codes this
 * app does not know are left out: never a raw line or code on screen.
 */
export function decisionReasons(reasons: readonly string[]): string[] {
  const out: string[] = [];
  for (const line of reasons) {
    if (line === 'entry filled (paper)') out.push('Filled (paper)');
    else if (line.startsWith('gate_reasons ')) {
      let typed: unknown;
      try {
        typed = JSON.parse(line.slice('gate_reasons '.length));
      } catch {
        continue;
      }
      if (Array.isArray(typed)) for (const r of typed) if (r && typeof r === 'object') out.push(reasonLabel((r as { gate?: unknown }).gate, (r as { code?: unknown }).code) ?? '');
    } else if (line.startsWith('s0_diagnostic ')) {
      const parts = unique(line.slice('s0_diagnostic '.length).split(',').map((p) => own(WAIVED_LABEL, p.trim())));
      if (parts.length > 0) out.push(`Practice: ${parts.join(', ')} not judged`);
    }
  }
  return [...new Set(out.filter((x) => x !== ''))];
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
          <TokenActions mint={d.mint} />
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
            <strong>{decision.symbol}</strong> <span className="mono muted">{shortAddress(decision.mint)}</span> <TokenActions mint={decision.mint} />
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
      {decisionReasons(decision.reasons).length > 0 && (
        <>
          <h3>Reasons</h3>
          <ul className="dash-reasons">
            {decisionReasons(decision.reasons).map((r) => (
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

/** The open trade's clock: re-reads the time every second, so Running and the mark's age stay true on screen. */
export const RUNNING_TICK_MS = 1_000;

function useNow(fixed: number | undefined): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (fixed !== undefined) return;
    const timer = setInterval(() => setTick(Date.now()), RUNNING_TICK_MS);
    return () => clearInterval(timer);
  }, [fixed]);
  return fixed ?? tick;
}

/** Time since the server's openedAt (APP-TRADE), never the phone's own start. */
export const runningSeconds = (openedAt: string, now: number): number => Math.max(0, Math.floor((now - Date.parse(openedAt)) / 1000));

/** The mark is stale past the app's stale rule for any answer (STALE_AFTER_SECONDS). */
export const markStale = (markedAt: string, now: number): boolean => now - Date.parse(markedAt) > STALE_AFTER_SECONDS * 1000;

function PriceNow({ position, now }: { position: PositionRecord; now: number }) {
  const { markPriceUsd: mark, markedAt } = position;
  if (mark == null) return <>—</>;
  if (markedAt == null) return <>{formatPrice4(mark)}</>;
  const stale = markStale(markedAt, now);
  return (
    <>
      <span className={stale ? 'loss' : ''}>{formatPrice4(mark)}</span> <span className={stale ? 'loss small' : 'muted small'}>{ago(markedAt, now)}</span>
    </>
  );
}

export function OpenPosition({ position, now: fixed }: { position: PositionRecord; now?: number }) {
  const now = useNow(fixed);
  const pnl = position.pnlUsd ?? null;
  const ret = pnl === null ? null : returnHundredths(pnl, position.sizeUsd);
  const rows: [string, ReactNode, string?][] = [
    ['Token', <><strong>{position.symbol}</strong> <span className="mono muted">{shortAddress(position.mint)}</span> <TokenActions mint={position.mint} /></>],
    ['Venue', VENUE_LABEL[position.venue]],
    ['Opened', <span className="mono">{melDateTime(position.openedAt)}</span>],
    ['Running', formatDuration(runningSeconds(position.openedAt, now)), 'num'],
    ['Entry price', formatPriceDec(position.entryPriceUsd), 'num'],
    ['Price now', <PriceNow position={position} now={now} />, 'num'],
    ['Size', formatUsdExact(position.sizeUsd), 'num'],
    ['Liquidation value', formatUsdExact(position.liquidationValueUsd), 'num'],
    ['Unrealized', formatUsdExact(position.unrealizedUsd, true), `num ${toneOf(position.unrealizedUsd)}`],
    ['Costs so far', formatUsdExact(position.costsSoFarUsd), 'num'],
    ['P&L', pnl === null ? '—' : formatUsdExact(pnl, true), `num ${pnl === null ? '' : toneOf(pnl)}`],
    ['Return', formatReturn(ret), `num ${toneOfReturn(ret)}`],
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
