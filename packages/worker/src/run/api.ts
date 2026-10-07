// The app's read API (UI-2 contract, apps/web/src/api/contract.ts): the paper worker's status, funnel, decisions, open
// position, calendar, trades, charts and statistics, every response and every record stamped `mode: "paper"`, money as
// decimal-string US dollars (micro-dollar exact). Loopback only (default 127.0.0.1:8788); on the host OPS publishes it
// to the owner's tailnet with `tailscale serve`, so the worker never binds anything else. Reads only: no command is
// served here (pause stays with the watchdog's /pause; commands need their own auth level, never "it came from
// loopback").
import { PRICE_SCALE, exitsFor } from '../../../core/src/config/index.ts';
import { attemptFee, type FillNetwork } from '../../../core/src/fills/index.ts';
import { createServer, type Server } from 'node:http';
import type { Policy } from '../../../core/src/config/index.ts';
import type { Book, ExitReason as BookExitReason, PositionState } from '../../../core/src/lifecycle/index.ts';
import { melbourneDay } from '../../../core/src/risk/index.ts';
import { type Lamports, type MicroUsd, lamportsToMicroUsd, microUsdToLamports } from '../../../core/src/units/index.ts';
import { type TradeUsd, tradeUsd } from '../../../core/src/fills/index.ts';
import { type PaperLegs, type PaperTrade, paperTradeLamports, tradePnl, tradeSol } from './account.ts';
import type { PaperAttempt } from './paper-world.ts';
import { SEEDING, STOPS_EVERY_MS } from '../engine/strategy.ts';
import type { LogRecord } from '../../../core/src/engine/index.ts';

const MODE = 'paper' as const;
const LAMPORTS_PER_SOL = 1_000_000_000n;
/** pump and PumpSwap tokens have 6 decimals. */
const TOKEN_UNIT = 1_000_000n;
const PRICE_PLACES = 12;

/** Micro-dollars as the contract's `Usd`: exact, shortest form. */
export const usdText = (micro: bigint): string => {
  const neg = micro < 0n;
  const a = neg ? -micro : micro;
  const frac = (a % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / 1_000_000n}${frac === '' ? '' : `.${frac}`}`;
};

/** Lamports as the contract's `Lamports`: an exact signed integer string (APP-SOL: the owner counts results in SOL). */
export const lamText = (l: bigint): string => l.toString();

/**
 * A lamport sum that fails closed (APP-SOL review N1): a trade with no lamport net makes the sum unknown (null), so the
 * figure is not served in lamports and the app shows its dollars; it never counts as 0 SOL.
 */
const addLam = (sum: bigint | null, x: bigint | null): bigint | null => (sum === null || x === null ? null : sum + x);
/** A lamport field only when known. */
const lamField = <K extends string>(key: K, v: bigint | null): Partial<Record<K, string>> => (v === null ? {} : ({ [key]: lamText(v) } as Record<K, string>));

/** Micro-dollars in lamports at a SOL price, signed; null without a price (APP-SOL: dollar-native figures shown in SOL). */
const usdLamports = (micro: bigint, price: MicroUsd | null, rounding: 'floor' | 'ceil'): string | null => {
  if (price === null) return null;
  const v = microUsdToLamports((micro < 0n ? -micro : micro) as MicroUsd, price, rounding);
  return lamText(micro < 0n ? -v : v);
};

/** Signed lamports in micro-dollars at a SOL price (rounded toward zero; 0 without a price). */
export const lamportsUsd = (l: bigint, price: MicroUsd | null): bigint => {
  if (price === null) return 0n;
  const v = lamportsToMicroUsd((l < 0n ? -l : l) as Lamports, price, 'floor');
  return l < 0n ? -v : v;
};

/** A token price in dollars per whole token, as a `Dec` with 12 places: lamports paid for `tokens` raw units. */
export const priceText = (lamports: bigint, tokens: bigint, price: MicroUsd | null): string => {
  if (tokens <= 0n || price === null) return '0';
  const scaled = (lamports * price * TOKEN_UNIT * 10n ** BigInt(PRICE_PLACES)) / (LAMPORTS_PER_SOL * tokens * 1_000_000n);
  const s = scaled.toString().padStart(PRICE_PLACES + 1, '0');
  return `${s.slice(0, -PRICE_PLACES)}.${s.slice(-PRICE_PLACES)}`;
};

/** A scaled executable price (PRICE_SCALE: lamports per raw token) in dollars per token, 4 significant digits; null without a SOL price. */
export const triggerPrice = (scaled: bigint, price: MicroUsd | null): string | null =>
  price === null ? null : `$${Number(priceText(scaled, PRICE_SCALE, price)).toLocaleString('en-US', { maximumSignificantDigits: 4, useGrouping: false })}`;

/** The app's longest text (its schema's `str`). */
const TEXT_MAX = 500;
const GATE_REASONS = 'gate_reasons ';

/**
 * One decision reason as served (review N2): a typed `gate_reasons` line keeps valid JSON, cut by entries (gate and
 * code only, the detail the app does not show is dropped) so it fits the app's text limit; any other line is cut at it.
 */
export const servedReason = (r: string): string => {
  if (r.startsWith(GATE_REASONS)) {
    let typed: unknown;
    try {
      typed = JSON.parse(r.slice(GATE_REASONS.length));
    } catch {
      typed = null;
    }
    if (Array.isArray(typed)) {
      const kept: { gate: unknown; code: unknown }[] = [];
      for (const x of typed) {
        const next = [...kept, { gate: (x as { gate?: unknown })?.gate ?? null, code: (x as { code?: unknown })?.code ?? null }];
        if (GATE_REASONS.length + JSON.stringify(next).length > TEXT_MAX) break;
        kept.push(next[next.length - 1]!);
      }
      return `${GATE_REASONS}${JSON.stringify(kept)}`;
    }
  }
  return r.length > TEXT_MAX ? `${r.slice(0, TEXT_MAX - 3)}...` : r;
};

/** An exit rule's trigger in a trader's words (APP-WORDS a): a dollar price, a hold time, an R multiple or a gain. */
const atOrBelow = (scaled: bigint | null | undefined, price: MicroUsd | null): string => {
  const usd = scaled == null ? null : triggerPrice(scaled, price);
  return usd === null ? 'Price unknown' : `Price at or below ${usd}`;
};

export const melbourneDate = (ms: number): string => {
  const d = melbourneDay(ms).date;
  return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
};

const iso = (ms: number): string => new Date(ms).toISOString();

/** The book's exit reasons in the app's terms. */
const EXIT_REASON: Readonly<Record<BookExitReason, string>> = {
  stop: 'price-stop', trailing_stop: 'trail', take_profit: 'take-profit', max_hold: 'time-stop', thesis_lost: 'thesis-stop', liquidity: 'liquidity-drop', emergency: 'blocked',
};

/** One logged candidate decision, kept for the decisions view and the funnel. */
export interface DecisionRow {
  readonly id: string;
  readonly atMs: number;
  readonly mint: string;
  readonly outcome: 'entered' | 'rejected' | 'no-trade';
  readonly check: string | null;
  readonly reasons: readonly string[];
  readonly tradeId: string | null;
}

/** Furthest funnel stage a candidate reached: 0 seen, 1 hard rejects passed, 2 costs and size passed, 3 risk passed, 4 entered. */
export interface FunnelState {
  readonly fromMs: number;
  readonly stage: ReadonlyMap<string, { readonly day: string; stage: number; check: string | null }>;
  readonly enteredByDay: ReadonlyMap<string, number>;
}

/**
 * FUNNEL-TRUTH: a reject reason's first failing check, named with the checks the installed app knows, and the funnel
 * stage the candidate truly passed before it (0 seen, 1 hard rejects passed, 2 cost gate passed), in the order
 * the strategy judges (strategy.ts #evaluate: regime, SOL price, pool data, sizing, hard rejects, account, stop, risk).
 * Missing or unusable inputs are H16 ("Stale or unknown data"). Every reason `#evaluate` can return is listed (the
 * test pins the list); a reason this list does not know gets no check and stays at "seen", never "Costs".
 */
