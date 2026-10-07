// Red-team kit: the TRADE-GAP-HEAL test helpers (copied from facts/trade-heal.test.ts, unexported there), plus the
// late-migration helpers of its POOL-FIRST-READ part 3 block. Test support only.
import { type PoolState, poolBuyExactBase, poolSell } from '../../src/amm/index.ts';
import { startSession, TRIAL_POLICY } from '../../src/config/index.ts';
import { OFF_CHAIN, type MarketEvent, type Moment } from '../../src/engine/index.ts';
import { HOLE_FETCH_PREFIX, RAW, STREAMS } from '../../src/facts/index.ts';
import { observedFeeContext } from '../../src/fills/index.ts';
import { Evidence, candlesKey, parseCandles, parsePool, poolKey, streamKey } from '../../src/gates/index.ts';
import { bps } from '../../src/units/index.ts';
import { FIX, FactWorld, MINT, POOL, coverage, offchain, slotNotice } from '../facts/helpers.ts';

export const policy = startSession(TRIAL_POLICY).policy;
export const R = BigInt(FIX.accountsRead.slot);
export const T0 = 1_791_100_000_000;
export const STREAM = STREAMS.trades(POOL);
export const VIA = `logs:${POOL}`;
export const FEES = { split: { lp: bps(2), protocol: bps(93), creator: bps(30) }, buybackFeeBps: bps(5_000), instruction: 'v1' as const };
export const SUPPLY = 1_000_000_000_000_000n;
export const ctx = observedFeeContext(FEES, SUPPLY, { mayhemMode: false, transferFee: false, transferHook: false });
/** No fees at all: a buy and a sell of the same base can bring the reserves back exactly. */
export const ZERO = { split: { lp: bps(0), protocol: bps(0), creator: bps(0) }, buybackFeeBps: bps(0), instruction: 'v1' as const };
export const ctx0 = observedFeeContext(ZERO, SUPPLY, { mayhemMode: false, transferFee: false, transferHook: false });

/** Receipt time of a slot; trade timestamps step 25 s a slot, so the candles span several minutes. */
export const at = (slot: bigint): number => T0 + Number(slot - R) * 400;
export const stamp = (slot: bigint): bigint => BigInt(Math.floor(T0 / 1000)) + (slot - R) * 25n;

export interface Swap {
  readonly sig: string;
  readonly slot: bigint;
  readonly after: PoolState;
  readonly name: 'BuyEvent' | 'SellEvent';
  readonly data: Record<string, unknown>;
}

