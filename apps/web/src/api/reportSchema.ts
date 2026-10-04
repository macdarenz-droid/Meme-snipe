import type { BacktestReport } from './contract.ts';
import { arr, bool, day, dec, fail, int, iso, lamports, modeIs, nullable, obj, oneOf, re, str, usd, type Check } from './schema.ts';

/**
 * Strict check of a backtest report file (schema version 1, packages/core/src/report).
 * Every field must be present with the right type, and no other field may exist,
 * so a file with a holdout result or any unknown number is refused whole.
 * A rejected file never shows partial numbers.
 */

const mode = modeIs('backtest');

const GROUP = oneOf('U1', 'U2', 'U3', 'S0');
const EXIT = oneOf('price-stop', 'thesis-stop', 'time-stop', 'take-profit', 'trail', 'liquidity-drop', 'flow-stop', 'owner-close', 'blocked');

const costs = obj({
  venueFeeUsd: usd,
  creatorFeeUsd: usd,
  priorityFeeUsd: usd,
  tipUsd: usd,
  networkFeeUsd: usd,
  slippageUsd: usd,
  rentPaidUsd: usd,
  rentReturnedUsd: usd,
  totalUsd: usd,
});

const costsLamports = obj({
  venueFeeLamports: lamports,
  creatorFeeLamports: lamports,
  priorityFeeLamports: lamports,
  tipLamports: lamports,
  networkFeeLamports: lamports,
  slippageLamports: lamports,
  rentPaidLamports: lamports,
  rentReturnedLamports: lamports,
  totalLamports: lamports,
});

const report = obj({
  schemaVersion: oneOf(1),
  mode,
  part: oneOf('walk-forward', 'research'),
  generatedAt: iso,
  runId: str,
  codeCommit: re(/^[0-9a-f]{40}$/, 'a 40-character commit'),
  policyHash: re(/^sha256:[0-9a-f]{64}$/, 'sha256: and 64 hex characters'),
  dataset: obj({ id: str, from: iso, to: iso }),
  engine: obj({ replays: int, identicalReplays: bool, crashes: int, illegalStates: int, unreconciledIntents: int }),
  candidates: int,
  entries: int,
  gates: arr(
    obj({
      mode,
      gate: oneOf('G0', 'G1'),
      state: oneOf('pass', 'fail', 'not-run'),
      checks: arr(obj({ mode, label: str, value: str, limit: str, pass: bool }), 100),
    }),
    10,
  ),
  folds: arr(obj({ mode, id: str, from: iso, to: iso, trades: int, meanNetUsd: usd, lowUsd: usd }), 1000),
  results: arr(
    obj({
      mode,
      group: GROUP,
      trades: int,
      wins: int,
      netUsd: usd,
      maxDrawdownUsd: usd,
      meanNetUsd: nullable(usd),
      netLamports: lamports,
      maxDrawdownLamports: lamports,
      meanNetLamports: nullable(lamports),
      meanReturn: nullable(dec),
      ci95: nullable(obj({ lowUsd: usd, highUsd: usd })),
      equity: arr(obj({ mode, at: iso, cumNetUsd: usd, cumNetLamports: lamports })),
      days: arr(obj({ mode, date: day, netUsd: usd, netLamports: lamports, trades: int }), 5000),
    }),
    4,
  ),
  trades: arr(
    obj({
      mode,
      id: str,
      group: GROUP,
      mint: re(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, 'a base58 mint'),
      symbol: str,
      venue: oneOf('pump-curve', 'pumpswap'),
      openedAt: iso,
      closedAt: iso,
      holdSeconds: int,
      entryPriceUsd: dec,
      exitPriceUsd: dec,
      sizeUsd: usd,
      grossUsd: usd,
      costs,
      netUsd: usd,
      sizeLamports: lamports,
      grossLamports: lamports,
      costsLamports,
      netLamports: lamports,
      netReturn: dec,
      realizedR: nullable(dec),
      exitReason: EXIT,
    }),
  ),
});

/** Checks consistency the shape cannot: one result per group, wins within trades, trades of known groups. */
function consistent(r: BacktestReport): void {
  const groups = r.results.map((x) => x.group);
  if (new Set(groups).size !== groups.length) fail('$.results', 'a group appears twice');
  for (const [i, x] of r.results.entries()) {
    if (x.wins > x.trades) fail(`$.results[${i}].wins`, 'more wins than trades');
  }
  for (const [i, t] of r.trades.entries()) {
    if (!groups.includes(t.group)) fail(`$.trades[${i}].group`, 'no result for this group');
  }
}

/** Parses a report file or throws DataError. Accepts only schema version 1. */
export function parseReport(raw: unknown): BacktestReport {
  report(raw, '$');
  const r = raw as BacktestReport;
  consistent(r);
  return r;
}

/** The report endpoint's `data`: a valid report or null (no backtest yet). */
export const reportData: Check = nullable((v) => {
  parseReport(v);
});
