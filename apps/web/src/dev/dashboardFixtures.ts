/**
 * Made-up dashboard data served through the worker API contract, for the dev
 * and preview Samples screen and for tests. Every value here is invented.
 * Amounts are large on purpose: layouts must hold a scaled-up bankroll.
 */
import {
  TIME_ZONE,
  type BacktestReport,
  type ReportGroup,
  type ReportResult,
  type ReportTrade,
  type CalendarMonth,
  type ChartsView,
  type Check,
  type CheckResult,
  type DashboardApi,
  type DayRecord,
  type DecisionRecord,
  type DiscoveredView,
  type Envelope,
  type ExitReason,
  type FunnelView,
  type Mode,
  type PositionRecord,
  type StatsView,
  type TradeCosts,
  type TradeRecord,
  type WorkerStatus,
} from '../api/contract.ts';
import { addUsd, cmpUsd, fromMicro, subUsd, toMicro } from '../lib/money.ts';

const ENTRY = 500_000_000n; // $500 in micro-dollars
const MAX_ENTRY = 1_250_000_000n;
/** Fake but valid base58 (no 0, O, I or l): the API schemas check addresses strictly. */
const b58digits = (n: number, width: number) => String(n).padStart(width, '1').replace(/0/g, '9');
const FAKE_MINT = (n: number) => `FAKEmint${b58digits(n, 4)}${'x'.repeat(32)}`;
const FAKE_SIG = (n: number) => `FAKEsig${b58digits(n, 5)}${'x'.repeat(76)}`;

/** The book's exit code (core BookExitReason) behind each exit reason the app shows. */
const BOOK_EXIT: Partial<Record<ExitReason, string>> = {
  'price-stop': 'stop', trail: 'trailing_stop', 'take-profit': 'take_profit', 'time-stop': 'max_hold', 'thesis-stop': 'thesis_lost', 'liquidity-drop': 'liquidity',
};

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const melbourneDay = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
export const dayOf = (iso: string) => melbourneDay.format(new Date(iso));

/** Hundredths as a decimal string: 152n → "1.52". */
const hundredths = (v: bigint) => {
  const neg = v < 0n;
  const a = neg ? -v : v;
  return `${neg ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`;
};

const passChecks = (mode: Mode): CheckResult[] =>
  (
    [
      ['H8', '84.2 SOL', '≥ 5 SOL'],
      ['H12', '6.1%', '≤ 10%'],
      ['H13', '8.4%', '≤ 15%'],
      ['H15', '2.3% round trip', '≤ 4.0%'],
      ['cost', '3.1%', '≤ 5%'],
      ['size', '$500.00', '≥ $500.00'],
    ] as const
  ).map(([check, value, limit]) => ({ mode, check, result: 'pass', value, limit }));

const WIN_EXITS: ExitReason[] = ['take-profit', 'trail', 'time-stop'];
const LOSS_EXITS: ExitReason[] = ['price-stop', 'thesis-stop', 'liquidity-drop', 'time-stop'];

