import { addUsd } from '../lib/money.ts';
import { MIN_TRADES, MODES, type Envelope, type Mode, type Moded, type StatsView } from './contract.ts';
import { DataError, fail, iso, obj, onlyUnknownFields, oneOf, str, type Check } from './schema.ts';

export { DataError };

export const MODE_LABEL: Record<Mode, string> = { backtest: 'Backtest', paper: 'Paper', live: 'Live' };

export const isMode = (m: unknown): m is Mode => typeof m === 'string' && (MODES as readonly string[]).includes(m);

/**
 * Checks a response before any screen sees it. The envelope must be exactly
 * { mode, asOf, data } in the requested mode, `data` must pass the endpoint's
 * strict schema (src/api/schemas.ts), and every object inside a list must carry
 * the requested mode. Throws DataError otherwise; nothing partial is used.
 */
export function checkEnvelope<T>(raw: unknown, mode: Mode, data: Check): Envelope<T> {
  if (raw && typeof raw === 'object' && 'mode' in raw && isMode(raw.mode) && raw.mode !== mode) {
    throw new DataError('mixed-modes', `response is ${raw.mode}, expected ${mode}`);
  }
  // A server that does not run this mode answers its paths with no data and the reason (API-1): exactly that shape.
  // Paper is the mode every server runs: a paper answer that says otherwise is bad data, never "Not running".
  if (raw && typeof raw === 'object' && Object.hasOwn(raw, 'notRunning')) {
    if (mode === 'paper') fail('$.notRunning', 'paper always runs');
    obj({ mode: oneOf(mode), asOf: iso, data: oneOf(null), notRunning: str })(raw, '$');
    return raw as Envelope<T>;
  }
  obj({ mode: oneOf(mode), asOf: iso, data })(raw, '$');
  walk(raw, mode, '$', false);
  return raw as Envelope<T>;
}

/**
 * checkEnvelope, with the cause of a refusal told apart (APP-COMPAT): when the only problem is fields this app does not
 * know (the worker is newer), it throws DataError('app-outdated'); any other refusal is thrown as it is.
 */
export function checkAnswer<T>(raw: unknown, mode: Mode, data: Check): Envelope<T> {
  try {
    return checkEnvelope<T>(raw, mode, data);
  } catch (e) {
    if (e instanceof DataError && e.kind === 'unknown-field' && onlyUnknownFields(() => checkEnvelope(raw, mode, data))) {
      throw new DataError('app-outdated', `${e.message} (the worker is newer than this app)`);
    }
    throw e;
  }
}

/** Second line of defence, independent of the schemas: no record of another mode, and none without a mode, inside any list. */
function walk(v: unknown, mode: Mode, path: string, inList: boolean): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => walk(x, mode, `${path}[${i}]`, true));
    return;
  }
  if (!v || typeof v !== 'object') return;
  const o = v as Record<string, unknown>;
  if ('mode' in o ? o['mode'] !== mode : inList) throw new DataError('mixed-modes', `${path}.mode is ${String(o['mode'])}, expected ${mode}`);
  for (const [k, x] of Object.entries(o)) walk(x, mode, `${path}.${k}`, false);
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
