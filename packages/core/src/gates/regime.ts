// Regime gate (docs/ARCHITECTURE.md §6.4). Live entries only while the market regime holds; otherwise paper only,
// exits keep running. Computed as of the decision moment from stored snapshots only: every series is read through
// the as-of store, and inside a snapshot only points dated at or before the check time count.
//
// Checks fall on hour boundaries. The current check is the latest hour every series has reached (and at most
// HOURLY_MAX_AGE_MS old); earlier checks are whole hours before it. The gate is off when the current check cannot be
// computed (unknown evidence means no trade), or when the last `failedChecksToDisable` checks all failed.
import type { PolicySession } from '../config/session.ts';
import type { Policy } from '../config/policy.ts';
import { Evidence, type GateContext } from './evidence.ts';
import {
  type CurveVolumeFact, type GraduatesFact, type SolUsdFact,
  CURVE_VOLUME_KEY, EXEC_HEALTH_KEY, GRADUATES_KEY, SOL_USD_KEY, parseCurveVolume, parseExecHealth, parseGraduates, parseSolUsd,
} from './facts.ts';
import type { Mode } from './hard.ts';
import type { EvidenceCode, FactName, GateReason } from './reasons.ts';
import { BPS_DENOMINATOR } from '../units/index.ts';
import { VOLUME_SERIES_START_DAY } from '../config/time.ts';
import { DAY_MS, HOURLY_MAX_AGE_MS, HOUR_MS, floorTo, solUsdExact } from './series.ts';

export type RegimeCondition = 'survival' | 'volume' | 'sol-change';

/** One condition at one check: its value and limit (logged as features), or why it could not be computed. */
export type ConditionResult =
  | { readonly condition: RegimeCondition; readonly ok: boolean; readonly value: string; readonly limit: string }
  | { readonly condition: RegimeCondition; readonly ok: null; readonly code: EvidenceCode; readonly input: FactName; readonly detail: string };

export interface RegimeCheck {
  readonly atMs: number;
  /** True: every condition held. False: one failed. Null: one could not be computed. */
  readonly ok: boolean | null;
  readonly conditions: readonly ConditionResult[];
}

export interface RegimeReason {
  readonly code: 'regime-off' | 'unknown' | 'exec-health' | 'policy-session-ended';
  readonly detail: string;
  readonly input?: FactName;
}

/**
 * The S0 shakedown's diagnostic set (WORKER-1e, supervisor ruling 2026-10-04): never in the qualifying run (the
 * worker refuses it there). Each part is named on every decision it changes; every other check stays real.
 * - `regime-volume`: the curve-volume condition is computed and logged but not judged (it needs 28 published days).
 * - `regime-survival`: the graduate-survival condition likewise (it needs 15 days of graduates, built live).
 * - `exec-health`: execution health is measured from paper's own attempts and logged, never judged (its limits are the owner's).
 * - `h14-creates-coverage`: H14 judges the deployer over the creates coverage the host has, not the full look-back.
 */
export type S0DiagnosticPart = 'regime-volume' | 'regime-survival' | 'exec-health' | 'h14-creates-coverage';
export const S0_DIAGNOSTIC_PARTS: readonly S0DiagnosticPart[] = ['regime-volume', 'regime-survival', 'exec-health', 'h14-creates-coverage'];
/** The regime conditions the diagnostic set logs without judging, with the part that names each. */
const UNJUDGED: ReadonlyMap<RegimeCondition, S0DiagnosticPart> = new Map([['volume', 'regime-volume'], ['survival', 'regime-survival']]);

export interface RegimeResult {
  readonly on: boolean;
  readonly mode: Mode;
  /** Newest first: the current check, then each earlier one. Empty when no check time could be found. */
  readonly checks: readonly RegimeCheck[];
  readonly reasons: readonly RegimeReason[];
  /** Live only: execution health; in the backtest it is absent (§16.3). */
  readonly execHealth: { readonly applied: boolean; readonly green: boolean | null; readonly detail: string };
  /** The S0 diagnostic parts this result relied on (empty without the diagnostic). */
  readonly waived: readonly S0DiagnosticPart[];
}

// ---------- Exact fractions ----------

interface Frac { readonly n: bigint; readonly d: bigint }
const cmpFrac = (a: Frac, b: Frac): number => {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};
const showFrac = (f: Frac): string => `${f.n}/${f.d}`;

/** Median of fractions; for an even count, the mean of the two middle ones, exactly. */
const median = (xs: readonly Frac[]): Frac => {
  const s = [...xs].sort(cmpFrac);
  const mid = s.length >> 1;
  if (s.length % 2 === 1) return s[mid]!;
  const a = s[mid - 1]!;
  const b = s[mid]!;
  return { n: a.n * b.d + b.n * a.d, d: 2n * a.d * b.d };
};

// ---------- Conditions ----------

const unknown = (condition: RegimeCondition, input: FactName, code: EvidenceCode, detail: string): ConditionResult => ({ condition, ok: null, code, input, detail });