export let n = 0;
/** A swap on `pre`, its amounts from the exact math. */
export const swap = (side: 'buy' | 'sell', pre: PoolState, base: bigint, slot: bigint, free = false): Swap => {
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
export const logOf = (s: Swap, k = 0, truncated = false): MarketEvent => ({
  kind: 'market', id: `log:${s.sig}:confirmed:00000`, moment: { slot: s.slot, txIndex: 2 ** 32 + k, ixIndex: 2 ** 36, receivedAt: at(s.slot) + k },
  key: `logs:pump_amm:${s.name}:${POOL}`,
  value: { event: { program: 'pump_amm', name: s.name, data: s.data, logIndex: 0 }, signature: s.sig, txSlot: s.slot, truncated, via: VIA, commitment: 'confirmed', source: 'helius', backfilled: false, seq: n++ },
});

/** A cut log with no event left (`logs:truncated:`), or one DEC-1 cannot read (`logs:undecodable:`), at its slot. */
export const hole = (sig: string, slot: bigint, kind: 'truncated' | 'undecodable' = 'truncated', k = 0): MarketEvent => ({
  kind: 'market', id: `log:${sig}:confirmed:${kind}`, moment: { slot, txIndex: 2 ** 32 + k, ixIndex: 2 ** 36, receivedAt: at(slot) + k },
  key: `logs:${kind}:${VIA}`, value: { signature: sig, source: 'helius', backfilled: false, seq: n++ },
});

/** A fetched transaction's events (`ev:`), released late: off-chain at `arrives`. */
export const fetched = (sig: string, slot: bigint, arrives: bigint, events: readonly { name: string; data?: Record<string, unknown> }[], ix = 1): MarketEvent[] =>
  events.map((e, i) => ({
    kind: 'market', id: `ev:${sig}:00000:${String(i).padStart(5, '0')}`, moment: { slot: arrives, txIndex: OFF_CHAIN, ixIndex: ix, receivedAt: at(arrives) + 10 },
    key: `pump_amm:${e.name}:${POOL}`,
    value: { event: { program: 'pump_amm', name: e.name, ...(e.data === undefined ? { discriminator: '0011223344556677' } : { data: e.data }), signature: sig, slot, txIndex: 0, outerIx: 0, innerIx: i }, txSlot: slot, blockTime: null, source: 'helius', backfilled: false, seq: n++ },
  }));
export const fetchedSwaps = (sig: string, slot: bigint, arrives: bigint, swaps: readonly Swap[], ix = 1): MarketEvent[] => fetched(sig, slot, arrives, swaps.map((s) => ({ name: s.name, data: s.data })), ix);

/** WORKER-1's fetch outcome for a hole, after the fetched transaction's events. */
export const outcome = (sig: string, found: boolean, arrives: bigint, extraMs = 20, ix = 2): MarketEvent => ({
  kind: 'market', id: `${HOLE_FETCH_PREFIX}${VIA}#${n++}`, moment: { slot: arrives, txIndex: OFF_CHAIN, ixIndex: ix, receivedAt: at(arrives) + extraMs },
  key: `${HOLE_FETCH_PREFIX}${VIA}`, value: { value: { signature: sig, found }, source: 'worker', backfilled: false, seq: n++ },
});

/** A pump event of a fetched transaction (create pool, graduation, migration), at its slot. */
export const lifecycleEv = (name: string, data: Record<string, unknown>, slot: bigint, i: number): MarketEvent => ({
  kind: 'market', id: `ev:life${i}:00000:00000`, moment: { slot, txIndex: 2 ** 32 + i, ixIndex: 1, receivedAt: at(slot) },
  key: `${name === 'CreatePoolEvent' ? 'pump_amm' : 'pump'}:${name}:${MINT}`,
  value: { event: { program: name === 'CreatePoolEvent' ? 'pump_amm' : 'pump', name, data, signature: `life${i}`, slot, txIndex: 0, outerIx: 0, innerIx: 0 }, txSlot: slot, blockTime: null, source: 'helius', backfilled: false, seq: n++ },
});

/** The stream started, the coin graduated and migrated to POOL, and the fixture read (the chain's base) applied. */
export const opened = (): { world: FactWorld; state: PoolState } => {
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
export const tape = (state: PoolState): Swap[] => {
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

export const now = (slot: bigint): Moment => ({ slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: at(slot) + 100 });
export const H = R + 7n;
export const head = (w: FactWorld): FactWorld => w.push(slotNotice(H, at(H) + 50));
export const candles = (w: FactWorld) => parseCandles(w.last(candlesKey(MINT)))!;
export const gapFree = (w: FactWorld) => (w.last(streamKey(STREAM)) as { gapFreeSince: bigint }).gapFreeSince;
export const verdicts = (w: FactWorld) => {
  const e = new Evidence(w.ctx(now(H)), policy);
  const c = e.read('candles', candlesKey(MINT), parseCandles, 'state', 'H11');
  const p = e.read('pool', poolKey(MINT), parsePool, 'state', 'H12');
  return { candles: c.ok ? 'ok' : `${c.reason.gate}:${c.reason.code}`, pool: p.ok ? 'ok' : `${p.reason.gate}:${p.reason.code}` };
};
/** A fact without its receipt time (a healed fact is known when the heal ran; the complete tape's earlier). */
export const noReceipt = (v: unknown): unknown => {
  const o = v as { obs: Record<string, unknown> };
  const { receivedAt: _r, ...obs } = o.obs;
  return { ...o, obs };
};

/** The swap as the backtest's dataset delivers it: its fetched transaction's `ev:` event, at its own slot (review N1). */
export const txOf = (x: Swap, k = 0): MarketEvent => ({
  kind: 'market', id: `ev:${x.sig}:00000:00000`, moment: { slot: x.slot, txIndex: 2 ** 32 + k, ixIndex: 1, receivedAt: at(x.slot) + k },
  key: `pump_amm:${x.name}:${POOL}`,
  value: { event: { program: 'pump_amm', name: x.name, data: x.data, signature: x.sig, slot: x.slot, txIndex: k, outerIx: 0, innerIx: 0 }, txSlot: x.slot, blockTime: null, source: 'helius', backfilled: false, seq: n++ },
});

/** The complete tape in the backtest's shape: every swap from its transaction, none from a log line. */
export const completeTx = () => {
  const { world, state } = opened();
  const s = tape(state);
  world.push(...s.map((x) => txOf(x)));
  return { world: head(world), s };
};

/** The complete tape: every swap's log line. */
export const complete = () => {
  const { world, state } = opened();
  const s = tape(state);
  world.push(...s.map((x) => logOf(x)));
  return { world: head(world), s };
};

/** The same tape with swap 3 (index 2) cut on the watch, its transaction fetched after swap 5, then the outcome. */
export const cut = (o: { found?: boolean; send?: 'none' | 'tx' | 'both'; fetchedSwaps?: (s: Swap[]) => Swap[] } = {}) => {
  const { world, state } = opened();
  const s = tape(state);
  world.push(logOf(s[0]!), logOf(s[1]!), hole(s[2]!.sig, s[2]!.slot), logOf(s[3]!), logOf(s[4]!));
  const arrives = R + 6n;
  const send = o.send ?? 'both';
  if (send !== 'none') world.push(...fetchedSwaps(s[2]!.sig, s[2]!.slot, arrives, o.fetchedSwaps?.(s) ?? [s[2]!]));
  if (send === 'both') world.push(outcome(s[2]!.sig, o.found ?? true, arrives));
  return { world: head(world), s };
};


export { FactWorld, MINT, POOL, FIX, coverage, offchain, slotNotice, OFF_CHAIN, RAW, STREAMS, candlesKey, poolKey, streamKey, parseCandles, parsePool };
export type { MarketEvent, Moment, PoolState };
export const P = R - 5n;
/** A pump event of the migration transaction, fetched late: off-chain at `arrives`, its own slot `slot`. */
export const lateLife = (name: string, data: Record<string, unknown>, slot: bigint, arrives: bigint, i: number): MarketEvent => ({
  kind: 'market', id: `ev:late${i}:00000:${String(i).padStart(5, '0')}`, moment: { slot: arrives, txIndex: OFF_CHAIN, ixIndex: i, receivedAt: at(arrives) + 10 + i },
  key: `${name === 'CreatePoolEvent' ? 'pump_amm' : 'pump'}:${name}:${MINT}`,
  value: { event: { program: name === 'CreatePoolEvent' ? 'pump_amm' : 'pump', name, data, signature: 'migrationtx', slot, txIndex: 0, outerIx: 0, innerIx: i }, txSlot: slot, blockTime: null, source: 'helius', backfilled: false, seq: n++ },
});
export const migration = (state: PoolState, arrives: bigint): MarketEvent[] => [
  lateLife('CompleteEvent', { mint: MINT, timestamp: stamp(P - 1n) }, P - 1n, arrives, 0),
  lateLife('CreatePoolEvent', { timestamp: stamp(P), baseMint: MINT, pool: POOL, poolQuoteAmount: state.quoteVault, poolBaseAmount: state.baseReserve }, P, arrives, 1),
  lateLife('CompletePumpAmmMigrationEvent', { mint: MINT, pool: POOL, timestamp: stamp(P) }, P, arrives, 2),
];
export const readEv = (): MarketEvent => offchain(RAW.accounts(MINT), { ...FIX.accountsRead, slot: R }, R, at(R), 'helius');
export const startEv = (): MarketEvent => coverage(STREAM, 'start', { fromSlot: P - 1n, via: VIA }, P - 2n, at(P - 2n));
export const nextN = (): number => n++;
