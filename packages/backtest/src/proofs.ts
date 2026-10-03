// The blind-backtest proofs on dataset runs (owner rule; docs/ARCHITECTURE.md §16.1): deterministic replay, the leak
// test with a planted future-only marker, and the +1-slot shift test. Same checks as ENG-1's proofs, driven through
// the backtest's streaming replay, fill model and S0 instead of a stub.
import { canonical, compareMoments, type FeedEvent, type LogRecord, type Moment, reaches, type Strategy, type StrategyContext } from '../../core/src/engine/index.ts';
import type { DatasetRow } from './dataset/rows.ts';
import { type RunOptions, runBacktest } from './run.ts';
import { S0 } from './strategy/s0.ts';

export interface ProofReport {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

/** Log hashes of `times` independent runs. Deterministic replay: all equal. */
export const replayHashes = (o: RunOptions, times: number): string[] => Array.from({ length: times }, () => runBacktest(o).logHash);

const describe = (m: Moment): string => `slot ${m.slot} tx ${m.txIndex} ix ${m.ixIndex} at ${m.receivedAt}`;

export interface PlantedMarker {
  /** A string found only in the planted data. */
  readonly token: string;
  readonly at: Moment;
  /** The planted future data: a market event (e.g. a pool state) and an account state, all at `at` or later. */
  readonly events: readonly FeedEvent[];
}

/**
 * Leak test. Runs the same data twice, with and without the planted events. Fails if, before the marker's time, the
 * strategy is handed the marker (event, context, lookup or history), the log records it, or any log record differs
 * from the clean run. `labels` stands for the scored outcomes: they must carry the marker and are never given to
 * the run (the scoring stage is separate), which the test checks structurally by never passing them in.
 */
export const leakTest = (o: RunOptions, marker: PlantedMarker, labels: unknown): ProofReport => {
  const violations: string[] = [];
  const early = (m: Moment) => compareMoments(m, marker.at) < 0;
  const flag = (what: string, m: Moment) => violations.push(`${what} saw the marker at ${describe(m)}, before ${describe(marker.at)}`);
  if (!reaches(labels, marker.token)) violations.push('the labels do not carry the marker token');
  if (!marker.events.some((e) => !early(e.moment) && reaches(e, marker.token))) violations.push('no planted event at or after the marker carries the token');
  if (marker.events.some((e) => early(e.moment))) violations.push('a planted event is dated before the marker');
  if (reaches(o, marker.token)) violations.push('the run options already carry the marker');

  let seenAfter = false;
  const watch = (s: Strategy): Strategy => ({
    onMarket: (event, ctx) => {
      if (!early(ctx.now)) {
        if (reaches(event, marker.token)) seenAfter = true;
        return s.onMarket(event, ctx);
      }
      if (reaches(event, marker.token)) flag('the strategy event', ctx.now);
      const watched: StrategyContext = {
        now: ctx.now, book: ctx.book, rng: ctx.rng,
        lookup: (key, asOf) => {
          const r = ctx.lookup(key, asOf);
          if (reaches(r, marker.token)) flag(`lookup ${key}`, ctx.now);
          return r;
        },
        history: (key, from, to) => {
          const r = ctx.history(key, from, to);
          if (reaches(r, marker.token)) flag(`history ${key}`, ctx.now);
          return r;
        },
      };
      if (reaches(ctx.book, marker.token)) flag('the book', ctx.now);
      return s.onMarket(event, watched);
    },
  });
  const planted = runBacktest({ ...o, extraEvents: [...(o.extraEvents ?? []), ...marker.events], strategy: (c) => watch(o.strategy?.(c) ?? new S0(c)) });
  const clean = runBacktest(o);
  for (const r of [planted, clean]) if (r.stats.crash !== null) violations.push(`a run crashed: ${r.stats.crash}`);
  const before = (records: readonly LogRecord[]) => records.filter((r) => r.type === 'start' || early(r.at)).map(canonical);
  const p = before(planted.records);
  const c = before(clean.records);
  for (const line of p) if (line.includes(marker.token)) violations.push(`the log records the marker before its time: ${line.slice(0, 200)}`);
  const n = Math.max(p.length, c.length);
  for (let i = 0; i < n; i++) {
    if (p[i] !== c[i]) {
      violations.push(`decisions before the marker differ from the clean run at record ${i}: ${(p[i] ?? 'missing').slice(0, 200)} vs ${(c[i] ?? 'missing').slice(0, 200)}`);
      break;
    }
  }
  // The marker must reach the strategy at or after its time, or the test proved nothing.
  if (!seenAfter) violations.push('the planted events never reached the strategy after their time; the test would not detect a leak');
  return { ok: violations.length === 0, violations };
};

/**
 * +1-slot shift test on dataset rows: every row is delayed by `slots` slots (times unchanged, so only the slot clock
 * moves). The delayed run's log, moved back, must equal the original: any decision that changes means a module read
 * a slot it should not have.
 */
export const shiftTest = (o: RunOptions, rows: readonly DatasetRow[], slots = 1n): ProofReport => {
  const a = runBacktest({ ...o, rows: () => rows[Symbol.iterator]() });
  const shifted = rows.map((r) => ({ ...r, slot: r.slot + slots, ...(r.kind === 'block' ? { parentSlot: r.parentSlot + slots } : {}) }) as DatasetRow);
  const b = runBacktest({ ...o, rows: () => shifted[Symbol.iterator]() });
  const violations: string[] = [];
  for (const r of [a, b]) if (r.stats.crash !== null) violations.push(`a run crashed: ${r.stats.crash}`);
  // Slots appear in each record's `at`, in fills (the landing slot) and in ids (b:<slot>, t:<slot>); all move back.
  const norm = (r: LogRecord, back: bigint) =>
    back === 0n
      ? canonical(r)
      : canonical(r)
        .replace(/"slot":\{"\$n":"(\d+)"\}/g, (_, s: string) => `"slot":{"$n":"${BigInt(s) - back}"}`)
        .replace(/"([bt]):(\d+)"/g, (_, k: string, s: string) => `"${k}:${BigInt(s) - back}"`);
  const x = a.records.map((r) => norm(r, 0n));
  const y = b.records.map((r) => norm(r, slots));
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    if (x[i] !== y[i]) {
      violations.push(`the delayed run differs at record ${i}: ${(x[i] ?? 'missing').slice(0, 400)} vs ${(y[i] ?? 'missing').slice(0, 400)}`);
      break;
    }
  }
  return { ok: violations.length === 0, violations };
};