export const classify = (reason: string): { readonly check: string | null; readonly stage: number } => {
  if (reason.startsWith('regime off')) return { check: 'regime', stage: 0 };
  // Refused before the pool is read or a hard reject runs (strategy.ts #evaluate, #market).
  if (reason === 'live SOL price unknown') return { check: 'H16', stage: 0 };
  if (/^(pool state (unknown|malformed|flagged)|fee context unknown)/.test(reason)) return { check: 'H16', stage: 0 };
  // The hard rejects: one that failed, or a pass that left a gate unevaluated (fail closed: its inputs were not known).
  const hard = /^hard reject (H(?:1[0-7]|[1-9]))(?=[:,\s]|$)/.exec(reason);
  // COMPLETION-READ: a step that failed for a missing or unusable input (its first reason an H16) is filed under H16,
  // not under the step it held up: "hard reject H7,H9,H10: H16 missing no curve …" is missing data, not a stuck curve.
  if (hard !== null && /^hard reject [^:]*: H16 /.test(reason)) return { check: 'H16', stage: 0 };
  if (hard !== null) return { check: hard[1]!, stage: 0 };
  if (reason === 'hard rejects incomplete') return { check: 'H16', stage: 0 };
  // After the hard rejects passed: the account, then the stop at the size.
  if (reason === 'account snapshot unknown') return { check: 'H16', stage: 1 };
  if (reason.startsWith('stop:') || reason.startsWith('no round trip:')) return { check: 'size', stage: 1 };
  // Risk approval proves the cost gate passed before a size mismatch. A refusal, fault or failed mark does not.
  if (reason.startsWith('risk sized ')) return { check: 'size', stage: 2 };
  if (reason.startsWith('risk ')) return { check: 'risk', stage: 1 };
  return { check: null, stage: 0 };
};
/** The first failing check of a reject reason (see `classify`); null when it names none the app knows. */
export const checkOf = (reason: string): string | null => classify(reason).check;

export interface ApiInputs {
  readonly nowMs: number;
  readonly policy: Policy;
  readonly policyVersion: string;
  readonly strategyVersion: string;
  readonly connected: boolean;
  readonly halted: readonly string[];
  readonly paused: boolean;
  /** /health's exit_capable: an exit could be sent now (paper: simulated). */
  readonly exitCapable: boolean;
  /** Providers whose request budget is spent (the scheduler refuses all but P0). */
  readonly budgetHalted: readonly string[];
  /** Critical engine alerts since boot. */
  readonly alerts: readonly { readonly code: string; readonly subject: string; readonly atMs: number }[];
  /** The latest regime evaluation; null before the first candidate. */
  readonly regime: { readonly atMs: number; readonly on: boolean; readonly reasons: readonly { readonly code: string; readonly input: string | null }[]; readonly waived: readonly string[] } | null;
  /**
   * How old a regime evaluation may be and still count as current: two of the strategy's candidate evaluation steps
   * (`evaluateEveryMs`, settings.ts: the policy's maxQuoteAgeMs). While any candidate is in its window the regime is
   * evaluated at least once per step; the second step allows for the gap to the next event.
   */
  readonly regimeMaxAgeMs: number;
  /** The account's entry stops (strategy RiskStopsView); null before the first event. */
  readonly stops: { readonly atMs: number; readonly codes: readonly string[] | null; readonly dayLoss: bigint | null } | null;
  readonly book: Book;
  readonly trades: readonly PaperTrade[];
  /** The account's costs that are no trade's (account.ts `costs`, the list risk reads): dated, micro-dollars. */
  readonly accountCosts: readonly { readonly atMs: number; readonly amount: bigint; readonly lamports: bigint; readonly kind: string }[];
  readonly attempts: ReadonlyMap<string, PaperAttempt>;
  /** What a trade settles from (PAPER-1): the attempts again, the network terms and which sells closed an account. */
  readonly legs: PaperLegs;
  readonly decisions: readonly DecisionRow[];
  /** Internal readiness only; never serialized as a new installed-app field. */
  readonly funnelAvailable?: boolean;
  readonly funnel: FunnelState;
  readonly solPrice: MicroUsd | null;
  /**
   * The network fee a close of this position would pay now (lamports): base + tip + the priority fee of the rung its next
   * exit attempt is sent at (the strategy's `closeRung`, core `attemptRung`; capped at the policy's per-attempt maximum),
   * as fills `attemptFee` charges a filled attempt. The open P&L counts it, so it is
   * never shown higher than a real close would give (APP-TRADE).
   */
  readonly exitFee: (p: PositionState) => bigint;
  readonly symbol: (mint: string) => string;
  /** Positions whose due exit waits for its first fresh quote, and since when (EXIT-1c). */
  readonly waitingExits: ReadonlyMap<string, number>;
  /**
   * The strategy's candidates, the tokens it is watching (APP-HOME): public market data and its own checks only. The
   * pool's quote reserve (lamports) is null until the pool is read; gates are the last evaluation's, null before one.
   */
  readonly discovered: readonly DiscoveredInput[];
  /** The open position's plan and our size's liquidation value now (lamports, null when it cannot be quoted). */
  readonly open: (p: PositionState) => { readonly stopPrice: bigint; readonly trail: bigint | null; readonly liquidation: bigint | null; readonly openedAtMs: number; readonly universe: string; readonly markedAtMs: number | null } | null;
}

export interface DiscoveredInput {
  readonly mint: string;
  /** The token's symbol once read, else null (never a made-up one). */
  readonly symbol: string | null;
  readonly migratedAtMs: number;
  readonly lastEvalMs: number | null;
  readonly gates: readonly { readonly gate: string; readonly code: string }[] | null;
  readonly quoteReserve: bigint | null;
}

