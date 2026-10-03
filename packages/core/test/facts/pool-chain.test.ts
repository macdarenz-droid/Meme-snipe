// POS-1: the pool fact kept current from the pool's confirmed swap stream, on the real account read of the fixture
// coin (fixtures/facts.json). Swaps here continue the read's real reserves; each one's logged amounts come from the
// exact PumpSwap math, as the program logs them. The rule: a gap, a hole, reserves that do not chain or a swap that
// does not reproduce its event make the fact stale (flagged), and nothing prices from it.
import { describe, expect, it } from 'vitest';
import { type PoolState, poolBuyExactBase, poolSell } from '../../src/amm/index.ts';
import { startSession, TRIAL_POLICY } from '../../src/config/index.ts';
import { OFF_CHAIN, type MarketEvent, type Moment } from '../../src/engine/index.ts';
import { RAW, STREAMS } from '../../src/facts/index.ts';
import { observedFeeContext } from '../../src/fills/index.ts';
import { Evidence, parsePool, poolKey } from '../../src/gates/index.ts';
import { bps } from '../../src/units/index.ts';
import { FIX, FactWorld, MINT, POOL, coverage, offchain } from './helpers.ts';

const policy = startSession(TRIAL_POLICY).policy;
const READ_SLOT = BigInt(FIX.accountsRead.slot);
const T0 = 1_791_100_000_000;
const STREAM = STREAMS.trades(POOL);
const FEES = { split: { lp: bps(2), protocol: bps(93), creator: bps(30) }, buybackFeeBps: bps(5_000), instruction: 'v1' as const };
const SUPPLY = 1_000_000_000_000_000n;
const ctx = observedFeeContext(FEES, SUPPLY, { mayhemMode: false, transferFee: false, transferHook: false });

const at = (slot: bigint): number => T0 + Number(slot - READ_SLOT) * 400;
let n = 0;

/** A confirmed BuyEvent/SellEvent log line on the pool, its amounts from the exact math on `pre`. */
const swap = (side: 'buy' | 'sell', pre: PoolState, base: bigint, slot: bigint, o: { commitment?: 'confirmed' | null; tamper?: Record<string, bigint>; arrives?: bigint } = {}): { event: MarketEvent; after: PoolState } => {
  const q = side === 'buy' ? poolBuyExactBase(pre, base, ctx) : poolSell(pre, base, ctx);
  if (!q.ok) throw new Error(q.reason);
  const t = q.trade;
  const common = {
    timestamp: BigInt(Math.floor(at(slot) / 1000)), poolBaseTokenReserves: pre.baseReserve, poolQuoteTokenReserves: pre.quoteVault, virtualQuoteReserves: pre.virtualQuoteReserves,
    lpFeeBasisPoints: 2n, lpFee: t.lpFee, protocolFeeBasisPoints: 93n, protocolFee: t.protocolFee, coinCreatorFeeBasisPoints: 30n, coinCreatorFee: t.creatorFee,
    buybackFeeBasisPoints: 5_000n, buybackFee: t.buybackFee, baseSupply: SUPPLY, pool: POOL, user: 'trader',
  };
  const data = side === 'buy'
    ? { ...common, baseAmountOut: base, quoteAmountIn: t.quote, quoteAmountInWithLpFee: t.quote + t.lpFee, userQuoteAmountIn: t.userQuote, ixName: 'buy' }
    : { ...common, baseAmountIn: base, quoteAmountOut: t.quote, quoteAmountOutWithoutLpFee: t.quote - t.lpFee, userQuoteAmountOut: t.userQuote };
  const k = n++;
  const commitment = o.commitment === undefined ? 'confirmed' : o.commitment;
  return {
    after: t.after,
    event: {
      kind: 'market', id: `log:sig${k}${commitment ? `:${commitment}` : ''}:00000`, moment: { slot: o.arrives ?? slot, txIndex: 2 ** 32 + k, ixIndex: 2 ** 36, receivedAt: at(o.arrives ?? slot) },
      key: `logs:pump_amm:${side === 'buy' ? 'BuyEvent' : 'SellEvent'}:${POOL}`,
      value: {
        event: { program: 'pump_amm', name: side === 'buy' ? 'BuyEvent' : 'SellEvent', data: { ...data, ...o.tamper }, logIndex: 0 }, signature: `sig${k}`, txSlot: slot,
        truncated: false, via: `logs:${POOL}`, ...(commitment ? { commitment } : {}), source: 'helius', backfilled: false, seq: k,
      },
    },
  };
};

