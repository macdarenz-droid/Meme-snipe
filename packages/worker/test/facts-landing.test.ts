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
import { blockNetwork } from './helpers.ts';

blockNetwork();

const M1 = 'HAcEqEVru6dRbe1grLFTPBxjxGgjn1tVpR7bLgYXdust';
const M2 = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const T0 = Date.UTC(2026, 9, 3, 12, 0);
const S0 = 400_000_000n;
const MIN = 60_000;
const CADENCE = TRIAL_POLICY.gates.maxQuoteAgeMs;

/** Wraps the strategy so every event leaves a line: its id and when each candidate was last evaluated. */
const traced = (inner: LiveStrategy, trace: string[]): Strategy => ({
  onMarket: (e, ctx) => {
    const out = inner.onMarket(e, ctx);
    trace.push(`${e.id} ${[...inner.candidates()].map(([m, c]) => `${m.slice(0, 4)}=${c.lastEvalMs}`).join(' ')}`);
    return out;
  },
});

const world = () => {
  const session = startSession(TRIAL_POLICY);
  const config = strategyConfig(session.policy, FILL_CONFIG, RESEARCH_CONFIG, 0n, { timing: 'gates', salt: '' });
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
  const evaluatedAt = (mint: string): number | null => strategy.candidates().get(mint)?.lastEvalMs ?? null;
  const start = (mints: readonly string[]): void => {
    put('worker', { type: 'fact', key: HALT_KEY, value: { halted: false, reasons: [] } });
    for (const m of mints) shortlist(m);
    tick(400);
  };
  return { feed, strategy, engine, frames, releases, session, config, trace, tick, read, evaluatedAt, start, now: () => now };
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