function makeTrades(mode: Mode, count: number, start: number, spanDays: number, seed: number): TradeRecord[] {
  const rand = rng(seed);
  return Array.from({ length: count }, (_, i) => {
    const opened = start + Math.floor((i / count) * spanDays * 86_400_000) + Math.floor(rand() * 3_600_000);
    const hold = 60 + Math.floor(rand() * 1700);
    const size = i % 6 === 0 ? MAX_ENTRY : ENTRY;
    const gross = (BigInt(Math.round((rand() - 0.43) * 1e6)) * size * 6n) / 10_000_000n;
    const pct = (bp: number) => (size * BigInt(bp)) / 10_000n;
    const c = {
      venueFeeUsd: pct(250),
      creatorFeeUsd: pct(60),
      priorityFeeUsd: 1_800_000n + BigInt(Math.floor(rand() * 900_000)),
      tipUsd: 950_000n,
      networkFeeUsd: 95_000n,
      slippageUsd: pct(Math.floor(rand() * 90)),
      rentPaidUsd: 380_000n,
      rentReturnedUsd: 380_000n,
    };
    const total = c.venueFeeUsd + c.creatorFeeUsd + c.priorityFeeUsd + c.tipUsd + c.networkFeeUsd + c.slippageUsd + c.rentPaidUsd - c.rentReturnedUsd;
    const net = gross - total;
    const oneR = (size * 15n) / 100n;
    const realized = (net * 100n) / oneR;
    const entry = 0.00002 + rand() * 0.00008;
    const exit = entry * (1 + Number(gross) / Number(size));
    const costs = Object.fromEntries(Object.entries(c).map(([k, v]) => [k, fromMicro(v)])) as unknown as TradeCosts;
    costs.totalUsd = fromMicro(total);
    const openedAt = new Date(opened).toISOString();
    const closedAt = new Date(opened + hold * 1000).toISOString();
    const slip = Math.floor(rand() * 80);
    return {
      mode,
      id: `${mode}-${i + 1}`,
      mint: FAKE_MINT(i),
      symbol: `TEST${i + 1}`,
      venue: i % 3 ? 'pumpswap' : 'pump-curve',
      universe: i % 4 ? 'U2' : 'U1',
      strategyVersion: 'u2-pullback-3',
      policyVersion: 'policy-7',
      openedAt,
      closedAt,
      holdSeconds: hold,
      entryPriceUsd: entry.toFixed(10),
      exitPriceUsd: exit.toFixed(10),
      sizeUsd: fromMicro(size),
      grossUsd: fromMicro(gross),
      costs,
      netUsd: fromMicro(net),
      plannedR: '1.50',
      realizedR: hundredths(realized),
      mfeR: hundredths(realized > 0n ? realized + 40n : 35n),
      maeR: hundredths(realized < 0n ? realized - 10n : -30n),
      exitReason: (net > 0n ? WIN_EXITS[i % 3] : LOSS_EXITS[i % 4]) ?? 'price-stop',
      // The worker serves the book's exit codes (APP-WORDS a); the app labels them.
      reasons: [BOOK_EXIT[(net > 0n ? WIN_EXITS[i % 3] : LOSS_EXITS[i % 4]) ?? 'price-stop'] ?? 'stop'],
      checks: passChecks(mode),
      fills: (['buy', 'sell'] as const).map((side, k) => {
        const quoted = side === 'buy' ? size : size + gross;
        return {
          mode,
          side,
          at: k ? closedAt : openedAt,
          slot: mode === 'backtest' ? 368_000_000 + i * 997 + k * 3_000 : mode === 'live' ? 368_500_000 + i : null,
          signature: mode === 'live' ? FAKE_SIG(i * 2 + k) : null,
          priceUsd: (k ? exit : entry).toFixed(10),
          quotedUsd: fromMicro(quoted),
          filledUsd: fromMicro(quoted - (quoted * BigInt(slip)) / 10_000n),
          slippageBps: slip,
          attempts: k && i % 7 === 0 ? 2 : 1,
        };
      }),
    };
  });
}

const PAPER_START = Date.UTC(2026, 8, 3, 1);
const BACKTEST_START = Date.UTC(2026, 6, 1, 1);

const TRADES: Record<Mode, TradeRecord[]> = {
  backtest: makeTrades('backtest', 420, BACKTEST_START, 61, 11),
  paper: makeTrades('paper', 12, PAPER_START, 26, 7),
  live: [],
};

const sumNet = (ts: TradeRecord[]) => addUsd('0', ...ts.map((t) => t.netUsd));

function daysOf(mode: Mode): DayRecord[] {
  const by = new Map<string, TradeRecord[]>();
  for (const t of TRADES[mode]) {
    const d = dayOf(t.closedAt);
    by.set(d, [...(by.get(d) ?? []), t]);
  }
  return [...by].map(([date, ts], i) => ({ mode, date, netUsd: sumNet(ts), trades: ts.length, pauses: i % 5 === 3 ? 1 : 0, tradeIds: ts.map((t) => t.id) }));
}

