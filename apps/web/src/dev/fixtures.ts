import type { ResultsView, TradeView } from '../performance/types.ts';
import type { SessionView, TokenRowView, WalletView } from '../screens/types.ts';

/** Build check marker: scripts/check-build.mjs fails if this string reaches dist/. */
export const FIXTURE_MARKER = 'ZEROED_FIXTURES_DEV_ONLY';

const MONTH = '2026-09';
// Large on purpose: layouts must hold a scaled-up bankroll and trade size.
const BANKROLL = 25000;
const ENTRY = 500;
const MAX_ENTRY = 1250;
const FAKE_MINT = (n: number) => `FAKEmint${String(n).padStart(4, '0')}xxxxxxxxxxxxxxxxxxxxxxxxxxxx`;

// Deterministic pseudo-random numbers so screenshots are stable.
let seed = 7;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const WIN_EXITS = ['Target hit', 'Time limit'];
const LOSS_EXITS = ['Stop hit', 'Liquidity dropped', 'Time limit'];

const trades: TradeView[] = Array.from({ length: 34 }, (_, i) => {
  const day = 1 + Math.floor(i * 0.85);
  const opened = new Date(Date.UTC(2026, 8, day, 1 + (i % 9), (i * 7) % 60));
  const hold = 40 + Math.floor(rand() * 1500);
  const size = i % 5 === 0 ? MAX_ENTRY : ENTRY;
  const fees = Number(((0.04 + rand() * 0.08) * (ENTRY / 2)).toFixed(2));
  const gross = Number(((rand() - 0.47) * size * 0.5).toFixed(2));
  const entry = 0.00001 + rand() * 0.0001;
  return {
    id: `fx-${i}`,
    symbol: `TEST${i + 1}`,
    mint: FAKE_MINT(i),
    venue: i % 3 ? 'PumpSwap' : 'Pump curve',
    openedAt: opened.toISOString(),
    closedAt: new Date(opened.getTime() + hold * 1000).toISOString(),
    entryPriceUsd: entry,
    exitPriceUsd: entry * (1 + gross / size),
    sizeUsd: size,
    feesUsd: fees,
    netUsd: Number((gross - fees).toFixed(2)),
    reasonIn: 'Fixture: liquidity, holder spread and costs inside limits.',
    reasonOut: (gross - fees > 0 ? WIN_EXITS[i % 2] : LOSS_EXITS[i % 3]) ?? 'Stop hit',
    holdSeconds: hold,
    entryTx: null,
    exitTx: null,
  };
});

const days = new Map<string, { netUsd: number; tradeIds: string[] }>();
for (const t of trades) {
  const date = t.closedAt.slice(0, 10);
  if (!date.startsWith(MONTH)) continue;
  const d = days.get(date) ?? { netUsd: 0, tradeIds: [] };
  d.netUsd = Number((d.netUsd + t.netUsd).toFixed(2));
  d.tradeIds.push(t.id);
  days.set(date, d);
}

let equity = BANKROLL;
const equityPoints = [{ at: '2026-09-01T00:00:00.000Z', equityUsd: BANKROLL }].concat(
  trades.map((t) => {
    equity = Number((equity + t.netUsd).toFixed(2));
    return { at: t.closedAt, equityUsd: equity };
  }),
);

let peak = BANKROLL;
let maxDd = 0;
for (const p of equityPoints) {
  peak = Math.max(peak, p.equityUsd);
  maxDd = Math.min(maxDd, p.equityUsd - peak);
}
const wins = trades.filter((t) => t.netUsd > 0).length;
const net = Number(trades.reduce((s, t) => s + t.netUsd, 0).toFixed(2));
const fees = trades.reduce((s, t) => s + t.feesUsd, 0);

export const fixtureResults: ResultsView = {
  month: MONTH,
  days: [...days].map(([date, d]) => ({ date, ...d })),
  trades: [...trades].reverse(),
  equity: equityPoints,
  costs: [
    { label: 'Venue fees', usd: Number((fees * 0.45).toFixed(2)) },
    { label: 'Slippage', usd: Number((fees * 0.3).toFixed(2)) },
    { label: 'Priority fees', usd: Number((fees * 0.15).toFixed(2)) },
    { label: 'Network fees', usd: Number((fees * 0.04).toFixed(2)) },
    { label: 'Account rent', usd: Number((fees * 0.06).toFixed(2)) },
  ],
  risk: [
    { label: 'Open exposure', usedUsd: ENTRY, limitUsd: MAX_ENTRY },
    { label: 'Daily loss', usedUsd: 425, limitUsd: 500 },
    { label: 'Session loss', usedUsd: 150, limitUsd: 1000 },
  ],
  stats: { sample: trades.length, minSample: 30, netUsd: net, winRate: wins / trades.length, expectancyUsd: net / trades.length, maxDrawdownUsd: maxDd },
};

export const fixtureResultsSmall: ResultsView = {
  ...fixtureResults,
  stats: { ...fixtureResults.stats, sample: 12 },
};

export const fixtureTokens: TokenRowView[] = Array.from({ length: 8 }, (_, i) => ({
  mint: FAKE_MINT(100 + i),
  symbol: `FAKE${i + 1}`,
  ageSeconds: 90 + i * 410,
  venue: i % 2 ? 'PumpSwap' : 'Pump curve',
  liquidityUsd: 4000 + i * 2300,
  volume24hUsd: 12000 + i * 5100,
  holders: 120 + i * 37,
  topHolderShare: 0.08 + i * 0.02,
  security: i === 3 ? 'failed' : i === 5 ? 'missing' : 'passed',
  promoted: i === 2,
  dataAgeSeconds: 2 + i * 3,
}));

export const fixtureSession: SessionView = {
  mode: 'paper',
  state: 'running',
  bankrollUsd: BANKROLL,
  entryUsd: ENTRY,
  maxEntryUsd: MAX_ENTRY,
  maxOpenPositions: 3,
  dailyLossLimitUsd: 500,
  sessionLossLimitUsd: 1000,
  workerConnected: true,
};

/** Addresses are 44 characters, the longest a Solana address can be. */
export const fixtureWallet: WalletView = {
  botAddress: 'FAKEbotWa11et9kQmZr7Hc2VnX4pLdT8sYwB3uJeGfNq',
  savedWallet: 'FAKEsavedWa11etR5mKz2Qh8VcN6pXdL3sTwY9uBjEW',
  availableUsd: 23812.4,
  reserveSol: 0.75,
  lockedSol: 0.0123,
  openExposureUsd: ENTRY,
  feesPaidUsd: 612.37,
};