/** At most this many discovered tokens are served, newest migration first. */
export const DISCOVERED_MAX = 200;

/**
 * The token checks of a candidate's last evaluation (APP-HOME): `failed` when a hard gate (H1–H15, H17) rejected it
 * or its create expired (an adverse market rule, judged before the hard gates),
 * `missing` before any evaluation or while evidence, the regime or the worker's own inputs stopped it before the hard
 * gates judged it (H16, regime, worker), `passed` otherwise (it cleared the hard gates; later stops are not checks).
 */
export const checksOf = (gates: DiscoveredInput['gates']): 'passed' | 'failed' | 'missing' => {
  if (gates === null) return 'missing';
  if (gates.some((g) => g.gate === 'worker' && g.code === 'create-expired')) return 'failed';
  if (gates.some((g) => /^H\d+$/.test(g.gate) && g.gate !== 'H16')) return 'failed';
  if (gates.some((g) => g.gate === 'H16' || g.gate === 'regime' || g.gate === 'worker')) return 'missing';
  return 'passed';
};

/**
 * The open position's P&L if closed now (APP-TRADE), in lamports, the one definition the P&L rows use: `gross` is what
 * selling the rest now returns (the liquidation quote, net of the pool's fees, less the close's own network fee
 * `exitFee`) plus what its exits already sold for, less what the entry paid; `fees` is every network fee paid so far
 * (entry and exits); `net` is gross less fees. With nothing left (and no close to pay for) it is the closed trade's net
 * (account.ts `filled`). A rest that cannot be quoted counts as worth nothing (the safe side); its close still costs.
 */
export const openPnl = (liquidation: bigint | null, fills: readonly PaperAttempt[], exitFee: bigint): { readonly gross: bigint; readonly fees: bigint; readonly net: bigint } => {
  const sum = (purpose: PaperAttempt['purpose'], f: (a: NonNullable<PaperAttempt['fill']>) => bigint) =>
    fills.filter((a) => a.purpose === purpose && a.fill !== null).reduce((s, a) => s + f(a.fill!), 0n);
  const gross = (liquidation ?? 0n) - exitFee + sum('exit', (f) => f.sol) - sum('entry', (f) => f.sol);
  const fees = sum('entry', (f) => f.fees) + sum('exit', (f) => f.fees);
  return { gross, fees, net: gross - fees };
};

/** Net lamports in micro-dollars as a closed trade's net is (account.ts): gains rounded down, losses rounded up. */
export const pnlMicroUsd = (l: bigint, price: MicroUsd): bigint =>
  l >= 0n ? lamportsToMicroUsd(l as Lamports, price, 'floor') : -lamportsToMicroUsd((-l) as Lamports, price, 'ceil');

/**
 * The open P&L's three rows in micro-dollars, one rounding for all (review N2): each on the safe side like a closed
 * trade's net (gains down, losses and costs up), and P&L their exact difference, so P&L = Unrealized − Costs so far.
 */
export const openUsd = (pnl: ReturnType<typeof openPnl>, price: MicroUsd): { readonly unrealized: bigint; readonly costs: bigint; readonly pnl: bigint } => {
  const unrealized = pnlMicroUsd(pnl.gross, price);
  const costs = -pnlMicroUsd(-pnl.fees, price);
  return { unrealized, costs, pnl: unrealized - costs };
};

/**
 * The network fee a close would pay at `rung` (APP-TRADE follow-up; the rung is the strategy's `closeRung`, the one the
 * next attempt is sent at): base + tip + that rung's priority fee, capped at the ladder's per-attempt maximum.
 */
export const closeFee = (ladder: Policy['exits']['ladder'], network: FillNetwork, rung: number): bigint => {
  const fee = ladder.steps[Math.min(rung, ladder.steps.length - 1)]!.priorityFeeLamports;
  return attemptFee(network, fee < ladder.maxFeePerAttempt ? fee : ladder.maxFeePerAttempt, 'filled');
};

const fillsOf = (i: ApiInputs, pid: string): PaperAttempt[] =>
  [...i.attempts.values()].filter((a) => a.trade === pid && a.outcome === 'filled' && a.fill !== null).sort((a, b) => (a.sentAtMs ?? 0) - (b.sentAtMs ?? 0));

/** The most critical alerts the app's status lists: a bounded memory, not a log (the engine log holds them all). */
export const MAX_ALERTS = 50;
export interface AlertSeen { readonly code: string; readonly subject: string; readonly atMs: number }

/** Adds a record's critical alerts to `alerts` (first sighting of each code and subject), keeping the newest MAX_ALERTS. */
export const collectAlerts = (alerts: AlertSeen[], r: LogRecord): void => {
  if (r.type !== 'decision' && r.type !== 'world') return;
  for (const { effect: e } of r.effects) {
    if (e.type !== 'alert' || e.level !== 'critical' || alerts.some((a) => a.code === e.code && a.subject === e.subject)) continue;
    alerts.push({ code: e.code, subject: e.subject, atMs: r.at.receivedAt });
  }
  if (alerts.length > MAX_ALERTS) alerts.splice(0, alerts.length - MAX_ALERTS);
};

/** A halt reason as the app names it, and the feed or provider it is about. Text this does not know is 'other'. */
export const haltOf = (reason: string): { readonly code: string; readonly source: string | null } => {
  const feed = /^feed (\S+) (stale|disconnected|dropped by drill)$/.exec(reason);
  if (feed !== null) return { code: feed[2] === 'stale' ? 'feed-stale' : feed[2] === 'disconnected' ? 'feed-disconnected' : 'feed-dropped', source: feed[1]! };
  if (reason === 'starting') return { code: 'starting', source: null };
  if (reason === 'owner pause (watchdog)') return { code: 'paused', source: null };
  if (reason === SEEDING) return { code: 'seeding', source: null };
  if (reason.startsWith('ledger and book diverged')) return { code: 'divergence', source: null };
  return { code: 'other', source: null };
};

/** Account stops older than this are unknown: they are read at least once per STOPS_EVERY_MS of event time. */
export const STOPS_MAX_AGE_MS = 5 * STOPS_EVERY_MS;
/** The core risk codes the app names one by one; any other tripped entry control is 'risk', with its code as source. */
const STOP_HALT: Readonly<Record<string, string>> = {
  daily_loss: 'daily-loss', weekly_loss: 'weekly-loss', weekly_review: 'weekly-review', kill_switch: 'kill-switch',
  wallet_below_kill_line: 'wallet-below-kill-line', loss_cooldown: 'loss-cooldown', loss_day_pause: 'loss-day-pause',
  loss_review: 'loss-review', session_not_running: 'session-ended', max_open_positions: 'max-open-positions',
};