function charts(mode: Mode): ChartsView {
  const ts = [...TRADES[mode]].sort((a, b) => a.closedAt.localeCompare(b.closedAt));
  let cum = '0';
  const cumulative = ts.map((t) => ({ mode, at: t.closedAt, cumNetUsd: (cum = addUsd(cum, t.netUsd)) }));
  const days = daysOf(mode);
  const edges = [-2, -1.5, -1, -0.5, 0, 0.5, 1, 1.5, 2, 2.5, 3];
  const rBuckets = edges.slice(0, -1).map((from, i) => {
    const to = edges[i + 1] ?? from;
    const count = ts.filter((t) => {
      const r = Number(t.realizedR);
      return (i === 0 || r >= from) && (i === edges.length - 2 || r < to);
    }).length;
    return { mode, fromR: from.toFixed(1), toR: to.toFixed(1), count };
  });
  const costsDaily = days.map((d) => ({ mode, date: d.date, totalUsd: addUsd('0', ...ts.filter((t) => d.tradeIds.includes(t.id)).map((t) => t.costs.totalUsd)) }));
  const kinds = ['venueFeeUsd', 'creatorFeeUsd', 'priorityFeeUsd', 'tipUsd', 'networkFeeUsd', 'slippageUsd'] as const;
  return {
    mode,
    cumulative,
    daily: days.map((d) => ({ mode, date: d.date, netUsd: d.netUsd })),
    rBuckets: ts.length ? rBuckets : [],
    costsDaily,
    costsByKind: ts.length
      ? [
          ...kinds.map((kind) => ({ mode, kind, amountUsd: addUsd('0', ...ts.map((t) => t.costs[kind])) })),
          { mode, kind: 'rentKeptUsd' as const, amountUsd: addUsd('0', ...ts.map((t) => subUsd(t.costs.rentPaidUsd, t.costs.rentReturnedUsd))) },
        ]
      : [],
  };
}

function stats(mode: Mode): StatsView {
  const ts = TRADES[mode];
  const n = ts.length;
  const net = sumNet(ts);
  let peak = 0n;
  let cum = 0n;
  let dd = 0n;
  for (const t of ts) {
    cum += toMicro(t.netUsd);
    peak = cum > peak ? cum : peak;
    dd = cum - peak < dd ? cum - peak : dd;
  }
  const mean = n ? fromMicro(toMicro(net) / BigInt(n)) : null;
  return {
    mode,
    trades: n,
    requiredTrades: mode === 'backtest' ? 321 : 30,
    netUsd: net,
    maxDrawdownUsd: fromMicro(dd),
    winRate: n ? (ts.filter((t) => cmpUsd(t.netUsd, '0') > 0).length / n).toFixed(4) : null,
    meanNetUsd: mean,
    meanR: n ? (ts.reduce((s, t) => s + Number(t.realizedR), 0) / n).toFixed(2) : null,
    ci95: mean ? { lowUsd: subUsd(mean, '4.1'), highUsd: addUsd(mean, '4.1') } : null,
  };
}

const REJECTS: Record<Mode, { check: Check; count: number }[]> = {
  backtest: [
    { check: 'H9', count: 6210 },
    { check: 'H8', count: 2933 },
    { check: 'H10', count: 1904 },
    { check: 'H11', count: 1288 },
    { check: 'H12', count: 806 },
    { check: 'H13', count: 512 },
    { check: 'H14', count: 341 },
    { check: 'cost', count: 297 },
    { check: 'risk', count: 89 },
  ],
  paper: [
    { check: 'H9', count: 412 },
    { check: 'H8', count: 233 },
    { check: 'H10', count: 151 },
    { check: 'H16', count: 64 },
    { check: 'H12', count: 48 },
    { check: 'cost', count: 19 },
    { check: 'risk', count: 7 },
  ],
  live: [],
};

function funnel(mode: Mode): FunnelView {
  const rejects = REJECTS[mode];
  const entered = TRADES[mode].length;
  const hard = rejects.filter((r) => r.check.startsWith('H')).reduce((s, r) => s + r.count, 0);
  const cost = rejects.find((r) => r.check === 'cost')?.count ?? 0;
  const risk = rejects.find((r) => r.check === 'risk')?.count ?? 0;
  const seen = hard + cost + risk + entered;
  const days = daysOf(mode);
  return {
    mode,
    from: new Date(mode === 'backtest' ? BACKTEST_START : PAPER_START).toISOString(),
    to: new Date((mode === 'backtest' ? BACKTEST_START : PAPER_START) + 26 * 86_400_000).toISOString(),
    stages: [
      { mode, stage: 'seen', count: seen },
      { mode, stage: 'hard-rejects', count: seen - hard },
      { mode, stage: 'costs', count: seen - hard - cost },
      { mode, stage: 'risk', count: entered },
      { mode, stage: 'entered', count: entered },
    ],
    rejects: rejects.map((r) => ({ mode, ...r })),
    perDay: days.map((d, i) => ({ mode, date: d.date, seen: Math.round(seen / Math.max(days.length, 1)) + ((i * 37) % 23) - 11, entered: d.trades })),
  };
}

