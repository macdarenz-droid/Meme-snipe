// FACTS-1b: a read landing for a candidate is judged at once, outside the evaluation cadence (supervisor ruling).
// Engine level, with an exact clock: the live Feed, core's FactFeed and the worker's strategy, as the worker runs them.
// The trigger is the read's own recorded frame, so the replay re-evaluates at the same release position.
import { describe, expect, it } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, RUG_CONFIG, TRIAL_POLICY, startSession } from '../../core/src/config/index.ts';
import { Engine, type LogRecord, type Strategy } from '../../core/src/engine/index.ts';
import { RAW } from '../../core/src/facts/index.ts';
import { migrationKey } from '../../core/src/gates/index.ts';
import { HALT_KEY, LiveStrategy } from '../src/engine/strategy.ts';
import { DEFAULT_LIVE_FEED, LiveFeed, replayRecorded, type Frame, type FrameBody, type Release, type Source } from '../src/providers/index.ts';
import { engineFeed } from '../src/run/engine-feed.ts';
import { strategyConfig } from '../src/run/settings.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { holdersKey } from '../../core/src/gates/index.ts';
import { blockNetwork } from './helpers.ts';
import { MINT as MINT_H, makeWorker, passingMarket } from './worker-harness.ts';

blockNetwork();

const M1 = 'HAcEqEVru6dRbe1grLFTPBxjxGgjn1tVpR7bLgYXdust';
const M2 = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const T0 = Date.UTC(2026, 9, 3, 12, 0);
const S0 = 400_000_000n;
const MIN = 60_000;
const CADENCE = TRIAL_POLICY.gates.maxQuoteAgeMs;
const LAG = BigInt(TRIAL_POLICY.gates.maxStateSlotLag);
const HOLDER = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
const OWNER = 'CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq';

/** Wraps the strategy so every event leaves a line: its id and when each candidate was last evaluated. */
const traced = (inner: LiveStrategy, trace: string[]): Strategy => ({
  onMarket: (e, ctx) => {
    const out = inner.onMarket(e, ctx);
    trace.push(`${e.id} ${[...inner.candidates()].map(([m, c]) => `${m.slice(0, 4)}=${c.lastEvalMs}`).join(' ')}`);
    return out;
  },
});

const world = (o: { readonly evaluateEveryMs?: number } = {}) => {
  const session = startSession(TRIAL_POLICY);
  const base = strategyConfig(session.policy, FILL_CONFIG, RESEARCH_CONFIG, 0n, { timing: 'gates', salt: '' });
  const config = o.evaluateEveryMs === undefined ? base : { ...base, evaluateEveryMs: o.evaluateEveryMs };
  const frames: Frame[] = [];
  const releases: Release[] = [];
  const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, onFrame: (f) => frames.push(f), onRelease: (_e, r) => releases.push(r) });
  const strategy = new LiveStrategy({ session, rugs: RUG_CONFIG, config });
  const trace: string[] = [];
  const engine = new Engine({ clock: feed.clock, feed: engineFeed(feed, session.policy).feed, strategy: traced(strategy, trace), runner: { run: () => undefined }, seed: 'landing', book: { maxOpenPositions: session.policy.positions.maxOpen } });
  let now = T0;
  let slot = S0;
  const put = (source: Source, body: FrameBody): void => void feed.ingest(source, body, { receivedAt: now });
  /** Moves the clock, one slot notice per 400 ms, releasing everything the horizon passed. */
  const tick = (ms: number): void => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 400);
      slot += 1n;
      put('helius', { type: 'slot', slot, parent: slot - 1n, root: null });
      feed.advance(now);
      engine.drain();
    }
  };
  const obs = () => ({ provider: 'test', slot: null, receivedAt: now, quality: [], commitment: 'confirmed' });
  const shortlist = (mint: string): void => {
    put('worker', { type: 'fact', key: migrationKey(mint), value: { obs: obs(), graduatedAtMs: now - 61 * MIN, migratedAtMs: now - 61 * MIN, pool: mint, quoteAtMigration: 1n, price: { quote: 1n, base: 1n } } });
  };
  /** A holder read of `mint` answered `behind` slots back. */
  const read = (mint: string, behind = 0n): void => {
    put('helius', { type: 'offchain', key: RAW.holders(mint), value: { mint, slot: slot - behind, commitment: 'confirmed', supply: 1_000n, accounts: [] } });
  };
  /**
   * A holder read answered exactly `behind` slots before the slot it lands in (the feed's open slot), with one holder,
   * so it makes a holder fact released at its own moment: the mark is judged at the read's own slot.
   */
  const readLanding = (mint: string, behind: bigint): void => {
    const holder = { address: HOLDER, owner: OWNER, ownerProgram: null, amount: 500n, delegate: null, delegatedAmount: 0n };
    put('helius', { type: 'offchain', key: RAW.holders(mint), value: { mint, slot: feed.openSlot - behind, commitment: 'confirmed', supply: 1_000n, accounts: [holder] } });
  };
  /** A RugCheck answer (off-chain: no slot) the producer cannot use, so no fact follows it and the next event judges the mark. */
  const rugcheck = (mint: string): void => put('rugcheck', { type: 'offchain', key: RAW.rugcheck(mint), value: { mint, unreadable: true } });
  /** Moves the clock with no slot notice: the feed releases what it holds only after its stale-release wait. */
  const pause = (ms: number): void => {
    now += ms;
    feed.advance(now);
    engine.drain();
  };
  const evaluatedAt = (mint: string): number | null => strategy.candidates().get(mint)?.lastEvalMs ?? null;
  const start = (mints: readonly string[]): void => {
    put('worker', { type: 'fact', key: HALT_KEY, value: { halted: false, reasons: [] } });
    for (const m of mints) shortlist(m);
    tick(400);
  };
  return { feed, strategy, engine, frames, releases, session, config, trace, tick, read, readLanding, rugcheck, pause, evaluatedAt, start, now: () => now };
};

