// TRADE-GAP-HEAL: a cut or undecodable log on a pool's trade stream is a hole; once WORKER-1 has fetched the hole's
// transaction (its events released, then its `hole-fetch:` outcome), the producer puts every swap since the book's mark
// in exact chain order and heals the hole only when the reserves chain is exact again. Fail closed otherwise. Swaps
// here continue the fixture pool's real read; each one's logged amounts come from the exact PumpSwap math.
import { describe, expect, it } from 'vitest';
import { type PoolState, poolBuyExactBase, poolSell } from '../../src/amm/index.ts';
import { startSession, TRIAL_POLICY } from '../../src/config/index.ts';
import { OFF_CHAIN, type MarketEvent, type Moment } from '../../src/engine/index.ts';
import { HEAL_TAPE_MAX, HEAL_TAPES_TOTAL, HEAL_WAIT_MS, HOLE_FETCH_PREFIX, PRE_READ_KEEP, PRE_READ_POOLS, RAW, STREAMS, type SwapEv, chainOrder } from '../../src/facts/index.ts';
import { observedFeeContext } from '../../src/fills/index.ts';
import { Evidence, candlesKey, parseCandles, parsePool, poolKey, streamKey } from '../../src/gates/index.ts';
import { bps } from '../../src/units/index.ts';
import { FIX, FactWorld, MINT, OPTIONS, POOL, coverage, offchain, slotNotice } from './helpers.ts';

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
const opened = (world = new FactWorld()): { world: FactWorld; state: PoolState } => {
  const read = (): MarketEvent => offchain(RAW.accounts(MINT), { ...FIX.accountsRead, slot: R }, R, at(R), 'helius');
  const p = parsePool(new FactWorld().push(read()).last(poolKey(MINT)))!;
  const state: PoolState = { baseReserve: p.baseVault, quoteVault: p.quoteVault, virtualQuoteReserves: p.pool.virtualQuoteReserves ?? 0n };
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
const cut = (o: { found?: boolean; send?: 'none' | 'tx' | 'both'; fetchedSwaps?: (s: Swap[]) => Swap[]; world?: FactWorld } = {}) => {
  const { world, state } = opened(o.world);
  const s = tape(state);
  world.push(logOf(s[0]!), logOf(s[1]!), hole(s[2]!.sig, s[2]!.slot), logOf(s[3]!), logOf(s[4]!));
  const arrives = R + 6n;
  const send = o.send ?? 'both';
  if (send !== 'none') world.push(...fetchedSwaps(s[2]!.sig, s[2]!.slot, arrives, o.fetchedSwaps?.(s) ?? [s[2]!]));
  if (send === 'both') world.push(outcome(s[2]!.sig, o.found ?? true, arrives));
  return { world: head(world), s };
};

describe('a hole in a pool\'s trade stream, healed by its fetched transaction (TRADE-GAP-HEAL)', () => {
  it('the complete tape: candles and pool current, H11 and H12 pass', () => {
    const { world } = complete();
    expect(verdicts(world)).toEqual({ candles: 'ok', pool: 'ok' });
  });

  it('a cut log alone is a gap: H11 refuses (H16 gap) and the pool is stale until a later swap re-bases it', () => {
    const { world } = cut({ send: 'none' });
    expect(gapFree(world)).toBe(R + 4n);
    expect(verdicts(world).candles).toBe('H16:gap');
  });

  it('a cut log, then its fetched transaction and the found outcome: the hole heals and every fact equals the complete tape', () => {
    const a = cut();
    const b = complete();
    expect(gapFree(a.world)).toBe(gapFree(b.world));
    expect(noReceipt(candles(a.world))).toEqual(noReceipt(candles(b.world)));
    expect(noReceipt(a.world.last(poolKey(MINT)))).toEqual(noReceipt(b.world.last(poolKey(MINT))));
    expect(verdicts(a.world)).toEqual({ candles: 'ok', pool: 'ok' });
    expect(verdicts(a.world)).toEqual(verdicts(b.world));
    // Every fact key either tape released ends at the same value (receipt times aside).
    const lastFacts = (w: FactWorld) => {
      const out = new Map<string, unknown>();
      for (const e of w.released) if (e.id.includes('~')) out.set(e.key, noReceipt(e.value));
      return [...out].sort(([x], [y]) => (x < y ? -1 : 1));
    };
    expect(lastFacts(a.world)).toEqual(lastFacts(b.world));
    // And the backtest's shape of the same tape (full transactions, no log lines) reaches the same facts and verdicts.
    const c = completeTx();
    const sourceless = (w: FactWorld) => lastFacts(w).map(([k, v]) => [k, { ...(v as { obs: object }), obs: { ...(v as { obs: object }).obs, provider: '-' } }]);
    expect(sourceless(c.world)).toEqual(sourceless(a.world));
    expect(verdicts(c.world)).toEqual(verdicts(a.world));
    // No lookahead: the healed facts are released at the outcome's moment, not before.
    const healed = a.world.facts(candlesKey(MINT)).at(-1)!;
    expect(healed.moment.slot).toBe(R + 6n);
    expect(healed.id.startsWith(HOLE_FETCH_PREFIX)).toBe(true);
  });

  it('an undecodable log heals the same way', () => {
    const { world, state } = opened();
    const s = tape(state);
    world.push(logOf(s[0]!), logOf(s[1]!), hole(s[2]!.sig, s[2]!.slot, 'undecodable'), logOf(s[3]!), logOf(s[4]!));
    world.push(...fetchedSwaps(s[2]!.sig, s[2]!.slot, R + 6n, [s[2]!]), outcome(s[2]!.sig, true, R + 6n));
    head(world);
    expect(noReceipt(candles(world))).toEqual(noReceipt(candles(complete().world)));
    expect(verdicts(world)).toEqual({ candles: 'ok', pool: 'ok' });
  });

  it('a log cut after its first swap (two swaps in the transaction): the fetched copy brings the second, the first counts once', () => {
    // Complete: swap 3 and swap 3b in one transaction at slot R+3.
    const build = (cutIt: boolean) => {
      const { world, state } = opened();
      const s = tape(state);
      const s3b = swap('buy', s[2]!.after, 777_777n, s[2]!.slot);
      const s3bSig = { ...s3b, sig: s[2]!.sig };
      const s4 = swap('sell', s3b.after, 1_234_567n, R + 4n);
      const s5 = swap('buy', s4.after, 2_345_678n, R + 5n);
      const logs: MarketEvent[] = [logOf(s[0]!), logOf(s[1]!)];
      if (cutIt) logs.push(logOf(s[2]!, 0, true));
      else logs.push(logOf(s[2]!), { ...logOf(s3bSig), id: `log:${s[2]!.sig}:confirmed:00001` });
      logs.push(logOf(s4), logOf(s5));
      world.push(...logs);
      if (cutIt) world.push(...fetchedSwaps(s[2]!.sig, s[2]!.slot, R + 6n, [s[2]!, s3bSig]), outcome(s[2]!.sig, true, R + 6n));
      return head(world);
    };
    const a = build(true);
    const b = build(false);
    expect(noReceipt(candles(a))).toEqual(noReceipt(candles(b)));
    expect(noReceipt(a.last(poolKey(MINT)))).toEqual(noReceipt(b.last(poolKey(MINT))));
    expect(verdicts(a)).toEqual({ candles: 'ok', pool: 'ok' });
  });

  it('a failed fetch keeps the gap: not found, no outcome yet (pending), or none at all within the wait (capped or never sent)', () => {
    expect(verdicts(cut({ found: false }).world).candles).toBe('H16:gap');
    expect(gapFree(cut({ found: false }).world)).toBe(R + 4n);
    // Its transaction released but no outcome yet: still pending.
    expect(verdicts(cut({ send: 'tx' }).world).candles).toBe('H16:gap');
    // A found outcome that comes after the wait (or a capped fetch that never sends one): the hole stays.
    const { world, state } = opened();
    const s = tape(state);
    world.push(logOf(s[0]!), logOf(s[1]!), hole(s[2]!.sig, s[2]!.slot), logOf(s[3]!), logOf(s[4]!));
    const late = R + 6n;
    world.push(...fetchedSwaps(s[2]!.sig, s[2]!.slot, late, [s[2]!]), outcome(s[2]!.sig, true, late, HEAL_WAIT_MS + 1_000));
    head(world);
    expect(verdicts(world).candles).toBe('H16:gap');
  });

  it('a found outcome with no swap released (the transaction did not carry the missing swap): the chain does not hold, the hole stays', () => {
    const { world } = cut({ fetchedSwaps: () => [] });
    expect(verdicts(world).candles).toBe('H16:gap');
    expect(gapFree(world)).toBe(R + 4n);
  });

  it('a hole that hides a reserves change heals only when the chain is exact: a fetched swap that does not chain keeps it', () => {
    // The fetched transaction carries a swap whose amounts differ from what happened (it does not reach swap 4's start).
    const { world } = cut({ fetchedSwaps: (s) => [swap('buy', s[1]!.after, 999n, s[2]!.slot)].map((x) => ({ ...x, sig: s[2]!.sig })) });
    expect(verdicts(world).candles).toBe('H16:gap');
    // A swap missed outside the hole (swap 4's log never came): the chain breaks there, so the hole is not healed.
    const { world: w2, state } = opened();
    const s = tape(state);
    w2.push(logOf(s[0]!), logOf(s[1]!), hole(s[2]!.sig, s[2]!.slot), logOf(s[4]!));
    w2.push(...fetchedSwaps(s[2]!.sig, s[2]!.slot, R + 6n, [s[2]!]), outcome(s[2]!.sig, true, R + 6n));
    head(w2);
    expect(verdicts(w2).candles).toBe('H16:gap');
  });

  it('a hole whose transaction also moved the pool another way (a deposit, an unnamed event) is never healed', () => {
    const { world, state } = opened();
    const s = tape(state);
    world.push(logOf(s[0]!), logOf(s[1]!), hole(s[2]!.sig, s[2]!.slot), logOf(s[3]!), logOf(s[4]!));
    world.push(...fetched(s[2]!.sig, s[2]!.slot, R + 6n, [{ name: s[2]!.name, data: s[2]!.data }, { name: 'other' }]), outcome(s[2]!.sig, true, R + 6n));
    head(world);
    expect(verdicts(world).candles).toBe('H16:gap');
  });

  it('out of order: same-slot swaps released in the wrong order, and the hole\'s swap fetched last, are put back in chain order', () => {
    // Complete: s0, s1, then at slot R+3: s2 and s2b (s2 first on chain), then s3, s4.
    const build = (mode: 'complete' | 'scrambled') => {
      const { world, state } = opened();
      const s = tape(state);
      const s2b = swap('sell', s[2]!.after, 444_444n, s[2]!.slot);
      const s3 = swap('buy', s2b.after, 1_111_111n, R + 4n);
      const s4 = swap('sell', s3.after, 2_222_222n, R + 5n);
      if (mode === 'complete') world.push(logOf(s[0]!), logOf(s[1]!), logOf(s[2]!, 0), logOf(s2b, 1), logOf(s3), logOf(s4));
      else {
        // s2b's log arrives first in its slot; s2's log is cut (released after it); s2 is fetched last.
        world.push(logOf(s[0]!), logOf(s[1]!), logOf(s2b, 0), hole(s[2]!.sig, s[2]!.slot, 'truncated', 1), logOf(s3), logOf(s4));
        world.push(...fetchedSwaps(s[2]!.sig, s[2]!.slot, R + 6n, [s[2]!]), outcome(s[2]!.sig, true, R + 6n));
      }
      return head(world);
    };
    const a = build('scrambled');
    const b = build('complete');
    expect(noReceipt(candles(a))).toEqual(noReceipt(candles(b)));
    expect(noReceipt(a.last(poolKey(MINT)))).toEqual(noReceipt(b.last(poolKey(MINT))));
    expect(verdicts(a)).toEqual({ candles: 'ok', pool: 'ok' });
  });

  it('two holes heal only once both transactions are in; a later swap keeps chaining on the healed state', () => {
    const { world, state } = opened();
    const s = tape(state);
    world.push(logOf(s[0]!), hole(s[1]!.sig, s[1]!.slot), logOf(s[2]!), hole(s[3]!.sig, s[3]!.slot), logOf(s[4]!));
    world.push(slotNotice(R + 6n, at(R + 6n)), ...fetchedSwaps(s[1]!.sig, s[1]!.slot, R + 6n, [s[1]!]), outcome(s[1]!.sig, true, R + 6n));
    expect(gapFree(world)).toBe(R + 5n);
    world.push(...fetchedSwaps(s[3]!.sig, s[3]!.slot, R + 6n, [s[3]!], 3), outcome(s[3]!.sig, true, R + 6n, 30, 4));
    head(world);
    expect(noReceipt(candles(world))).toEqual(noReceipt(candles(complete().world)));
    expect(verdicts(world)).toEqual({ candles: 'ok', pool: 'ok' });
    // The next swap applies on the healed chain, clean.
    const s6 = swap('buy', s[4]!.after, 1_000_000n, H + 1n);
    world.push(logOf(s6), slotNotice(H + 1n, at(H + 1n) + 50));
    const p = parsePool(world.last(poolKey(MINT)))!;
    expect(p.obs.quality).toEqual([]);
    expect(p.baseVault).toBe(s6.after.baseReserve);
  });

  it('a hole before the book has a swap to anchor on stays (fail closed)', () => {
    const { world, state } = opened();
    const s = tape(state);
    world.push(hole(s[0]!.sig, s[0]!.slot), logOf(s[1]!), logOf(s[2]!), logOf(s[3]!), logOf(s[4]!));
    world.push(...fetchedSwaps(s[0]!.sig, s[0]!.slot, R + 6n, [s[0]!]), outcome(s[0]!.sig, true, R + 6n));
    head(world);
    expect(verdicts(world).candles).toBe('H16:gap');
    // The hole's late fetched swap is never applied out of order: the chain, re-based by the next swap, stays clean.
    expect(verdicts(world).pool).toBe('ok');
    expect(parsePool(world.last(poolKey(MINT)))!.baseVault).toBe(s[4]!.after.baseReserve);
  });

  /** A confirmed PumpSwap event on the pool's watch that is not a swap (a deposit; DEC-1 names it 'other' when it cannot). */
  const other = (slot: bigint, k = 9): MarketEvent => ({
    kind: 'market', id: `log:other${slot}:confirmed:00000`, moment: { slot, txIndex: 2 ** 32 + k, ixIndex: 2 ** 36, receivedAt: at(slot) + k },
    key: 'logs:pump_amm:other:pump_amm',
    value: { event: { program: 'pump_amm', name: 'other', discriminator: '0011223344556677', logIndex: 0 }, signature: `other${slot}`, txSlot: slot, truncated: false, via: VIA, commitment: 'confirmed', source: 'helius', backfilled: false, seq: n++ },
  });

  it('review B2: a deposit (or any other pool transaction) on the watch during the wait, after the last swap, blocks the heal: the pool stays stale, never priced from before it', () => {
    const { world, state } = opened();
    const s = tape(state);
    world.push(logOf(s[0]!), logOf(s[1]!), hole(s[2]!.sig, s[2]!.slot), logOf(s[3]!), logOf(s[4]!), other(R + 5n));
    world.push(...fetchedSwaps(s[2]!.sig, s[2]!.slot, R + 6n, [s[2]!]), outcome(s[2]!.sig, true, R + 6n));
    head(world);
    expect(verdicts(world).candles).toBe('H16:gap');
    expect((world.last(poolKey(MINT)) as { stale?: string }).stale).toBe('a pool transaction other than a swap (other)');
    expect(verdicts(world).pool).not.toBe('ok');
  });

  it('review B2: a chain already stale at the mark (a swap that did not chain from the read) is never marked clean by a heal', () => {
    const { world, state } = opened();
    // A swap nobody saw moved the pool after the read: s0 starts elsewhere, so the chain is stale (mismatch) from s0 on.
    const missed = swap('buy', state, 4_444_444n, R + 1n);
    const s = tape(missed.after);
    world.push(logOf(s[0]!), logOf(s[1]!), hole(s[2]!.sig, s[2]!.slot), logOf(s[3]!), logOf(s[4]!));
    expect((world.last(poolKey(MINT)) as { stale?: string }).stale).toMatch(/^reserves mismatch/);
    world.push(...fetchedSwaps(s[2]!.sig, s[2]!.slot, R + 6n, [s[2]!]), outcome(s[2]!.sig, true, R + 6n));
    head(world);
    // The candles heal (every swap since the book's mark chains); the chain needs a read.
    expect(verdicts(world).candles).toBe('ok');
    expect((world.last(poolKey(MINT)) as { stale?: string }).stale).toMatch(/^reserves mismatch/);
    expect(verdicts(world).pool).not.toBe('ok');
  });

  it('review B2: a chain stale at the mark (a stream gap its fill restored, no swap since to re-base it) stays stale after the heal: only a read or a swap clears it', () => {
    const { world, state } = opened();
    const s = tape(state);
    world.push(logOf(s[0]!), logOf(s[1]!));
    // A disconnect, then a fill that restored the range in full: no hole is left, but the chain went stale on the gap.
    world.push(
      coverage(STREAM, 'gap', { fromSlot: R + 3n, toSlot: null, reason: 'disconnect', via: VIA }, R + 2n, at(R + 2n) + 100),
      coverage(STREAM, 'resume', { fromSlot: R + 3n, toSlot: R + 3n, via: VIA }, R + 2n, at(R + 2n) + 200),
    );
    expect((world.last(poolKey(MINT)) as { stale?: string }).stale).toBe('swap stream gap');
    // The hole's swap is the last one: nothing re-bases the chain before the heal.
    world.push(hole(s[2]!.sig, s[2]!.slot));
    world.push(...fetchedSwaps(s[2]!.sig, s[2]!.slot, R + 6n, [s[2]!]), outcome(s[2]!.sig, true, R + 6n));
    head(world);
    // The candles heal (the stream has no hole left); the chain was not clean at the mark, so it is not set clean.
    expect(verdicts(world).candles).toBe('ok');
    expect((world.last(poolKey(MINT)) as { stale?: string }).stale).toBe('swap stream gap');
  });

  it('review N4: two swaps that could come next (a round trip back to the same reserves) leave the order unproven: no heal', () => {
    // No fees: buying half the base and selling it back returns the reserves exactly.
    const anchor = swap('sell', { baseReserve: 999_000_000n, quoteVault: 1_001_001_002n, virtualQuoteReserves: 0n }, 1_000_000n, R + 1n, true);
    const from = anchor.after;
    const a = swap('buy', from, from.baseReserve / 2n, R + 2n, true);
    const back = swap('sell', a.after, from.baseReserve / 2n, R + 2n, true);
    expect(back.after).toEqual(from);
    const c = swap('buy', from, 1_000n, R + 2n, true);
    const t = (x: Swap) => ({ ev: { name: x.name, data: x.data } as unknown as SwapEv, seen: { slot: x.slot } });
    // A, its exact reverse, then C chains; but A and C both start at the same reserves, so which came first is not
    // proven by the chain: no order.
    expect(chainOrder(from, [t(a), t(back), t(c)])).toBeNull();
    expect(chainOrder(from, [t(c)])).not.toBeNull();
  });

  it('review N4: a heal that holds more than HEAL_TAPE_MAX swaps is let go: the hole stays', () => {
    const { world, state } = opened();
    const s = tape(state);
    world.push(logOf(s[0]!), logOf(s[1]!), hole(s[2]!.sig, s[2]!.slot));
    // Past the hole: HEAL_TAPE_MAX + 1 tiny swaps, a few hundred a slot, all chained from swap 3's end.
    let pre = s[2]!.after;
    const per = 250;
    const many: Swap[] = [];
    for (let i = 0; i <= HEAL_TAPE_MAX; i++) {
      const x = swap(i % 2 === 0 ? 'buy' : 'sell', pre, 1_000_000n, R + 4n + BigInt(Math.floor(i / per)), false);
      many.push(x);
      pre = x.after;
    }
    const last = many.at(-1)!.slot;
    world.push(...many.map((x, i) => logOf(x, i % per)));
    world.push(...fetchedSwaps(s[2]!.sig, s[2]!.slot, last + 1n, [s[2]!]), outcome(s[2]!.sig, true, last + 1n));
    world.push(slotNotice(last + 2n, at(last + 2n) + 50));
    expect((world.last(streamKey(STREAM)) as { gapFreeSince: bigint }).gapFreeSince).toBe(s[2]!.slot + 1n);
  }, 120_000);

  it('MEM-FIXES: past the total cap on every heal\'s swaps, the heal that grew is let go and noted: the hole stays; at the cap it heals', () => {
    // The heal holds swaps 4 and 5 (taken after the hole) and the hole's own fetched swap 3: three swaps.
    const run = (total: number) => {
      const notes: string[] = [];
      const { world } = cut({ world: new FactWorld({ ...OPTIONS, healTapesTotal: total }, (l) => notes.push(l)) });
      return { gapFree: gapFree(world), verdicts: verdicts(world), notes, held: world.producer.sizes().healSwaps };
    };
    const healed = run(3);
    expect(healed).toEqual({ gapFree: gapFree(complete().world), verdicts: { candles: 'ok', pool: 'ok' }, notes: [], held: 0 });
    const capped = run(2);
    expect(capped.gapFree).toBe(R + 3n + 1n);
    expect(capped.verdicts.candles).not.toBe('ok');
    expect(capped.held).toBe(0);
    expect(capped.notes).toEqual([`Trade heal of pool ${POOL} let go: the heals held 3 swaps, over the total cap of 2; its holes stay.`]);
    // The live default: one pool's own cap.
    expect(HEAL_TAPES_TOTAL).toBe(HEAL_TAPE_MAX);
  });

  it('review N4: a hole released behind the book\'s newest trade slot (before its mark) is never healed, even by a transaction with no swap on the pool', () => {
    const { world, state } = opened();
    const s = tape(state);
    world.push(logOf(s[0]!), logOf(s[1]!), logOf(s[2]!));
    // A cut log of a transaction at slot R+2 (a swap on another pool, then the cut), released at R+3 behind swap 3.
    const late: MarketEvent = {
      kind: 'market', id: 'log:lateCut:confirmed:00000', moment: { slot: R + 3n, txIndex: 2 ** 32 + 50, ixIndex: 2 ** 36, receivedAt: at(R + 3n) + 50 },
      key: 'logs:pump_amm:BuyEvent:OtherPool111111111111111111111111111111111',
      value: { event: { program: 'pump_amm', name: 'BuyEvent', data: { ...s[0]!.data, pool: 'OtherPool111111111111111111111111111111111' }, logIndex: 0 }, signature: 'lateCut', txSlot: R + 2n, truncated: true, via: VIA, commitment: 'confirmed', source: 'helius', backfilled: false, seq: n++ },
    };
    world.push(late, logOf(s[3]!), logOf(s[4]!));
    world.push(...fetched('lateCut', R + 2n, R + 6n, []), outcome('lateCut', true, R + 6n));
    head(world);
    expect(gapFree(world)).toBe(R + 3n);
    expect(verdicts(world).candles).toBe('H16:gap');
  });
});

describe('a hole whose transaction holds a no-change PumpSwap event (POOL-FIRST-READ part 2)', () => {
  const withEvent = (d: string) => {
    const { world, state } = opened();
    const s = tape(state);
    world.push(logOf(s[0]!), logOf(s[1]!), hole(s[2]!.sig, s[2]!.slot), logOf(s[3]!), logOf(s[4]!));
    const arrives = R + 6n;
    const evs = fetched(s[2]!.sig, s[2]!.slot, arrives, [{ name: s[2]!.name, data: s[2]!.data }, { name: 'other' }]);
    const o = evs[1]!.value as { event: Record<string, unknown> };
    const tx = [evs[0]!, { ...evs[1]!, value: { ...o, event: { ...o.event, discriminator: d } } }];
    world.push(...tx, outcome(s[2]!.sig, true, arrives));
    return head(world);
  };

  it('a proven no-change event in it does not block the heal; any other unnamed one does', () => {
    expect(gapFree(withEvent('929fbdac925838f4'))).toBe(gapFree(complete().world));
    expect(gapFree(withEvent('6161d7905d92167c'))).toBe(gapFree(complete().world));
    expect(gapFree(withEvent('0011223344556677'))).toBe(R + 4n);
  });
});

describe('candles after a late migration (POOL-FIRST-READ part 3)', () => {
  // #263's finding: the book opens only at the migration's CreatePoolEvent, and swaps released before it were dropped:
  // with the migration released late (a re-read), the candles were [] and complete, and Evidence ok.
  const P = R - 5n;
  /** A pump event of the migration transaction, fetched late: off-chain at `arrives`, its own slot `slot`. */
  const lateLife = (name: string, data: Record<string, unknown>, slot: bigint, arrives: bigint, i: number): MarketEvent => ({
    kind: 'market', id: `ev:late${i}:00000:${String(i).padStart(5, '0')}`, moment: { slot: arrives, txIndex: OFF_CHAIN, ixIndex: i, receivedAt: at(arrives) + 10 + i },
    key: `${name === 'CreatePoolEvent' ? 'pump_amm' : 'pump'}:${name}:${MINT}`,
    value: { event: { program: name === 'CreatePoolEvent' ? 'pump_amm' : 'pump', name, data, signature: 'migrationtx', slot, txIndex: 0, outerIx: 0, innerIx: i }, txSlot: slot, blockTime: null, source: 'helius', backfilled: false, seq: n++ },
  });
  const migration = (state: PoolState, arrives: bigint): MarketEvent[] => [
    lateLife('CompleteEvent', { mint: MINT, timestamp: stamp(P - 1n) }, P - 1n, arrives, 0),
    lateLife('CreatePoolEvent', { timestamp: stamp(P), baseMint: MINT, pool: POOL, poolQuoteAmount: state.quoteVault, poolBaseAmount: state.baseReserve }, P, arrives, 1),
    lateLife('CompletePumpAmmMigrationEvent', { mint: MINT, pool: POOL, timestamp: stamp(P) }, P, arrives, 2),
  ];
  const readEv = (): MarketEvent => offchain(RAW.accounts(MINT), { ...FIX.accountsRead, slot: R }, R, at(R), 'helius');
  /** The stream started and the pool read, the swaps' log lines, then the migration's transaction (late). */
  const late = (swaps: (state: PoolState) => Swap[], arrives = R + 6n) => {
    const { state } = opened();
    const s = swaps(state);
    const world = new FactWorld().push(coverage(STREAM, 'start', { fromSlot: P - 1n, via: VIA }, P - 2n, at(P - 2n)), readEv(), ...s.map((x) => logOf(x)), ...migration(state, arrives));
    return { world: head(world), s, state };
  };

  it('the late migration\'s candles and pool equal the in-order tape\'s, and H11 and H12 pass', () => {
    const a = late(tape);
    const b = complete();
    expect(candles(a.world).candles.length).toBeGreaterThan(0);
    expect(noReceipt(candles(a.world))).toEqual(noReceipt(candles(b.world)));
    expect((a.world.last(candlesKey(MINT)) as { completeness?: string }).completeness).toBe((b.world.last(candlesKey(MINT)) as { completeness?: string }).completeness);
    expect(noReceipt(a.world.last(poolKey(MINT)))).toEqual(noReceipt(b.world.last(poolKey(MINT))));
    expect(verdicts(a.world)).toEqual({ candles: 'ok', pool: 'ok' });
    // Both the chain (read first) and the book (migration last) now hold them: nothing is kept.
    expect(a.world.producer.sizes().preReads).toBe(0);
  });

  it('the migration transaction\'s own swap (after its CreatePoolEvent) comes before the kept swaps: candles equal the in-order run', () => {
    const { state } = opened();
    const s = tape(state);
    // The migration's own buy, logged after its CreatePoolEvent in the same transaction (mainnet: CreatePool, InitBoost,
    // CompletePumpAmmMigration, Buy).
    const own = swap('buy', state, 2_000_000n, P);
    const ownEv = (moment: Moment): MarketEvent => ({
      kind: 'market', id: `ev:migrationtx:00000:00003`, moment, key: `pump_amm:BuyEvent:${POOL}`,
      value: { event: { program: 'pump_amm', name: 'BuyEvent', data: own.data, signature: 'migrationtx', slot: P, txIndex: 0, outerIx: 0, innerIx: 3 }, txSlot: P, blockTime: null, source: 'helius', backfilled: false, seq: n++ },
    });
    const start = coverage(STREAM, 'start', { fromSlot: P - 1n, via: VIA }, P - 2n, at(P - 2n));
    const life = migration(state, R + 6n);
    const lateRun = head(new FactWorld().push(start, readEv(), ...s.map((x) => logOf(x)), ...life, ownEv({ slot: R + 6n, txIndex: OFF_CHAIN, ixIndex: 3, receivedAt: at(R + 6n) + 13 })));
    const inOrder = head(new FactWorld().push(
      start, ...life.map((e, i) => ({ ...e, moment: { slot: P, txIndex: 2 ** 32, ixIndex: i, receivedAt: at(P) + i } })),
      ownEv({ slot: P, txIndex: 2 ** 32, ixIndex: 3, receivedAt: at(P) + 3 }), readEv(), ...s.map((x) => logOf(x)),
    ));
    expect(candles(inOrder).obs.quality).toEqual([]);
    expect(noReceipt(candles(lateRun))).toEqual(noReceipt(candles(inOrder)));
  });

  it('kept swaps from before the migration\'s slot are not the pool\'s trades: not taken into the book', () => {
    const { state } = opened();
    const s = tape(state);
    // A swap on the pool stamped before its CreatePoolEvent's slot, released (late) just before the tape.
    const e = logOf(swap('buy', state, 1_000_000n, P - 1n));
    const early = { ...e, moment: { ...e.moment, slot: R + 1n, txIndex: 2 ** 32 - 1, receivedAt: at(R + 1n) - 1 } };
    const world = head(new FactWorld().push(coverage(STREAM, 'start', { fromSlot: P - 1n, via: VIA }, P - 2n, at(P - 2n)), readEv(), early, ...s.map((x) => logOf(x)), ...migration(state, R + 6n)));
    expect(noReceipt(candles(world))).toEqual(noReceipt(candles(complete().world)));
  });

  it('swaps let go past the cap before the migration: the candles are partial, never complete with trades missing', () => {
    const a = late((state) => {
      const out: Swap[] = [];
      let pre = state;
      for (let i = 0; i <= PRE_READ_KEEP; i++) {
        const x = swap('buy', pre, 1_000n, R + 1n);
        out.push(x);
        pre = x.after;
      }
      return out;
    }, R + 6n);
    expect(candles(a.world).obs.quality).toContain('partial');
    expect(verdicts(a.world).candles).not.toBe('ok');
  });

  it('a pool whose kept swaps were let go whole (past the pool cap) opens its book partial', () => {
    const { state } = opened();
    const s = tape(state);
    const others = Array.from({ length: PRE_READ_POOLS }, (_, i) => `OtherPool${i}`);
    const world = new FactWorld().push(
      coverage(STREAM, 'start', { fromSlot: P - 1n, via: VIA }, P - 2n, at(P - 2n)),
      ...others.map((p) => coverage(STREAMS.trades(p), 'start', { fromSlot: P - 1n, via: `logs:${p}` }, P - 2n, at(P - 2n))),
      readEv(), logOf(s[0]!),
    );
    expect(world.producer.sizes().preReads).toBe(1);
    // Other watched pools, none read nor migrated, each with a kept swap, push it out.
    others.forEach((p, i) => {
      const e = logOf(swap('buy', state, 1_000n, R + 2n), i + 1);
      const v = e.value as { event: { data: Record<string, unknown> }; via: string };
      world.push({ ...e, key: e.key.replace(POOL, p), value: { ...v, event: { ...v.event, data: { ...v.event.data, pool: p } }, via: `logs:${p}` } });
    });
    // Taken at the first event after the migration transaction's own (here the next slot notice).
    head(world.push(...migration(state, R + 6n)));
    expect(candles(world).obs.quality).toContain('partial');
  });
});
