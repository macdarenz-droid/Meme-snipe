// FEES-KEEP: a restart keeps each candidate's fee terms (the latest swap's, as it reported them), so a restored coin
// with no swap since the restart is still priced and judged past #market. POOL-DATA: #market's cases have typed codes.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUG_CONFIG } from '../../core/src/config/rugs.ts';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY, startSession } from '../../core/src/config/index.ts';
import type { StrategyContext } from '../../core/src/engine/index.ts';
import { emptyBook } from '../../core/src/lifecycle/index.ts';
import { observedFeeContext } from '../../core/src/fills/index.ts';
import { bps } from '../../core/src/units/index.ts';
import { poolKey, rugCheckKey, simKey } from '../../core/src/gates/index.ts';
import { FEE_CONTEXT, passingFacts } from '../../core/test/gates/world.ts';
import { swapLog } from '../../core/test/facts/swaps.ts';
import type { PoolState } from '../../core/src/amm/index.ts';
import { LiveStrategy, MARKET_MISS_CODES, RESTORE_KEY, SEED_KEY, marketMissCode } from '../src/engine/strategy.ts';
import { strategyConfig } from '../src/run/settings.ts';
import { loadState, saveState } from '../src/persist/index.ts';
import { runSeed } from '../src/run/seed-start.ts';
import { PERSIST_FILE, type SeedRequest } from '../src/run/worker.ts';
import { DEV, MIGRATED_AT, MINT, Market, POOL_ADDRESS, SLOT, SUPPLY, T, dueTimers, makeWorker, passingMarket, slotAt, tempState, virtualTimers } from './worker-harness.ts';

const emptyRpc = { getSignaturesForAddress: async () => [{ signature: 'before-the-range', slot: 0n, err: null, blockTime: 0 }], getTransaction: async () => null };
const CREATES_VIA = ((passingFacts().get('coverage:creates:start')!.value as { value: { via: string } }).value).via;
type H = ReturnType<typeof makeWorker>;
const journal = (dir: string) => readFileSync(join(dir, 'journal.jsonl'), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Record<string, unknown>);
const decisions = (h: H) => journal(h.stateDir).filter((l) => l['boot'] === h.worker.boot && l['kind'] === 'decision').map((l) => (l['reasons'] as string[]) ?? []);
let port = 18_900;

const NOW = MIGRATED_AT + 30 * 60_000;
/** Saved terms of a v2 buy, with the pool its swap left. */
const LEFT: PoolState = { baseReserve: 700_000_000_000_000n, quoteVault: 80_000_000_000n, virtualQuoteReserves: 5_000_000_000n };
const TERMS = { atMs: NOW - 120_000, lp: 2, protocol: 93, creator: 30, buyback: 5_000, instruction: 'v2' as const, baseSupply: SUPPLY, after: { base: LEFT.baseReserve, quote: LEFT.quoteVault + LEFT.virtualQuoteReserves } };
const GOOD = { mint: MINT, pool: POOL_ADDRESS, migratedAtMs: MIGRATED_AT, migrationSlot: SLOT - 15_000n, tries: 2, lastEvalMs: NOW - 60_000, lastReason: 'H11 missing', bars: [], fees: TERMS };

/** The strategy alone, given a restore fact at NOW with these saved candidates. */
const restoreInto = (candidates: unknown[]) => {
  const session = startSession(TRIAL_POLICY);
  const strategy = new LiveStrategy({ session, rugs: RUG_CONFIG, config: strategyConfig(session.policy, FILL_CONFIG, RESEARCH_CONFIG) });
  const moment = { slot: SLOT, txIndex: 0, ixIndex: 0, receivedAt: NOW };
  const ctx = { now: moment, book: emptyBook({ maxOpenPositions: session.policy.positions.maxOpen }), rng: { next: () => 0 }, lookup: () => ({ ok: false, reason: 'missing' }), history: () => [] } as unknown as StrategyContext;
  const out = strategy.onMarket({ kind: 'market', id: 'restore', moment, key: RESTORE_KEY, value: { exits: {}, candidates } }, ctx);
  return { strategy, out };
};

