// RED TEAM A, probe RT-A1: a confirmed pool log that reaches the live feed after its slot was released.
//
// The live feed releases a slot once the tip (Helius slotSubscribe, processed) is `horizonSlots` = 2 past it
// (live-feed.ts `advance`). The pool watches are confirmed logsSubscribe (pool-watch.ts:109), so a notification that
// arrives after its slot was released is "late" (live-feed.ts:255): its events are released at once, out of the total
// order. The producer (FactFeed, engine-feed.ts) observes the late swap BEFORE the engine and takes it into the candle
// book, but every fact it writes for that swap sits at the late event's moment, so the engine refuses them as
// `out_of_order` (engine.ts:165) and the as-of store never gets them. Nothing marks a gap on `trades:<pool>`. Until the
// next swap on the pool re-writes the candles, the store's candles miss the swap and still read complete and current.
//
// Here the late swap is a +60% spike. Delivered on time, H11 refuses `candle-spike`. Delivered late, the store's
// candles do not have it, the stream reads gap-free, and H11 passes on candles that miss a trade: fail-open.
// The backtest (dataset replay, no late frames) sees the spike: live != backtest on the same decision.
import { describe, expect, it } from 'vitest';
import { startSession, TRIAL_POLICY } from '../../../core/src/config/index.ts';
import { Engine, OFF_CHAIN, type MarketEvent, type Strategy, type StrategyContext } from '../../../core/src/engine/index.ts';
import { STREAMS } from '../../../core/src/facts/index.ts';
import { candlesKey, evaluateHardRejects, parseCandles, type GateContext } from '../../../core/src/gates/index.ts';
import { encodeBase58 } from '../../../core/src/chain/index.ts';
import type { PoolState } from '../../../core/src/amm/index.ts';
import type { Lamports, MicroUsd } from '../../../core/src/units/index.ts';
import { CONFIG } from '../../../core/test/fixtures.ts';
import { swapLog } from '../../../core/test/facts/swaps.ts';
import { DEFAULT_LIVE_FEED, LiveFeed, type FrameBody } from '../../src/providers/index.ts';
import { engineFeed } from '../../src/run/engine-feed.ts';

const session = startSession(TRIAL_POLICY);
const addr = (n: number): string => encodeBase58(Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? n : 11 + i)));
const MINT = addr(1);
const POOL = addr(2);
const CREATOR = addr(3);
const VIA = `logs:${POOL}`;
const SUPPLY = 1_000_000_000_000_000n;
const PRE: PoolState = { baseReserve: 200_000_000_000_000n, quoteVault: 85_000_000_000n, virtualQuoteReserves: 0n };
const S0 = 400_000_000n;
const T0 = 1_791_100_000_000;
/** Receipt time of a slot (400 ms a slot). */
const at = (slot: bigint): number => T0 + Number(slot - S0) * 400;
const sec = (slot: bigint): bigint => BigInt(Math.floor(at(slot) / 1000));
let k = 0;

/** A fetched transaction's event, as the worker puts a lookup on the feed (an off-chain `fact` frame keeps the shape). */
const life = (program: 'pump' | 'pump_amm', name: string, data: Record<string, unknown>, slot: bigint): FrameBody =>
  ({ type: 'fact', key: `${program}:${name}:${MINT}`, value: { event: { program, name, data, signature: `life${k++}`, slot, txIndex: 0, outerIx: 0, innerIx: 0 }, txSlot: slot, blockTime: null, source: 'helius', backfilled: false } });

interface Run { readonly feed: LiveFeed; readonly seen: { ctx: StrategyContext | null }; readonly engine: Engine }

const world = (): Run => {
  const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED });
  const seen: { ctx: StrategyContext | null } = { ctx: null };
  const strategy: Strategy = { onMarket: (_e: MarketEvent, ctx: StrategyContext) => { seen.ctx = ctx; return []; } };
  const ef = engineFeed(feed, session.policy);
  const engine = new Engine({ clock: feed.clock, feed: ef.feed, strategy, runner: { run: () => {} }, seed: 's', book: CONFIG });
  return { feed, seen, engine };
};

const slot = (r: Run, s: bigint, ms = at(s)): void => {
  r.feed.ingest('helius', { type: 'slot', slot: s, parent: s - 1n, root: null }, { receivedAt: ms });
  r.feed.advance(ms);
  r.engine.drain();
};

const log = (r: Run, sig: string, s: bigint, logs: readonly string[], ms: number) =>
  r.feed.ingest('helius', { type: 'logs', signature: sig, slot: s, err: null, via: VIA, logs: [...logs], commitment: 'confirmed' }, { receivedAt: ms });

