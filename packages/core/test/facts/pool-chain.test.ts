// POS-1: the pool fact kept current from the pool's confirmed swap stream, on the real account read of the fixture
// coin (fixtures/facts.json). Swaps here continue the read's real reserves; each one's logged amounts come from the
// exact PumpSwap math, as the program logs them. The rule: a gap, a hole, reserves that do not chain or a swap that
// does not reproduce its event make the fact stale (flagged), and nothing prices from it.
import { describe, expect, it } from 'vitest';
import { type PoolState, poolBuyExactBase, poolSell } from '../../src/amm/index.ts';
import { startSession, TRIAL_POLICY } from '../../src/config/index.ts';
import { OFF_CHAIN, type MarketEvent, type Moment } from '../../src/engine/index.ts';
import { PRE_READ_KEEP, PRE_READ_POOLS, RAW, STREAMS } from '../../src/facts/index.ts';
import { observedFeeContext } from '../../src/fills/index.ts';
import { Evidence, carryKey, parsePool, poolKey } from '../../src/gates/index.ts';
import { bps } from '../../src/units/index.ts';
import { FIX, FactWorld, MINT, POOL, coverage, offchain, slotNotice } from './helpers.ts';

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
const swap = (side: 'buy' | 'sell', pre: PoolState, base: bigint, slot: bigint, o: { commitment?: 'confirmed' | null; tamper?: Record<string, bigint>; arrives?: bigint; tail?: string } = {}): { event: MarketEvent; after: PoolState } => {
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
        event: { program: 'pump_amm', name: side === 'buy' ? 'BuyEvent' : 'SellEvent', data: { ...data, ...o.tamper }, logIndex: 0, ...(o.tail === undefined ? {} : { trailing: o.tail.length / 2, extra: o.tail }) }, signature: `sig${k}`, txSlot: slot,
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

  it('H5-POOL-TAILS: a swap with a non-zero creator-fee tail is applied when it reproduces, and still marks the state stale when it does not', () => {
    const TAIL = '384a120000000000';
    const ok = base();
    const s = swap('buy', ok.state, 1_000_000n, READ_SLOT + 2n, { tail: TAIL });
    ok.world.push(s.event);
    expect(facts(ok.world).at(-1)!.obs).toMatchObject({ slot: READ_SLOT + 2n, quality: [] });
    expect((ok.world.last(poolKey(MINT)) as { stale?: string }).stale).toBeUndefined();
    const bad = base();
    const lpFee = ((s.event.value as { event: { data: { lpFee: bigint } } }).event.data.lpFee) + 1n;
    bad.world.push(swap('buy', bad.state, 1_000_000n, READ_SLOT + 2n, { tail: TAIL, tamper: { lpFee } }).event);
    expect((bad.world.last(poolKey(MINT)) as { stale: string }).stale).toMatch(/does not reproduce its event: lp fee/);
    const gap = base();
    const s1 = swap('buy', gap.state, 1_000_000n, READ_SLOT + 2n, { tail: TAIL });
    const missed = swap('buy', s1.after, 3_000_000n, READ_SLOT + 3n, { tail: TAIL });
    gap.world.push(s1.event, swap('sell', missed.after, 1_000_000n, READ_SLOT + 4n, { tail: TAIL }).event);
    expect((gap.world.last(poolKey(MINT)) as { stale: string }).stale).toMatch(/^reserves mismatch/);
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

  it('a late swap older than the newest one applied never re-bases after a gap: no clean old price', () => {
    const { world, state } = base();
    const s1 = swap('buy', state, 1_000_000n, READ_SLOT + 2n);
    const s2 = swap('buy', s1.after, 1_000_000n, READ_SLOT + 10n);
    world.push(s1.event, s2.event);
    // A bounded gap reported late, then a swap from before the newest one (slot +7, delivered late): its pre-trade
    // reserves are an old state, and must not be released as current.
    world.push(coverage(STREAM, 'gap', { fromSlot: READ_SLOT + 4n, toSlot: READ_SLOT + 5n, reason: 'disconnect', via: `logs:${POOL}` }, READ_SLOT + 11n, at(READ_SLOT + 11n)));
    world.push(swap('sell', s1.after, 500_000n, READ_SLOT + 7n, { arrives: READ_SLOT + 12n }).event);
    expect(facts(world).at(-1)!.obs.quality).toEqual(['partial']);
    // The next swap after the gap and after the newest one re-bases.
    const s3 = swap('sell', s2.after, 500_000n, READ_SLOT + 13n);
    world.push(s3.event);
    expect(facts(world).at(-1)!).toMatchObject({ obs: { quality: [], slot: READ_SLOT + 13n }, baseVault: s3.after.baseReserve });
  });

  it('the same swap delivered twice (log line and fetched transaction) is applied once and stays clean', () => {
    const { world, state } = base();
    const s1 = swap('buy', state, 1_000_000n, READ_SLOT + 2n);
    const again = { ...s1.event, id: `${s1.event.id}:again`, moment: { ...s1.event.moment, txIndex: s1.event.moment.txIndex + 1 } };
    world.push(s1.event, again);
    const f = facts(world);
    expect(f).toHaveLength(2);
    expect(f.at(-1)!).toMatchObject({ obs: { quality: [] }, baseVault: s1.after.baseReserve });
  });

  it('a second delivery of an applied swap that arrives after newer ones is ignored, not taken as a mismatch', () => {
    const { world, state } = base();
    const s1 = swap('buy', state, 1_000_000n, READ_SLOT + 2n);
    const s2 = swap('sell', s1.after, 500_000n, READ_SLOT + 4n);
    const late = { ...s1.event, id: `${s1.event.id}:fetched`, moment: { ...s1.event.moment, slot: READ_SLOT + 5n, receivedAt: at(READ_SLOT + 5n) } };
    world.push(s1.event, s2.event, late);
    expect(facts(world).at(-1)!).toMatchObject({ obs: { quality: [], slot: READ_SLOT + 4n }, baseVault: s2.after.baseReserve });
  });

  it('a swap whose base reserve alone, or effective quote alone, does not chain marks the state stale', () => {
    for (const pre of [(p: PoolState) => ({ ...p, baseReserve: p.baseReserve + 1n }), (p: PoolState) => ({ ...p, quoteVault: p.quoteVault + 1n })]) {
      const { world, state } = base();
      world.push(swap('buy', pre(state), 1_000_000n, READ_SLOT + 2n).event);
      expect((world.last(poolKey(MINT)) as { stale: string }).stale).toMatch(/^reserves mismatch/);
    }
  });

  it('a pool that leaves the watch list drops its chain: its last state is flagged and later swaps make nothing', () => {
    const { world, state } = base();
    const s1 = swap('buy', state, 1_000_000n, READ_SLOT + 2n);
    world.push(s1.event, coverage(STREAM, 'gap', { fromSlot: READ_SLOT + 3n, toSlot: null, reason: 'not watched', via: `logs:${POOL}` }, READ_SLOT + 3n, at(READ_SLOT + 3n)));
    expect(facts(world).at(-1)!.obs.quality).toEqual(['partial']);
    const n = facts(world).length;
    world.push(coverage(STREAM, 'start', { fromSlot: READ_SLOT + 5n, via: `logs:${POOL}` }, READ_SLOT + 5n, at(READ_SLOT + 5n)), swap('buy', s1.after, 1_000n, READ_SLOT + 6n).event);
    expect(facts(world)).toHaveLength(n);
  });

  it('the read\'s base is its fact\'s slot (the oldest account it was built from), not the read\'s own', () => {
    const { world, state } = base();
    // A later read that answers only the pool account: the vaults are still those of the first read.
    const poolOnly = { ...FIX.accountsRead, slot: READ_SLOT + 5n, accounts: FIX.accountsRead.accounts.filter((a) => a.address === POOL) };
    world.push(offchain(RAW.accounts(MINT), poolOnly, READ_SLOT + 5n, at(READ_SLOT + 5n), 'helius'));
    expect(facts(world).at(-1)!.obs.slot).toBe(READ_SLOT);
    // A swap at slot +3, after the vaults' read: not in that state, so it moves it.
    const s1 = swap('buy', state, 1_000_000n, READ_SLOT + 3n, { arrives: READ_SLOT + 6n });
    world.push(s1.event);
    expect(facts(world).at(-1)!).toMatchObject({ obs: { quality: [], slot: READ_SLOT + 3n }, baseVault: s1.after.baseReserve });
  });

  it('a read older than the swaps already applied is not released over them', () => {
    const { world, state } = base();
    const s1 = swap('buy', state, 1_000_000n, READ_SLOT + 4n);
    world.push(s1.event, read(READ_SLOT + 3n, READ_SLOT + 5n));
    const f = facts(world).at(-1)!;
    expect(f.obs.slot).toBe(READ_SLOT + 4n);
    expect(f.baseVault).toBe(s1.after.baseReserve);
  });

describe('a quiet pool proven unchanged by its covered stream (WATCH-1c)', () => {
  const carries = (w: FactWorld) => w.facts(carryKey(MINT)).map((e) => e.value as { pool: string; slot: bigint; state: PoolState; obs: { slot: bigint; receivedAt: number } });
  const notice = (slot: bigint) => slotNotice(slot, at(slot) + 50);
  /** A confirmed PumpSwap event on the pool's stream that is not a swap (DEC-1 names it 'other' when it cannot). */
  const other = (slot: bigint, name = 'other'): MarketEvent => ({
    kind: 'market', id: `log:other${slot}:confirmed:00000`, moment: { slot, txIndex: 2 ** 32 + 999, ixIndex: 2 ** 36, receivedAt: at(slot) },
    key: `logs:pump_amm:${name}:pump_amm`,
    value: { event: { program: 'pump_amm', name, discriminator: '0011223344556677', logIndex: 0 }, signature: `other${slot}`, txSlot: slot, truncated: false, via: `logs:${POOL}`, commitment: 'confirmed', source: 'helius', backfilled: false, seq: 0 },
  });

  it('each slot notice carries the unchanged state through its slot; a swap moves the state it carries', () => {
    const { world, state } = base();
    world.push(notice(READ_SLOT + 1n), notice(READ_SLOT + 2n));
    expect(carries(world).map((c) => [c.slot, c.state])).toEqual([[READ_SLOT + 1n, state], [READ_SLOT + 2n, state]]);
    expect(carries(world)[1]!).toMatchObject({ pool: POOL, obs: { slot: READ_SLOT + 2n, receivedAt: at(READ_SLOT + 2n) + 50, quality: [], commitment: 'confirmed' } });
    const s1 = swap('buy', state, state.baseReserve / 1000n, READ_SLOT + 3n);
    world.push(s1.event, notice(READ_SLOT + 3n));
    expect(carries(world).at(-1)).toMatchObject({ slot: READ_SLOT + 3n, state: s1.after });
  });

  it('nothing is carried without coverage: before the stream starts, across a gap, after a hole or a non-swap pool transaction', () => {
    // No stream: the read alone proves nothing about the slots after it.
    const bare = new FactWorld().push(read(), notice(READ_SLOT + 1n));
    expect(carries(bare)).toEqual([]);
    // A gap.
    const g = base();
    g.world.push(coverage(STREAM, 'gap', { fromSlot: READ_SLOT + 1n, toSlot: null, reason: 'disconnect', via: `logs:${POOL}` }, READ_SLOT + 1n, at(READ_SLOT + 1n)), notice(READ_SLOT + 2n));
    expect(carries(g.world)).toEqual([]);
    // A cut log on the stream.
    const h = base();
    h.world.push(offchain(`logs:truncated:logs:${POOL}`, { signature: 'cut' }, READ_SLOT + 1n, at(READ_SLOT + 1n)), notice(READ_SLOT + 2n));
    expect(carries(h.world)).toEqual([]);
    // A deposit, a withdrawal, a buyback or anything else on the pool that is not a swap: stale until the next swap.
    for (const name of ['other', 'BoostBuyAndBurnEvent']) {
      const o = base();
      o.world.push(notice(READ_SLOT + 1n), other(READ_SLOT + 2n, name), notice(READ_SLOT + 2n), notice(READ_SLOT + 3n));
      expect(carries(o.world).map((c) => c.slot)).toEqual([READ_SLOT + 1n]);
      expect(facts(o.world).at(-1)!.obs.quality).toContain('partial');
      expect((o.world.last(poolKey(MINT)) as { stale: string }).stale).toBe(`a pool transaction other than a swap (${name})`);
      // The next swap re-bases on its own pre-trade reserves, and carrying resumes.
      const s = swap('buy', o.state, o.state.baseReserve / 1000n, READ_SLOT + 4n);
      o.world.push(s.event, notice(READ_SLOT + 4n));
      expect(carries(o.world).at(-1)).toMatchObject({ slot: READ_SLOT + 4n, state: s.after });
    }
  });

  it('a swap released behind a newer one makes the state stale; a repeat of an applied one does not', () => {
    const { world, state } = base();
    const s1 = swap('buy', state, state.baseReserve / 1000n, READ_SLOT + 3n);
    const s2 = swap('buy', s1.after, state.baseReserve / 1000n, READ_SLOT + 5n);
    const late = swap('sell', state, state.baseReserve / 4000n, READ_SLOT + 4n, { arrives: READ_SLOT + 6n });
    const again = { ...s1.event, id: `${s1.event.id}:again`, moment: { ...s1.event.moment, slot: READ_SLOT + 5n, txIndex: 2 ** 32 + 10_000, receivedAt: at(READ_SLOT + 5n) + 10 } };
    world.push(s1.event, s2.event, again, notice(READ_SLOT + 5n));
    expect(carries(world).at(-1)).toMatchObject({ slot: READ_SLOT + 5n, state: s2.after });
    world.push(late.event, notice(READ_SLOT + 6n));
    expect(carries(world).at(-1)!.slot).toBe(READ_SLOT + 5n);
    expect((world.last(poolKey(MINT)) as { stale: string }).stale).toBe(`swap ${late.event.value && (late.event.value as { signature: string }).signature} arrived out of order`);
  });
});
});

describe('swaps released before the pool\'s first read (POOL-FIRST-READ)', () => {
  // REPLAY-1000: pool ECVuPnoq, 6 Oct 00:38Z: the first read, answered for slot 453742328, arrived at slot 330, after
  // the swaps of slot 329 had been released and dropped; the next swap's pre-trade reserves then held them: mismatch.
  const readState = (): PoolState => base().state;
  const carries = (w: FactWorld) => w.facts(carryKey(MINT)).map((e) => e.value as { slot: bigint; state: PoolState });
  const other = (slot: bigint, name = 'DepositEvent'): MarketEvent => ({
    kind: 'market', id: `log:other${slot}:confirmed:00000`, moment: { slot, txIndex: 2 ** 32 + 999, ixIndex: 2 ** 36, receivedAt: at(slot) },
    key: `logs:pump_amm:${name}:pump_amm`,
    value: { event: { program: 'pump_amm', name, discriminator: '0011223344556677', logIndex: 0 }, signature: `other${slot}`, txSlot: slot, truncated: false, via: `logs:${POOL}`, commitment: 'confirmed', source: 'helius', backfilled: false, seq: 0 },
  });
  const stale = (w: FactWorld): string | undefined => (w.last(poolKey(MINT)) as { stale?: string }).stale;

  it('swaps newer than the read that came before it are applied when it arrives; the chain stays clean and carries', () => {
    const state = readState();
    const s1 = swap('buy', state, state.baseReserve / 1000n, READ_SLOT + 1n);
    const s2 = swap('sell', s1.after, state.baseReserve / 4000n, READ_SLOT + 1n);
    const s3 = swap('buy', s2.after, state.baseReserve / 2000n, READ_SLOT + 2n);
    const world = new FactWorld().push(start(), s1.event, s2.event, s3.event, read(READ_SLOT, READ_SLOT + 3n));
    expect(facts(world).at(-1)!).toMatchObject({ obs: { quality: [], slot: READ_SLOT + 2n }, baseVault: s3.after.baseReserve, quoteVault: s3.after.quoteVault });
    expect(stale(world)).toBeUndefined();
    expect(world.producer.sizes().preReads).toBe(0);
    // The next live swap chains on them (before the fix: "reserves mismatch").
    const s4 = swap('sell', s3.after, state.baseReserve / 8000n, READ_SLOT + 4n);
    world.push(s4.event, slotNotice(READ_SLOT + 4n, at(READ_SLOT + 4n) + 50));
    expect(facts(world).at(-1)!).toMatchObject({ obs: { quality: [], slot: READ_SLOT + 4n }, baseVault: s4.after.baseReserve });
    expect(carries(world).at(-1)).toMatchObject({ slot: READ_SLOT + 4n, state: s4.after });
    // A second delivery of a kept swap (a fetched copy) is a repeat, not an out-of-order swap.
    world.push({ ...s3.event, id: `${s3.event.id}:fetched`, moment: { ...s3.event.moment, slot: READ_SLOT + 5n, receivedAt: at(READ_SLOT + 5n) } });
    expect(stale(world)).toBeUndefined();
  });

  it('kept swaps at or before the read\'s slot are in the read: never applied again', () => {
    const state = readState();
    // Same pre-trade reserves as the read: applied again, they would chain and move the state.
    const inRead = swap('buy', state, state.baseReserve / 1000n, READ_SLOT);
    const world = new FactWorld().push(start(), inRead.event, read(READ_SLOT, READ_SLOT + 1n));
    expect(facts(world)).toHaveLength(1);
    expect(facts(world)[0]!).toMatchObject({ obs: { quality: [], slot: READ_SLOT }, baseVault: state.baseReserve });
  });

  it('a kept swap that does not chain makes the state stale (the continuity check holds for every kept swap)', () => {
    const state = readState();
    const s1 = swap('buy', state, 1_000_000n, READ_SLOT + 1n);
    const missed = swap('buy', s1.after, 3_000_000n, READ_SLOT + 2n);
    const s3 = swap('sell', missed.after, 1_000_000n, READ_SLOT + 3n);
    const world = new FactWorld().push(start(), s1.event, s3.event, read(READ_SLOT, READ_SLOT + 4n));
    expect(stale(world)).toMatch(/^reserves mismatch: swap sig\d+ starts at/);
    expect(facts(world).at(-1)!.obs.quality).toEqual(['partial']);
    // A swap that does not reproduce its event, kept: stale too.
    const lpFee = ((s1.event.value as { event: { data: { lpFee: bigint } } }).event.data.lpFee) + 1n;
    const bad = new FactWorld().push(start(), swap('buy', state, 1_000_000n, READ_SLOT + 1n, { tamper: { lpFee } }).event, read(READ_SLOT, READ_SLOT + 2n));
    expect(stale(bad)).toMatch(/does not reproduce its event: lp fee/);
  });

  it('kept swaps are applied in release order within a slot, as the stream applies them', () => {
    const state = readState();
    const s1 = swap('buy', state, 1_000_000n, READ_SLOT + 1n);
    const s2 = swap('buy', s1.after, 1_000_000n, READ_SLOT + 1n);
    const inOrder = new FactWorld().push(start(), s1.event, s2.event, read(READ_SLOT, READ_SLOT + 2n));
    expect(facts(inOrder).at(-1)!).toMatchObject({ obs: { quality: [] }, baseVault: s2.after.baseReserve });
    // Released the other way round, they do not chain, live or kept: stale.
    const s1Late = { ...s1.event, moment: { ...s1.event.moment, txIndex: s2.event.moment.txIndex + 1 } };
    const swapped = new FactWorld().push(start(), s2.event, s1Late, read(READ_SLOT, READ_SLOT + 2n));
    expect(stale(swapped)).toMatch(/^reserves mismatch/);
  });

  it('a pool event other than a swap newer than the read, released before it, makes the chain stale until the next swap', () => {
    const state = readState();
    const world = new FactWorld().push(start(), other(READ_SLOT + 1n), read(READ_SLOT, READ_SLOT + 2n), slotNotice(READ_SLOT + 3n, at(READ_SLOT + 3n) + 50));
    expect(stale(world)).toBe('a pool transaction other than a swap (DepositEvent)');
    expect(carries(world)).toEqual([]);
    const s = swap('buy', state, 1_000n, READ_SLOT + 4n);
    world.push(s.event);
    expect(facts(world).at(-1)!).toMatchObject({ obs: { quality: [] }, baseVault: s.after.baseReserve });
    // One at or before the read's slot is in the read.
    const old = new FactWorld().push(start(), other(READ_SLOT), read(READ_SLOT, READ_SLOT + 1n));
    expect(stale(old)).toBeUndefined();
  });

  it('a re-read answered for a slot older than a pool event other than a swap is left out: the change is not in it', () => {
    const { world, state } = base();
    const s1 = swap('buy', state, 1_000n, READ_SLOT + 1n);
    world.push(s1.event, other(READ_SLOT + 3n), read(READ_SLOT + 2n, READ_SLOT + 4n));
    expect(stale(world)).toBe('a pool transaction other than a swap (DepositEvent)');
    expect(facts(world).at(-1)!.obs.slot).toBe(READ_SLOT + 3n);
    // A re-read at or after it re-bases.
    world.push(read(READ_SLOT + 3n, READ_SLOT + 5n));
    expect(facts(world).at(-1)!.obs).toMatchObject({ slot: READ_SLOT + 3n, quality: [] });
    expect(stale(world)).toBeUndefined();
  });

  it('a re-read older than a swap already applied is left out (the chain holds a newer state)', () => {
    const { world, state } = base();
    const s1 = swap('buy', state, 1_000n, READ_SLOT + 3n);
    world.push(s1.event, read(READ_SLOT + 2n, READ_SLOT + 4n));
    expect(facts(world).at(-1)!).toMatchObject({ obs: { slot: READ_SLOT + 3n, quality: [] }, baseVault: s1.after.baseReserve });
  });

  it('a pool with no trade stream keeps nothing; a pool let go from the watch list or retired drops what it kept', () => {
    const state = readState();
    const none = new FactWorld().push(swap('buy', state, 1_000n, READ_SLOT + 1n).event);
    expect(none.producer.sizes().preReads).toBe(0);
    const gone = new FactWorld().push(start(), swap('buy', state, 1_000n, READ_SLOT + 1n).event);
    expect(gone.producer.sizes().preReads).toBe(1);
    gone.push(coverage(STREAM, 'gap', { fromSlot: READ_SLOT + 2n, toSlot: null, reason: 'not watched', via: `logs:${POOL}` }, READ_SLOT + 2n, at(READ_SLOT + 2n)));
    expect(gone.producer.sizes().preReads).toBe(0);
    const retired = new FactWorld().push(start(), swap('buy', state, 1_000n, READ_SLOT + 1n).event);
    retired.producer.retire([POOL]);
    expect(retired.producer.sizes().preReads).toBe(0);
  });

  it('past the per-pool cap the oldest are let go: stale when one was newer than the read, clean when all were in it', () => {
    const state = readState();
    // PRE_READ_KEEP + 1 swaps chaining from the read: the first (slot +1, newer than the read) is let go.
    const swaps: ReturnType<typeof swap>[] = [];
    let pre = state;
    for (let i = 0; i <= PRE_READ_KEEP; i++) {
      const s = swap('buy', pre, 1_000n, READ_SLOT + 1n + BigInt(i));
      swaps.push(s);
      pre = s.after;
    }
    const last = READ_SLOT + 1n + BigInt(PRE_READ_KEEP);
    const lost = new FactWorld().push(start(), ...swaps.map((s) => s.event), read(READ_SLOT, last + 1n));
    // Stale (a gap) at the read; the first kept swap does not chain on the read but re-bases on its own pre-trade
    // reserves (a gap, not a mismatch), the rest chain: the end state is exact and clean, as after any gap.
    expect(facts(lost).at(-1)!).toMatchObject({ obs: { quality: [], slot: last }, baseVault: pre.baseReserve });
    // Swaps let go that are all in the read: no gap. The first is at the read's own slot.
    const inRead = swap('buy', state, 1_000n, READ_SLOT);
    const rest: ReturnType<typeof swap>[] = [];
    let p2 = state;
    for (let i = 0; i < PRE_READ_KEEP; i++) {
      const s = swap('buy', p2, 1_000n, READ_SLOT + 1n + BigInt(i));
      rest.push(s);
      p2 = s.after;
    }
    const kept = new FactWorld().push(start(), inRead.event, ...rest.map((s) => s.event), read(READ_SLOT, last + 1n));
    expect(kept.facts(poolKey(MINT)).every((e) => (e.value as { stale?: string }).stale === undefined)).toBe(true);
    expect(facts(kept).at(-1)!).toMatchObject({ obs: { quality: [], slot: READ_SLOT + BigInt(PRE_READ_KEEP) }, baseVault: p2.baseReserve });
  });

  it('a pool whose kept events were let go whole (past the pool cap) starts stale at its first read', () => {
    const state = readState();
    // PRE_READ_POOLS other watched pools with a kept swap each push this pool out.
    const pools = Array.from({ length: PRE_READ_POOLS }, (_, i) => `OtherPool${i}`);
    const world = new FactWorld().push(start(), ...pools.map((p) => coverage(STREAMS.trades(p), 'start', { fromSlot: READ_SLOT - 10n, via: `logs:${p}` }, READ_SLOT - 11n, at(READ_SLOT - 11n))));
    world.push(swap('buy', state, 1_000n, READ_SLOT + 1n).event);
    expect(world.producer.sizes().preReads).toBe(1);
    for (const p of pools) {
      const s = swap('buy', state, 1_000n, READ_SLOT + 1n);
      const v = s.event.value as { event: { data: Record<string, unknown> }; via: string };
      world.push({ ...s.event, key: s.event.key.replace(POOL, p), value: { ...v, event: { ...v.event, data: { ...v.event.data, pool: p } }, via: `logs:${p}` } });
    }
    expect(world.producer.sizes().preReads).toBe(PRE_READ_POOLS);
    world.push(read(READ_SLOT, READ_SLOT + 2n));
    expect(stale(world)).toBe('pool events before the first read were let go');
  });
});
