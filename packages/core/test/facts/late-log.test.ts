// LATE-LOG review (#272, 1c60999): the candle book's order rules and a late hole's slot, on the trade-heal fixture.
// HIGH-1: two swaps of one slot on one pool released out of chain order (one late, or both on time in reverse) must not
// leave complete candles whose close is the wrong trade's. LOW-3: a late cut log's hole sits at its transaction's slot.
// LOW-4: a swap the book refused never becomes a heal's anchor. (Helpers copied from trade-heal.test.ts.)
import { describe, expect, it } from 'vitest';
import { type PoolState, poolBuyExactBase, poolSell } from '../../src/amm/index.ts';
import { startSession, TRIAL_POLICY } from '../../src/config/index.ts';
import { OFF_CHAIN, type MarketEvent, type Moment } from '../../src/engine/index.ts';
import { HEAL_TAPE_MAX, HEAL_WAIT_MS, HOLE_FETCH_PREFIX, PRE_READ_KEEP, PRE_READ_POOLS, RAW, STREAMS, type SwapEv, chainOrder } from '../../src/facts/index.ts';
import { observedFeeContext } from '../../src/fills/index.ts';
import { Evidence, candlesKey, parseCandles, parsePool, poolKey, streamKey } from '../../src/gates/index.ts';
import { bps } from '../../src/units/index.ts';
import { FIX, FactWorld, MINT, POOL, coverage, offchain, slotNotice } from './helpers.ts';

const policy = startSession(TRIAL_POLICY).policy;
const R = BigInt(FIX.accountsRead.slot);
const T0 = 1_791_100_000_000;
const STREAM = STREAMS.trades(POOL);
const VIA = `logs:${POOL}`;
const FEES = { split: { lp: bps(2), protocol: bps(93), creator: bps(30) }, buybackFeeBps: bps(5_000), instruction: 'v1' as const };
const SUPPLY = 1_000_000_000_000_000n;
const ctx = observedFeeContext(FEES, SUPPLY, { mayhemMode: false, transferFee: false, transferHook: false });
/** No fees at all: a buy and a sell of the same base can bring the reserves back exactly. */
const ZERO = { split: { lp: bps(0), protocol: bps(0), creator: bps(0) }, buybackFeeBps: bps(0), instruction: 'v1' as const };
const ctx0 = observedFeeContext(ZERO, SUPPLY, { mayhemMode: false, transferFee: false, transferHook: false });

/** Receipt time of a slot; trade timestamps step 25 s a slot, so the candles span several minutes. */
const at = (slot: bigint): number => T0 + Number(slot - R) * 400;
const stamp = (slot: bigint): bigint => BigInt(Math.floor(T0 / 1000)) + (slot - R) * 25n;

interface Swap {
  readonly sig: string;
  readonly slot: bigint;
  readonly after: PoolState;
  readonly name: 'BuyEvent' | 'SellEvent';
  readonly data: Record<string, unknown>;
}

let n = 0;
/** A swap on `pre`, its amounts from the exact math. */
const swap = (side: 'buy' | 'sell', pre: PoolState, base: bigint, slot: bigint, free = false): Swap => {
  const c = free ? ctx0 : ctx;
  const q = side === 'buy' ? poolBuyExactBase(pre, base, c) : poolSell(pre, base, c);
  if (!q.ok) throw new Error(q.reason);
  const t = q.trade;
  const common = {
    timestamp: stamp(slot), poolBaseTokenReserves: pre.baseReserve, poolQuoteTokenReserves: pre.quoteVault, virtualQuoteReserves: pre.virtualQuoteReserves,
    lpFeeBasisPoints: free ? 0n : 2n, lpFee: t.lpFee, protocolFeeBasisPoints: free ? 0n : 93n, protocolFee: t.protocolFee, coinCreatorFeeBasisPoints: free ? 0n : 30n, coinCreatorFee: t.creatorFee,
    buybackFeeBasisPoints: free ? 0n : 5_000n, buybackFee: t.buybackFee, baseSupply: SUPPLY, pool: POOL, user: 'trader',
  };
  const data = side === 'buy'
    ? { ...common, baseAmountOut: base, quoteAmountIn: t.quote, quoteAmountInWithLpFee: t.quote + t.lpFee, userQuoteAmountIn: t.userQuote, ixName: 'buy' }
    : { ...common, baseAmountIn: base, quoteAmountOut: t.quote, quoteAmountOutWithoutLpFee: t.quote - t.lpFee, userQuoteAmountOut: t.userQuote };
  return { sig: `sig${n++}`, slot, after: t.after, name: side === 'buy' ? 'BuyEvent' : 'SellEvent', data };
};