describe('FEES-KEEP: the saved fee terms come back with the candidate', () => {
  it('restores the fee context the live swap built (the same observedFeeContext from the same terms), for the pool it left', () => {
    const s = restoreInto([GOOD]);
    expect(s.strategy.candidates().has(MINT)).toBe(true);
    expect(s.strategy.observedFees(MINT, LEFT)).toEqual(observedFeeContext(
      { split: { lp: bps(2), protocol: bps(93), creator: bps(30) }, buybackFeeBps: bps(5_000), instruction: 'v2' }, SUPPLY, { mayhemMode: false, transferFee: false, transferHook: false },
    ));
    // The same effective quote split differently between vault and virtual is the same pool (price and tier alike).
    expect(s.strategy.observedFees(MINT, { ...LEFT, quoteVault: LEFT.quoteVault + 1n, virtualQuoteReserves: LEFT.virtualQuoteReserves - 1n })).toBeDefined();
  });

  it.each([
    ['no pool given', null],
    ['one more base token', { ...LEFT, baseReserve: LEFT.baseReserve + 1n }],
    ['one more lamport of quote', { ...LEFT, quoteVault: LEFT.quoteVault + 1n }],
  ])('restored terms price no other pool (%s): a swap missed in the downtime may have crossed a tier', (_, pool) => {
    const s = restoreInto([GOOD]);
    expect(s.strategy.observedFees(MINT, pool)).toBeUndefined();
  });

  it.each([
    ['absent (a save from before FEES-KEEP)', undefined],
    ['null', null],
    ['a rate over 10,000 bps', { ...TERMS, lp: 10_001 }],
    ['a negative lp rate', { ...TERMS, lp: -5 }],
    ['a negative creator rate', { ...TERMS, creator: -1 }],
    ['a negative buyback rate', { ...TERMS, buyback: -1 }],
    ['a rate not a whole number', { ...TERMS, protocol: 9.5 }],
    ['an unknown instruction', { ...TERMS, instruction: 'v3' }],
    ['a supply not a bigint', { ...TERMS, baseSupply: 1_000 }],
    ['a zero supply', { ...TERMS, baseSupply: 0n }],
    ['no receipt time', { ...TERMS, atMs: undefined }],
    ['no pool it left (a save from before the reserves check)', { ...TERMS, after: undefined }],
    ['a zero reserve in the pool it left', { ...TERMS, after: { ...TERMS.after, base: 0n } }],
    ['a quote reserve not a bigint', { ...TERMS, after: { ...TERMS.after, quote: 5 } }],
  ])('fee terms %s restore as none: the candidate comes back, unpriced as today (fail closed)', (_, fees) => {
    const { fees: _f, ...rest } = GOOD;
    const s = restoreInto([fees === undefined ? rest : { ...rest, fees }]);
    expect(s.strategy.candidates().has(MINT)).toBe(true);
    expect(s.strategy.observedFees(MINT, LEFT)).toBeUndefined();
  });

  it('fee terms received after the restore moment refuse the saved candidates whole, as a bar would', () => {
    const s = restoreInto([GOOD, { ...GOOD, mint: 'other-mint', fees: { ...TERMS, atMs: NOW + 1 } }]);
    expect(s.out).toContainEqual({ action: null, reasons: ['candidates refused', 'a saved candidate is dated after the restore'] });
    expect(s.strategy.candidates().size).toBe(0);
    expect(s.strategy.observedFees(MINT, LEFT)).toBeUndefined();
  });

  it('a save leaves out fee terms received after its moment (moments order by slot first, receipt times need not follow)', () => {
    const s = restoreInto([GOOD]);
    const at = (slot: bigint, ms: number) => ({ slot, txIndex: 0, ixIndex: 0, receivedAt: ms });
    const ctx = (ms: number) => ({ now: at(SLOT, ms), book: emptyBook({ maxOpenPositions: TRIAL_POLICY.positions.maxOpen }), rng: { next: () => 0 }, lookup: () => ({ ok: false, reason: 'missing' }), history: () => [] } as unknown as StrategyContext);
    s.strategy.onMarket({ kind: 'market', id: 'seed', moment: at(SLOT, NOW), key: SEED_KEY, value: {} }, ctx(NOW));
    const saved = () => s.strategy.persistable(0)?.state.candidates.find((c) => c.mint === MINT)?.fees;
    expect(saved()).toEqual(TERMS);
    // A swap at the next slot, received at NOW + 5 s, then an event a slot later received at NOW + 1 s: the save's moment.
    const { data, after } = swapLog({ pool: POOL_ADDRESS, coinCreator: DEV, supply: SUPPLY, pre: LEFT, side: 'buy', base: LEFT.baseReserve / 500n, atMs: NOW + 5_000 });
    s.strategy.onMarket({ kind: 'market', id: 'swap', moment: at(SLOT + 1n, NOW + 5_000), key: `logs:pump_amm:BuyEvent:${POOL_ADDRESS}:1`, value: { event: { program: 'pump_amm', name: 'BuyEvent', data }, signature: 'swap-1' } }, ctx(NOW + 5_000));
    // A swap seen in this run prices any pool (the live rule) and is what a save keeps, with the pool it left.
    expect(s.strategy.observedFees(MINT)).toBeDefined();
    expect(saved()).toEqual(expect.objectContaining({ atMs: NOW + 5_000, after: { base: after.baseReserve, quote: after.quoteVault + after.virtualQuoteReserves } }));
    s.strategy.onMarket({ kind: 'market', id: 'later', moment: at(SLOT + 2n, NOW + 1_000), key: 'chain:slot', value: { slot: SLOT + 2n } }, ctx(NOW + 1_000));
    expect(s.strategy.persistable(0)?.state.asOf.receivedAt).toBe(NOW + 1_000);
    expect(saved()).toBeNull();
  });

  it.each([
    ['the pool its swap left: judged past #market (not unpriced)', true, false],
    ['a pool moved since (a downtime swap not seen): no-fee-context, never priced at the old tier', false, false],
    ['a pool moved since, with a fee-context fact (FEE-TIER-NOW\'s batch read): judged past #market at the read\'s tiers', false, true],
  ])('a restored candidate with a swap before the restart and none after, its pool fact at %s', async (_, same, feeFact) => {
    // A fresh host 16 days before T; the coin passes every gate at T but H15 (no simulation), so it is judged, never entered.
    const stateDir = tempState();
    const timers = virtualTimers(T - 16 * 86_400_000);
    const h = makeWorker({ stateDir, timers, seed: (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers }), config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port++}`, ZEROED_API_ADDR: `127.0.0.1:${port++}` } });
    const m0 = new Market(h);
    const started = h.worker.start();
    while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
    m0.slot();
    m0.offchain('coverage:creates:start', { fromSlot: slotAt(m0.now), via: CREATES_VIA });
    expect(await started).toEqual({ ok: true });
    // No fee-context fact: the terms come only from the swap seen on the pool.
    const m = await passingMarket(h, { fees: false, omit: [simKey(MINT)] });
    m.offchain('feed:status:helius', { state: 'up' });
    // A real buy on the pool as it stands (its event's reserves before; the replay gives the pool it leaves).
    const pre = h.worker.reservesOf(MINT)!;
    const { data, after } = swapLog({ pool: POOL_ADDRESS, coinCreator: DEV, supply: SUPPLY, pre, side: 'buy', base: pre.baseReserve / 500n, atMs: m.now });
    m.fact(`logs:pump_amm:BuyEvent:${POOL_ADDRESS}:1`, { event: { program: 'pump_amm', name: 'BuyEvent', data }, signature: 'swap-1' });
    await m.run(3_000, 400, () => m.pool());
    expect(h.worker.strategy.observedFees(MINT)).toBeDefined();
    await h.worker.stop();
    const st = loadState(join(stateDir, PERSIST_FILE), RUG_CONFIG);
    if (!st.ok) throw new Error(st.reason);
    expect(st.candidates.map((c) => [c.mint, c.fees])).toEqual([[MINT, expect.objectContaining({ lp: 2, protocol: 93, creator: 30, buyback: 5_000, instruction: 'v1', baseSupply: SUPPLY, after: { base: after.baseReserve, quote: after.quoteVault + after.virtualQuoteReserves } })]]);
    // The state file refuses fee terms dated after its moment, as it refuses such a bar.
    const later = st.candidates.map((c) => ({ ...c, fees: { ...c.fees!, atMs: st.asOf.receivedAt + 1 } }));
    expect(() => saveState(join(tempState(), PERSIST_FILE), { asOf: st.asOf, index: st.index.snapshot(st.asOf), labeller: st.labeller.snapshot(), coverage: st.coverage.filter((e) => !e.id.startsWith('persist:restart:')), candidates: later }))
      .toThrow(`candidate ${MINT} is dated after the snapshot moment`);

    // The restart: every fact again but no swap and no fee-context fact.
    const t2 = dueTimers(timers.now() + 30_000);
    const h2 = makeWorker({ stateDir, timers: t2, seed: (r) => runSeed(r, { rpc: emptyRpc, timers: t2 }), config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port++}`, ZEROED_API_ADDR: `127.0.0.1:${port++}` } });
    void h2.worker.start();
    const tick = async (): Promise<void> => {
      t2.set(t2.now() + 100);
      for (let k = 0; k < 4; k++) await new Promise<void>((r) => setImmediate(r));
    };
    for (let k = 0; k < 600 && !h2.order.includes('start helius-ws'); k++) await tick();
    const m2 = new Market(h2);
    m2.withFees = feeFact;
    m2.omit = new Set([simKey(MINT)]);
    // The pool fact at the reserves the swap left, or at the passing pool's (which the swap moved away from).
    m2.poolAt = same ? after : null;
    m2.slot();
    m2.offchain('coverage:creates:start', { fromSlot: slotAt(m2.now), via: CREATES_VIA });
    m2.offchain('feed:status:helius', { state: 'up' });
    expect(decisions(h2).some((r) => r[0] === 'candidate restored' && r[2] === MINT)).toBe(true);
    // Judged after the restore (a reject line is written only when its reason changes, so its last reasons are read).
    const judged = () => {
      const c = h2.worker.strategy.candidates().get(MINT);
      return c !== undefined && c.gates !== null && c.lastEvalMs !== null && c.lastEvalMs > restoredAt;
    };
    const restoredAt = t2.now();
    for (let k = 0; k < 300 && !judged(); k++) {
      m2.slot();
      if (k % 10 === 0) for (const [key, { value }] of passingFacts()) if (!key.startsWith('coverage:') && key !== poolKey(MINT)) m2.fact(key, value);
      m2.fact(rugCheckKey(DEV), { obs: { provider: 'helius', slot: h2.worker.feed.openSlot - 1n, receivedAt: m2.now, quality: [], commitment: 'confirmed' }, creator: DEV, version: RUG_CONFIG.version, fromMs: 0, asOfMs: m2.now, mints: [], credits: 0 });
      m2.pool();
      await tick();
    }
    expect(judged()).toBe(true);
    if (!same && !feeFact) {
      expect(h2.worker.strategy.candidates().get(MINT)!.gates).toEqual([{ gate: 'worker', code: 'no-fee-context', detail: 'fee context unknown' }]);
      expect(h2.worker.poolOf(MINT)).toBeNull();
      await h2.worker.stop();
      return;
    }
    // Priced from the kept terms: the gates judged it (H15, its simulation missing), never the worker's no-market cases.
    const gates = h2.worker.strategy.candidates().get(MINT)!.gates!;
    expect(gates.length).toBeGreaterThan(0);
    expect(gates.filter((g) => g.gate === 'worker')).toEqual([]);
    expect(gates.some((g) => g.input === 'sim' || g.neededBy === 'H15' || g.gate === 'H15')).toBe(true);
    if (feeFact) {
      // Priced from the fact, whatever the restored terms say: the pool moved, so they price nothing.
      expect(h2.worker.strategy.observedFees(MINT, h2.worker.poolOf(MINT)!.state)).toBeUndefined();
      expect(h2.worker.poolOf(MINT)?.ctx).toEqual(FEE_CONTEXT);
      await h2.worker.stop();
      return;
    }
    expect(h2.worker.strategy.observedFees(MINT, after)).toBeDefined();
    expect(h2.worker.poolOf(MINT)?.state).toEqual(after);
    await h2.worker.stop();
  }, 60_000);
});

