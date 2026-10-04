// REC-1: a rejected candidate's pool stays watched after its window, until the window end plus the universe's
// maximum hold, so the recording holds every swap a counterfactual entry would need (G3). Engine level, exact clock.
import { describe, expect, it } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, RUG_CONFIG, TRIAL_POLICY, exitsFor, startSession } from '../../core/src/config/index.ts';
import { Engine } from '../../core/src/engine/index.ts';
import { migrationKey } from '../../core/src/gates/index.ts';
import { HALT_KEY, LiveStrategy } from '../src/engine/strategy.ts';
import { DEFAULT_LIVE_FEED, LiveFeed, type FrameBody, type Source } from '../src/providers/index.ts';
import { engineFeed } from '../src/run/engine-feed.ts';
import { PoolWatch } from '../src/run/pool-watch.ts';
import { strategyConfig } from '../src/run/settings.ts';
import { P1, P3 } from '../src/scheduler/index.ts';
import { blockNetwork } from './helpers.ts';

blockNetwork();

const M1 = 'HAcEqEVru6dRbe1grLFTPBxjxGgjn1tVpR7bLgYXdust';
const POOL = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 3, 12, 0);
const session = startSession(TRIAL_POLICY);
const config = strategyConfig(session.policy, FILL_CONFIG, RESEARCH_CONFIG, 0n, { timing: 'gates', salt: '' });
const T_MAX = exitsFor(session.policy.exits, config.universe).tMaxMs;

const world = () => {
  const feed = new LiveFeed(DEFAULT_LIVE_FEED);
  const strategy = new LiveStrategy({ session, rugs: RUG_CONFIG, config });
  const engine = new Engine({ clock: feed.clock, feed: engineFeed(feed, session.policy).feed, strategy, runner: { run: () => undefined }, seed: 'rec-1', book: { maxOpenPositions: session.policy.positions.maxOpen } });
  let now = T0;
  let slot = 500_000_000n;
  const put = (source: Source, body: FrameBody): void => void feed.ingest(source, body, { receivedAt: now });
  /** Moves the clock by `ms` with three slot notices at its end, so everything up to it is released. */
  const jump = (ms: number): void => {
    now += ms;
    for (let k = 0; k < 3; k++) {
      slot += 1n;
      put('helius', { type: 'slot', slot, parent: slot - 1n, root: null });
    }
    feed.advance(now);
    engine.drain();
  };
  /** A candidate that migrated `agoMs` ago, with its PumpSwap pool. */
  const shortlist = (mint: string, agoMs: number): void => {
    const obs = { provider: 'test', slot: null, receivedAt: now, quality: [], commitment: 'confirmed' };
    put('worker', { type: 'fact', key: migrationKey(mint), value: { obs, graduatedAtMs: now - agoMs, migratedAtMs: now - agoMs, pool: POOL, quoteAtMigration: 1n, price: { quote: 1n, base: 1n } } });
  };
  put('worker', { type: 'fact', key: HALT_KEY, value: { halted: false, reasons: [] } });
  return { strategy, jump, shortlist, now: () => now };
};

describe('REC-1: a rejected candidate\'s pool is watched until its window end plus the maximum hold', () => {
  it('evaluated and rejected: the pool stays watched past the window, until windowEnd + tMax, then is dropped', () => {
    const w = world();
    // Five seconds before its window ends.
    w.shortlist(M1, config.windowToMs - 5_000);
    w.jump(400);
    const c = w.strategy.candidates().get(M1)!;
    expect(c.lastEvalMs).not.toBeNull();
    expect(w.strategy.watchedPools().get(POOL)).toEqual({ mint: M1, held: false });
    const windowEnd = c.migratedAtMs + config.windowToMs;
    w.jump(6_000);
    expect(w.strategy.candidates().has(M1)).toBe(false);
    expect(w.strategy.tail.get(M1)).toEqual({ pool: POOL, untilMs: windowEnd + T_MAX });
    expect(w.strategy.watchedPools().get(POOL)).toEqual({ mint: M1, held: false });
    // Still watched at exactly windowEnd + tMax (an exit at the maximum hold needs that moment), dropped 1 ms later.
    w.jump(windowEnd + T_MAX - w.now());
    expect(w.now()).toBe(windowEnd + T_MAX);
    expect(w.strategy.watchedPools().has(POOL)).toBe(true);
    w.jump(1);
    expect(w.strategy.tail.has(M1)).toBe(false);
    expect(w.strategy.watchedPools().has(POOL)).toBe(false);
  });

  it('a candidate never evaluated gets no tail', () => {
    const w = world();
    // Its window has already ended when it is shortlisted: it leaves without one evaluation.
    w.shortlist(M1, config.windowToMs + MIN);
    w.jump(400);
    expect(w.strategy.candidates().has(M1)).toBe(false);
    expect(w.strategy.tail.has(M1)).toBe(false);
    expect(w.strategy.watchedPools().has(POOL)).toBe(false);
  });

  it('the pool watch follows: PoolWatch keeps the tail pool at P3 past the window and unwatches it after windowEnd + tMax', () => {
    const w = world();
    const calls: string[] = [];
    let id = 0;
    const watch = new PoolWatch({
      stream: {
        watchLogs: (address, o) => (calls.push(`watch ${address} P${o.priority}`), ++id),
        unwatch: (n, reason) => void calls.push(`unwatch ${n} ${reason}`),
      },
      timers: { now: () => w.now(), setTimeout: () => ({ id: 0 }), clearTimeout: () => undefined },
      pools: () => w.strategy.watchedPools(),
      everyMs: 2_000,
    });
    w.shortlist(M1, config.windowToMs - 5_000);
    w.jump(400);
    watch.sync();
    const windowEnd = w.strategy.candidates().get(M1)!.migratedAtMs + config.windowToMs;
    w.jump(6_000);
    watch.sync();
    w.jump(T_MAX - 10_000);
    watch.sync();
    expect(calls).toEqual([`watch ${POOL} P${P3}`]);
    w.jump(windowEnd + T_MAX + 1_000 - w.now());
    watch.sync();
    expect(calls).toEqual([`watch ${POOL} P${P3}`, 'unwatch 1 not watched']);
    expect(P3).toBeGreaterThan(P1);
  });
});
