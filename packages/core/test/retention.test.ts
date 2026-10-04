// WORKER-GROW G4a: the engine's as-of store is pruned to each key's horizon at fixed points of the event clock. Inside
// the horizon every lookup and history answers as before, so a strategy that reads within it decides the same; the
// store stays bounded over a long run; live, the parity replay and the backtest use one rule set built from the policy.
import { describe, expect, it } from 'vitest';
import { TRIAL_POLICY } from '../src/config/index.ts';
import {
  AsOfStore, createReplay, createRng, Engine, OFF_CHAIN, runToEnd, SimClock, type Decision, type FeedEvent, type Moment, type Retention,
  type Strategy, type StrategyContext,
} from '../src/engine/index.ts';
import { createKey, engineRetention, poolTradeKeys, curveTradeKeys, retentionFor } from '../src/gates/index.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number, slot = BigInt(Math.floor(ms / 400))): Moment => ({ slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: ms });

describe('AsOfStore.prune', () => {
  const store = () => {
    const clock = new SimClock(at(0));
    const s = new AsOfStore(clock);
    const put = (key: string, ms: number) => {
      clock.advanceTo(at(ms));
      s.record(key, { ms }, at(ms), `${key}@${ms}`);
    };
    return { s, put, clock };
  };

  it('keeps every entry at or after the cut and the newest before it; a lookup at now and a history from the cut answer as before', () => {
    const { s, put, clock } = store();
    for (let ms = 0; ms <= 10 * HOUR; ms += 10 * 60_000) put('chain:slot', ms);
    const cut = 6 * HOUR;
    const before = { last: s.lookup('chain:slot'), from: s.history('chain:slot', at(cut)), mid: s.lookup('chain:slot', at(7 * HOUR)) };
    const r = s.prune(10 * HOUR, () => ({ horizonMs: 4 * HOUR, dropStale: false }));
    expect(r).toEqual({ entries: 35, keys: 0 });
    expect(s.lookup('chain:slot')).toEqual(before.last);
    expect(s.lookup('chain:slot', at(7 * HOUR))).toEqual(before.mid);
    expect(s.history('chain:slot', at(cut))).toEqual(before.from);
    // The newest entry before the cut stays, so a lookup just before the cut still answers.
    expect(s.history('chain:slot', at(0))).toHaveLength(26);
    expect((s.history('chain:slot', at(0)) as unknown as { source: string }[])[0]!.source).toBe(`chain:slot@${cut - 10 * 60_000}`);
    expect(clock.now().receivedAt).toBe(10 * HOUR);
  });

  it("'all' keeps every entry; a stale key goes whole only with dropStale, else its newest entry stays", () => {
    const { s, put } = store();
    put('coverage:creates:start', 0);
    put('gates/create:M1', 1);
    put('gates/halted', 2);
    put('coverage:creates:start', 3);
    put('later', 9 * DAY);
    const r = s.prune(9 * DAY, (k) => (k.startsWith('coverage:') ? 'all' : { horizonMs: DAY, dropStale: k.startsWith('gates/create:') }));
    expect(r).toEqual({ entries: 1, keys: 1 });
    expect(s.history('coverage:creates:start', at(0))).toHaveLength(2);
    expect(s.lookup('gates/create:M1')).toEqual({ ok: false, reason: 'missing' });
    expect(s.lookup('gates/halted')).toMatchObject({ ok: true, source: 'gates/halted@2' });
    expect(s.size).toEqual({ keys: 3, entries: 4 });
  });
});