describe('POOL-DATA: each case of no market has its own code', () => {
  it.each([
    ['pool state unknown', 'no-pool-state'],
    ['pool state malformed', 'pool-malformed'],
    ['pool state flagged partial (swap stream gap)', 'pool-flagged'],
    ['pool state flagged partial', 'pool-flagged'],
    ['fee context unknown', 'no-fee-context'],
  ])('%s → %s', (why, code) => {
    expect(marketMissCode(why)).toBe(code);
  });

  it('the codes are the four cases, none of them the old catch-all', () => {
    expect([...MARKET_MISS_CODES].sort()).toEqual(['no-fee-context', 'no-pool-state', 'pool-flagged', 'pool-malformed']);
  });

  it.each([
    ['a pool never read', { omit: [poolKey(MINT)] }, 'no-pool-state', 'pool state unknown'],
    ['no swap seen and no fee-context fact', { fees: false }, 'no-fee-context', 'fee context unknown'],
  ])('%s: the reject carries gate worker, code %s', async (_, o, code, why) => {
    const timers = virtualTimers(T - 16 * 86_400_000);
    const h = makeWorker({ stateDir: tempState(), timers, seed: (r: SeedRequest) => runSeed(r, { rpc: emptyRpc, timers }), config: { ZEROED_HEALTH_ADDR: `127.0.0.1:${port++}`, ZEROED_API_ADDR: `127.0.0.1:${port++}` } });
    const m0 = new Market(h);
    const started = h.worker.start();
    while (!h.order.includes('start helius-ws')) await new Promise<void>((r) => setImmediate(r));
    m0.slot();
    m0.offchain('coverage:creates:start', { fromSlot: slotAt(m0.now), via: CREATES_VIA });
    expect(await started).toEqual({ ok: true });
    const m = await passingMarket(h, o);
    m.offchain('feed:status:helius', { state: 'up' });
    await m.run(3_000, 400, () => m.pool());
    const r = journal(h.stateDir).find((l) => l['kind'] === 'decision' && (l['reasons'] as string[])[0] === 'reject' && (l['reasons'] as string[])[2] === MINT);
    expect((r?.['reasons'] as string[])[3]).toBe(why);
    expect(r?.['gate_reasons']).toEqual([{ gate: 'worker', code, detail: why }]);
    await h.worker.stop();
  }, 60_000);
});