/** The account stops as halts: each tripped control, or 'risk-unknown' when they are not known as of now. */
export const stopHalts = (stops: { readonly atMs: number; readonly codes: readonly string[] | null } | null, nowMs: number): { readonly code: string; readonly source: string | null }[] => {
  if (stops === null || stops.codes === null || nowMs - stops.atMs > STOPS_MAX_AGE_MS) return [{ code: 'risk-unknown', source: null }];
  return stops.codes.map((c) => (STOP_HALT[c] !== undefined ? { code: STOP_HALT[c], source: null } : { code: 'risk', source: c }));
};

/** A trade's partial sales (RISK-PARTIAL `partials`: each part's realised result at its own time). */
const partsOf = (t: PaperTrade): readonly { readonly atMs: number; readonly pnl: bigint; readonly lamports: bigint }[] => t.partials ?? [];

export type MoneyEvent =
  | { readonly kind: 'close'; readonly atMs: number; readonly net: bigint; readonly lamports: bigint | null; readonly trade: PaperTrade }
  | { readonly kind: 'partial'; readonly atMs: number; readonly net: bigint; readonly lamports: bigint | null; readonly trade: PaperTrade }
  | { readonly kind: 'cost'; readonly atMs: number; readonly net: bigint; readonly lamports: bigint | null; readonly costKind: string }
  | { readonly kind: 'late'; readonly atMs: number; readonly net: bigint; readonly lamports: bigint | null; readonly trade: PaperTrade };

/**
 * The account costs the app totals: all but `late_settlement`, which is risk's view of a trade's late entries (PAPER-2);
 * the app counts those as the trade's own `late` events instead, gains included, so nothing is counted twice.
 */
const appCosts = (i: ApiInputs) => i.accountCosts.filter((c) => c.kind !== 'late_settlement');

/**
 * Every realised money movement the app totals (APP-MONEY), oldest first, counted as core risk counts equity: each
 * partial sale's result at its own time (open trades' too), each closed trade's remainder (its net less its parts) at its
 * close, and each account cost (as a loss) when it was booked. So the app's totals agree with the wallet, with risk's day
 * split and with the backtest report (which counts its stray costs the same way).
 */
export const moneyEvents = (i: ApiInputs): MoneyEvent[] => {
  const out: MoneyEvent[] = [];
  for (const t of i.trades) {
    const parts = partsOf(t);
    for (const p of parts) out.push({ kind: 'partial', atMs: p.atMs, net: p.pnl, lamports: p.lamports, trade: t });
    if (t.closedAtMs !== null && t.netPnl !== null) out.push({ kind: 'close', atMs: t.closedAtMs, net: t.netPnl - parts.reduce((s, p) => s + p.pnl, 0n), lamports: t.netLamports === null ? null : t.netLamports - parts.reduce((s, p) => s + p.lamports, 0n), trade: t });
    // What landed after the close, on the day it was booked (PAPER-2), as risk counts a late loss.
    for (const x of t.late ?? []) if (x.usd !== null) out.push({ kind: 'late', atMs: x.atMs, net: x.usd, lamports: x.lamports, trade: t });
  }
  for (const c of appCosts(i)) out.push({ kind: 'cost', atMs: c.atMs, net: -c.amount, lamports: -c.lamports, costKind: c.kind });
  return out.sort((x, y) => x.atMs - y.atMs);
};

/** Dates with an unvalued movement absent from the existing dollar timeline: never report an incomplete SOL sum. */
const unvaluedDays = (i: ApiInputs): ReadonlySet<string> => new Set(i.trades.flatMap((t) => [
  ...(t.closedAtMs !== null && t.netPnl === null ? [melbourneDate(t.closedAtMs)] : []),
  ...(t.late ?? []).filter((x) => x.usd === null).map((x) => melbourneDate(x.atMs)),
]));

/**
 * Today's realised loss (Melbourne day), gains offsetting, from the money events; a late gain is left out, as risk
 * leaves it out (PAPER-2: a day's loss is never lowered after the fact), so the meter never reads below risk's view.
 */
export const realisedLossToday = (i: ApiInputs): bigint => {
  const start = melbourneDay(i.nowMs).start;
  const realised = -moneyEvents(i).filter((e) => e.atMs >= start && !(e.kind === 'late' && e.net > 0n)).reduce((s, e) => s + e.net, 0n);
  return realised > 0n ? realised : 0n;
};

/** An account cost under the app's cost kinds: the wallet's setup rent is rent kept; a failed entry's fees are network fees. */
const ACCOUNT_COST_KIND: Readonly<Record<string, string>> = { wallet_setup: 'rentKeptUsd', failed_entry: 'networkFeeUsd', late_settlement: 'networkFeeUsd' };

