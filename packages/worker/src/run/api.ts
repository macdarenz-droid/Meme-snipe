// The app's read API (UI-2 contract, apps/web/src/api/contract.ts): the paper worker's status, funnel, decisions, open
// position, calendar, trades, charts and statistics, every response and every record stamped `mode: "paper"`, money as
// decimal-string US dollars (micro-dollar exact). Loopback only (default 127.0.0.1:8788); on the host OPS publishes it
// to the owner's tailnet with `tailscale serve`, so the worker never binds anything else. Reads only: no command is
// served here (pause stays with the watchdog's /pause; commands need their own auth level, never "it came from
// loopback").
import { exitsFor } from '../../../core/src/config/index.ts';
import { createServer, type Server } from 'node:http';
import type { Policy } from '../../../core/src/config/index.ts';
import type { Book, ExitReason as BookExitReason, PositionState } from '../../../core/src/lifecycle/index.ts';
import { melbourneDay } from '../../../core/src/risk/index.ts';
import { type Lamports, type MicroUsd, lamportsToMicroUsd } from '../../../core/src/units/index.ts';
import type { PaperTrade } from './account.ts';
import type { PaperAttempt } from './paper-world.ts';
import { SEEDING } from '../engine/strategy.ts';
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

/** The first failing check of a reject reason, as the app names checks. */
export const checkOf = (reason: string): string => {
  if (reason.startsWith('regime off')) return 'regime';
  const hard = /^hard reject (H\d+)/.exec(reason);
  if (hard !== null) return hard[1]!;
  if (reason.startsWith('stop:')) return 'size';
  if (reason.startsWith('risk ') || reason.includes('SOL price') || reason.includes('account snapshot')) return 'risk';
  return 'cost';
};
export const stageOf = (check: string): number => (check === 'regime' || /^H\d+$/.test(check) ? 0 : check === 'cost' || check === 'size' ? 1 : 2);

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
  readonly regime: { readonly atMs: number; readonly on: boolean; readonly reasons: readonly { readonly code: string; readonly input: string | null }[] } | null;
  readonly book: Book;
  readonly trades: readonly PaperTrade[];
  readonly attempts: ReadonlyMap<string, PaperAttempt>;
  readonly decisions: readonly DecisionRow[];
  readonly funnel: FunnelState;
  readonly solPrice: MicroUsd | null;
  readonly symbol: (mint: string) => string;
  /** Positions whose due exit waits for its first fresh quote, and since when (EXIT-1c). */
  readonly waitingExits: ReadonlyMap<string, number>;
  /** The open position's plan and our size's liquidation value now (lamports, null when it cannot be quoted). */
  readonly open: (p: PositionState) => { readonly stopPrice: bigint; readonly trail: bigint | null; readonly liquidation: bigint | null; readonly openedAtMs: number; readonly universe: string } | null;
}

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
    const day = melbourneDay(i.nowMs);
    const lossToday = i.trades.filter((t) => t.closedAtMs !== null && t.closedAtMs >= day.start && (t.netPnl ?? 0n) < 0n).reduce((s, t) => s - (t.netPnl ?? 0n), 0n);
    const open = Object.values(i.book.positions).filter((p) => p.status !== 'closed').reduce((s, p) => s + lamportsUsd(p.cost, i.solPrice), 0n);
    const bankroll = i.policy.capital.bankroll as bigint;
    return {
      mode: MODE, connected: i.connected, flags: [...flags],
      haltReasons: [...i.halted.map(haltOf), ...i.budgetHalted.map((p) => ({ code: 'budget', source: p }))].map((h) => ({ mode: MODE, ...h })),
      exitCapable: i.exitCapable,
      alerts: i.alerts.map((a) => ({ mode: MODE, code: a.code, subject: a.subject, at: iso(a.atMs) })),
      regime: i.regime === null ? null : { state: i.regime.on ? 'on' : 'off', at: iso(i.regime.atMs), reasons: i.regime.reasons.map((r) => ({ mode: MODE, code: r.code, input: r.input })) },
      risk: [
        { mode: MODE, kind: 'open-exposure', usedUsd: usdText(open), limitUsd: null },
        { mode: MODE, kind: 'daily-loss', usedUsd: usdText(lossToday), limitUsd: usdText((bankroll * BigInt(i.policy.loss.dailyBps)) / 10_000n) },
      ],
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
      ruleScore: null, reasons: d.reasons.slice(0, 40).map((r) => (r.length > 500 ? `${r.slice(0, 497)}...` : r)), tradeId: d.tradeId,
    })),

  position: (i: ApiInputs) => {
    const p = Object.values(i.book.positions).find((x) => x.status !== 'closed' && x.status !== 'opening');
    if (p === undefined) return null;
    const o = i.open(p);
    const fees = fillsOf(i, p.id).reduce((s, a) => s + (a.fill?.fees ?? 0n), 0n);
    const liq = o?.liquidation ?? null;
    const exit = p.status === 'exit_blocked' ? 'blocked' : p.status === 'open' && !i.waitingExits.has(p.id) ? 'none' : 'pending';
    // The exits of the universe the position was entered under (CFG-2); unknown plan: the strategy's universe.
    const u = o?.universe ?? 'U2';
    // A universe the policy lacks is being flattened (no time stop or take-profit of its own).
    const ux = Object.hasOwn(i.policy.exits.universes, u) ? exitsFor(i.policy.exits, u) : { tMaxMs: 0, partialAtRBps: 0, partialAtGainBps: 0 };
    return {
      mode: MODE, id: p.id, mint: p.mint, symbol: i.symbol(p.mint), venue: 'pumpswap', openedAt: iso(o?.openedAtMs ?? i.nowMs),
      entryPriceUsd: priceText(p.cost, p.bought, i.solPrice), sizeUsd: usdText(lamportsUsd(p.cost, i.solPrice)),
      liquidationValueUsd: usdText(lamportsUsd(liq ?? 0n, i.solPrice)), unrealizedUsd: usdText(lamportsUsd((liq ?? 0n) - p.cost, i.solPrice)),
      costsSoFarUsd: usdText(lamportsUsd(fees, i.solPrice)),
      exitRules: [
        { mode: MODE, rule: 'price-stop', trigger: o === null ? 'unknown' : `executable price at or below ${o.stopPrice}`, state: p.exitOwner?.reasons.includes('stop') ? 'triggered' : 'armed' },
        { mode: MODE, rule: 'time-stop', trigger: `held ${Math.round(ux.tMaxMs / 60_000)} min`, state: p.exitOwner?.reasons.includes('max_hold') ? 'triggered' : 'armed' },
        { mode: MODE, rule: 'take-profit', trigger: `+${ux.partialAtRBps / 100}% of R or +${ux.partialAtGainBps / 100}%`, state: p.exitOwner?.reasons.includes('take_profit') ? 'triggered' : 'armed' },
        ...(o?.trail == null ? [] : [{ mode: MODE, rule: 'trail', trigger: `executable price at or below ${o.trail}`, state: p.exitOwner?.reasons.includes('trailing_stop') ? 'triggered' : 'armed' }]),
      ],
      exit, worker: p.status === 'open' ? 'watching' : p.status === 'exit_blocked' ? 'watching' : 'exiting',
    };
  },

  trades: (i: ApiInputs) => i.trades.filter((t) => t.closedAtMs !== null).map((t) => tradeRecord(i, t)).reverse(),

  calendar: (i: ApiInputs, month: string) => {
    const byDay = new Map<string, { net: bigint; ids: string[] }>();
    for (const t of i.trades) {
      if (t.closedAtMs === null) continue;
      const date = melbourneDate(t.closedAtMs);
      if (!date.startsWith(month)) continue;
      const d = byDay.get(date) ?? { net: 0n, ids: [] };
      d.net += t.netPnl ?? 0n;
      d.ids.push(t.positionId);
      byDay.set(date, d);
    }
    return {
      mode: MODE, month, timeZone: 'Australia/Melbourne',
      days: [...byDay].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, d]) => ({ mode: MODE, date, netUsd: usdText(d.net), trades: d.ids.length, pauses: 0, tradeIds: d.ids })),
    };
  },

  charts: (i: ApiInputs) => {
    const closed = i.trades.filter((t) => t.closedAtMs !== null).sort((a, b) => a.closedAtMs! - b.closedAtMs!);
    let cum = 0n;
    const daily = new Map<string, bigint>();
    const costsDaily = new Map<string, bigint>();
    const kinds = new Map<string, bigint>();
    const cumulative = closed.map((t) => {
      cum += t.netPnl ?? 0n;
      const date = melbourneDate(t.closedAtMs!);
      daily.set(date, (daily.get(date) ?? 0n) + (t.netPnl ?? 0n));
      const c = costsOf(i, t);
      costsDaily.set(date, (costsDaily.get(date) ?? 0n) + c.total);
      for (const [k, v] of Object.entries(c.kinds)) kinds.set(k, (kinds.get(k) ?? 0n) + v);
      return { mode: MODE, at: iso(t.closedAtMs!), cumNetUsd: usdText(cum) };
    });
    return {
      mode: MODE, cumulative,
      daily: [...daily].map(([date, v]) => ({ mode: MODE, date, netUsd: usdText(v) })),
      rBuckets: [],
      costsDaily: [...costsDaily].map(([date, v]) => ({ mode: MODE, date, totalUsd: usdText(v) })),
      costsByKind: [...kinds].map(([kind, v]) => ({ mode: MODE, kind, amountUsd: usdText(v) })),
    };
  },

  stats: (i: ApiInputs) => {
    const closed = i.trades.filter((t) => t.closedAtMs !== null && t.netPnl !== null).sort((a, b) => a.closedAtMs! - b.closedAtMs!);
    const nets = closed.map((t) => t.netPnl!);
    const net = nets.reduce((s, x) => s + x, 0n);
    let peak = 0n;
    let cum = 0n;
    let dd = 0n;
    for (const x of nets) {
      cum += x;
      if (cum > peak) peak = cum;
      if (peak - cum > dd) dd = peak - cum;
    }
    const n = closed.length;
    return {
      mode: MODE, trades: n, requiredTrades: 30, netUsd: usdText(net), maxDrawdownUsd: usdText(dd),
      winRate: n === 0 ? null : (nets.filter((x) => x > 0n).length / n).toFixed(4), meanNetUsd: n === 0 ? null : usdText(net / BigInt(n)),
      meanR: null, ci95: null,
    };
  },
};

