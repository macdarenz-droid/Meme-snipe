// WORKER-HARDEN, SAVE-ASOF: a save is never refused for an in-order run of events. Moments order by slot first, and
// receipt times need not follow (a lower-slot frame can arrive after a higher-slot one, both held for confirmation): a
// candidate evaluated on an event received later than the save's moment (the last event's) made state.ts refuse the
// whole save, at every turn until a later event came. The save treats the evaluation as it treats fee terms received
// after its moment (FEES-KEEP): never after the moment.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG } from '../../core/src/config/rugs.ts';
import { AsOfClamp, DeployerIndex } from '../../core/src/gates/index.ts';
import type { MarketEvent, Moment } from '../../core/src/engine/index.ts';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY, startSession } from '../../core/src/config/index.ts';
import type { StrategyContext } from '../../core/src/engine/index.ts';
import { emptyBook } from '../../core/src/lifecycle/index.ts';
import { HALT_KEY, LiveStrategy, RESTORE_KEY, SEED_KEY } from '../src/engine/strategy.ts';
import { strategyConfig } from '../src/run/settings.ts';
import { loadState, saveState } from '../src/persist/index.ts';
import { DEV, MIGRATED_AT, MINT, Market, POOL_ADDRESS, SLOT, dueTimers, makeWorker, slotAt, tempState } from './worker-harness.ts';
import { CLAMP_LOG_MS, PERSIST_EVERY_MS, PERSIST_FILE, clampNote } from '../src/run/worker.ts';
import { CHAIN_SKEW_MS } from '../../core/src/config/index.ts';
import { TX_CREATE_PREFIX } from '../../core/src/gates/index.ts';
import { existsSync, readFileSync } from 'node:fs';

const RESTORED = MIGRATED_AT + 30 * 60_000;
/** Inside the candidate's window (U2: 60 to 240 minutes after the migration). */
const IN_WINDOW = MIGRATED_AT + 90 * 60_000;
const SIGNATURES = { create: null, complete: null, migration: null };
const at = (slot: bigint, ms: number) => ({ slot, txIndex: 0, ixIndex: 0, receivedAt: ms });

/** The strategy alone, restored with one candidate at RESTORED and its seed applied; entries are not halted. */
const restored = (candidate: Record<string, unknown>) => {
  const session = startSession(TRIAL_POLICY);
  const strategy = new LiveStrategy({ session, rugs: RUG_CONFIG, config: strategyConfig(session.policy, FILL_CONFIG, RESEARCH_CONFIG) });
  const ctx = (ms: number, slot = SLOT) => ({
    now: at(slot, ms), book: emptyBook({ maxOpenPositions: session.policy.positions.maxOpen }), rng: { next: () => 0 },
    lookup: (k: string) => (k === HALT_KEY ? { ok: true, value: { halted: false, reasons: [] }, moment: at(slot, ms), source: 'halt' } : { ok: false, reason: 'missing' }), history: () => [],
  } as unknown as StrategyContext);
  const out = strategy.onMarket({ kind: 'market', id: 'restore', moment: at(SLOT, RESTORED), key: RESTORE_KEY, value: { exits: {}, candidates: [candidate] } }, ctx(RESTORED));
  strategy.onMarket({ kind: 'market', id: 'seed', moment: at(SLOT, RESTORED), key: SEED_KEY, value: {} }, ctx(RESTORED));
  const event = (id: string, slot: bigint, ms: number) => strategy.onMarket({ kind: 'market', id, moment: at(slot, ms), key: 'chain:slot', value: { slot } }, ctx(ms, slot));
  return { strategy, out, event };
};
const CANDIDATE = { mint: MINT, pool: POOL_ADDRESS, migratedAtMs: MIGRATED_AT, migrationSlot: SLOT - 15_000n, tries: 0, lastEvalMs: RESTORED - 60_000, lastReason: null, bars: [], fees: null };

/** The worker's save of the strategy's state (worker.ts #persist: each candidate with its transactions). */
const save = (s: LiveStrategy) => {
  const p = s.persistable(0)!;
  const path = join(tempState(), 'deployer-state.json');
  saveState(path, { ...p.state, candidates: p.state.candidates.map((c) => ({ ...c, signatures: SIGNATURES })) }, { mintRows: p.mintRows });
  return { state: p.state, path };
};