export const views = {
  status: (i: ApiInputs) => {
    const flags = new Set<string>();
    if (i.paused) flags.add('paused');
    if (i.halted.some((h) => h.startsWith('feed '))) flags.add('stale-data');
    const latest = i.decisions[i.decisions.length - 1];
    if (latest?.check === 'regime') flags.add('regime-off');
    if (latest?.check === 'H16') flags.add('waiting-for-evidence');
    for (const p of Object.values(i.book.positions)) {
      if (p.status === 'exit_pending' || p.status === 'exit_requested') flags.add('exit-pending');
      if (p.status === 'exit_blocked') flags.add('exit-blocked');
      // An exit waiting for a fresh quote is pending; once it has waited the blocked-retry time it is an alert.
      const since = p.status === 'closed' ? undefined : i.waitingExits.get(p.id);
      if (since !== undefined) {
        flags.add('exit-pending');
        if (i.nowMs - since >= i.policy.exits.blockedRetryMs) flags.add('exit-blocked');
      }
    }
    if (Object.values(i.book.intents).some((s) => s.status === 'unknown')) flags.add('unknown-tx-result');
    if (i.funnel.stage.size === 0) flags.add('no-eligible-candidate');
    const openLamports = Object.values(i.book.positions).filter((p) => p.status !== 'closed').reduce((s, p) => s + p.cost, 0n);
    const open = Object.values(i.book.positions).filter((p) => p.status !== 'closed').reduce((s, p) => s + lamportsUsd(p.cost, i.solPrice), 0n);
    const bankroll = i.policy.capital.bankroll as bigint;
    const dailyLimit = (bankroll * BigInt(i.policy.loss.dailyBps)) / 10_000n;
    const halts = [...i.halted.map(haltOf), ...i.budgetHalted.map((p) => ({ code: 'budget', source: p })), ...stopHalts(i.stops, i.nowMs)];
    // Today's loss is R7's own figure (the strategy's risk snapshot: trades, account costs and marked open losses), so
    // the meter and the daily-loss stop (in `halts`, from the same snapshot) agree. Between a fill and the snapshot's
    // next read, today's realised loss (trades and account costs, gains offsetting) counts too: it is never more than
    // R7's figure on the same data (marked losses only add), so it only closes that gap. Unknown: no meter, never 0.
    const realisedLoss = realisedLossToday(i);
    if (realisedLoss >= dailyLimit && !halts.some((h) => h.code === 'daily-loss')) halts.push({ code: 'daily-loss', source: null });
    const fresh = i.stops !== null && i.stops.codes !== null && i.nowMs - i.stops.atMs <= STOPS_MAX_AGE_MS;
    const r7 = fresh ? (i.stops!.dayLoss ?? null) : null;
    const dayLoss = r7 === null ? null : r7 > realisedLoss ? r7 : realisedLoss;
    return {
      mode: MODE, connected: i.connected, flags: [...flags], solPriceUsd: i.solPrice === null ? null : usdText(i.solPrice),
      haltReasons: halts.map((h) => ({ mode: MODE, ...h })),
      exitCapable: i.exitCapable,
      alerts: i.alerts.map((a) => ({ mode: MODE, code: a.code, subject: a.subject, at: iso(a.atMs) })),
      regime: i.regime === null ? null : { state: i.regime.on ? 'on' : 'off', at: iso(i.regime.atMs), current: i.nowMs - i.regime.atMs <= i.regimeMaxAgeMs, reasons: i.regime.reasons.map((r) => ({ mode: MODE, code: r.code, input: r.input })), waived: [...i.regime.waived] },
      risk: [
        { mode: MODE, kind: 'open-exposure', usedUsd: usdText(open), limitUsd: null, usedLamports: lamText(openLamports), limitLamports: null },
        ...(dayLoss === null ? [] : [{ mode: MODE, kind: 'daily-loss', usedUsd: usdText(dayLoss), limitUsd: usdText(dailyLimit), usedLamports: usdLamports(dayLoss, i.solPrice, 'ceil'), limitLamports: usdLamports(dailyLimit, i.solPrice, 'floor') }]),
      ],
      // The session this worker runs (APP-HOME): it starts its own paper session on the policy it loaded, so the app
      // never offers to start one (startable: false). Limits come from that policy; it has no session loss limit.
      session: {
        state: i.paused ? 'paused' : halts.some((h) => h.code === 'session-ended') ? 'ended' : 'running',
        bankrollUsd: usdText(bankroll), entryUsd: usdText(i.policy.capital.minNotional), maxEntryUsd: usdText(i.policy.capital.maxNotional),
        maxOpenPositions: i.policy.positions.maxOpen, dailyLossLimitUsd: usdText(dailyLimit),
        weeklyLossLimitUsd: usdText((bankroll * BigInt(i.policy.loss.weeklyBps)) / 10_000n), sessionLossLimitUsd: null, startable: false,
      },
    };
  },

  funnel: (i: ApiInputs) => {
    const counts = [0, 0, 0, 0, 0];
    const rejects = new Map<string, number>();
    const seenByDay = new Map<string, number>();
    for (const s of i.funnel.stage.values()) {
      for (let k = 0; k <= s.stage; k++) counts[k]!++;
      if (s.check !== null && s.stage < 3) rejects.set(s.check, (rejects.get(s.check) ?? 0) + 1);
      seenByDay.set(s.day, (seenByDay.get(s.day) ?? 0) + 1);
    }
    const days = [...new Set([...seenByDay.keys(), ...i.funnel.enteredByDay.keys()])].sort();
    return {
      mode: MODE, from: iso(i.funnel.fromMs), to: iso(i.nowMs),
      stages: (['seen', 'hard-rejects', 'costs', 'risk', 'entered'] as const).map((stage, k) => ({ mode: MODE, stage, count: counts[k]! })),
      rejects: [...rejects].sort(([a], [b]) => (a < b ? -1 : 1)).map(([check, count]) => ({ mode: MODE, check, count })),
      perDay: days.map((date) => ({ mode: MODE, date, seen: seenByDay.get(date) ?? 0, entered: i.funnel.enteredByDay.get(date) ?? 0 })),
    };
  },

  decisions: (i: ApiInputs) =>
    [...i.decisions].reverse().map((d) => ({
      mode: MODE, id: d.id, at: iso(d.atMs), mint: d.mint, symbol: i.symbol(d.mint), venue: 'pumpswap', outcome: d.outcome,
      checks: d.check === null ? [] : [{ mode: MODE, check: d.check, result: 'fail', value: null, limit: null }],
      ruleScore: null, reasons: d.reasons.slice(0, 40).map(servedReason), tradeId: d.tradeId,
    })),

  position: (i: ApiInputs) => {
    const p = Object.values(i.book.positions).find((x) => x.status !== 'closed' && x.status !== 'opening');
    if (p === undefined) return null;
    const o = i.open(p);
    const liq = o?.liquidation ?? null;
    const pnl = openPnl(liq, fillsOf(i, p.id), p.quantity > 0n ? i.exitFee(p) : 0n);
    const usd = i.solPrice === null ? { unrealized: 0n, costs: 0n } : openUsd(pnl, i.solPrice);
    // The mark: our rest's executable price now (the liquidation quote per token held), the price the stops judge.
    const mark = liq === null || p.quantity <= 0n || i.solPrice === null ? null : priceText(liq, p.quantity, i.solPrice);
    const exit = p.status === 'exit_blocked' ? 'blocked' : p.status === 'open' && !i.waitingExits.has(p.id) ? 'none' : 'pending';
    // The exits of the universe the position was entered under (CFG-2); unknown plan: the strategy's universe.
    const u = o?.universe ?? 'U2';
    // A universe the policy lacks is being flattened (no time stop or take-profit of its own).
    const ux = Object.hasOwn(i.policy.exits.universes, u) ? exitsFor(i.policy.exits, u) : { tMaxMs: 0, partialAtRBps: 0, partialAtGainBps: 0 };
    return {
      mode: MODE, id: p.id, mint: p.mint, symbol: i.symbol(p.mint), venue: 'pumpswap', openedAt: iso(o?.openedAtMs ?? i.nowMs),
      entryPriceUsd: priceText(p.cost, p.bought, i.solPrice), sizeUsd: usdText(lamportsUsd(p.cost, i.solPrice)),
      liquidationValueUsd: usdText(lamportsUsd(liq ?? 0n, i.solPrice)), unrealizedUsd: usdText(usd.unrealized),
      costsSoFarUsd: usdText(usd.costs), pnlUsd: i.solPrice === null ? null : usdText(usd.unrealized - usd.costs),
      sizeLamports: lamText(p.cost), liquidationValueLamports: lamText(liq ?? 0n), unrealizedLamports: lamText(pnl.gross), costsSoFarLamports: lamText(pnl.fees), pnlLamports: lamText(pnl.net),
      markPriceUsd: mark, markedAt: mark === null || o?.markedAtMs == null ? null : iso(o.markedAtMs),
      exitRules: [
        { mode: MODE, rule: 'price-stop', trigger: atOrBelow(o?.stopPrice, i.solPrice), state: p.exitOwner?.reasons.includes('stop') ? 'triggered' : 'armed' },
        { mode: MODE, rule: 'time-stop', trigger: `After ${Math.round(ux.tMaxMs / 60_000)} min`, state: p.exitOwner?.reasons.includes('max_hold') ? 'triggered' : 'armed' },
        { mode: MODE, rule: 'take-profit', trigger: `At +${ux.partialAtRBps / 10_000}R or +${ux.partialAtGainBps / 100}%`, state: p.exitOwner?.reasons.includes('take_profit') ? 'triggered' : 'armed' },
        ...(o?.trail == null ? [] : [{ mode: MODE, rule: 'trail', trigger: atOrBelow(o.trail, i.solPrice), state: p.exitOwner?.reasons.includes('trailing_stop') ? 'triggered' : 'armed' }]),
      ],
      exit, worker: p.status === 'open' ? 'watching' : p.status === 'exit_blocked' ? 'watching' : 'exiting',
    };
  },

  trades: (i: ApiInputs) => i.trades.filter((t) => t.closedAtMs !== null).map((t) => tradeRecord(i, t)).reverse(),

  calendar: (i: ApiInputs, month: string) => {
    const missing = [...unvaluedDays(i)].some((date) => date.startsWith(month));
    // A day's net is every realised movement that day (APP-MONEY): its trades and the account costs booked on it.
    const byDay = new Map<string, { net: bigint; lam: bigint | null; ids: string[] }>();
    for (const e of moneyEvents(i)) {
      const date = melbourneDate(e.atMs);
      if (!date.startsWith(month)) continue;
      const d = byDay.get(date) ?? { net: 0n, lam: 0n, ids: [] };
      d.net += e.net;
      d.lam = addLam(d.lam, e.lamports);
      if (e.kind === 'close') d.ids.push(e.trade.positionId);
      byDay.set(date, d);
    }
    return {
      mode: MODE, month, timeZone: 'Australia/Melbourne',
      days: [...byDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, d]) => ({ mode: MODE, date, netUsd: usdText(d.net), ...lamField('netLamports', missing ? null : d.lam), trades: d.ids.length, pauses: 0, tradeIds: d.ids })),
    };
  },

  charts: (i: ApiInputs) => {
    const missing = unvaluedDays(i);
    // Cumulative and daily net count the account costs with the trades (APP-MONEY), so the curve ends at the account's
    // realised result; the costs charts add them under their kind.
    type Pair = { usd: bigint; lam: bigint | null };
    const add = (m: Map<string, Pair>, k: string, usd: bigint, lam: bigint | null) => {
      const p = m.get(k) ?? { usd: 0n, lam: 0n };
      m.set(k, { usd: p.usd + usd, lam: addLam(p.lam, lam) });
    };
    let cum = 0n;
    let cumLam: bigint | null = 0n;
    const daily = new Map<string, Pair>();
    const costsDaily = new Map<string, Pair>();
    const kinds = new Map<string, Pair>();
    const cumulative = moneyEvents(i).map((e) => {
      cum += e.net;
      cumLam = addLam(cumLam, e.lamports);
      const date = melbourneDate(e.atMs);
      add(daily, date, e.net, e.lamports);
      const kind = e.kind === 'cost' ? ACCOUNT_COST_KIND[e.costKind] ?? 'networkFeeUsd' : null;
      const c = e.kind === 'cost' ? { total: -e.net, kinds: { [kind!]: -e.net }, totalLamports: e.lamports === null ? null : -e.lamports, lamports: { [kind!]: e.lamports === null ? null : -e.lamports } }
        : e.kind === 'close' ? costsOf(i, e.trade) : { total: 0n, kinds: {}, totalLamports: 0n, lamports: {} };
      add(costsDaily, date, c.total, c.totalLamports);
      for (const [k, v] of Object.entries(c.kinds)) add(kinds, k, v, (c.lamports as Record<string, bigint | null>)[k] ?? null);
      return { mode: MODE, at: iso(e.atMs), cumNetUsd: usdText(cum), ...lamField('cumNetLamports', missing.size > 0 ? null : cumLam) };
    });
    return {
      mode: MODE, cumulative,
      daily: [...daily].map(([date, v]) => ({ mode: MODE, date, netUsd: usdText(v.usd), ...lamField('netLamports', missing.size > 0 ? null : v.lam) })),
      rBuckets: [],
      costsDaily: [...costsDaily].map(([date, v]) => ({ mode: MODE, date, totalUsd: usdText(v.usd), ...lamField('totalLamports', v.lam) })),
      costsByKind: [...kinds].map(([kind, v]) => ({ mode: MODE, kind, amountUsd: usdText(v.usd), ...lamField('amountLamports', v.lam) })),
    };
  },

  discovered: (i: ApiInputs) => ({
    mode: MODE,
    tokens: [...i.discovered].sort((a, b) => b.migratedAtMs - a.migratedAtMs || (a.mint < b.mint ? -1 : 1)).slice(0, DISCOVERED_MAX).map((d) => ({
      mode: MODE, mint: d.mint, symbol: d.symbol, migratedAt: iso(d.migratedAtMs), venue: 'PumpSwap',
      // Pool liquidity as both sides at the pool's price: twice the quote reserve; unknown without a pool or SOL price.
      liquidityUsd: d.quoteReserve === null || i.solPrice === null ? null : usdText(lamportsUsd(2n * d.quoteReserve, i.solPrice)),
      checks: checksOf(d.gates), checkedAt: d.lastEvalMs === null ? null : iso(d.lastEvalMs),
    })),
  }),

  stats: (i: ApiInputs) => {
    // Net and drawdown are the account's (APP-MONEY): trades and account costs in time order. Win rate and mean net are
    // per trade, so they read the trades alone.
    const closed = i.trades.filter((t) => t.closedAtMs !== null && t.netPnl !== null).sort((a, b) => a.closedAtMs! - b.closedAtMs!);
    const nets = closed.map((t) => tradePnl(t)!);
    const events = moneyEvents(i);
    const net = events.reduce((s, e) => s + e.net, 0n);
    const tradeNet = nets.reduce((s, x) => s + x, 0n);
    let peak = 0n;
    let cum = 0n;
    let dd = 0n;
    for (const { net: x } of events) {
      cum += x;
      if (cum > peak) peak = cum;
      if (peak - cum > dd) dd = peak - cum;
    }
    const n = closed.length;
    // The account's SOL result, like its dollar net (APP-MONEY): the trades' and, as losses, the account costs' lamports.
    const netLam = unvaluedDays(i).size > 0 ? null : events.reduce<bigint | null>((s, e) => addLam(s, e.lamports), 0n);
    const tradeLam = closed.reduce<bigint | null>((s, t) => addLam(s, tradeSol(t)), 0n);
    let solPeak = 0n, solCum = 0n, solDd = 0n;
    for (const e of events) {
      solCum += e.lamports ?? 0n;
      if (solCum > solPeak) solPeak = solCum;
      if (solPeak - solCum > solDd) solDd = solPeak - solCum;
    }
    const solMove = closed.reduce((s, t) => {
      const v = settledUsd(i, t);
      return s + (v === null ? 0n : tradePnl(t)! - v.trading);
    }, 0n);
    return {
      mode: MODE, trades: n, requiredTrades: 30, netUsd: usdText(net), netSol: solText(closed.reduce((s, t) => s + (tradeSol(t) ?? 0n), 0n) - appCosts(i).reduce((s, c) => s + c.lamports, 0n)), ...lamField('netLamports', netLam), ...lamField('maxDrawdownLamports', netLam === null ? null : solDd), ...(tradeLam === null ? {} : { meanNetLamports: n === 0 ? null : lamText(tradeLam / BigInt(n)) }), solMoveUsd: usdText(solMove), maxDrawdownUsd: usdText(dd),
      winRate: n === 0 ? null : (nets.filter((x) => x > 0n).length / n).toFixed(4), meanNetUsd: n === 0 ? null : usdText(tradeNet / BigInt(n)),
      meanR: null, ci95: null,
    };
  },
};