function decisions(mode: Mode): DecisionRecord[] {
  const rejected = (REJECTS[mode] ?? []).slice(0, 5);
  const fromTrades: DecisionRecord[] = TRADES[mode].slice(-6).map((t) => ({
    mode,
    id: `d-${t.id}`,
    at: t.openedAt,
    mint: t.mint,
    symbol: t.symbol,
    venue: t.venue,
    outcome: 'entered',
    checks: t.checks,
    ruleScore: '0.71',
    reasons: ['entry filled (paper)'],
    tradeId: t.id,
  }));
  const fromRejects: DecisionRecord[] = rejected.map((r, i) => ({
    mode,
    id: `d-${mode}-r${i}`,
    at: new Date((mode === 'backtest' ? BACKTEST_START : PAPER_START) + 25 * 86_400_000 + i * 913_000).toISOString(),
    mint: FAKE_MINT(500 + i),
    symbol: `SKIP${i + 1}`,
    venue: 'pumpswap',
    outcome: r.check === 'cost' || r.check === 'risk' ? 'no-trade' : 'rejected',
    checks: [{ mode, check: r.check, result: r.check === 'H16' ? 'unknown' : 'fail', value: VALUES[r.check] ?? null, limit: LIMITS[r.check] ?? null }, ...passChecks(mode).filter((c) => c.check !== r.check).slice(0, 2)],
    ruleScore: null,
    reasons: [],
    tradeId: null,
  }));
  return [...fromRejects, ...fromTrades].sort((a, b) => b.at.localeCompare(a.at));
}

const VALUES: Partial<Record<Check, string>> = { H9: '2m 41s', H8: '3.2 SOL', H10: '38 min', H16: 'quote 4.8 s old', H12: '14.6%', cost: '6.2%', risk: 'daily loss 7.1%' };
const LIMITS: Partial<Record<Check, string>> = { H9: '≥ 5 min', H8: '≥ 5 SOL', H10: '≥ 60 min', H16: '< 2 s', H12: '≤ 10%', cost: '≤ 5%', risk: '< 7.5%' };

const POSITION: PositionRecord = {
  mode: 'paper',
  id: 'paper-open-1',
  mint: FAKE_MINT(900),
  symbol: 'OPEN1',
  venue: 'pumpswap',
  openedAt: new Date(PAPER_START + 27 * 86_400_000).toISOString(),
  entryPriceUsd: '0.0000412300',
  sizeUsd: '500',
  liquidationValueUsd: '521.384217',
  unrealizedUsd: '6.218804',
  costsSoFarUsd: '15.165413',
  exitRules: [
    { mode: 'paper', rule: 'price-stop', trigger: 'Value ≤ $425.00', state: 'armed' },
    { mode: 'paper', rule: 'take-profit', trigger: 'Half at +1.5R', state: 'armed' },
    { mode: 'paper', rule: 'time-stop', trigger: 'Below +0.5R at 20 min', state: 'armed' },
    { mode: 'paper', rule: 'thesis-stop', trigger: 'Liquidity −30% or dev sells > 2%', state: 'armed' },
  ],
  exit: 'none',
  worker: 'watching',
};

/** One result block per group, from that group's trades in close order. */
function reportResult(group: ReportGroup, ts: { closedAt: string; netUsd: string }[]): ReportResult {
  const sorted = [...ts].sort((x, y) => x.closedAt.localeCompare(y.closedAt));
  let cum = 0n;
  let peak = 0n;
  let dd = 0n;
  const equity = sorted.map((t) => {
    cum += toMicro(t.netUsd);
    peak = cum > peak ? cum : peak;
    dd = cum - peak < dd ? cum - peak : dd;
    return { mode: 'backtest' as const, at: t.closedAt, cumNetUsd: fromMicro(cum) };
  });
  const by = new Map<string, { net: bigint; n: number }>();
  for (const t of sorted) {
    const d = by.get(dayOf(t.closedAt)) ?? { net: 0n, n: 0 };
    by.set(dayOf(t.closedAt), { net: d.net + toMicro(t.netUsd), n: d.n + 1 });
  }
  const n = sorted.length;
  const mean = n ? fromMicro(cum / BigInt(n)) : null;
  return {
    mode: 'backtest',
    group,
    trades: n,
    wins: sorted.filter((t) => cmpUsd(t.netUsd, '0') > 0).length,
    netUsd: fromMicro(cum),
    maxDrawdownUsd: fromMicro(dd),
    meanNetUsd: mean,
    ci95: mean ? { lowUsd: subUsd(mean, '4.1'), highUsd: addUsd(mean, '4.1') } : null,
    equity,
    days: [...by].map(([date, d]) => ({ mode: 'backtest' as const, date, netUsd: fromMicro(d.net), trades: d.n })),
  };
}

