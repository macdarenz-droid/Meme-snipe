// WORKER-GROW G4a: the engine's as-of store is pruned to each key's horizon at fixed points of the event clock. Inside
// the horizon every lookup and history answers as before, so a strategy that reads within it decides the same; the
// store stays bounded over a long run; live, the parity replay and the backtest use one rule set built from the policy.
import { describe, expect, it, vi } from 'vitest';
import { TRIAL_POLICY } from '../src/config/index.ts';
import {
  AsOfStore, createReplay, createRng, Engine, OFF_CHAIN, runToEnd, SimClock, type Decision, type FeedEvent, type Moment, type Retention,
  type Strategy, type StrategyContext,
} from '../src/engine/index.ts';
import { LIVE_ONE_SHOT, createKey, engineRetention, liveRetention, poolTradeKeys, curveTradeKeys, retentionFor } from '../src/gates/index.ts';
import { createRefreshAgeMs } from '../src/gates/retention.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number, slot = BigInt(Math.floor(ms / 400))): Moment => ({ slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: ms });

describe('AsOfStore.prune (one retention mechanism with BT-2: the on-record trim and the sweep share the rules)', () => {
  const store = (rule: Retention) => {
    const clock = new SimClock(at(0));
    const s = new AsOfStore(clock, rule);
    const put = (key: string, ms: number) => {
      clock.advanceTo(at(ms));
      s.record(key, { ms }, at(ms), `${key}@${ms}`);
    };
    return { s, put, clock };
  };

  it('keeps the latest value at or before the cutoff and every later one; a lookup at now and a history from the cutoff answer as before', () => {
    const { s, put } = store(() => 4 * HOUR);
    const plain = new AsOfStore(new SimClock(at(0)));
    const clock2 = new SimClock(at(0));
    const ref = new AsOfStore(clock2);
    for (let ms = 0; ms <= 10 * HOUR; ms += 10 * 60_000) {
      put('chain:slot', ms);
      clock2.advanceTo(at(ms));
      ref.record('chain:slot', { ms }, at(ms), `chain:slot@${ms}`);
    }
    expect(plain.size).toEqual({ keys: 0, entries: 0 });
    s.prune(10 * HOUR);
    const cut = 6 * HOUR;
    expect(s.lookup('chain:slot')).toEqual(ref.lookup('chain:slot'));
    expect(s.lookup('chain:slot', at(7 * HOUR))).toEqual(ref.lookup('chain:slot', at(7 * HOUR)));
    expect(s.history('chain:slot', at(cut))).toEqual(ref.history('chain:slot', at(cut)));
    // The latest value at or before the cutoff stays, so a lookup at the cutoff still answers.
    expect(s.lookup('chain:slot', at(cut))).toEqual(ref.lookup('chain:slot', at(cut)));
    expect((s.history('chain:slot', at(0)) as unknown as { source: string }[])[0]!.source).toBe(`chain:slot@${cut}`);
    expect(s.size.entries).toBe(25);
  });

  it('null keeps every value; a dropStale key goes whole once its newest value is at or before the cutoff, a plain horizon keeps its newest', () => {
    const { s, put } = store((k) => (k.startsWith('coverage:') ? null : k.startsWith('gates/create:') ? { horizonMs: DAY, dropStale: true } : DAY));
    put('coverage:creates:start', 0);
    put('gates/create:M1', 1);
    put('gates/halted', 2);
    put('coverage:creates:start', 3);
    put('later', 9 * DAY);
    const r = s.prune(9 * DAY);
    expect(r).toEqual({ entries: 1, keys: 1 });
    expect(s.history('coverage:creates:start', at(0))).toHaveLength(2);
    expect(s.lookup('gates/create:M1')).toEqual({ ok: false, reason: 'missing' });
    expect(s.lookup('gates/halted')).toMatchObject({ ok: true, source: 'gates/halted@2' });
    expect(s.size).toEqual({ keys: 3, entries: 4 });
  });

  it('BT-2\'s plain rules (a number or null) work unchanged; without a retention prune does nothing', () => {
    const { s, put } = store((k) => (k === 'x' ? null : 0));
    for (let ms = 0; ms < 100; ms++) { put('x', ms); put('y', ms); }
    s.prune(100);
    expect(s.history('x', at(0))).toHaveLength(100);
    expect(s.size.entries).toBe(101);
    const clock = new SimClock(at(0));
    const none = new AsOfStore(clock);
    clock.advanceTo(at(5));
    none.record('k', 1, at(5), 'k@5');
    expect(none.prune(DAY * 100)).toEqual({ entries: 0, keys: 0 });
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
  const RULES: Retention = Object.assign((k: string) => (k.startsWith('coverage:') ? null : k.startsWith('gates/create:') ? { horizonMs: 2 * HOUR, dropStale: true as const } : 2 * HOUR), { sweep: true as const });

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

});

describe('the rule set (engineRetention, retentionFor)', () => {
  const r = retentionFor(TRIAL_POLICY, 240 * 60_000);
  it('coverage keeps everything; trade keys the look-back plus a day; per-object keys (raw creates too) at least a day; the rest its newest plus an hour', () => {
    expect(r('coverage:creates:start')).toBeNull();
    expect(r('coverage:rugs:gap')).toBeNull();
    for (const k of [...poolTradeKeys('P'), ...curveTradeKeys('M')]) expect(r(k), k).toEqual({ horizonMs: (TRIAL_POLICY.gates.deployerRugLookbackDays + 1) * DAY, dropStale: true });
    // A raw create goes with the other per-object keys (the worker reads it again at a shortlist when it is gone).
    for (const k of ['logs:pump:CreateEvent:M', 'pump:CreateEvent:M', createKey('M'), 'gates/pool:M', 'gates/holders:M', 'gates/deployer:C', 'pump:CompleteEvent:M', 'pump_amm:CreatePoolEvent:P', 'account:A']) {
      expect(r(k), k).toEqual({ horizonMs: DAY, dropStale: true });
    }
    for (const k of ['chain:slot', 'seen:logs:X', 'gates/sol-usd', 'worker:halt', 'logs:truncated:logs:X', 'gates/stream:chain']) expect(r(k), k).toBe(HOUR);
  });
  it('a one-shot key (only observed as released, never looked up) goes after an hour, whatever its family', () => {
    const o = retentionFor(TRIAL_POLICY, 240 * 60_000, ['worker:seed']);
    expect(o('worker:seed')).toEqual({ horizonMs: HOUR, dropStale: true });
    expect(r('worker:seed')).toBe(HOUR);
  });
  it('the per-object horizon covers the candidate window plus the longest hold, and the trade horizon the look-back', () => {
    const long = engineRetention({ lookbackDays: 30, candidateWindowMs: 20 * HOUR, maxHoldMs: 6 * HOUR });
    expect(long(createKey('M'))).toEqual({ horizonMs: 27 * HOUR, dropStale: true });
    expect(long(poolTradeKeys('P')[0]!)).toEqual({ horizonMs: 31 * DAY, dropStale: true });
    expect(() => engineRetention({ lookbackDays: 0, candidateWindowMs: 1, maxHoldMs: 1 })).toThrow(/lookbackDays/);
  });
});

describe('the live rules over a long run (WORKER-GROW, review of #164)', () => {
  /** A minute's slot, and every 2 minutes a new mint: its raw create in both forms, its create fact and one trade. */
  const live = (days: number): FeedEvent[] => {
    const out: FeedEvent[] = [];
    for (let ms = 1_000; ms < days * DAY; ms += 60_000) {
      // In event order within the slot: the mint's events, then the slot fact (off-chain, last).
      if ((ms - 1_000) % 120_000 === 0) {
        const mint = `M${ms}`;
        const ev = (tx: number, key: string) => out.push({ kind: 'market', id: `${key}@${ms}`, moment: { ...at(ms), txIndex: tx, ixIndex: 0 }, key, value: { ms, pad: 'x'.repeat(200) } });
        ev(1, `logs:pump:CreateEvent:${mint}`);
        ev(2, `pump:CreateEvent:${mint}`);
        ev(3, createKey(mint));
        ev(4, curveTradeKeys(mint)[0]!);
        if (ms % (6 * HOUR) < 60_000) ev(5, 'coverage:creates:gap');
      }
      out.push({ kind: 'market', id: `slot:${ms}`, moment: at(ms), key: 'chain:slot', value: { ms } });
    }
    return out;
  };
  const sizes = (days: number, retention?: Retention): { keys: number; entries: number }[] => {
    const events = live(days);
    const clock = new SimClock(at(0));
    let head = 0;
    const engine = new Engine({ clock, feed: { next: () => (head < events.length && events[head]!.moment.receivedAt <= clock.now().receivedAt ? events[head++]! : null) }, strategy: { onMarket: () => [] }, runner: { run: () => undefined }, seed: 's', book: { maxOpenPositions: 1 }, keepLog: false, ...(retention === undefined ? {} : { retention }) });
    const out: { keys: number; entries: number }[] = [];
    for (let day = 1; day <= days; day++) {
      for (let ms = (day - 1) * DAY; ms < day * DAY; ms += 60_000) {
        clock.advanceTo(at(ms + 1_000, BigInt(Math.floor((ms + 1_000) / 400)) + 1n));
        engine.drain();
      }
      out.push({ ...engine.storeSize });
    }
    return out;
  };

  it('with liveRetention the store stops growing once the longest horizon (the look-back plus a day) is reached; without, it grows every day', () => {
    const lookback = TRIAL_POLICY.gates.deployerRugLookbackDays + 1;
    const days = lookback + 5;
    const kept = sizes(days, liveRetention(TRIAL_POLICY, 240 * 60_000));
    const all = sizes(days);
    // Without retention: four new keys a mint, 720 mints a day, every day.
    expect(all[days - 1]!.keys - all[days - 4]!.keys).toBeGreaterThan(3 * 720 * 3);
    // With it: flat from the look-back on (trade keys go after it; raw creates and create facts after a day).
    const flat = kept.slice(lookback);
    for (const s of flat) {
      expect(Math.abs(s.keys - flat[0]!.keys), JSON.stringify(s)).toBeLessThan(50);
      expect(Math.abs(s.entries - flat[0]!.entries), JSON.stringify(s)).toBeLessThan(100);
    }
    // What stays: about the look-back's trade keys and a day of creates, never a key per mint seen.
    expect(flat[0]!.keys).toBeLessThan(720 * (lookback + 1) + 3 * 720 * 2);
    expect(flat.at(-1)!.keys).toBeLessThan(all.at(-1)!.keys / 2);
  });

  it('a raw create is fetched again at a shortlist when older than the refresh age, which leaves the window and the longest hold inside its horizon', () => {
    const maxHold = Math.max(...(['U1', 'U2'] as const).map((u) => TRIAL_POLICY.exits.universes[u].tMaxMs));
    const window = 240 * 60_000;
    const age = createRefreshAgeMs(TRIAL_POLICY, window);
    const horizon = (retentionFor(TRIAL_POLICY, window)('pump:CreateEvent:M') as { horizonMs: number }).horizonMs;
    expect(age).toBeGreaterThan(0);
    // A create read at the shortlist no older than `age` is still held after the window, the hold and the hourly prune.
    expect(age + window + maxHold + HOUR).toBeLessThan(horizon);
    // A long window and hold leave no room: every shortlist reads the create again.
    const longPolicy = { ...TRIAL_POLICY, exits: { ...TRIAL_POLICY.exits, universes: Object.fromEntries(Object.entries(TRIAL_POLICY.exits.universes).map(([k, u]) => [k, { ...u, tMaxMs: DAY }])) } } as typeof TRIAL_POLICY;
    expect(createRefreshAgeMs(longPolicy, window)).toBe(0);
  });
});

describe('one rule object for live, the parity replay and the backtest (guard)', () => {
  it('liveRetention gives the same object for the same policy and window; each site that claims live parity calls it', async () => {
    expect(liveRetention(TRIAL_POLICY, 240 * 60_000)).toBe(liveRetention(TRIAL_POLICY, 240 * 60_000));
    expect(liveRetention(TRIAL_POLICY, 240 * 60_000)).not.toBe(liveRetention(TRIAL_POLICY, 241 * 60_000));
    expect(LIVE_ONE_SHOT).toEqual(['worker:seed']);
    expect(liveRetention(TRIAL_POLICY, 240 * 60_000)('worker:seed')).toEqual({ horizonMs: HOUR, dropStale: true });
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = (p: string) => readFileSync(join(import.meta.dirname, '..', '..', p), 'utf8');
    expect(src('worker/src/run/worker.ts')).toContain('retention: liveRetention(d.session.policy, d.strategy.windowToMs)');
    expect(src('worker/src/run/parity.ts')).toContain('retention: liveRetention(d.session.policy, d.strategy.windowToMs)');
    expect(src('backtest/src/run.ts')).toContain('retention: o.retention ?? liveRetention(o.policy, config.windowToMs)');
    for (const p of ['worker/src/run/worker.ts', 'worker/src/run/parity.ts', 'backtest/src/run.ts']) expect(src(p), p).not.toMatch(/retentionFor\(/);
  });
});

describe('the hourly sweep runs only for rules that ask for it (BT-2\'s study keeps #41\'s behaviour)', () => {
  const run = (retention: Retention) => {
    const spy = vi.spyOn(AsOfStore.prototype, 'prune');
    const events: FeedEvent[] = [];
    for (let ms = 1_000; ms < 5 * HOUR; ms += 60_000) events.push({ kind: 'market', id: `e:${ms}`, moment: at(ms), key: 'k', value: ms });
    const replay = createReplay(events);
    runToEnd(replay, new Engine({ clock: replay.clock, feed: replay.feed, strategy: { onMarket: () => [] }, runner: { run: () => undefined }, seed: 's', book: { maxOpenPositions: 1 }, keepLog: false, retention }));
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    return calls;
  };
  it('a plain function (the study\'s STUDY_RETENTION shape) is never swept; the live rules are, once an hour', () => {
    expect(run((k) => (k === 'coverage:x' ? null : 0))).toBe(0);
    expect(run(liveRetention(TRIAL_POLICY, 240 * 60_000))).toBe(5);
  });
});