/**
 * One closed trade settled as the backtest settles it (PAPER-1): core's `tradeUsd` on the trade's lamports, the entry
 * leg at the entry's SOL price and the exit leg at the close's. Null when either price was unknown (then the account
 * booked the notional as lost, and the dollar parts are not split).
 */
const settledUsd = (i: ApiInputs, t: PaperTrade): TradeUsd | null => {
  const l = paperTradeLamports(i.book, t.positionId, i.legs);
  const pxIn = t.openSolPrice ?? null;
  const pxOut = t.closeSolPrice ?? null;
  return l === null || pxIn === null || pxOut === null ? null : tradeUsd(l, pxIn, pxOut);
};

/** One closed trade's costs in micro-dollars, by the app's cost kinds; rent counts only what was not returned. */
const costsOf = (i: ApiInputs, t: PaperTrade) => {
  const v = settledUsd(i, t);
  const c = v?.costs;
  const kinds = {
    venueFeeUsd: c?.venue ?? 0n, creatorFeeUsd: c?.creator ?? 0n, priorityFeeUsd: c?.priority ?? 0n, tipUsd: c?.tip ?? 0n,
    networkFeeUsd: c?.network ?? 0n, slippageUsd: c?.slippage ?? 0n, rentKeptUsd: c === undefined ? 0n : c.rentPaid - c.rentReturned,
  };
  const l = paperTradeLamports(i.book, t.positionId, i.legs);
  const both = (key: keyof NonNullable<typeof l>['legs']['entry']) => l === null ? null : l.legs.entry[key] + l.legs.exit[key];
  const lamports = { venueFeeUsd: both('venueFee'), creatorFeeUsd: both('creatorFee'), priorityFeeUsd: both('priority'), tipUsd: both('tip'), networkFeeUsd: both('networkBase'), slippageUsd: both('slippage'), rentKeptUsd: l === null ? null : l.rentPaid - l.rentReturned };
  const totalLamports = Object.values(lamports).reduce<bigint | null>((s, x) => addLam(s, x), 0n);
  return { v, kinds, total: v?.total ?? 0n, lamports, totalLamports, rentPaid: l?.rentPaid ?? null, rentReturned: l?.rentReturned ?? null, entrySol: l?.entrySol ?? null };
};