/** One closed trade's costs in micro-dollars, by the app's cost kinds (rent is not modelled by the paper fill: 0). */
const costsOf = (i: ApiInputs, t: PaperTrade) => {
  const price = t.closeSolPrice ?? t.openSolPrice ?? i.solPrice;
  const sum = (f: (c: NonNullable<PaperAttempt['costs']>) => bigint) => fillsOf(i, t.positionId).reduce((s, a) => s + (a.costs === undefined ? 0n : f(a.costs)), 0n);
  const kinds = {
    venueFeeUsd: lamportsUsd(sum((c) => c.venueFee), price), creatorFeeUsd: lamportsUsd(sum((c) => c.creatorFee), price),
    priorityFeeUsd: lamportsUsd(sum((c) => c.priority), price), tipUsd: lamportsUsd(sum((c) => c.tip), price),
    networkFeeUsd: lamportsUsd(sum((c) => c.base), price), slippageUsd: lamportsUsd(sum((c) => c.slippage), price), rentKeptUsd: 0n,
  };
  return { kinds, total: Object.values(kinds).reduce((s, v) => s + v, 0n) };
};

const tradeRecord = (i: ApiInputs, t: PaperTrade) => {
  const price = t.closeSolPrice ?? t.openSolPrice ?? i.solPrice;
  const fills = fillsOf(i, t.positionId);
  const buys = fills.filter((a) => a.purpose === 'entry');
  const sells = fills.filter((a) => a.purpose === 'exit');
  const sol = (xs: PaperAttempt[]) => xs.reduce((s, a) => s + (a.fill?.sol ?? 0n), 0n);
  const tok = (xs: PaperAttempt[]) => xs.reduce((s, a) => s + (a.fill?.tokens ?? 0n), 0n);
  const c = costsOf(i, t);
  const net = t.netPnl ?? 0n;
  const attemptsOf = (intent: string) => i.book.intents[intent]?.attempts.length ?? 1;
  const reason = (t.exitReasons ?? []).find((r): r is BookExitReason => r in EXIT_REASON);
  return {
    mode: MODE, id: t.positionId, mint: t.mint, symbol: i.symbol(t.mint), venue: 'pumpswap', universe: 'U2',
    strategyVersion: i.strategyVersion, policyVersion: i.policyVersion, openedAt: iso(t.openedAtMs), closedAt: iso(t.closedAtMs!),
    holdSeconds: Math.max(0, Math.round((t.closedAtMs! - t.openedAtMs) / 1000)),
    entryPriceUsd: priceText(sol(buys), tok(buys), t.openSolPrice ?? price), exitPriceUsd: priceText(sol(sells), tok(sells), price),
    sizeUsd: usdText(t.notional), grossUsd: usdText(net + c.total),
    costs: {
      venueFeeUsd: usdText(c.kinds.venueFeeUsd), creatorFeeUsd: usdText(c.kinds.creatorFeeUsd), priorityFeeUsd: usdText(c.kinds.priorityFeeUsd),
      tipUsd: usdText(c.kinds.tipUsd), networkFeeUsd: usdText(c.kinds.networkFeeUsd), slippageUsd: usdText(c.kinds.slippageUsd),
      rentPaidUsd: '0', rentReturnedUsd: '0', totalUsd: usdText(c.total),
    },
    netUsd: usdText(net), plannedR: null, realizedR: null, mfeR: null, maeR: null,
    exitReason: reason === undefined ? 'blocked' : EXIT_REASON[reason], reasons: [...(t.exitReasons ?? [])], checks: [],
    fills: fills.map((a) => {
      const buy = a.purpose === 'entry';
      const f = a.fill!;
      // Buys: what we paid against the spend we sent, and tokens against the quote; sells: lamports against the quote.
      const quoted = buy ? a.inAmount : a.quotedOut;
      const filled = buy ? f.sol : f.sol;
      const shortBps = buy ? (a.quotedOut > 0n ? Number(((a.quotedOut - f.tokens) * 10_000n) / a.quotedOut) : 0) : (a.quotedOut > 0n ? Number(((a.quotedOut - f.sol) * 10_000n) / a.quotedOut) : 0);
      return {
        mode: MODE, side: buy ? 'buy' : 'sell', at: iso(a.sentAtMs ?? t.openedAtMs), slot: null, signature: null,
        priceUsd: priceText(f.sol, f.tokens, price), quotedUsd: usdText(lamportsUsd(quoted, price)), filledUsd: usdText(lamportsUsd(filled, price)),
        slippageBps: shortBps, attempts: attemptsOf(a.intentId),
      };
    }),
  };
};