const S0_TRADES = makeTrades('backtest', 320, BACKTEST_START, 61, 23).map((t) => ({ ...t, id: `s0-${t.id}`, universe: 'U1' as const }));

const reportTrade = (t: TradeRecord, group: ReportGroup): ReportTrade => ({
  mode: 'backtest',
  id: t.id,
  group,
  mint: FAKE_MINT(Number(t.id.split('-').pop())),
  symbol: t.symbol,
  venue: t.venue,
  openedAt: t.openedAt,
  closedAt: t.closedAt,
  holdSeconds: t.holdSeconds,
  entryPriceUsd: t.entryPriceUsd,
  exitPriceUsd: t.exitPriceUsd,
  sizeUsd: t.sizeUsd,
  grossUsd: t.grossUsd,
  costs: t.costs,
  netUsd: t.netUsd,
  realizedR: t.realizedR,
  exitReason: t.exitReason,
});

const REPORT: BacktestReport = {
  schemaVersion: 1,
  mode: 'backtest',
  part: 'walk-forward',
  generatedAt: new Date(BACKTEST_START + 62 * 86_400_000).toISOString(),
  runId: 'bt-2026-10-02-a',
  codeCommit: '9f2c41d0b7e3a85c6e1f4d2a9b0c7e3f5a1d8c6b',
  policyHash: 'sha256:9f2c41d0b7e3a85c6e1f4d2a9b0c7e3f5a1d8c6b4e2f0a9d7c5b3e1f8a6d4c2b',
  dataset: { id: 'pump-migrations-2026-07', from: new Date(BACKTEST_START).toISOString(), to: new Date(BACKTEST_START + 61 * 86_400_000).toISOString() },
  engine: { replays: 10, identicalReplays: true, crashes: 0, illegalStates: 0, unreconciledIntents: 0 },
  candidates: 14_800,
  entries: 420,
  folds: [1, 2, 3, 4].map((k) => ({
    mode: 'backtest' as const,
    id: `F${k}`,
    from: new Date(BACKTEST_START + (k - 1) * 15 * 86_400_000).toISOString(),
    to: new Date(BACKTEST_START + k * 15 * 86_400_000).toISOString(),
    trades: [96, 112, 101, 111][k - 1] ?? 0,
    meanNetUsd: ['3.91', '-1.24', '5.07', '2.36'][k - 1] ?? '0',
    lowUsd: ['-2.15', '-7.88', '-0.94', '-3.61'][k - 1] ?? '0',
  })),
  gates: [
    {
      mode: 'backtest',
      gate: 'G0',
      state: 'pass',
      checks: [
        { mode: 'backtest', label: 'Second-source coverage', value: '97.1%', limit: '≥ 95%', pass: true },
        { mode: 'backtest', label: 'Identical replays', value: '10 of 10', limit: '10 of 10', pass: true },
        { mode: 'backtest', label: 'Leak and +1-slot tests', value: 'passed', limit: 'pass', pass: true },
      ],
    },
    {
      mode: 'backtest',
      gate: 'G1',
      state: 'fail',
      checks: [
        { mode: 'backtest', label: 'Walk-forward lower bound', value: '−$1.12', limit: '> $0', pass: false },
        { mode: 'backtest', label: 'DSR', value: '0.81', limit: '≥ 0.95', pass: false },
        { mode: 'backtest', label: 'PBO', value: '0.19', limit: '≤ 0.25', pass: true },
        { mode: 'backtest', label: 'Top 1% of trades', value: '38% of P&L', limit: '≤ 50%', pass: true },
        { mode: 'backtest', label: 'Largest day', value: '17% of P&L', limit: '≤ 25%', pass: true },
      ],
    },
  ],
  results: [
    reportResult('U1', TRADES.backtest.filter((t) => t.universe === 'U1')),
    reportResult('U2', TRADES.backtest.filter((t) => t.universe === 'U2')),
    reportResult('S0', S0_TRADES),
  ],
  trades: [
    ...TRADES.backtest.map((t) => reportTrade(t, t.universe)),
    ...S0_TRADES.map((t) => reportTrade(t, 'S0')),
  ],
};