/** Lamports as a SOL decimal string (9 places, exact). */
const solText = (lamports: bigint): string => {
  const neg = lamports < 0n;
  const a = neg ? -lamports : lamports;
  return `${neg ? '-' : ''}${a / LAMPORTS_PER_SOL}.${(a % LAMPORTS_PER_SOL).toString().padStart(9, '0')}`;
};

const tradeRecord = (i: ApiInputs, t: PaperTrade) => {
  const pxIn = t.openSolPrice ?? t.closeSolPrice ?? i.solPrice;
  const pxOut = t.closeSolPrice ?? pxIn;
  const fills = fillsOf(i, t.positionId);
  const buys = fills.filter((a) => a.purpose === 'entry');
  const sells = fills.filter((a) => a.purpose === 'exit');
  const sol = (xs: PaperAttempt[]) => xs.reduce((s, a) => s + (a.fill?.sol ?? 0n), 0n);
  const tok = (xs: PaperAttempt[]) => xs.reduce((s, a) => s + (a.fill?.tokens ?? 0n), 0n);
  const c = costsOf(i, t);
  // The trade's whole result: its close and what landed after it (PAPER-2).
  const net = tradePnl(t) ?? 0n;
  // The dollar result split in two: the SOL result at the close's price, and SOL's own move over the trade.
  const trading = c.v === null ? net : c.v.trading;
  const attemptsOf = (intent: string) => i.book.intents[intent]?.attempts.length ?? 1;
  const reason = (t.exitReasons ?? []).find((r): r is BookExitReason => r in EXIT_REASON);
  return {
    mode: MODE, id: t.positionId, mint: t.mint, symbol: i.symbol(t.mint), venue: 'pumpswap', universe: 'U2',
    strategyVersion: i.strategyVersion, policyVersion: i.policyVersion, openedAt: iso(t.openedAtMs), closedAt: iso(t.closedAtMs!),
    holdSeconds: Math.max(0, Math.round((t.closedAtMs! - t.openedAtMs) / 1000)),
    entryPriceUsd: priceText(sol(buys), tok(buys), pxIn), exitPriceUsd: priceText(sol(sells), tok(sells), pxOut),
    sizeUsd: usdText(t.notional), grossUsd: usdText(net + c.total),
    // In lamports, exact (APP-SOL): what the entry swapped in, the trade's net (account.ts), and gross as net plus its costs.
    ...lamField('sizeLamports', c.entrySol ?? (buys.length === 0 ? null : sol(buys))), ...lamField('netLamports', tradeSol(t)), ...lamField('grossLamports', addLam(tradeSol(t), c.totalLamports)),
    costs: {
      venueFeeUsd: usdText(c.kinds.venueFeeUsd), creatorFeeUsd: usdText(c.kinds.creatorFeeUsd), priorityFeeUsd: usdText(c.kinds.priorityFeeUsd),
      tipUsd: usdText(c.kinds.tipUsd), networkFeeUsd: usdText(c.kinds.networkFeeUsd), slippageUsd: usdText(c.kinds.slippageUsd),
      rentPaidUsd: usdText(c.v?.costs.rentPaid ?? 0n), rentReturnedUsd: usdText(c.v?.costs.rentReturned ?? 0n), totalUsd: usdText(c.total),
      ...lamField('venueFeeLamports', c.lamports.venueFeeUsd), ...lamField('creatorFeeLamports', c.lamports.creatorFeeUsd), ...lamField('priorityFeeLamports', c.lamports.priorityFeeUsd),
      ...lamField('tipLamports', c.lamports.tipUsd), ...lamField('networkFeeLamports', c.lamports.networkFeeUsd), ...lamField('slippageLamports', c.lamports.slippageUsd),
      ...lamField('rentPaidLamports', c.rentPaid), ...lamField('rentReturnedLamports', c.rentReturned), ...lamField('totalLamports', c.totalLamports),
    },
    netUsd: usdText(net), netSol: solText(tradeSol(t) ?? 0n), tradingUsd: usdText(trading), solMoveUsd: usdText(net - trading),
    plannedR: null, realizedR: null, mfeR: null, maeR: null,
    exitReason: reason === undefined ? 'blocked' : EXIT_REASON[reason], reasons: [...(t.exitReasons ?? [])], checks: [],
    fills: fills.map((a) => {
      const buy = a.purpose === 'entry';
      const f = a.fill!;
      const price = buy ? pxIn : pxOut;
      // Buys: what we paid against the spend we sent, and tokens against the quote; sells: lamports against the quote.
      const quoted = buy ? a.inAmount : a.quotedOut;
      const filled = f.sol;
      const shortBps = buy ? (a.quotedOut > 0n ? Number(((a.quotedOut - f.tokens) * 10_000n) / a.quotedOut) : 0) : (a.quotedOut > 0n ? Number(((a.quotedOut - f.sol) * 10_000n) / a.quotedOut) : 0);
      return {
        mode: MODE, side: buy ? 'buy' : 'sell', at: iso(a.sentAtMs ?? t.openedAtMs), slot: null, signature: null,
        priceUsd: priceText(f.sol, f.tokens, price), quotedUsd: usdText(lamportsUsd(quoted, price)), filledUsd: usdText(lamportsUsd(filled, price)),
        quotedLamports: lamText(quoted), filledLamports: lamText(filled),
        slippageBps: shortBps, attempts: attemptsOf(a.intentId),
      };
    }),
  };
};

