// The proofs that the engine cannot see the future (docs/ARCHITECTURE.md §16.1 and §16.3):
// the leak test (a planted future-only marker stays invisible until its time, and no decision before
// that time changes) and the +1-slot shift test (delaying every event must delay every decision).
// They run on any event stream and strategy: a stub here, real data and strategies in BT-1.

import type { BookConfig, Effect } from '../lifecycle/index.ts';
import { Engine, type LogRecord, type Strategy, type StrategyContext } from './engine.ts';
import { createReplay, type FeedEvent, type Replay } from './feed.ts';
import { canonical } from './log.ts';
import { compareMoments, type Moment } from './moment.ts';
import type { EffectRunner } from './runner.ts';

export interface ProofRun {
  readonly events: readonly FeedEvent[];
  /** A fresh strategy for each run. Called inside the event loop on first use, so it must be pure like the strategy. */
  readonly strategy: () => Strategy;
  /** The outside world for one run: performs effects, schedules their results into the replay. Default: does nothing. */
  readonly world?: (replay: Replay) => EffectRunner;
  readonly seed: string;
  readonly book: BookConfig;
  readonly start?: Moment;
}

export interface RunResult {
  readonly records: readonly LogRecord[];
  readonly hash: string;
  readonly replay: Replay;
}

const NO_WORLD: EffectRunner = { run: () => {} };

export const replayOnce = (run: ProofRun, wrap: (s: Strategy) => Strategy = (s) => s, wrapRunner: (r: EffectRunner) => EffectRunner = (r) => r): RunResult => {
  const replay = createReplay(run.events, run.start);
  // The strategy and world are built on first use, inside the engine's event loop, so their factories run
  // under the same rules as their calls (and under the test suite's runtime trap). Engine construction is pure.
  let strategy: Strategy | null = null;
  let runner: EffectRunner | null = null;
  const engine = new Engine({
    clock: replay.clock,
    feed: replay.feed,
    strategy: { onMarket: (e, ctx) => (strategy ??= wrap(run.strategy())).onMarket(e, ctx) },
    runner: { run: (fx, now) => (runner ??= wrapRunner(run.world?.(replay) ?? NO_WORLD)).run(fx, now) },
    seed: run.seed,
    book: run.book,
  });
  while (replay.advance()) engine.drain();
  return { records: engine.records, hash: engine.logHash(), replay };
};

/** Log hashes of `times` independent replays of the same run. Deterministic replay means they are all equal. */
export const replayHashes = (run: ProofRun, times: number): string[] => Array.from({ length: times }, () => replayOnce(run).hash);

export interface ProofReport {
  readonly ok: boolean;
  readonly violations: readonly string[];
}

const at = (r: LogRecord): Moment | null => (r.type === 'start' ? null : r.at);
const describe = (m: Moment): string => `slot ${m.slot} tx ${m.txIndex} ix ${m.ixIndex} received ${m.receivedAt}`;

/**
 * Searches everything reachable from `root` through data (own properties, array items, map and set
 * entries; getters and function closures are not entered) for a string containing `token`.
 */
export const reaches = (root: unknown, token: string, budget = 200_000): boolean => {
  const seen = new Set<object>();
  const stack: unknown[] = [root];
  while (stack.length > 0 && budget-- > 0) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (v.includes(token)) return true;
      continue;
    }
    if (typeof v !== 'object' || v === null || seen.has(v)) continue;
    seen.add(v);
    if (v instanceof Map) for (const [k, x] of v) stack.push(k, x);
    else if (v instanceof Set) for (const x of v) stack.push(x);
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key === 'string' && key.includes(token)) return true;
      const d = Object.getOwnPropertyDescriptor(v, key);
      if (d !== undefined && 'value' in d) stack.push(d.value);
    }
  }
  if (budget <= 0) throw new RangeError('reachability search budget exhausted');
  return false;
};

export interface Marker {
  /** A string that appears only in the planted future data. */
  readonly token: string;
  /** When the planted data becomes true. Nothing may observe it, and no decision may change, before this. */
  readonly at: Moment;
}

/**
 * Leak test. `run.events` carries the planted data at `marker.at` (for example an event and an account
 * state); `labels` stands for the scored outcomes, which only the separate scoring stage reads and the
 * engine is never given. Fails if, before the marker's time:
 * - the strategy is handed the marker (its event, a lookup, a history read, or anything reachable from its context);
 * - the runner is handed an effect carrying it, or the log records it;
 * - any log record differs from a run on the same data without the planted events.
 */