/** Survival share of graduates whose +30 min mark falls in the 24 h before `at`, against the median of the 14 days before. */
export const survivalCondition = (g: GraduatesFact, at: number, p: Policy['regime']): ConditionResult => {
  const known = g.items.filter((i) => i.migratedAtMs + p.survivalAfterMs <= at);
  const share = (from: number, to: number): Frac | null => {
    const inWindow = known.filter((i) => i.migratedAtMs + p.survivalAfterMs > from && i.migratedAtMs + p.survivalAfterMs <= to);
    if (inWindow.length === 0) return null;
    return { n: BigInt(inWindow.filter((i) => i.reserveAfter > p.survivalReserveFloor).length), d: BigInt(inWindow.length) };
  };
  // R2-6: the 24 h share is judged only on a window the series observed whole (a restart's hole reads as not covered).
  const u = g.unobserved;
  if (u !== undefined && u.fromMs <= at && u.toMs > at - DAY_MS) return unknown('survival', 'graduates', 'not-covered', `survival marks from ${u.fromMs} to ${u.toMs} were not observed; the 24 h before ${at} needs them`);
  const recent = share(at - DAY_MS, at);
  if (recent === null) return unknown('survival', 'graduates', 'not-covered', `no graduate reached +${p.survivalAfterMs} ms in the 24 h before ${at}`);
  const days: Frac[] = [];
  for (let k = 1; k <= p.survivalMedianDays; k++) {
    const s = share(at - (k + 1) * DAY_MS, at - k * DAY_MS);
    if (s === null) return unknown('survival', 'graduates', 'not-covered', `no graduates in day -${k} before ${at}`);
    days.push(s);
  }
  const m = median(days);
  return { condition: 'survival', ok: cmpFrac(recent, m) >= 0, value: showFrac(recent), limit: showFrac(m) };
};

/**
 * Curve volume of day L = D - volumeLagDays (D is the check's UTC day) against the nearest-rank percentile of the
 * expanding window from max(series start, L - volumeWindowDays + 1) to L. Fewer than volumeMinDays days in the window,
 * or any day in it missing, is unknown. The lag leaves room for the archive to finish a day before it is read.
 */
export const volumeCondition = (v: CurveVolumeFact, at: number, p: Policy['regime']): ConditionResult => {
  const lastDay = Math.floor(at / DAY_MS) - p.volumeLagDays;
  const firstDay = Math.max(VOLUME_SERIES_START_DAY, lastDay - p.volumeWindowDays + 1);
  if (lastDay - firstDay + 1 < p.volumeMinDays) {
    return unknown('volume', 'curve-volume', 'not-covered', `${Math.max(0, lastDay - firstDay + 1)} days of curve volume up to UTC day ${lastDay}; ${p.volumeMinDays} needed`);
  }
  const byDay = new Map<number, bigint>();
  for (const d of v.days) if ((d.day + 1) * DAY_MS <= at) byDay.set(d.day, d.volumeLamports);
  const span: bigint[] = [];
  for (let day = firstDay; day <= lastDay; day++) {
    const x = byDay.get(day);
    if (x === undefined) return unknown('volume', 'curve-volume', 'not-covered', `no curve volume for UTC day ${day}`);
    span.push(x);
  }
  const last = byDay.get(lastDay)!;
  const sorted = [...span].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const rank = Math.ceil((p.volumePercentile * sorted.length) / 100);
  const pct = sorted[Math.max(rank, 1) - 1]!;
  return { condition: 'volume', ok: last >= pct, value: String(last), limit: String(pct) };
};

/** SOL's change over the 24 h ending at `at`, in basis points (rounded down), must be above the floor. */
const solChange = (s: SolUsdFact, at: number, p: Policy['regime']): ConditionResult => {
  const end = solUsdExact(s, at);
  const start = solUsdExact(s, at - DAY_MS);
  if (end === null || start === null) return unknown('sol-change', 'sol-usd', 'not-covered', `no SOL/USD point at ${end === null ? at : at - DAY_MS}`);
  const diff = (end - start) * BPS_DENOMINATOR;
  const bpsChange = diff / start - (diff % start !== 0n && diff < 0n ? 1n : 0n);
  return { condition: 'sol-change', ok: bpsChange > BigInt(p.solChange24hFloorBps), value: String(bpsChange), limit: String(p.solChange24hFloorBps) };
};

type Missing = { readonly missing: string };

/** One check; with the diagnostic set volume and survival are listed but left out of `ok` (`missing`: no such fact). */
const check = (atMs: number, g: GraduatesFact | Missing, v: CurveVolumeFact | Missing, s: SolUsdFact, p: Policy['regime'], diag: boolean): RegimeCheck => {
  const volume = 'missing' in v ? unknown('volume', 'curve-volume', 'missing', v.missing) : volumeCondition(v, atMs, p);
  const surv = 'missing' in g ? unknown('survival', 'graduates', 'missing', g.missing) : survivalCondition(g, atMs, p);
  const conditions = [surv, volume, solChange(s, atMs, p)];
  const judged = diag ? conditions.filter((c) => !UNJUDGED.has(c.condition)) : conditions;
  const ok = judged.some((c) => c.ok === null) ? null : judged.every((c) => c.ok === true);
  return { atMs, ok, conditions };
};