/** The app's other modes: this worker runs paper only, so their paths answer "not running" (API-1). */
const OTHER_MODES = ['live', 'backtest'] as const;
export const NOT_RUNNING = 'this server runs paper only';

export type ApiEndpoint = 'status' | 'funnel' | 'decisions' | 'position' | 'trades' | 'charts' | 'stats' | 'discovered';
const ENDPOINTS: readonly ApiEndpoint[] = ['status', 'funnel', 'decisions', 'position', 'trades', 'charts', 'stats', 'discovered'];

/** V1's existing strict app contract, until a caller explicitly requests APP-SOL's extra fields. */
const withoutLamports = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(withoutLamports);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !key.endsWith('Lamports') && key !== 'solPriceUsd').map(([key, v]) => [key, withoutLamports(v)]));
  return value;
};

/** The envelope of one endpoint, or null for a path this worker does not serve. */
export const route = (path: string, inputs: () => ApiInputs): { readonly status: number; readonly body: unknown } => {
  const url = new URL(path, 'http://localhost');
  path = url.pathname;
  const present = (v: unknown) => url.searchParams.get('money') === 'lamports' ? v : withoutLamports(v);
  const asOf = (i: ApiInputs) => iso(i.nowMs);
  if (path === '/api/v1/backtest/report') {
    // The app loads backtest reports from the release; this worker holds none.
    return { status: 200, body: { mode: 'backtest', asOf: iso(Date.now()), data: null } };
  }
  const m = /^\/api\/v1\/([a-z]+)\/([a-z]+)(?:\/(\d{4}-(?:0[1-9]|1[0-2])))?$/.exec(path);
  if (m === null) return { status: 404, body: { error: 'not found' } };
  const [, mode, endpoint, month] = m;
  if (mode !== MODE) {
    // A mode this worker does not run (API-1): every app path of it answers, with no data and the reason, so the app
    // shows "Not running" for that mode instead of a server error. Unknown modes and paths stay 404.
    if (!OTHER_MODES.includes(mode as (typeof OTHER_MODES)[number])) return { status: 404, body: { error: 'not found' } };
    if (!(endpoint === 'calendar' ? month !== undefined : month === undefined && ENDPOINTS.includes(endpoint as ApiEndpoint))) return { status: 404, body: { error: 'not found' } };
    return { status: 200, body: { mode, asOf: iso(inputs().nowMs), data: null, notRunning: NOT_RUNNING } };
  }
  const i = inputs();
  if ((endpoint === 'funnel' || endpoint === 'decisions') && i.funnelAvailable === false) return { status: 503, body: { error: 'candidate view unavailable' } };
  if (endpoint === 'calendar' && month !== undefined) return { status: 200, body: { mode: MODE, asOf: asOf(i), data: present(views.calendar(i, month)) } };
  if (month !== undefined || !ENDPOINTS.includes(endpoint as ApiEndpoint)) return { status: 404, body: { error: 'not found' } };
  return { status: 200, body: { mode: MODE, asOf: asOf(i), data: present(views[endpoint as ApiEndpoint](i)) } };
};

/**
 * The commands the app may one day send, each with the auth level it needs (supervisor ruling: never "came from
 * loopback", since tailscale's proxied requests arrive on loopback). None is served: no level exists in this worker yet,
 * so every command is refused (403) and journaled with the level it lacked. Pause stays with the watchdog's signed
 * `/pause`; session control (paper to live) is the owner's alone and never an API call (AGENTS.md).
 */
export const COMMANDS = {
  pause: 'owner-signed request (the watchdog HMAC today, its /pause)',
  close: 'owner-signed request with a fresh nonce, per position',
  session: 'owner only, on the host; never over the API',
} as const;
export type Command = keyof typeof COMMANDS;

export const startApiServer = (host: string, port: number, inputs: () => ApiInputs, refused: (command: string, auth: string | null) => void = () => undefined): Promise<Server> => {
  const server = createServer((req, res) => {
    if (req.method !== 'GET') {
      const m = /^\/api\/v1\/commands\/([a-z]+)$/.exec((req.url ?? '').split('?')[0]!);
      if (req.method === 'POST' && m !== null) {
        const auth = Object.hasOwn(COMMANDS, m[1]!) ? COMMANDS[m[1] as Command] : null;
        refused(m[1]!, auth);
        req.resume();
        res.writeHead(auth === null ? 404 : 403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          .end(JSON.stringify({ error: auth === null ? 'no such command' : `refused: needs ${auth}` }));
        return;
      }
      res.writeHead(405, { allow: 'GET' }).end();
      return;
    }
    let r: { status: number; body: unknown };
    try {
      r = route(req.url ?? '', inputs);
    } catch (e) {
      r = { status: 500, body: { error: e instanceof Error ? e.name : 'error' } };
    }
    res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(r.body));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.off('error', reject);
      resolve(server);
    });
  });
};
