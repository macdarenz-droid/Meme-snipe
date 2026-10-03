import { addUsd, isDec, isUsd } from '../lib/money.ts';
import { MIN_TRADES, MODES, type Envelope, type Mode, type Moded, type StatsView } from './contract.ts';

export const MODE_LABEL: Record<Mode, string> = { backtest: 'Backtest', paper: 'Paper', live: 'Live' };

export class DataError extends Error {
  readonly kind: 'mixed-modes' | 'bad-money' | 'bad-shape';
  constructor(kind: DataError['kind'], message: string) {
    super(message);
    this.kind = kind;
  }
}

export const isMode = (m: unknown): m is Mode => typeof m === 'string' && (MODES as readonly string[]).includes(m);

/**
 * Checks a response before any screen sees it: the envelope and every nested
 * record must carry the requested mode, and every field ending in "Usd" must
 * be an exact decimal string (or null); prices may have any number of places. Throws DataError otherwise.
 */
export function checkEnvelope<T>(raw: unknown, mode: Mode): Envelope<T> {
  if (!raw || typeof raw !== 'object') throw new DataError('bad-shape', 'response is not an object');
  const env = raw as Partial<Envelope<T>>;
  if (!isMode(env.mode)) throw new DataError('bad-shape', 'response has no mode');
  if (typeof env.asOf !== 'string' || Number.isNaN(Date.parse(env.asOf))) throw new DataError('bad-shape', 'response has no time');
  if (!('data' in env)) throw new DataError('bad-shape', 'response has no data');
  walk(env, mode, '$');
  return env as Envelope<T>;
}

function walk(v: unknown, mode: Mode, path: string): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => walk(x, mode, `${path}[${i}]`));
    return;
  }
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    const p = `${path}.${k}`;
    if (k === 'mode' && x !== mode) throw new DataError('mixed-modes', `${p} is ${String(x)}, expected ${mode}`);
    // Prices ("...PriceUsd", "priceUsd") are exact decimals of any precision; every other "...Usd" is money.
    if (/Usd$/.test(k) && !/[pP]riceUsd$/.test(k) && x !== null && !isUsd(x)) throw new DataError('bad-money', `${p} is not an exact dollar amount`);
    if (/[pP]riceUsd$/.test(k) && x !== null && !isDec(x)) throw new DataError('bad-money', `${p} is not an exact price`);
    walk(x, mode, p);
  }
}

/** Throws unless every record is in `mode`. */
export function onlyMode<T extends Moded>(mode: Mode, records: readonly T[]): readonly T[] {
  for (const r of records) {
    if (r.mode !== mode) throw new DataError('mixed-modes', `a ${r.mode} record reached the ${mode} view`);
  }
  return records;
}

/** The one way screens add up money: exact, and refuses records from another mode. */
export function totalUsd<T extends Moded>(mode: Mode, records: readonly T[], pick: (r: T) => string): string {
  return addUsd('0', ...onlyMode(mode, records).map(pick));
}

/** Sums amounts inside one view (a response object), after checking the view is in `mode`. */
export function totalWithin(mode: Mode, view: Moded, amounts: readonly string[]): string {
  onlyMode(mode, [view]);
  return addUsd('0', ...amounts);
}

/** The sample a statistic needs: the worker's requirement, never below the floor for the mode. */
export function requiredTrades(stats: StatsView): number {
  return Math.max(MIN_TRADES[stats.mode], stats.requiredTrades ?? 0);
}

export const hasSample = (stats: StatsView): boolean => stats.trades >= requiredTrades(stats);