describe('a landed read is judged at once (FACTS-1b)', () => {
  it('a fresh read re-evaluates its candidate inside the cadence, once', () => {
    const w = world();
    w.start([M1]);
    const first = w.evaluatedAt(M1);
    expect(first).not.toBeNull();
    w.read(M1);
    w.tick(800);
    const again = w.evaluatedAt(M1)!;
    expect(again).toBeGreaterThan(first!);
    expect(again - first!).toBeLessThan(CADENCE);
    // Once per landed read: the ticks after it, still inside the cadence, bring no further evaluation.
    w.tick(400);
    expect(w.evaluatedAt(M1)).toBe(again);
  });

  it('without a read the candidate waits for the cadence', () => {
    const w = world();
    w.start([M1]);
    const first = w.evaluatedAt(M1)!;
    w.tick(1_200);
    expect(w.evaluatedAt(M1)).toBe(first);
    w.tick(CADENCE + 800);
    expect(w.evaluatedAt(M1)! - first).toBeGreaterThanOrEqual(CADENCE);
  });

  it('a read that landed older than the state lag marks nothing', () => {
    const w = world();
    w.start([M1]);
    const first = w.evaluatedAt(M1)!;
    w.read(M1, BigInt(TRIAL_POLICY.gates.maxStateSlotLag) + 5n);
    w.tick(800);
    expect(w.evaluatedAt(M1)).toBe(first);
  });

  it('the slot-lag edge: a read exactly the state lag behind marks, one slot more does not', () => {
    const at = world();
    at.start([M1]);
    const first = at.evaluatedAt(M1)!;
    at.readLanding(M1, LAG);
    at.tick(800);
    expect(at.evaluatedAt(M1)! - first).toBeGreaterThan(0);
    expect(at.evaluatedAt(M1)! - first).toBeLessThan(CADENCE);

    const past = world();
    past.start([M1]);
    const was = past.evaluatedAt(M1)!;
    past.readLanding(M1, LAG + 1n);
    past.tick(800);
    expect(past.evaluatedAt(M1)).toBe(was);
  });

  it('an off-chain read (no slot) that has aged past the quote age by the next event re-evaluates nothing', () => {
    // A cadence slower than the quote age, as the policy allows: only then can a mark outlive its read.
    const slow = 10_000;
    const late = world({ evaluateEveryMs: slow });
    late.start([M1]);
    const first = late.evaluatedAt(M1)!;
    late.rugcheck(M1);
    // A quiet feed: the read is released by the stale-release wait, the next event comes 5 s after it.
    late.pause(5_000);
    late.tick(1_200);
    // The events after the read did reach the strategy, more than the quote age after the read's receipt.
    expect(late.trace.some((l) => l.startsWith(`${RAW.rugcheck(M1)}#`))).toBe(true);
    expect(late.trace.at(-1)!.startsWith('slot:')).toBe(true);
    expect(late.evaluatedAt(M1)).toBe(first);

    // The same read followed by an event inside the quote age does re-evaluate.
    const soon = world({ evaluateEveryMs: slow });
    soon.start([M1]);
    const was = soon.evaluatedAt(M1)!;
    soon.rugcheck(M1);
    soon.tick(1_200);
    expect(soon.evaluatedAt(M1)! - was).toBeGreaterThan(0);
    expect(soon.evaluatedAt(M1)! - was).toBeLessThan(slow);
  });

  it('the quote-age edge: the next event exactly the quote age after an off-chain read re-evaluates, 1 ms later does not', () => {
    /** The read, a quiet wait, then slot notices: the first event after the read lands `wait` + 400 ms after it. */
    const edge = (wait: number): boolean => {
      const w = world({ evaluateEveryMs: 10_000 });
      w.start([M1]);
      const first = w.evaluatedAt(M1)!;
      w.rugcheck(M1);
      w.pause(wait);
      w.tick(1_600);
      return w.evaluatedAt(M1) !== first;
    };
    expect(edge(CADENCE - 400)).toBe(true);
    expect(edge(CADENCE - 399)).toBe(false);
  });

  it('only the read\'s own candidate is re-evaluated', () => {
    const w = world();
    w.start([M1, M2]);
    const m2 = w.evaluatedAt(M2)!;
    w.read(M1);
    w.tick(800);
    expect(w.evaluatedAt(M1)! - m2).toBeLessThan(CADENCE);
    expect(w.evaluatedAt(M1)).not.toBe(m2);
    expect(w.evaluatedAt(M2)).toBe(m2);
  });

  it('a read for a mint that is not a candidate marks nothing', () => {
    const w = world();
    w.start([M1]);
    const first = w.evaluatedAt(M1)!;
    w.read(M2);
    w.tick(800);
    expect(w.evaluatedAt(M1)).toBe(first);
  });

  it('the replay re-evaluates at the same release position: the recorded decisions reproduce exactly', () => {
    const w = world();
    w.start([M1, M2]);
    const first = w.evaluatedAt(M1)!;
    w.read(M1);
    w.tick(800);
    // Live re-evaluated M1 on its read, inside the cadence.
    const landed = w.evaluatedAt(M1)!;
    expect(landed - first).toBeGreaterThan(0);
    expect(landed - first).toBeLessThan(CADENCE);
    w.read(M2, 50n);
    w.tick(2_400);
    const decisions = (records: readonly LogRecord[]) => records.flatMap((r) => (r.type === 'decision' ? [{ event: r.eventId, reasons: r.reasons, result: r.result }] : []));
    const live = decisions(w.engine.records as readonly LogRecord[]);
    expect(live.some((d) => d.reasons[0] === 'reject')).toBe(true);
    const { clock, feed } = replayRecorded(w.frames, w.releases);
    const strategy = new LiveStrategy({ session: w.session, rugs: RUG_CONFIG, config: w.config });
    const trace: string[] = [];
    const engine = new Engine({ clock, feed: engineFeed(feed, w.session.policy).feed, strategy: traced(strategy, trace), runner: { run: () => undefined }, seed: 'landing', book: { maxOpenPositions: w.session.policy.positions.maxOpen } });
    engine.drain();
    expect(decisions(engine.records as readonly LogRecord[])).toEqual(live);
    // Every evaluation, the read-driven one included, falls on the same event in the replay.
    expect(trace).toEqual(w.trace);
  });
});