describe('the engine prunes at fixed points of the event clock and decides the same inside the horizon', () => {
  /** A stream of `days` days: a slot every 400 ms (thinned), a fact on a few keys, a new per-object key a minute. */
  const stream = (days: number, seed: string): FeedEvent[] => {
    const rng = createRng(seed);
    const out: FeedEvent[] = [];
    for (let ms = 1_000; ms < days * DAY; ms += 20_000) {
      out.push({ kind: 'market', id: `slot:${ms}`, moment: at(ms), key: 'chain:slot', value: { ms } });
      if (rng.int(4) === 0) out.push({ kind: 'market', id: `px:${ms}`, moment: { ...at(ms), txIndex: 5 }, key: 'gates/sol-usd', value: { px: rng.int(1000) } });
      if (ms % 60_000 < 20_000) out.push({ kind: 'market', id: `cr:${ms}`, moment: { ...at(ms), txIndex: 7 }, key: createKey(`M${ms}`), value: { ms } });
      if (ms % (6 * HOUR) < 20_000) out.push({ kind: 'market', id: `cov:${ms}`, moment: { ...at(ms), txIndex: 9 }, key: 'coverage:creates:gap', value: { ms } });
    }
    return out;
  };
  /** Reads within the horizon: the newest of each key, an hour of slot history, and every coverage entry. */
  const reader = (): Strategy => ({
    onMarket: (e, ctx: StrategyContext): Decision[] => {
      if (!e.id.startsWith('px:')) return [];
      const px = ctx.lookup('gates/sol-usd');
      const slots = ctx.history('chain:slot', { ...ctx.now, slot: ctx.now.slot > 9_000n ? ctx.now.slot - 9_000n : 0n, receivedAt: ctx.now.receivedAt - HOUR });
      const cov = ctx.history('coverage:creates:gap', { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: 0 });
      const recent = ctx.lookup(createKey(`M${e.moment.receivedAt - (e.moment.receivedAt % 60_000) + 1_000}`));
      return [{ action: null, reasons: [String(px.ok), String(Array.isArray(slots) ? slots.length : -1), String(Array.isArray(cov) ? cov.length : -1), String(recent.ok)] }];
    },
  });
  const run = (events: FeedEvent[], retention?: Retention) => {
    const replay = createReplay(events);
    const engine = new Engine({ clock: replay.clock, feed: replay.feed, strategy: reader(), runner: { run: () => undefined }, seed: 's', book: { maxOpenPositions: 1 }, keepLog: false, ...(retention === undefined ? {} : { retention }) });
    runToEnd(replay, engine);
    return engine;
  };
  const RULES: Retention = { everyMs: HOUR, rule: (k) => (k.startsWith('coverage:') ? 'all' : k.startsWith('gates/create:') ? { horizonMs: 2 * HOUR, dropStale: true } : { horizonMs: 2 * HOUR, dropStale: false }) };

  it('the same decision log, byte for byte, with and without retention, and the pruned store stays bounded', () => {
    const events = stream(3, 'g4a');
    const full = run(events);
    const pruned = run(events, RULES);
    expect(pruned.logHash()).toBe(full.logHash());
    // About 3 days of slots and creates kept without retention; two hours plus the boundary's hour with it.
    expect(full.storeSize.entries).toBeGreaterThan(15_000);
    expect(pruned.storeSize.entries).toBeLessThan(1_000);
    expect(pruned.storeSize.keys).toBeLessThan(250);
  });

  it('the pruned size does not grow with the run: day 6 holds what day 2 holds', () => {
    const size = (days: number) => run(stream(days, 'g4a'), RULES).storeSize;
    const two = size(2);
    const six = size(6);
    expect(Math.abs(six.keys - two.keys)).toBeLessThan(10);
    expect(Math.abs(six.entries - two.entries)).toBeLessThan(80);
  });

  it('a retention without a positive everyMs, or a rule horizon below it, is refused', () => {
    const replay = createReplay([]);
    const base = { clock: replay.clock, feed: replay.feed, strategy: reader(), runner: { run: () => undefined }, seed: 's', book: { maxOpenPositions: 1 } };
    expect(() => new Engine({ ...base, retention: { everyMs: 0, rule: () => 'all' } })).toThrow(/everyMs/);
    const bad = createReplay(stream(1, 'x').slice(0, 300));
    const e = new Engine({ ...base, clock: bad.clock, feed: bad.feed, retention: { everyMs: HOUR, rule: () => ({ horizonMs: 60_000, dropStale: false }) } });
    expect(() => runToEnd(bad, e)).toThrow(/at least everyMs/);
  });
});

describe('the rule set (engineRetention, retentionFor)', () => {
  const r = retentionFor(TRIAL_POLICY, 240 * 60_000);
  it('coverage keeps everything; trade keys the look-back plus a day; per-object keys at least a day; the rest an hour', () => {
    expect(r.everyMs).toBe(HOUR);
    expect(r.rule('coverage:creates:start')).toBe('all');
    expect(r.rule('coverage:rugs:gap')).toBe('all');
    for (const k of [...poolTradeKeys('P'), ...curveTradeKeys('M')]) expect(r.rule(k), k).toEqual({ horizonMs: (TRIAL_POLICY.gates.deployerRugLookbackDays + 1) * DAY, dropStale: true });
    // A raw create event keeps its newest entry: the exits' deployer-sell trigger and the gates' create alias read it.
    for (const k of ['logs:pump:CreateEvent:M', 'pump:CreateEvent:M']) expect(r.rule(k), k).toEqual({ horizonMs: HOUR, dropStale: false });
    for (const k of [createKey('M'), 'gates/pool:M', 'gates/holders:M', 'gates/deployer:C', 'pump:CompleteEvent:M', 'pump_amm:CreatePoolEvent:P', 'account:A']) {
      expect(r.rule(k), k).toEqual({ horizonMs: DAY, dropStale: true });
    }
    for (const k of ['chain:slot', 'seen:logs:X', 'gates/sol-usd', 'worker:halt', 'logs:truncated:logs:X', 'gates/stream:chain']) expect(r.rule(k), k).toEqual({ horizonMs: HOUR, dropStale: false });
  });
  it('a one-shot key (only observed as released, never looked up) goes after an hour, whatever its family', () => {
    const o = retentionFor(TRIAL_POLICY, 240 * 60_000, ['worker:seed']);
    expect(o.rule('worker:seed')).toEqual({ horizonMs: HOUR, dropStale: true });
    expect(r.rule('worker:seed')).toEqual({ horizonMs: HOUR, dropStale: false });
  });
  it('the per-object horizon covers the candidate window plus the longest hold, and the trade horizon the look-back', () => {
    const long = engineRetention({ lookbackDays: 30, candidateWindowMs: 20 * HOUR, maxHoldMs: 6 * HOUR });
    expect(long.rule(createKey('M'))).toEqual({ horizonMs: 27 * HOUR, dropStale: true });
    expect(long.rule(poolTradeKeys('P')[0]!)).toEqual({ horizonMs: 31 * DAY, dropStale: true });
    expect(() => engineRetention({ lookbackDays: 0, candidateWindowMs: 1, maxHoldMs: 1 })).toThrow(/lookbackDays/);
  });
});

describe('one rule set for live, the parity replay and the backtest (guard)', () => {
  it('each builds its Engine with retentionFor from its policy and its strategy window', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = (p: string) => readFileSync(join(import.meta.dirname, '..', '..', p), 'utf8');
    expect(src('worker/src/run/worker.ts')).toContain('retention: retentionFor(d.session.policy, d.strategy.windowToMs, [SEED_KEY])');
    expect(src('worker/src/run/parity.ts')).toContain('retention: retentionFor(d.session.policy, d.strategy.windowToMs, [SEED_KEY])');
    expect(src('backtest/src/run.ts')).toContain('retention: retentionFor(o.policy, config.windowToMs)');
  });
});
