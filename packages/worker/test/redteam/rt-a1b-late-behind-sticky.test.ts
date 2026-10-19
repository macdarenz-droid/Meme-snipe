// RED TEAM A, probe RT-A1 (LATE-LOG): a confirmed pool log that reaches the live feed after its slot was released.
//
// The live feed releases a slot once the tip (Helius slotSubscribe, processed) is `horizonSlots` = 2 past it
// (live-feed.ts `advance`). The pool watches are confirmed logsSubscribe (pool-watch.ts), so a notification can arrive
// after its slot was released: "late". Before LATE-LOG the feed released its events at once, out of the total order;
// the producer (FactFeed) took the swap into the candle book, but every fact it wrote sat at the late event's moment,
// so the engine refused them as `out_of_order` and the as-of store never got them, with no gap on `trades:<pool>`.
// Here the late swap is a +78% spike: on 959d801, delivered late, H11 passed on candles that missed it (fail-open).
//
// LATE-LOG: a late frame is placed off-chain at the open slot (`late: true`) and released in order; the producer
// judges the swap by its own slot. Still in order on its pool: the candles end exactly as the on-time run's (the
// backtest of the full tape) and H11 refuses the spike. Behind a newer swap: the candles are partial and the pool is
// stale (fail closed). Nothing the engine is handed is ever refused.
import { describe, expect, it } from 'vitest';
import { startSession, TRIAL_POLICY } from '../../../core/src/config/index.ts';
import { Engine, type Clock, type Feed, type MarketEvent, type Strategy, type StrategyContext } from '../../../core/src/engine/index.ts';
import { STREAMS } from '../../../core/src/facts/index.ts';
import { candlesKey, evaluateHardRejects, parseCandles, type GateContext } from '../../../core/src/gates/index.ts';
import { encodeBase58 } from '../../../core/src/chain/index.ts';
import type { PoolState } from '../../../core/src/amm/index.ts';
import type { Lamports, MicroUsd } from '../../../core/src/units/index.ts';
import { CONFIG } from '../../../core/test/fixtures.ts';
import { swapLog } from '../../../core/test/facts/swaps.ts';
import { DEFAULT_LIVE_FEED, LiveFeed, replayRecorded, type Frame, type FrameBody, type Release } from '../../src/providers/index.ts';
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

interface Run {
  readonly feed: LiveFeed;
  readonly seen: { ctx: StrategyContext | null };
  readonly engine: Engine;
  readonly frames: Frame[];
  readonly releases: Release[];
}

const engineOn = (clock: Clock, inner: Feed, seen: { ctx: StrategyContext | null }): Engine => {
  const strategy: Strategy = { onMarket: (_e: MarketEvent, ctx: StrategyContext) => { seen.ctx = ctx; return []; } };
  return new Engine({ clock, feed: engineFeed(inner, session.policy).feed, strategy, runner: { run: () => {} }, seed: 's', book: CONFIG });
};

const world = (): Run => {
  const frames: Frame[] = [];
  const releases: Release[] = [];
  const feed = new LiveFeed({ ...DEFAULT_LIVE_FEED, onFrame: (f) => frames.push(f), onRelease: (_e, r) => releases.push(r) });
  const seen: { ctx: StrategyContext | null } = { ctx: null };
  return { feed, seen, engine: engineOn(feed.clock, feed, seen), frames, releases };
};

const slot = (r: Run, s: bigint, ms = at(s)): void => {
  r.feed.ingest('helius', { type: 'slot', slot: s, parent: s - 1n, root: null }, { receivedAt: ms });
  r.feed.advance(ms);
  r.engine.drain();
};

const log = (r: Run, sig: string, s: bigint, logs: readonly string[], ms: number) =>
  r.feed.ingest('helius', { type: 'logs', signature: sig, slot: s, err: null, via: VIA, logs: [...logs], commitment: 'confirmed' }, { receivedAt: ms });

/**
 * Pool opened at S0, watched from S0; two small buys at S0+2 (one slot, two swaps); then the spike buy at S0+4: on time,
 * late (after S0+4 was released, nothing newer on the pool), or late behind a newer swap (a sell at S0+6, on time,
 * released first). `on-time-behind` is that last tape delivered on time: the backtest of the full tape.
 */
