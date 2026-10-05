// WORKER-HARDEN, SAVE-ASOF: a save is never refused for an in-order run of events. Moments order by slot first, and
// receipt times need not follow (a lower-slot frame can arrive after a higher-slot one, both held for confirmation): a
// candidate evaluated on an event received later than the save's moment (the last event's) made state.ts refuse the
// whole save, at every turn until a later event came. The save treats the evaluation as it treats fee terms received
// after its moment (FEES-KEEP): never after the moment.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG } from '../../core/src/config/rugs.ts';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY, startSession } from '../../core/src/config/index.ts';
import type { StrategyContext } from '../../core/src/engine/index.ts';
import { emptyBook } from '../../core/src/lifecycle/index.ts';
import { HALT_KEY, LiveStrategy, RESTORE_KEY, SEED_KEY } from '../src/engine/strategy.ts';
import { strategyConfig } from '../src/run/settings.ts';
import { loadState, saveState } from '../src/persist/index.ts';
import { MIGRATED_AT, MINT, POOL_ADDRESS, SLOT, tempState } from './worker-harness.ts';

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
});