/** The swap's confirmed log line on the pool watch, released at its slot (rank `k` in it); `truncated` when cut after it. */
const logOf = (s: Swap, k = 0, truncated = false): MarketEvent => ({
  kind: 'market', id: `log:${s.sig}:confirmed:00000`, moment: { slot: s.slot, txIndex: 2 ** 32 + k, ixIndex: 2 ** 36, receivedAt: at(s.slot) + k },
  key: `logs:pump_amm:${s.name}:${POOL}`,
  value: { event: { program: 'pump_amm', name: s.name, data: s.data, logIndex: 0 }, signature: s.sig, txSlot: s.slot, truncated, via: VIA, commitment: 'confirmed', source: 'helius', backfilled: false, seq: n++ },
});

/** A cut log with no event left (`logs:truncated:`), or one DEC-1 cannot read (`logs:undecodable:`), at its slot. */
const hole = (sig: string, slot: bigint, kind: 'truncated' | 'undecodable' = 'truncated', k = 0): MarketEvent => ({
  kind: 'market', id: `log:${sig}:confirmed:${kind}`, moment: { slot, txIndex: 2 ** 32 + k, ixIndex: 2 ** 36, receivedAt: at(slot) + k },
  key: `logs:${kind}:${VIA}`, value: { signature: sig, source: 'helius', backfilled: false, seq: n++ },
});

/** A fetched transaction's events (`ev:`), released late: off-chain at `arrives`. */
const fetched = (sig: string, slot: bigint, arrives: bigint, events: readonly { name: string; data?: Record<string, unknown> }[], ix = 1): MarketEvent[] =>
  events.map((e, i) => ({
    kind: 'market', id: `ev:${sig}:00000:${String(i).padStart(5, '0')}`, moment: { slot: arrives, txIndex: OFF_CHAIN, ixIndex: ix, receivedAt: at(arrives) + 10 },
    key: `pump_amm:${e.name}:${POOL}`,
    value: { event: { program: 'pump_amm', name: e.name, ...(e.data === undefined ? { discriminator: '0011223344556677' } : { data: e.data }), signature: sig, slot, txIndex: 0, outerIx: 0, innerIx: i }, txSlot: slot, blockTime: null, source: 'helius', backfilled: false, seq: n++ },
  }));
const fetchedSwaps = (sig: string, slot: bigint, arrives: bigint, swaps: readonly Swap[], ix = 1): MarketEvent[] => fetched(sig, slot, arrives, swaps.map((s) => ({ name: s.name, data: s.data })), ix);

/** WORKER-1's fetch outcome for a hole, after the fetched transaction's events. */
const outcome = (sig: string, found: boolean, arrives: bigint, extraMs = 20, ix = 2): MarketEvent => ({
  kind: 'market', id: `${HOLE_FETCH_PREFIX}${VIA}#${n++}`, moment: { slot: arrives, txIndex: OFF_CHAIN, ixIndex: ix, receivedAt: at(arrives) + extraMs },
  key: `${HOLE_FETCH_PREFIX}${VIA}`, value: { value: { signature: sig, found }, source: 'worker', backfilled: false, seq: n++ },
});

/** A pump event of a fetched transaction (create pool, graduation, migration), at its slot. */
const lifecycleEv = (name: string, data: Record<string, unknown>, slot: bigint, i: number): MarketEvent => ({
  kind: 'market', id: `ev:life${i}:00000:00000`, moment: { slot, txIndex: 2 ** 32 + i, ixIndex: 1, receivedAt: at(slot) },
  key: `${name === 'CreatePoolEvent' ? 'pump_amm' : 'pump'}:${name}:${MINT}`,
  value: { event: { program: name === 'CreatePoolEvent' ? 'pump_amm' : 'pump', name, data, signature: `life${i}`, slot, txIndex: 0, outerIx: 0, innerIx: 0 }, txSlot: slot, blockTime: null, source: 'helius', backfilled: false, seq: n++ },
});