export interface RegimeDeps {
  readonly session: PolicySession;
  readonly mode: Mode;
  /** The S0 shakedown's diagnostic set (`S0DiagnosticPart`); the worker refuses it in the qualifying run. */
  readonly s0Diagnostic?: true;
}

export const evaluateRegime = (ctx: GateContext, deps: RegimeDeps): RegimeResult => {
  const absent = { applied: false, green: null, detail: 'live only (§16.3)' } as const;
  const diag = deps.s0Diagnostic === true;
  const waived: S0DiagnosticPart[] = [];
  const off = (reasons: RegimeReason[], checks: RegimeCheck[] = [], execHealth: RegimeResult['execHealth'] = absent): RegimeResult =>
    ({ on: false, mode: deps.mode, checks, reasons, execHealth, waived });
  if (!deps.session.running) return off([{ code: 'policy-session-ended', detail: 'the policy session has ended' }]);
  const policy = deps.session.policy;
  const ev = new Evidence(ctx, policy);
  const now = ctx.now.receivedAt;

  const g = ev.read('graduates', GRADUATES_KEY, parseGraduates, 'series', 'H16');
  const v = ev.read('curve-volume', CURVE_VOLUME_KEY, parseCurveVolume, 'series', 'H16');
  const s = ev.read('sol-usd', SOL_USD_KEY, parseSolUsd, 'series', 'H16');
  const failed = [...(diag ? [] : [g, v]), s].filter((r): r is { ok: false; reason: GateReason } => !r.ok);
  if (failed.length > 0) return off(failed.map((r) => ({ code: 'unknown', detail: r.reason.detail, ...(r.reason.input ? { input: r.reason.input } : {}) })));
  if (!s.ok) throw new Error('unreachable');
  const volume = v.ok ? v.fact : { missing: v.reason.detail };
  const graduates = g.ok ? g.fact : { missing: g.reason.detail };

  // The current check: the latest hour boundary that the SOL series has a point for and the graduate snapshot has reached.
  const solLatest = s.fact.points.reduce((m, p) => (p.tMs <= now && p.tMs > m ? p.tMs : m), Number.MIN_SAFE_INTEGER);
  const reached = Math.min(now, g.ok ? g.fact.obs.receivedAt : now, solLatest);
  const current = floorTo(reached, HOUR_MS);
  if (solLatest === Number.MIN_SAFE_INTEGER || now - current > HOURLY_MAX_AGE_MS) {
    return off([{ code: 'unknown', input: 'sol-usd', detail: `regime series have not reached a check within ${HOURLY_MAX_AGE_MS} ms of now` }]);
  }

  const checks: RegimeCheck[] = [];
  for (let k = 0; k < policy.regime.failedChecksToDisable; k++) checks.push(check(current - k * HOUR_MS, graduates, volume, s.fact, policy.regime, diag));
  if (diag) for (const [cond, part] of UNJUDGED) if (checks.some((c) => c.conditions.some((x) => x.condition === cond && x.ok !== true))) waived.push(part);

  let execHealth: RegimeResult['execHealth'] = absent;
  const reasons: RegimeReason[] = [];
  if (deps.mode === 'live') {
    const h = ev.read('exec-health', EXEC_HEALTH_KEY, parseExecHealth, 'offchain', 'H16');
    if (diag) {
      // Measured, not judged: logged for the owner's limits, never a reason.
      execHealth = { applied: false, green: h.ok ? h.fact.green : null, detail: `S0 diagnostic, not judged: ${h.ok ? h.fact.detail : h.reason.detail}` };
      waived.push('exec-health');
    } else if (!h.ok) {
      execHealth = { applied: true, green: null, detail: h.reason.detail };
      reasons.push({ code: 'unknown', input: 'exec-health', detail: h.reason.detail });
    } else {
      execHealth = { applied: true, green: h.fact.green, detail: h.fact.detail };
      if (!h.fact.green) reasons.push({ code: 'exec-health', input: 'exec-health', detail: `execution health is not green: ${h.fact.detail}` });
    }
  }

  const head = checks[0]!;
  if (head.ok === null) {
    for (const c of head.conditions) if (c.ok === null && (!diag || !UNJUDGED.has(c.condition))) reasons.push({ code: 'unknown', input: c.input, detail: c.detail });
  } else if (checks.every((c) => c.ok !== true)) {
    const judged = (x: ConditionResult): boolean => x.ok !== true && (!diag || !UNJUDGED.has(x.condition));
    reasons.push({ code: 'regime-off', detail: `the last ${checks.length} checks failed: ${checks.map((c) => c.conditions.filter(judged).map((x) => x.condition).join('+')).join(', ')}` });
  }
  return { on: reasons.length === 0, mode: deps.mode, checks, reasons, execHealth, waived };
};