const STATUS: Record<Mode, WorkerStatus> = {
  backtest: { mode: 'backtest', connected: true, flags: [], risk: [] },
  paper: {
    mode: 'paper',
    connected: true,
    flags: ['waiting-for-evidence'],
    risk: [
      { mode: 'paper', kind: 'open-exposure', usedUsd: '500', limitUsd: '1250' },
      { mode: 'paper', kind: 'daily-loss', usedUsd: '412.5', limitUsd: '500' },
      { mode: 'paper', kind: 'weekly-loss', usedUsd: '640', limitUsd: '2000' },
    ],
  },
  live: {
    mode: 'live',
    connected: true,
    flags: [],
    risk: [
      { mode: 'live', kind: 'open-exposure', usedUsd: '0', limitUsd: null },
      { mode: 'live', kind: 'daily-loss', usedUsd: '0', limitUsd: null },
    ],
  },
};

export const FIXTURE_MONTH: Record<Mode, string> = { backtest: '2026-08', paper: '2026-09', live: '2026-09' };

function calendar(mode: Mode, month: string): CalendarMonth {
  return { mode, month, timeZone: TIME_ZONE, days: daysOf(mode).filter((d) => d.date.startsWith(month)) };
}

export interface FixtureOptions {
  /** Seconds to age every response by, to show the stale state. */
  ageSeconds?: number;
  /** Puts one record of another mode into each paper response (tests only). */
  leakMode?: Mode;
}

/** The worker API served from the data above. Each call returns a fresh copy. */
/** Tokens the bot is watching, timed from `now` (made up; paper only, other modes watch nothing). */
export function fixtureDiscovered(mode: Mode, now = Date.now()): DiscoveredView {
  const checks = ['passed', 'failed', 'missing'] as const;
  const tokens = mode !== 'paper' ? [] : Array.from({ length: 6 }, (_, i) => ({
    mode, mint: FAKE_MINT(700 + i), symbol: i === 5 ? null : `FAKE${i + 1}`, migratedAt: new Date(now - (i + 1) * 7 * 60_000).toISOString(),
    venue: 'PumpSwap' as const, liquidityUsd: i === 4 ? null : fromMicro(BigInt(38_000 + i * 9_100) * 1_000_000n),
    checks: checks[i % 3]!, checkedAt: i === 5 ? null : new Date(now - (i + 2) * 1000).toISOString(),
  }));
  return { mode, tokens };
}

export function fixtureApi(opts: FixtureOptions = {}): DashboardApi {
  const wrap = <T>(mode: Mode, data: T): Promise<Envelope<T>> => {
    let copy = structuredClone(data) as T;
    if (opts.leakMode && mode === 'paper') copy = leak(copy, opts.leakMode);
    return Promise.resolve({ mode, asOf: new Date(Date.now() - (opts.ageSeconds ?? 0) * 1000).toISOString(), data: copy });
  };
  return {
    status: (m) => wrap(m, STATUS[m]),
    funnel: (m) => wrap(m, funnel(m)),
    decisions: (m) => wrap(m, decisions(m)),
    position: (m) => wrap(m, m === 'paper' ? POSITION : null),
    calendar: (m, month) => wrap(m, calendar(m, month)),
    trades: (m) => wrap(m, [...TRADES[m]].reverse()),
    charts: (m) => wrap(m, charts(m)),
    stats: (m) => wrap(m, stats(m)),
    discovered: (m) => wrap(m, fixtureDiscovered(m)),
    backtestReport: () => wrap('backtest', REPORT),
  };
}

/** Swaps the mode of the first nested record, as a broken worker might. */
function leak<T>(data: T, other: Mode): T {
  const visit = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(visit);
    if (!v || typeof v !== 'object') return false;
    const o = v as Record<string, unknown>;
    for (const x of Object.values(o)) if (visit(x)) return true;
    if ('mode' in o) {
      o['mode'] = other;
      return true;
    }
    return false;
  };
  visit(data);
  return data;
}

export const fixtureTrades = TRADES;
export const fixtureStats = stats;
export const fixtureCharts = charts;
export const fixtureDays = daysOf;
export const fixtureReport = REPORT;
export const fixtureFunnel = funnel;
export const fixtureDecisions = decisions;
export const fixturePosition = POSITION;
export const fixtureStatus = STATUS;