/** The stream started, the coin graduated and migrated to POOL, and the fixture read (the chain's base) applied. */
const opened = (): { world: FactWorld; state: PoolState } => {
  const read = (): MarketEvent => offchain(RAW.accounts(MINT), { ...FIX.accountsRead, slot: R }, R, at(R), 'helius');
  const p = parsePool(new FactWorld().push(read()).last(poolKey(MINT)))!;
  const state: PoolState = { baseReserve: p.baseVault, quoteVault: p.quoteVault, virtualQuoteReserves: p.pool.virtualQuoteReserves ?? 0n };
  const world = new FactWorld();
  const P = R - 5n;
  world.push(
    coverage(STREAM, 'start', { fromSlot: P - 1n, via: VIA }, P - 2n, at(P - 2n)),
    lifecycleEv('CompleteEvent', { mint: MINT, timestamp: stamp(P - 1n) }, P - 1n, 0),
    lifecycleEv('CreatePoolEvent', { timestamp: stamp(P), baseMint: MINT, pool: POOL, poolQuoteAmount: state.quoteVault, poolBaseAmount: state.baseReserve }, P, 1),
    lifecycleEv('CompletePumpAmmMigrationEvent', { mint: MINT, pool: POOL, timestamp: stamp(P) }, P, 2),
    read(),
  );
  return { world, state };
};

/** Five chained swaps, one a slot, from the read's state. */
const tape = (state: PoolState): Swap[] => {
  const out: Swap[] = [];
  let pre = state;
  const sizes = [1_000_000n, 3_000_000n, 2_000_000n, 1_500_000n, 2_500_000n];
  sizes.forEach((b, i) => {
    const s = swap(i % 2 === 0 ? 'buy' : 'sell', pre, state.baseReserve / 1000n + b, R + 1n + BigInt(i));
    out.push(s);
    pre = s.after;
  });
  return out;
};

const now = (slot: bigint): Moment => ({ slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: at(slot) + 100 });
const H = R + 7n;
const head = (w: FactWorld): FactWorld => w.push(slotNotice(H, at(H) + 50));
const candles = (w: FactWorld) => parseCandles(w.last(candlesKey(MINT)))!;
const gapFree = (w: FactWorld) => (w.last(streamKey(STREAM)) as { gapFreeSince: bigint }).gapFreeSince;
const verdicts = (w: FactWorld) => {
  const e = new Evidence(w.ctx(now(H)), policy);
  const c = e.read('candles', candlesKey(MINT), parseCandles, 'state', 'H11');
  const p = e.read('pool', poolKey(MINT), parsePool, 'state', 'H12');
  return { candles: c.ok ? 'ok' : `${c.reason.gate}:${c.reason.code}`, pool: p.ok ? 'ok' : `${p.reason.gate}:${p.reason.code}` };
};
/** A fact without its receipt time (a healed fact is known when the heal ran; the complete tape's earlier). */
const noReceipt = (v: unknown): unknown => {
  const o = v as { obs: Record<string, unknown> };
  const { receivedAt: _r, ...obs } = o.obs;
  return { ...o, obs };
};

/** The swap as the backtest's dataset delivers it: its fetched transaction's `ev:` event, at its own slot (review N1). */
const txOf = (x: Swap, k = 0): MarketEvent => ({
  kind: 'market', id: `ev:${x.sig}:00000:00000`, moment: { slot: x.slot, txIndex: 2 ** 32 + k, ixIndex: 1, receivedAt: at(x.slot) + k },
  key: `pump_amm:${x.name}:${POOL}`,
  value: { event: { program: 'pump_amm', name: x.name, data: x.data, signature: x.sig, slot: x.slot, txIndex: k, outerIx: 0, innerIx: 0 }, txSlot: x.slot, blockTime: null, source: 'helius', backfilled: false, seq: n++ },
});

/** The complete tape in the backtest's shape: every swap from its transaction, none from a log line. */
const completeTx = () => {
  const { world, state } = opened();
  const s = tape(state);
  world.push(...s.map((x) => txOf(x)));
  return { world: head(world), s };
};

/** The complete tape: every swap's log line. */
const complete = () => {
  const { world, state } = opened();
  const s = tape(state);
  world.push(...s.map((x) => logOf(x)));
  return { world: head(world), s };
};

