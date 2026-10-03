import type { BacktestReport } from './contract.ts';
import { DataError } from './modes.ts';
import { isDec, isUsd } from '../lib/money.ts';

/**
 * Strict check of a backtest report file (schema version 1, packages/core/src/report).
 * Every field must be present with the right type, and no other field may exist,
 * so a file with a holdout result or any unknown number is refused whole.
 * A rejected file never shows partial numbers.
 */

type Check = (v: unknown, path: string) => void;

const fail = (path: string, why: string, kind: DataError['kind'] = 'bad-shape'): never => {
  throw new DataError(kind, `${path}: ${why}`);
};

const str: Check = (v, p) => {
  if (typeof v !== 'string' || v.length === 0 || v.length > 500) fail(p, 'expected text');
};
const int: Check = (v, p) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) fail(p, 'expected a whole number ≥ 0');
};
const bool: Check = (v, p) => {
  if (typeof v !== 'boolean') fail(p, 'expected true or false');
};
const usd: Check = (v, p) => {
  if (!isUsd(v)) fail(p, 'expected an exact dollar amount as text', 'bad-money');
};
const dec: Check = (v, p) => {
  if (!isDec(v)) fail(p, 'expected an exact decimal as text', 'bad-money');
};
const iso: Check = (v, p) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/.test(v) || Number.isNaN(Date.parse(v))) fail(p, 'expected a UTC time');
};
const day: Check = (v, p) => {
  if (typeof v !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v)) fail(p, 'expected a YYYY-MM-DD day');
};
const re =
  (pattern: RegExp, what: string): Check =>
  (v, p) => {
    if (typeof v !== 'string' || !pattern.test(v)) fail(p, `expected ${what}`);
  };
const oneOf =
  (...values: readonly unknown[]): Check =>
  (v, p) => {
    if (!values.includes(v)) fail(p, `expected one of ${values.join(', ')}`);
  };
const nullable =
  (c: Check): Check =>
  (v, p) => {
    if (v !== null) c(v, p);
  };
const arr =
  (c: Check, max = 200_000): Check =>
  (v, p) => {
    if (!Array.isArray(v)) return fail(p, 'expected a list');
    if (v.length > max) fail(p, `more than ${max} items`);
    v.forEach((x, i) => c(x, `${p}[${i}]`));
  };
const obj =
  (shape: Record<string, Check>): Check =>
  (v, p) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(p, 'expected an object');
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) if (!(k in shape)) fail(`${p}.${k}`, 'unknown field');
    for (const [k, c] of Object.entries(shape)) {
      if (!(k in o)) fail(`${p}.${k}`, 'missing');
      c(o[k], `${p}.${k}`);
    }
  };

/** Every record inside the file: a wrong mode is a mixed-mode error, not a shape error. */
const mode: Check = (v, p) => {
  if (v !== 'backtest') fail(p, `mode is ${String(v)}, expected backtest`, 'mixed-modes');
};

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
      ci95: nullable(obj({ lowUsd: usd, highUsd: usd })),
      equity: arr(obj({ mode, at: iso, cumNetUsd: usd })),
      days: arr(obj({ mode, date: day, netUsd: usd, trades: int }), 5000),
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