export const leakTest = (run: ProofRun, marker: Marker, labels: unknown = null): ProofReport => {
  const violations: string[] = [];
  const early = (m: Moment) => compareMoments(m, marker.at) < 0;
  const flag = (what: string, m: Moment) => violations.push(`${what} saw the marker at ${describe(m)}, before ${describe(marker.at)}`);
  if (!reaches(labels, marker.token)) violations.push('the labels do not carry the marker token');
  if (!run.events.some((e) => early(e.moment) === false && reaches(e, marker.token))) violations.push('no event at or after the marker carries the token');

  const watch = (s: Strategy): Strategy => ({
    onMarket: (event, ctx) => {
      if (!early(ctx.now)) return s.onMarket(event, ctx);
      if (reaches(event, marker.token)) flag('the strategy event', ctx.now);
      if (reaches(ctx, marker.token)) flag('the strategy context', ctx.now);
      const watched: StrategyContext = {
        now: ctx.now,
        book: ctx.book,
        rng: ctx.rng,
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
      return s.onMarket(event, watched);
    },
  });
  const watchRunner = (r: EffectRunner): EffectRunner => ({
    run: (effect: Effect, now: Moment) => {
      if (early(now) && reaches(effect, marker.token)) flag('the effect runner', now);
      r.run(effect, now);
    },
  });

  const planted = replayOnce(run, watch, watchRunner);
  const before = (records: readonly LogRecord[]) =>
    records.filter((r) => {
      const m = at(r);
      return m === null || early(m);
    }).map(canonical);
  const plantedBefore = before(planted.records);
  for (const line of plantedBefore) if (line.includes(marker.token)) violations.push(`the log records the marker before its time: ${line.slice(0, 200)}`);

  const clean = replayOnce({ ...run, events: run.events.filter((e) => !reaches(e, marker.token)) });
  const cleanBefore = before(clean.records);
  const n = Math.max(plantedBefore.length, cleanBefore.length);
  for (let i = 0; i < n; i++) {
    if (plantedBefore[i] !== cleanBefore[i]) {
      violations.push(`decisions before the marker differ from a run without it at record ${i}: ${(plantedBefore[i] ?? 'missing').slice(0, 200)} vs ${(cleanBefore[i] ?? 'missing').slice(0, 200)}`);
      break;
    }
  }
  return { ok: violations.length === 0, violations };
};

const shiftMoment = (m: Moment, slots: bigint, msPerSlot: number): Moment => ({
  ...m, slot: m.slot + slots, receivedAt: m.receivedAt + Number(slots) * msPerSlot,
});

/** Every decision's inputs were due at or before the decision. Returns one line per violation. */
export const checkCausality = (label: string, result: RunResult): string[] => {
  const out: string[] = [];
  for (const r of result.records) {
    if (r.type !== 'decision') continue;
    for (const id of r.inputs) {
      const due = result.replay.momentOf(id);
      if (due === undefined) out.push(`${label}: decision at ${describe(r.at)} read unknown event ${id}`);
      else if (compareMoments(due, r.at) > 0) out.push(`${label}: decision at ${describe(r.at)} read ${id}, due at ${describe(due)}`);
    }
  }
  return out;
};

/**
 * +1-slot shift test. Every event is delayed by `slots` (receipt time by `slots × msPerSlot`).
 * Fails if any decision in either run read an event before it was due, or if the delayed run's log,
 * moved back by `slots`, is not exactly the original log: a decision that came earlier, later,
 * differently or not at all means some module used data before the data existed.
 * The strategy and world must not put absolute slots into their outputs (ids, payloads) for the
 * comparison to hold; times belong in each record's `at`.
 */
export const shiftTest = (run: ProofRun, slots = 1n, msPerSlot = 400): ProofReport => {
  if (slots < 1n) throw new RangeError('shift by at least one slot');
  const original = replayOnce(run);
  const shifted = replayOnce({
    ...run,
    ...(run.start === undefined ? {} : { start: shiftMoment(run.start, slots, msPerSlot) }),
    events: run.events.map((e) => ({ ...e, moment: shiftMoment(e.moment, slots, msPerSlot) })),
  });
  const violations = [...checkCausality('original', original), ...checkCausality('shifted', shifted)];
  const unshift = (r: LogRecord) => canonical(r.type === 'start' ? r : { ...r, at: shiftMoment(r.at, -slots, msPerSlot) });
  const a = original.records.map(canonical);
  const b = shifted.records.map(unshift);
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      violations.push(`the delayed run differs at record ${i}: ${(a[i] ?? 'missing').slice(0, 200)} vs ${(b[i] ?? 'missing').slice(0, 200)}`);
      break;
    }
  }
  return { ok: violations.length === 0, violations };
};