describe('a landed read changes the decision (FACTS-1e)', () => {
  /**
   * The passing coin with an unusable holder fact, ticked until an evaluation just happened (so the next cadence
   * evaluation is a full window away). Then the good holder fact again and, with `read`, any read of the mint landing.
   * Returns whether the coin was entered within 1.2 s (the read is released two slots later), inside the cadence.
   */
  const enteredSoon = async (read: boolean): Promise<boolean> => {
    const h = makeWorker();
    await h.worker.reconcile();
    const m = await passingMarket(h);
    const bad = () => {
      m.slot();
      m.pool();
      m.fact(holdersKey(MINT_H), { unreadable: true });
    };
    await m.run(3_000, 100, bad);
    const evaluated = () => h.worker.strategy.candidates().get(MINT_H)?.lastEvalMs ?? null;
    let was = evaluated();
    for (let k = 0; k < 100; k++) {
      await m.run(100, 100, bad);
      if (evaluated() !== was) break;
      was = evaluated();
    }
    expect(entered(h.stateDir)).toBe(false);
    m.slot();
    m.pool();
    // A read of the mint the producer cannot use: it makes no fact, but it lands, so it marks the candidate.
    if (read) m.offchain(RAW.sim(MINT_H), { mint: MINT_H, unreadable: true });
    await m.run(1_200, 100, () => m.slot());
    const out = entered(h.stateDir);
    await h.worker.stop();
    return out;
  };
  const entered = (dir: string): boolean =>
    readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n').some((l) => l.includes('"reasons":["enter"'));

  it('with the read the coin is entered at once; without it the entry waits for the next cadence evaluation', async () => {
    expect(await enteredSoon(true)).toBe(true);
    expect(await enteredSoon(false)).toBe(false);
  });
});