/** Pool opened at S0, watched from S0; a small buy at S0+2; then the spike buy at S0+4, on time or late. */
const scenario = (late: boolean) => {
  const r = world();
  slot(r, S0 - 3n);
  r.feed.ingest('helius', { type: 'fact', key: `coverage:${STREAMS.trades(POOL)}:start`, value: { fromSlot: S0, via: VIA } }, { receivedAt: at(S0 - 3n) + 1 });
  r.feed.ingest('helius', life('pump', 'CompleteEvent', { mint: MINT, timestamp: sec(S0 - 1n) }, S0 - 1n), { receivedAt: at(S0 - 3n) + 2 });
  r.feed.ingest('helius', life('pump_amm', 'CreatePoolEvent', { timestamp: sec(S0), baseMint: MINT, pool: POOL, poolQuoteAmount: PRE.quoteVault, poolBaseAmount: PRE.baseReserve }, S0), { receivedAt: at(S0 - 3n) + 3 });
  r.feed.ingest('helius', life('pump', 'CompletePumpAmmMigrationEvent', { mint: MINT, pool: POOL, timestamp: sec(S0) }, S0), { receivedAt: at(S0 - 3n) + 4 });
  for (let s = S0 - 2n; s <= S0 + 1n; s++) slot(r, s);
  const small = swapLog({ pool: POOL, coinCreator: CREATOR, supply: SUPPLY, pre: PRE, side: 'buy', base: 1_000_000_000n, atMs: at(S0 + 2n) });
  log(r, 'smallbuy', S0 + 2n, small.logs, at(S0 + 2n) + 300);
  slot(r, S0 + 2n);
  slot(r, S0 + 3n);
  // 50,000 of 200,000 base tokens: the price rises about 78%.
  const spike = swapLog({ pool: POOL, coinCreator: CREATOR, supply: SUPPLY, pre: small.after, side: 'buy', base: 50_000_000_000_000n, atMs: at(S0 + 4n) });
  if (!late) log(r, 'spikebuy', S0 + 4n, spike.logs, at(S0 + 4n) + 300);
  slot(r, S0 + 4n);
  slot(r, S0 + 5n);
  slot(r, S0 + 6n);
  slot(r, S0 + 7n); // released through S0 + 5: slot S0 + 4 is gone
  if (late) {
    const f = log(r, 'spikebuy', S0 + 4n, spike.logs, at(S0 + 7n) + 50);
    expect(f.place).toEqual({ at: 'chain', slot: S0 + 4n });
    expect(r.feed.status().late).toBe(1);
  }
  for (let s = S0 + 8n; s <= S0 + 12n; s++) slot(r, s);
  const ctx = r.seen.ctx!;
  const gctx: GateContext = { now: ctx.now, observedTip: ctx.now.slot, lookup: (key, asOf) => ctx.lookup(key, asOf), history: (key, f, t) => ctx.history(key, f, t) };
  const hard = evaluateHardRejects(gctx, { session, mode: 'live' }, { mint: MINT, universe: 'U1', notional: 1_000_000n as MicroUsd, spend: 10_000_000n as Lamports, roundTrip: { ok: false, reason: 'unused', detail: '' } as never }, { only: ['H11'], stopAtFirst: false });
  const c = ctx.lookup(candlesKey(MINT));
  const candles = c.ok ? parseCandles(c.value) : null;
  const faults = r.engine.records.filter((x) => x.type === 'fault').map((x) => (x as { eventId: string }).eventId);
  return { hard, candles, faults };
};

describe('RT-A1: a late confirmed pool log loses its swap from the store with no gap', () => {
  it('on time: the spike is in the candles and H11 refuses it (control)', () => {
    const { hard, candles } = scenario(false);
    expect(candles?.candles.length).toBeGreaterThan(0);
    expect(hard.reasons.map((x) => `${x.gate}:${x.code}`)).toEqual(['H11:candle-spike']);
  });

  it('late: H11 must not pass on candles that miss the spike (fails on 959d801: H11 passes)', () => {
    const { hard, candles, faults } = scenario(true);
    // What happened: the engine refused the late swap and every fact the producer wrote for it.
    expect(faults.some((id) => id.startsWith('log:spikebuy'))).toBe(true);
    expect(faults.some((id) => id.startsWith('log:spikebuy') && id.includes('~gates/candles:'))).toBe(true);
    // The store's candles are the small buy's only, complete and unflagged.
    expect(candles?.obs.quality).toEqual([]);
    expect(candles?.candles).toHaveLength(1);
    // Fail closed would be: the spike refused, or the candles not usable (gap / partial).
    expect(hard.pass).toBe(false);
  });
});