/** The fixture's account read, answered for `slot`, arriving at `arrives` (its own slot unless later). */
const read = (slot = READ_SLOT, arrives = slot): MarketEvent => offchain(RAW.accounts(MINT), { ...FIX.accountsRead, slot }, arrives, at(arrives), 'helius');
const start = (from = READ_SLOT - 10n): MarketEvent => coverage(STREAM, 'start', { fromSlot: from, via: `logs:${POOL}` }, READ_SLOT - 11n, at(READ_SLOT - 11n));

/** The read's reserves (the fixture's real pool) and a world with the stream started and the read applied. */
const base = (): { world: FactWorld; state: PoolState } => {
  const world = new FactWorld().push(start(), read());
  const p = parsePool(world.last(poolKey(MINT)))!;
  return { world, state: { baseReserve: p.baseVault, quoteVault: p.quoteVault, virtualQuoteReserves: p.pool.virtualQuoteReserves ?? 0n } };
};

const facts = (w: FactWorld) => w.facts(poolKey(MINT)).map((e) => parsePool(e.value)!);
const now = (slot: bigint, ms = at(slot) + 100): Moment => ({ slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: ms });

describe('pool state from the swap stream (POS-1)', () => {
  it('each confirmed swap releases the pool right after it, stamped with its slot and receipt time', () => {
    const { world, state } = base();
    const s1 = swap('buy', state, state.baseReserve / 1000n, READ_SLOT + 3n);
    const s2 = swap('sell', s1.after, state.baseReserve / 4000n, READ_SLOT + 5n);
    world.push(s1.event, s2.event);
    const [, f1, f2] = facts(world);
    expect([f1, f2].map((f) => [f!.baseVault, f!.quoteVault, f!.pool.virtualQuoteReserves])).toEqual([
      [s1.after.baseReserve, s1.after.quoteVault, s1.after.virtualQuoteReserves], [s2.after.baseReserve, s2.after.quoteVault, s2.after.virtualQuoteReserves],
    ]);
    expect(f2!.obs).toEqual({ provider: 'helius', slot: READ_SLOT + 5n, receivedAt: at(READ_SLOT + 5n), quality: [], commitment: 'confirmed' });
    // Every static field is the read's.
    const r = facts(world)[0]!;
    expect({ ...f2!, obs: r.obs, baseVault: r.baseVault, quoteVault: r.quoteVault, pool: { ...f2!.pool, virtualQuoteReserves: r.pool.virtualQuoteReserves } }).toEqual(r);
    // GATE-1 reads it as current pool state.
    const ev = new Evidence(world.ctx(now(READ_SLOT + 6n)), policy).read('pool', poolKey(MINT), parsePool, 'state', 'H12');
    expect(ev.ok).toBe(true);
  });

  it('a processed swap, or one already in the read (its slot or earlier), moves nothing', () => {
    const { world, state } = base();
    world.push(swap('buy', state, 1_000n, READ_SLOT + 2n, { commitment: null }).event, swap('buy', state, 1_000n, READ_SLOT, { arrives: READ_SLOT + 3n }).event);
    expect(facts(world)).toHaveLength(1);
  });

  it('a gap in the stream makes the state stale at once; nothing is released clean until a swap after the gap re-bases it', () => {
    const { world, state } = base();
    const s1 = swap('buy', state, 1_000_000n, READ_SLOT + 2n);
    world.push(s1.event, coverage(STREAM, 'gap', { fromSlot: READ_SLOT + 3n, toSlot: null, reason: 'disconnect', via: `logs:${POOL}` }, READ_SLOT + 3n, at(READ_SLOT + 3n)));
    const stale = facts(world).at(-1)!;
    expect(stale.obs.quality).toEqual(['partial']);
    expect((world.last(poolKey(MINT)) as { stale: string }).stale).toBe('swap stream gap');
    const ev = new Evidence(world.ctx(now(READ_SLOT + 3n)), policy).read('pool', poolKey(MINT), parsePool, 'state', 'H12');
    expect(!ev.ok && ev.reason.code).toBe('degraded');
    // While the gap is open, a swap (even one that chains) is not applied.
    const s2 = swap('buy', s1.after, 1_000_000n, READ_SLOT + 4n);
    world.push(s2.event);
    expect(facts(world).at(-1)!.obs.quality).toEqual(['partial']);
    // The gap closes at slot +6; a swap in it cannot re-base, the first after it does, from its own pre-trade reserves.
    const s3 = swap('sell', s2.after, 500_000n, READ_SLOT + 6n);
    world.push(s3.event, coverage(STREAM, 'gap', { fromSlot: READ_SLOT + 3n, toSlot: READ_SLOT + 6n, reason: 'disconnect', via: `logs:${POOL}` }, READ_SLOT + 7n, at(READ_SLOT + 7n)));
    expect(facts(world).at(-1)!.obs.quality).toEqual(['partial']);
    const s4 = swap('buy', s3.after, 2_000_000n, READ_SLOT + 8n);
    world.push(s4.event);
    const f = facts(world).at(-1)!;
    expect(f.obs.quality).toEqual([]);
    expect([f.baseVault, f.quoteVault]).toEqual([s4.after.baseReserve, s4.after.quoteVault]);
  });

  it('a cut or undecodable log of the stream is a hole: stale', () => {
    const { world, state } = base();
    world.push(swap('buy', state, 1_000n, READ_SLOT + 2n).event);
    world.push({ kind: 'market', id: 'log:x:undecodable', moment: { slot: READ_SLOT + 3n, txIndex: 2 ** 33, ixIndex: 0, receivedAt: at(READ_SLOT + 3n) }, key: `logs:undecodable:logs:${POOL}`, value: { signature: 'x', error: 'bad', source: 'helius', backfilled: false, seq: 1 } });
    expect(facts(world).at(-1)!.obs.quality).toEqual(['partial']);
  });

  it('reserves that do not chain mark the state stale until a new read; later swaps never clear it', () => {
    const { world, state } = base();
    const s1 = swap('buy', state, 1_000_000n, READ_SLOT + 2n);
    // A swap we never saw happened in between: the next one starts elsewhere.
    const missed = swap('buy', s1.after, 3_000_000n, READ_SLOT + 3n);
    const s3 = swap('sell', missed.after, 1_000_000n, READ_SLOT + 4n);
    const s4 = swap('buy', s3.after, 1_000_000n, READ_SLOT + 5n);
    world.push(s1.event, s3.event, s4.event);
    const f = facts(world);
    expect(f.at(-1)!.obs.quality).toEqual(['partial']);
    expect((world.last(poolKey(MINT)) as { stale: string }).stale).toMatch(/^reserves mismatch: swap sig\d+ starts at/);
    expect(f).toHaveLength(3);
    // A coherent read at a later slot re-bases.
    world.push(read(READ_SLOT + 6n));
    expect(facts(world).at(-1)!.obs).toMatchObject({ slot: READ_SLOT + 6n, quality: [] });
  });

  it('a swap that does not reproduce its logged amounts marks the state stale', () => {
    const { world, state } = base();
    const s = swap('buy', state, 1_000_000n, READ_SLOT + 2n);
    const lpFee = ((s.event.value as { event: { data: { lpFee: bigint } } }).event.data.lpFee) + 1n;
    world.push(swap('buy', state, 1_000_000n, READ_SLOT + 2n, { tamper: { lpFee } }).event);
    expect((world.last(poolKey(MINT)) as { stale: string }).stale).toMatch(/does not reproduce its event: lp fee/);
  });

  it('a stream that started after the read, or no stream at all, gives no swap state', () => {
    const late = new FactWorld().push(start(READ_SLOT + 2n), read());
    const p = parsePool(late.last(poolKey(MINT)))!;
    const state = { baseReserve: p.baseVault, quoteVault: p.quoteVault, virtualQuoteReserves: p.pool.virtualQuoteReserves ?? 0n };
    late.push(swap('buy', state, 1_000n, READ_SLOT + 3n).event);
    expect(facts(late).at(-1)!.obs.quality).toEqual(['partial']);
    const none = new FactWorld().push(read());
    none.push(swap('buy', state, 1_000n, READ_SLOT + 3n).event);
    expect(facts(none).at(-1)!.obs.quality).toEqual(['partial']);
  });

  it('a read older than the swaps already applied is not released over them', () => {
    const { world, state } = base();
    const s1 = swap('buy', state, 1_000_000n, READ_SLOT + 4n);
    world.push(s1.event, read(READ_SLOT + 3n, READ_SLOT + 5n));
    const f = facts(world).at(-1)!;
    expect(f.obs.slot).toBe(READ_SLOT + 4n);
    expect(f.baseVault).toBe(s1.after.baseReserve);
  });
});