/** The same tape with swap 3 (index 2) cut on the watch, its transaction fetched after swap 5, then the outcome. */
const cut = (o: { found?: boolean; send?: 'none' | 'tx' | 'both'; fetchedSwaps?: (s: Swap[]) => Swap[] } = {}) => {
  const { world, state } = opened();
  const s = tape(state);
  world.push(logOf(s[0]!), logOf(s[1]!), hole(s[2]!.sig, s[2]!.slot), logOf(s[3]!), logOf(s[4]!));
  const arrives = R + 6n;
  const send = o.send ?? 'both';
  if (send !== 'none') world.push(...fetchedSwaps(s[2]!.sig, s[2]!.slot, arrives, o.fetchedSwaps?.(s) ?? [s[2]!]));
  if (send === 'both') world.push(outcome(s[2]!.sig, o.found ?? true, arrives));
  return { world: head(world), s };
};


/** A log line delivered late: placed off-chain at `arrives` (LATE-LOG), its own slot only in `txSlot`. */
const lateLog = (s: Swap, arrives: bigint): MarketEvent => {
  const e = logOf(s);
  return { ...e, id: `${e.id}#late${n++}`, moment: { slot: arrives, txIndex: OFF_CHAIN, ixIndex: 1 + n, receivedAt: at(arrives) + 30 } };
};

/** A slot with a big buy A and a sell B on A's reserves, then a quiet slot. */
const pair = (state: PoolState) => {
  const a = swap('buy', state, state.baseReserve / 4n, R + 1n);
  const b = swap('sell', a.after, state.baseReserve / 1000n, R + 1n);
  return { a, b };
};

describe('LATE-LOG review HIGH-1: two swaps of one slot out of chain order', () => {
  it('in chain order: the candles are complete (control)', () => {
    const { world, state } = opened();
    const { a, b } = pair(state);
    head(world.push(logOf(a, 0), logOf(b, 1)));
    expect(candles(world).obs.quality).toEqual([]);
    expect(verdicts(world).candles).toBe('ok');
  });

  it('the later one on time, the earlier one late: not applied, the candles go partial (fails before the guard)', () => {
    const { world, state } = opened();
    const { a, b } = pair(state);
    head(world.push(logOf(b, 0), lateLog(a, R + 4n)));
    expect(candles(world).obs.quality).toEqual(['partial']);
    expect(verdicts(world).candles).not.toBe('ok');
  });

  it('both on time in reverse arrival order: partial too (fails before the guard)', () => {
    const { world, state } = opened();
    const { a, b } = pair(state);
    head(world.push(logOf(b, 0), logOf(a, 1)));
    expect(candles(world).obs.quality).toEqual(['partial']);
    expect(verdicts(world).candles).not.toBe('ok');
  });
});

describe('LATE-LOG review LOW-3: a late cut log\'s hole is at its own slot', () => {
  it('the gap is at the transaction\'s slot, not the off-chain slot it was placed in (fails before)', () => {
    const { world, state } = opened();
    const s = tape(state);
    const cutAt = s[1]!.slot;
    world.push(logOf(s[0]!), { ...hole(s[1]!.sig, R + 6n), moment: { slot: R + 6n, txIndex: OFF_CHAIN, ixIndex: 3, receivedAt: at(R + 6n) }, value: { signature: s[1]!.sig, txSlot: cutAt, source: 'helius', backfilled: false, seq: n++ } });
    head(world);
    expect(gapFree(world)).toBe(cutAt + 1n);
  });
});

describe('LATE-LOG review LOW-4: a refused swap is never a heal\'s anchor', () => {
  it('a late-behind swap refused, then a hole healed from its fetched transaction: the heal anchors on the last applied swap (fails before)', () => {
    const { world, state } = opened();
    const s = tape(state);
    // A real swap of slot R+1 that the watch delivered late, after s[1] (slot R+2): refused, not applied.
    const x = swap('buy', state, state.baseReserve / 2000n, R + 1n);
    world.push(logOf(s[0]!), logOf(s[1]!), lateLog(x, R + 2n));
    world.push(hole(s[2]!.sig, s[2]!.slot), logOf(s[3]!), logOf(s[4]!));
    world.push(...fetchedSwaps(s[2]!.sig, s[2]!.slot, R + 6n, [s[2]!]), outcome(s[2]!.sig, true, R + 6n));
    head(world);
    // Healed: the hole is out of the stream's gaps (the late swap keeps the candles partial).
    expect(gapFree(world)).toBeLessThan(R);
    expect(candles(world).obs.quality).toEqual(['partial']);
  });
});