describe('SAVE-ASOF', () => {
  it('a candidate evaluated on an event received after the save\'s moment is saved as at that moment, and the save is written and restores', () => {
    const r = restored(CANDIDATE);
    // Slot +1, received 4 s after the slot +2 event that follows it in moment order (and is the save's moment).
    r.event('late', SLOT + 1n, IN_WINDOW + 4_000);
    expect(r.strategy.candidates().get(MINT)!.lastEvalMs).toBe(IN_WINDOW + 4_000);
    r.event('next', SLOT + 2n, IN_WINDOW);
    const { state, path } = save(r.strategy);
    expect(state.asOf.receivedAt).toBe(IN_WINDOW);
    expect(state.candidates.find((c) => c.mint === MINT)!.lastEvalMs).toBe(IN_WINDOW);
    const back = loadState(path, RUG_CONFIG);
    expect(back.ok ? 'ok' : back.reason).toBe('ok');
  });

  it('with no candidate, the deployer index\'s first and last moments received after the save\'s moment still restore', () => {
    const session = startSession(TRIAL_POLICY);
    const strategy = new LiveStrategy({ session, rugs: RUG_CONFIG, config: strategyConfig(session.policy, FILL_CONFIG, RESEARCH_CONFIG) });
    const ctx = (ms: number, slot: bigint) => ({ now: at(slot, ms), book: emptyBook({ maxOpenPositions: session.policy.positions.maxOpen }), rng: { next: () => 0 }, lookup: () => ({ ok: false, reason: 'missing' }), history: () => [] } as unknown as StrategyContext);
    strategy.onMarket({ kind: 'market', id: 'seed', moment: at(SLOT, RESTORED), key: SEED_KEY, value: {} }, ctx(RESTORED, SLOT));
    strategy.onMarket({ kind: 'market', id: 'late', moment: at(SLOT + 1n, IN_WINDOW + 4_000), key: 'chain:slot', value: { slot: SLOT + 1n } }, ctx(IN_WINDOW + 4_000, SLOT + 1n));
    strategy.onMarket({ kind: 'market', id: 'next', moment: at(SLOT + 2n, IN_WINDOW), key: 'worker:account', value: {} }, ctx(IN_WINDOW, SLOT + 2n));
    const { state, path } = save(strategy);
    expect(state.index.last!.receivedAt).toBe(IN_WINDOW);
    const back = loadState(path, RUG_CONFIG);
    expect(back.ok ? 'ok' : back.reason).toBe('ok');
  });

  it('an evaluation at or before the save\'s moment is saved as it was', () => {
    const r = restored(CANDIDATE);
    r.event('first', SLOT + 1n, IN_WINDOW);
    // A millisecond later: within the evaluation interval, so no evaluation on it.
    r.event('next', SLOT + 2n, IN_WINDOW + 1);
    expect(save(r.strategy).state.candidates.find((c) => c.mint === MINT)!.lastEvalMs).toBe(IN_WINDOW);
  });

  it('a candidate truly after the moment is still refused: by the save\'s own check and on restore', () => {
    const r = restored(CANDIDATE);
    r.event('next', SLOT + 1n, IN_WINDOW);
    const p = r.strategy.persistable(0)!;
    const future = p.state.candidates.map((c) => ({ ...c, lastEvalMs: p.state.asOf.receivedAt + 1, signatures: SIGNATURES }));
    expect(() => saveState(join(tempState(), 'deployer-state.json'), { ...p.state, candidates: future }, { mintRows: p.mintRows })).toThrow(/is dated after the snapshot moment/);
    const late = restored({ ...CANDIDATE, lastEvalMs: RESTORED + 1 });
    expect(late.out).toContainEqual({ action: null, reasons: ['candidates refused', 'a saved candidate is dated after the restore'] });
  });

  // Persist review (S1), items 1, 2 and 4.
  const createEvent = (mint: string, createdAtMs: number, slot: bigint) => ({
    event: { name: 'CreateEvent', program: 'pump', data: { mint, creator: 'Dev1111', timestamp: BigInt(createdAtMs / 1_000), name: 'x', symbol: 'x', uri: '' } },
    signature: `sig-${mint}`, txSlot: slot, truncated: false, via: 'logs:pump', source: 'helius', backfilled: false, seq: 1,
  });
  const market = (key: string, value: unknown, moment: Moment): MarketEvent => ({ kind: 'market', id: key, moment, key, value });

  it('labels received after the moment keep their exact receipt time and restore, checked by moment; the first moment and mint rows are saved as at it, slot, transaction and instruction kept', () => {
    const idx = new DeployerIndex();
    const rug = { slot: SLOT + 1n, txIndex: 3, ixIndex: 1, receivedAt: IN_WINDOW + 4_000 };
    const unjudged = { slot: SLOT + 1n, txIndex: 4, ixIndex: 2, receivedAt: IN_WINDOW + 4_500 };
    const asOf = { slot: SLOT + 2n, txIndex: 1, ixIndex: 0, receivedAt: IN_WINDOW + 1_000 };
    idx.observe(market('rug:R', { mint: 'R', creator: 'Dev1111', rule: 'dump' }, rug));
    idx.observe(market('rug-unjudged:U', { mint: 'U', creator: 'Dev1111' }, unjudged));
    // A create whose chain block time is 5 s after the moment's receipt time.
    idx.observe(market('logs:pump:CreateEvent:M', createEvent('M', IN_WINDOW + 6_000, SLOT + 2n), asOf));
    const clamp = new AsOfClamp(asOf.receivedAt);
    const saved = idx.snapshot(asOf, Number.MIN_SAFE_INTEGER, { clamp });
    expect(saved.first).toEqual({ ...rug, receivedAt: asOf.receivedAt });
    expect(saved.last).toEqual(asOf);
    // Facts review B1: never clamped (H14 counts a prior rug by its receipt time).
    expect(saved.rugs).toEqual([['Dev1111', [['R', { at: rug, kind: 'dump' }]]]]);
    expect(saved.unjudged).toEqual([['Dev1111', [['U', { at: unjudged, kind: null }]]]]);
    expect(saved.mints).toEqual([['Dev1111', [['M', asOf.receivedAt]]]]);
    // Before: restore refused the labels ('an entry is dated after the snapshot moment') and the save was discarded.
    const back = DeployerIndex.restore(saved);
    expect(back.snapshot(asOf)).toEqual(saved);
    // The look-back edge reads exactly as before the restart: the same labels with the same receipt times.
    const edge = { ...asOf, receivedAt: rug.receivedAt };
    for (const now of [asOf, edge]) expect(back.factFor('Dev1111', now, 0)).toMatchObject({ rugs: idx.factFor('Dev1111', now, 0).rugs, unjudged: idx.factFor('Dev1111', now, 0).unjudged });
    expect(back.factFor('Dev1111', edge, 0).rugs).toEqual([expect.objectContaining({ mint: 'R', knownAtMs: rug.receivedAt })]);
    // Item 5: each clamp counted (first, one mint row) with the largest.
    expect([clamp.count, clamp.maxMs]).toEqual([2, 5_000]);
  });

  it('a label after the save\'s moment in the engine\'s order (a later slot, or its own slot at a later transaction or instruction), or received more than 60 s after it, is refused on restore', () => {
    const idx = new DeployerIndex();
    const asOf = { slot: SLOT + 2n, txIndex: 1, ixIndex: 1, receivedAt: IN_WINDOW + 1_000 };
    idx.observe(market('logs:pump:CreateEvent:M', createEvent('M', IN_WINDOW, SLOT + 2n), asOf));
    const saved = idx.snapshot(asOf);
    const withLabel = (table: 'rugs' | 'unjudged', at: Moment) => ({ ...saved, [table]: [['Dev1111', [['R', { at, kind: null }]]]] });
    for (const table of ['rugs', 'unjudged'] as const) {
      // Received before the moment, but after it in the engine's order: future.
      for (const at of [{ slot: SLOT + 3n, txIndex: 0, ixIndex: 0 }, { slot: SLOT + 2n, txIndex: 2, ixIndex: 0 }, { slot: SLOT + 2n, txIndex: 1, ixIndex: 2 }]) {
        expect(() => DeployerIndex.restore(withLabel(table, { ...at, receivedAt: IN_WINDOW })), `${table} ${at.slot}/${at.txIndex}/${at.ixIndex}`).toThrow(/dated after the snapshot moment/);
      }
      // Its own slot, the moment itself: restores.
      expect(() => DeployerIndex.restore(withLabel(table, { ...asOf, receivedAt: IN_WINDOW }))).not.toThrow();
      // An earlier slot, received just under and just over CHAIN_SKEW_MS after the moment.
      const early = { slot: SLOT + 1n, txIndex: 0, ixIndex: 0 };
      const ok = DeployerIndex.restore(withLabel(table, { ...early, receivedAt: asOf.receivedAt + CHAIN_SKEW_MS }));
      expect(ok.snapshot(asOf)[table]).toEqual([['Dev1111', [['R', { at: { ...early, receivedAt: asOf.receivedAt + CHAIN_SKEW_MS }, kind: null }]]]]);
      expect(() => DeployerIndex.restore(withLabel(table, { ...early, receivedAt: asOf.receivedAt + CHAIN_SKEW_MS + 1 })), table).toThrow(/dated after the snapshot moment/);
    }
  });

  it('a clamp is capped at CHAIN_SKEW_MS: just under is saved as at the moment, just over refuses the save with its reason', () => {
    const c = new AsOfClamp(IN_WINDOW);
    expect(c.ms(IN_WINDOW + CHAIN_SKEW_MS)).toBe(IN_WINDOW);
    expect(() => c.ms(IN_WINDOW + CHAIN_SKEW_MS + 1)).toThrow(/more than the 60000 ms of clock skew allowed/);
    // Through the save: an evaluation received 61 s after the moment refuses the whole save (as before SAVE-ASOF).
    const r = restored(CANDIDATE);
    r.event('late', SLOT + 1n, IN_WINDOW + CHAIN_SKEW_MS + 1_000);
    r.event('next', SLOT + 2n, IN_WINDOW);
    expect(() => r.strategy.persistable(0)).toThrow(/clock skew allowed/);
    const ok = restored(CANDIDATE);
    ok.event('late', SLOT + 1n, IN_WINDOW + CHAIN_SKEW_MS - 1_000);
    ok.event('next', SLOT + 2n, IN_WINDOW);
    expect(ok.strategy.persistable(0)!.clamp.maxMs).toBe(CHAIN_SKEW_MS - 1_000);
  });

  it('the log line is written for a largest clamp over 10 s only (9 s: none; 11 s: logged)', () => {
    expect(clampNote({ count: 3, maxMs: 9_000 })).toBeNull();
    expect(clampNote({ count: 3, maxMs: CLAMP_LOG_MS })).toBeNull();
    expect(clampNote({ count: 3, maxMs: 11_000 })).toBe("Saved state: 3 times dated after the save's moment were saved as at it, the latest 11.0 s after.");
  });

  it('a create, a launch and a migration dated by chain time 5 s after the moment, and a coverage fact received after it, are saved as at the moment and restore', () => {
    const r = restored(CANDIDATE);
    const late = IN_WINDOW + 4_000;
    // Slot +1, received after the slot +2 event that is the save's moment: a coverage fact and a create whose block
    // time is 5 s after the moment's receipt time (the launch of the rug labeller comes from the same create).
    r.strategy.onMarket(market('coverage:creates:resume', { value: { fromSlot: SLOT, toSlot: SLOT + 1n, via: 'logs:pump' }, source: 'worker', backfilled: false, seq: 1 }, { slot: SLOT + 1n, txIndex: 2, ixIndex: 0, receivedAt: late }), { now: at(SLOT + 1n, late), book: emptyBook({ maxOpenPositions: 3 }), rng: { next: () => 0 }, lookup: () => ({ ok: false, reason: 'missing' }), history: () => [] } as unknown as StrategyContext);
    r.strategy.onMarket(market('logs:pump:CreateEvent:M', createEvent('M', IN_WINDOW + 5_000, SLOT + 1n), { slot: SLOT + 1n, txIndex: 3, ixIndex: 0, receivedAt: late }), { now: at(SLOT + 1n, late), book: emptyBook({ maxOpenPositions: 3 }), rng: { next: () => 0 }, lookup: () => ({ ok: false, reason: 'missing' }), history: () => [] } as unknown as StrategyContext);
    r.event('next', SLOT + 2n, IN_WINDOW);
    const p = r.strategy.persistable(0)!;
    const { state, path } = save(r.strategy);
    expect(state.asOf.receivedAt).toBe(IN_WINDOW);
    const cov = state.coverage.find((e) => e.key === 'coverage:creates:resume')!;
    expect(cov.moment).toEqual({ slot: SLOT + 1n, txIndex: 2, ixIndex: 0, receivedAt: IN_WINDOW });
    expect(state.labeller.launches.find((l) => l.mint === 'M')!.createdAtMs).toBe(IN_WINDOW);
    expect(p.clamp.maxMs).toBe(5_000);
    const back = loadState(path, RUG_CONFIG);
    expect(back.ok ? 'ok' : back.reason).toBe('ok');
  });

  it('a candidate whose migration\'s chain time is after the moment is saved as at the moment, not left out', () => {
    // Migrated (by its block time) 5 s after the save's moment, which is the restore event's (RESTORED).
    const r = restored({ ...CANDIDATE, migratedAtMs: RESTORED });
    r.event('next', SLOT + 1n, RESTORED - 5_000 + 1);
    const saved = save(r.strategy);
    // persistable's own moment check: the event at slot +1 is the moment, received before the migration's block time.
    expect(saved.state.asOf.receivedAt).toBe(RESTORED - 5_000 + 1);
    expect(saved.state.candidates.map((c) => [c.mint, c.migratedAtMs])).toEqual([[MINT, RESTORED - 5_000 + 1]]);
    const back = loadState(saved.path, RUG_CONFIG);
    expect(back.ok ? 'ok' : back.reason).toBe('ok');
  });

  it('the worker refuses a save holding a time more than 60 s after its moment, logs the reason and keeps the last file', async () => {
    const stateDir = tempState();
    const timers = dueTimers(MIGRATED_AT);
    const h = makeWorker({ stateDir, timers, seed: async () => ({ mode: 'none', creates: [], coverage: [], report: 'test' }) });
    const m = new Market(h);
    const started = h.worker.start();
    for (let k = 0; k < 200 && !h.order.includes('start helius-ws'); k++) {
      timers.set(timers.now() + 100);
      await new Promise<void>((r) => setImmediate(r));
    }
    m.slot();
    m.offchain('coverage:creates:start', { fromSlot: slotAt(m.now), via: 'logs:pump' });
    await m.run(PERSIST_EVERY_MS + 60_000, 30_000, () => m.slot());
    expect(await started).toEqual({ ok: true });
    const path = join(stateDir, PERSIST_FILE);
    expect(existsSync(path)).toBe(true);
    const before = readFileSync(path, 'utf8');
    // A create whose chain time is an hour ahead: no clock is that far off.
    const ahead = timers.now() + 3_600_000;
    m.fact(`${TX_CREATE_PREFIX}Future1111`, { event: { program: 'pump', name: 'CreateEvent', data: { mint: 'Future1111', creator: DEV, user: DEV, timestamp: BigInt(Math.floor(ahead / 1000)), tokenTotalSupply: 1_000_000_000_000_000n } }, signature: 'create-future' });
    await m.run(PERSIST_EVERY_MS + 60_000, 30_000, () => m.slot());
    expect(h.logs.filter((l) => l.startsWith('Saved state not written') && !l.endsWith('the seed is not applied yet.'))).toEqual(expect.arrayContaining([expect.stringMatching(/^Saved state not written: a saved time is \d+ ms after the save's moment, more than the 60000 ms of clock skew allowed\.$/)]));
    expect(readFileSync(path, 'utf8')).toBe(before);
    await h.worker.kill();
  }, 60_000);
});