type Mode = 'on-time' | 'late' | 'late-behind' | 'on-time-behind';
const scenario = (mode: Mode, after = 0) => {
  const r = world();
  slot(r, S0 - 3n);
  r.feed.ingest('helius', { type: 'fact', key: `coverage:${STREAMS.trades(POOL)}:start`, value: { fromSlot: S0, via: VIA } }, { receivedAt: at(S0 - 3n) + 1 });
  r.feed.ingest('helius', life('pump', 'CompleteEvent', { mint: MINT, timestamp: sec(S0 - 1n) }, S0 - 1n), { receivedAt: at(S0 - 3n) + 2 });
  r.feed.ingest('helius', life('pump_amm', 'CreatePoolEvent', { timestamp: sec(S0), baseMint: MINT, pool: POOL, poolQuoteAmount: PRE.quoteVault, poolBaseAmount: PRE.baseReserve }, S0), { receivedAt: at(S0 - 3n) + 3 });
  r.feed.ingest('helius', life('pump', 'CompletePumpAmmMigrationEvent', { mint: MINT, pool: POOL, timestamp: sec(S0) }, S0), { receivedAt: at(S0 - 3n) + 4 });
  for (let s = S0 - 2n; s <= S0 + 1n; s++) slot(r, s);
  const small = swapLog({ pool: POOL, coinCreator: CREATOR, supply: SUPPLY, pre: PRE, side: 'buy', base: 1_000_000_000n, atMs: at(S0 + 2n) });
  log(r, 'smallbuy', S0 + 2n, small.logs, at(S0 + 2n) + 300);
  const small2 = swapLog({ pool: POOL, coinCreator: CREATOR, supply: SUPPLY, pre: small.after, side: 'buy', base: 1_000_000_000n, atMs: at(S0 + 2n) });
  log(r, 'smallbuy2', S0 + 2n, small2.logs, at(S0 + 2n) + 310);
  slot(r, S0 + 2n);
  slot(r, S0 + 3n);
  // 50,000 of 200,000 base tokens: the price rises about 78%.
  const spike = swapLog({ pool: POOL, coinCreator: CREATOR, supply: SUPPLY, pre: small2.after, side: 'buy', base: 50_000_000_000_000n, atMs: at(S0 + 4n) });
  const newer = swapLog({ pool: POOL, coinCreator: CREATOR, supply: SUPPLY, pre: spike.after, side: 'sell', base: 1_000_000_000n, atMs: at(S0 + 6n) });
  if (mode === 'on-time' || mode === 'on-time-behind') log(r, 'spikebuy', S0 + 4n, spike.logs, at(S0 + 4n) + 300);
  slot(r, S0 + 4n);
  slot(r, S0 + 5n);
  if (mode === 'late-behind' || mode === 'on-time-behind') log(r, 'newsell', S0 + 6n, newer.logs, at(S0 + 6n) + 300);
  slot(r, S0 + 6n);
  slot(r, S0 + 7n); // released through S0 + 5: slot S0 + 4 is gone
  let lateFrame: Frame | null = null;
  if (mode === 'late') lateFrame = log(r, 'spikebuy', S0 + 4n, spike.logs, at(S0 + 7n) + 50);
  slot(r, S0 + 8n); // released through S0 + 6: the newer sell is in
  if (mode === 'late-behind') lateFrame = log(r, 'spikebuy', S0 + 4n, spike.logs, at(S0 + 8n) + 50);
  for (let s = S0 + 9n; s <= S0 + 12n; s++) slot(r, s);
  let pre = newer.after;
  for (let k = 0; k < after; k++) {
    const sl = S0 + 13n + BigInt(k) * 150n; // one small swap a minute
    const x = swapLog({ pool: POOL, coinCreator: CREATOR, supply: SUPPLY, pre, side: k % 2 === 0 ? 'buy' : 'sell', base: 1_000_000_000n, atMs: at(sl) });
    log(r, `later${k}`, sl, x.logs, at(sl) + 300);
    for (let s2 = sl; s2 <= sl + 3n; s2++) slot(r, s2);
    pre = x.after;
  }
  const ctx = r.seen.ctx!;
  const gctx: GateContext = { now: ctx.now, observedTip: ctx.now.slot, lookup: (key, asOf) => ctx.lookup(key, asOf), history: (key, f, t) => ctx.history(key, f, t) };
  const hard = evaluateHardRejects(gctx, { session, mode: 'live' }, { mint: MINT, universe: 'U1', notional: 1_000_000n as MicroUsd, spend: 10_000_000n as Lamports, roundTrip: { ok: false, reason: 'unused', detail: '' } as never }, { only: ['H11'], stopAtFirst: false });
  const c = ctx.lookup(candlesKey(MINT));
  const candles = c.ok ? parseCandles(c.value) : null;
  const faults = r.engine.records.filter((x) => x.type === 'fault');
  return { r, hard, candles, faults, lateFrame };
};


// RED TEAM A round 3, RT-A1b (on #272 head c752a6d): LATE-LOG turns every late swap behind a newer one into a sticky
// `partial` on the pool's candle book (producer.ts `#bookSwap`, `book.partial = true`; only a heal from an earlier mark
// resets it, and no hole means no heal). H11 then refuses the coin (H16 degraded, candles) for the rest of its window,
// although every swap was delivered and the late one chains exactly between its neighbours (its pre-trade reserves are
// the earlier swap's post-trade ones), so the book could be rebuilt in chain order as TRADE-GAP-HEAL already does.
// Rate: 0.24% and 0.68% of confirmed PumpSwap notifications were at or past the horizon on public mainnet (late-measure.mjs,
// 60 s and 230 s samples); a busy candidate pool sees hundreds to thousands of swaps in its window, so most active coins
// would be blocked for the whole window (the "never trades" class).
describe('RT-A1b: a late swap behind a newer one blocks H11 for the rest of the window', () => {
  it('after 30 more on-time swaps over 30 minutes, with every swap delivered, H11 is not refused for incomplete candles (fails on c752a6d)', () => {
    const { hard, candles } = scenario('late-behind', 30);
    const reasons = hard.reasons.map((x) => `${x.gate}:${x.code}:${x.input ?? ''}`);
    expect({ quality: candles?.obs.quality, reasons }).toEqual({ quality: [], reasons: expect.not.arrayContaining(['H16:degraded:candles']) });
  });
});