export type ApiEndpoint = 'status' | 'funnel' | 'decisions' | 'position' | 'trades' | 'charts' | 'stats';
const ENDPOINTS: readonly ApiEndpoint[] = ['status', 'funnel', 'decisions', 'position', 'trades', 'charts', 'stats'];

/** The envelope of one endpoint, or null for a path this worker does not serve. */
export const route = (path: string, inputs: () => ApiInputs): { readonly status: number; readonly body: unknown } => {
  const asOf = (i: ApiInputs) => iso(i.nowMs);
  if (path === '/api/v1/backtest/report') {
    // The app loads backtest reports from the release; this worker holds none.
    return { status: 200, body: { mode: 'backtest', asOf: iso(Date.now()), data: null } };
  }
  const m = /^\/api\/v1\/([a-z]+)\/([a-z]+)(?:\/(\d{4}-(?:0[1-9]|1[0-2])))?$/.exec(path);
  if (m === null) return { status: 404, body: { error: 'not found' } };
  const [, mode, endpoint, month] = m;
  if (mode !== MODE) return { status: 404, body: { error: `this worker serves paper data only, not ${mode}` } };
  const i = inputs();
  if (endpoint === 'calendar' && month !== undefined) return { status: 200, body: { mode: MODE, asOf: asOf(i), data: views.calendar(i, month) } };
  if (month !== undefined || !ENDPOINTS.includes(endpoint as ApiEndpoint)) return { status: 404, body: { error: 'not found' } };
  return { status: 200, body: { mode: MODE, asOf: asOf(i), data: views[endpoint as ApiEndpoint](i) } };
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
      r = route((req.url ?? '').split('?')[0]!, inputs);
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
