// FACTS-1 producers on recorded mainnet data (fixtures/facts.json, DEC-1's migration fixtures). Each producer is
// checked for the fact it makes from real inputs, then for the rule: missing, stale, processed or failed input makes
// no fact (or a flagged one) and GATE-1 rejects. Facts go through the FactFeed into an as-of store, as in the engine.
import { describe, expect, it } from 'vitest';
import { transactionEvents, type TransactionRecord } from '../../src/chain/index.ts';
import { startSession, TRIAL_POLICY } from '../../src/config/index.ts';
import { pumpSwapRoundTrip } from '../../src/costs/index.ts';
import { OFF_CHAIN, createReplay, type MarketEvent, type Moment } from '../../src/engine/index.ts';
import {
  CURVE_VOLUME_KEY, EXEC_HEALTH_KEY, GRADUATES_KEY, SOL_USD_KEY, Evidence, evaluateSoftFeatures, candlesKey, createKey, curveKey, evaluateHardRejects, evaluateRegime,
  holdersKey, insidersKey, lpKey, migrationKey, mintKey, parseCandles, parseCreate, parseHolders, parseInsiders, parseLp, parseMigration, parseMint,
  parsePool, parseSim, parseSolUsd, parseXcheck, poolKey, simKey, streamKey, xcheckKey, type CandlesFact, type GateRequest,
} from '../../src/gates/index.ts';
import { FACT_KINDS, FactFeed, FactProducer, GRADUATES_SEED_KEY, HOLDER_ABSTENTIONS_KEY, RAW, STREAMS, dailyChainVolume, graduatesFact, insiderLinks, decimalToMicro, producerOptions, tradeRepeatId, RETIRED_KEEP, cappedAdd } from '../../src/facts/index.ts';
import { lamports, microUsd } from '../../src/units/index.ts';
import { FEE_CONTEXT } from '../gates/world.ts';
import { recordFromRpc } from '../../src/chain/index.ts';
import { TRANSACTIONS } from '../chain/helpers.ts';
import { FIX, FactWorld, MINT, OPTIONS, POOL, RECORDS, atOf, chainTx, coverage, logEvents, offchain, slotNotice, txEvents } from './helpers.ts';

const session = startSession(TRIAL_POLICY);
const policy = session.policy;

const create = RECORDS.find((r) => transactionEvents(r.rec).some((e) => e.name === 'CreateEvent' && e.data.mint === MINT))!.rec;
const fromRecords = (sig: string) => RECORDS.find((r) => r.rec.signature === sig)?.rec;
const complete = fromRecords(chainTx('pump CompleteEvent (curve filled)').signature)!;
const migrate = fromRecords(chainTx('migration CreatePoolEvent').signature)!;
const swaps = RECORDS.filter((r) => r.label === 'pool swap after migration' && r.rec.signature !== migrate.signature && r.rec.signature !== complete.signature).map((r) => r.rec);

/** The coin's create, graduation and migration, as the live feed releases fetched transactions. */
const lifecycle = (): MarketEvent[] => [
  ...txEvents(create),
  ...txEvents(complete),
  ...txEvents(migrate),
];

const ev = (w: FactWorld, now: Moment) => new Evidence(w.ctx(now), policy);
const after = (slot: bigint, receivedAt: number): Moment => ({ slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt });

describe('fact kinds', () => {
  it('names every fact GATE-1 reads, once, with its source class', () => {
    const keys = FACT_KINDS.map((k) => k.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of ['gates/mint:', 'gates/pool:', 'gates/lp:', 'gates/curve:', 'gates/create:', 'gates/migration:', 'gates/candles:', 'gates/holders:', 'gates/insiders:', 'gates/sim:', 'gates/xcheck:', 'gates/soft:', 'gates/stream:', SOL_USD_KEY, CURVE_VOLUME_KEY, GRADUATES_KEY, EXEC_HEALTH_KEY]) {
      expect(keys).toContain(k);
    }
    expect(FACT_KINDS.filter((k) => k.source === 'live-only-veto').map((k) => k.key).sort()).toEqual([EXEC_HEALTH_KEY, 'gates/sim:', 'gates/xcheck:'].sort());
  });

  it('sizes its kept windows from the locked policy', () => {
    const o = producerOptions(policy);
    expect(o.candleFirstMs).toBe(policy.gates.chaseCheckAfterMs + 60_000);
    expect(o.candleLastMs).toBe(policy.gates.candleWindowMs + 60_000);
    expect(o.maxQuoteAgeMs).toBe(policy.gates.maxQuoteAgeMs);
    expect(o.survivalAfterMs).toBe(policy.regime.survivalAfterMs);
    expect(o.execHealth).toBeUndefined();
    expect(() => new FactProducer({ ...o, firstBuyers: -1 })).toThrow(/whole number/);
  });
});

describe('create', () => {
  it('a fetched CreateEvent makes the create fact at confirmed, stamped with its slot', () => {
    const w = new FactWorld().push(...txEvents(create));
    const d = transactionEvents(create).find((e) => e.name === 'CreateEvent')!;
    if (d.name !== 'CreateEvent') throw new Error('unreachable');
    const f = parseCreate(w.last(createKey(MINT)))!;
    expect(f).not.toBeNull();
    expect(f.createdAtMs).toBe(Number(d.data.timestamp) * 1000);
    expect(f.creator).toBe(d.data.creator);
    expect(f.obs).toMatchObject({ slot: create.slot, commitment: 'confirmed', receivedAt: atOf(create), quality: [] });
    // The fact sits right after its source, at the same moment.
    const fact = w.facts(createKey(MINT))[0]!;
    const src = w.released[w.released.indexOf(fact) - 1]!;
    expect(fact.moment).toEqual(src.moment);
    expect(fact.id.startsWith(`${src.id.split('~')[0]}~`)).toBe(true);
  });

  it('a create read from processed log lines makes no fact; a confirmed log watch does', () => {
    expect(new FactWorld().push(...logEvents(create)).facts(createKey(MINT))).toEqual([]);
    expect(new FactWorld().push(...logEvents(create, 'confirmed')).facts(createKey(MINT))).toHaveLength(1);
  });
});

describe('migration and curve', () => {
  it('graduation, migration and the created pool make the migration fact from real events', () => {
    const w = new FactWorld().push(...lifecycle());
    const m = parseMigration(w.last(migrationKey(MINT)))!;
    expect(m).toEqual({
      obs: { provider: 'helius', slot: 452_941_614n, receivedAt: atOf(migrate), quality: [], commitment: 'confirmed' },
      graduatedAtMs: 1_791_032_673_000, migratedAtMs: 1_791_032_673_000, pool: POOL,
      quoteAtMigration: 84_990_359_062n, price: { quote: 84_990_359_062n, base: 206_900_000_000_000n }, completeness: 'complete',
    });
    // H5's tail check filters the pool's trades from this slot: it must be the migration event's own slot.
    const migSlot = transactionEvents(migrate).find((e) => e.name === 'CompletePumpAmmMigrationEvent')!.slot;
    expect(m.obs.slot).toBe(migSlot);
    expect(w.last(curveKey(MINT))).toMatchObject({ complete: true, obs: { slot: 452_941_614n, commitment: 'confirmed' } });
  });

  it('without the graduation, or seen only at processed, there is no migration fact and H8-H10 reject as missing', () => {
    const noComplete = new FactWorld().push(...txEvents(create), ...txEvents(migrate));
    expect(noComplete.facts(migrationKey(MINT))).toEqual([]);
    const processed = new FactWorld().push(...logEvents(complete), ...logEvents(migrate));
    expect(processed.facts(migrationKey(MINT))).toEqual([]);
    expect(processed.facts(curveKey(MINT))).toEqual([]);
    const r = ev(noComplete, after(migrate.slot + 9000n, atOf(migrate) + 3_600_000)).read('migration', migrationKey(MINT), parseMigration, 'event', 'H10');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatchObject({ gate: 'H16', code: 'missing', neededBy: 'H10' });
  });

  it('a trade never makes "not complete": the curve fact exists only from a CompleteEvent', () => {
    const w = new FactWorld().push(...txEvents(create));
    expect(w.facts(curveKey(MINT))).toEqual([]);
  });

  it('H9 reads the real create and graduation: graduated after the 5-minute floor or not', () => {
    const w = new FactWorld().push(...lifecycle());
    const c = parseCreate(w.last(createKey(MINT)))!;
    const m = parseMigration(w.last(migrationKey(MINT)))!;
    const took = m.graduatedAtMs - c.createdAtMs;
    expect(took).toBeGreaterThanOrEqual(0);
    const r = evaluateHardRejects(w.ctx(after(migrate.slot + 10n, atOf(migrate) + 2 * 3_600_000)), { session, mode: 'backtest' }, request(), { stopAtFirst: false });
    const h9 = r.reasons.filter((x) => x.gate === 'H9' || x.neededBy === 'H9');
    if (took >= policy.gates.instantGraduationMinMs) expect(h9).toEqual([]);
    else expect(h9).toEqual([expect.objectContaining({ gate: 'H9', code: 'instant-graduation', value: String(took) })]);
  });
});

/** A gate request for the coin at 0.05 SOL, its round trip quoted on the migration's opening reserves. */
const request = (): GateRequest => {
  const rt = pumpSwapRoundTrip({ baseReserve: 206_900_000_000_000n, quoteVault: 67_405_853_773n, virtualQuoteReserves: 17_584_505_289n }, FEE_CONTEXT)(lamports(50_000_000n));
  return { mint: MINT, universe: 'U1', notional: microUsd(10_000_000n), spend: lamports(50_000_000n), roundTrip: rt };
};

describe('candles', () => {
  const tradesStream = STREAMS.trades(POOL);
  const covered = (): MarketEvent[] => [coverage(tradesStream, 'start', { fromSlot: migrate.slot, via: `logs:${POOL}` }, migrate.slot - 1n, atOf(migrate) - 500)];
  const swapEvents = (): MarketEvent[] => swaps.flatMap((s) => txEvents(s));
  const build = (pre: MarketEvent[] = covered()): FactWorld => {
    const w = new FactWorld();
    w.push(...pre);
    w.push(...txEvents(create), ...txEvents(complete));
    w.push(...txEvents(migrate), ...swapEvents());
    return w;
  };

  it('real swaps chain: each trade\'s reserves after equal the next trade\'s reserves before', () => {
    // The after-trade formula (base by the base amount, quote by the lp-adjusted amount) checked on mainnet data.
    const legs = [migrate, ...swaps].flatMap((r) => transactionEvents(r)).filter((e) => (e.name === 'BuyEvent' || e.name === 'SellEvent') && e.data.pool === POOL);
    expect(legs.length).toBeGreaterThan(10);
    let checked = 0;
    for (let i = 1; i < legs.length; i++) {
      const a = legs[i - 1]!;
      const b = legs[i]!;
      if ((a.name !== 'BuyEvent' && a.name !== 'SellEvent') || (b.name !== 'BuyEvent' && b.name !== 'SellEvent')) continue;
      const base = a.name === 'BuyEvent' ? a.data.poolBaseTokenReserves - a.data.baseAmountOut : a.data.poolBaseTokenReserves + a.data.baseAmountIn;
      const quote = a.name === 'BuyEvent' ? a.data.poolQuoteTokenReserves + a.data.quoteAmountInWithLpFee : a.data.poolQuoteTokenReserves - a.data.quoteAmountOutWithoutLpFee;
      // Consecutive trades of the recorded set only (a gap in the fetched set would skip a trade).
      if (b.slot - a.slot > 3n) continue;
      expect([b.data.poolBaseTokenReserves, b.data.poolQuoteTokenReserves]).toEqual([base, quote]);
      checked++;
    }
    expect(checked).toBeGreaterThan(5);
  });

  it('one-minute candles from every real swap since the pool opened, stream-backed from its first slot', () => {
    const w = build();
    const c = parseCandles(w.last(candlesKey(MINT)))!;
    expect(c.intervalMs).toBe(60_000);
    expect(c.obs).toMatchObject({ slot: migrate.slot, stream: tradesStream, commitment: 'confirmed', quality: [] });
    // The first candle opens at the migration price: the boost moved quote into virtual reserves, effective unchanged.
    expect(c.candles[0]!.open).toEqual({ quote: 84_990_359_062n, base: 206_900_000_000_000n });
    expect(c.candles[0]!.startMs).toBe(Math.floor(1_791_032_673_000 / 60_000) * 60_000);
    for (const k of c.candles) {
      const ge = (a: { quote: bigint; base: bigint }, b: { quote: bigint; base: bigint }) => a.quote * b.base >= b.quote * a.base;
      expect(ge(k.high, k.open) && ge(k.high, k.close)).toBe(true);
    }
    const starts = c.candles.map((k) => k.startMs);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('H11 reads them current while the trade stream is gap-free and at the head', () => {
    const w = build();
    const head = swaps.at(-1)!.slot + 1n;
    const at = atOf(swaps.at(-1)!) + 1000;
    w.push(slotNotice(head, at));
    expect(ev(w, after(head, at + 1)).read('candles', candlesKey(MINT), parseCandles, 'state', 'H11').ok).toBe(true);
    // Three slots later with no slot notice the stream head is stale: H16 rejects.
    const stale = ev(w, after(head + 3n, at + 2000)).read('candles', candlesKey(MINT), parseCandles, 'state', 'H11');
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.reason).toMatchObject({ gate: 'H16', code: 'stale', input: 'stream' });
  });

  it('without coverage, or with an open gap, or covered only after the pool opened, H16 rejects the candles', () => {
    const head = swaps.at(-1)!.slot + 1n;
    const at = atOf(swaps.at(-1)!) + 1000;
    const none = build([]).push(slotNotice(head, at));
    const r1 = ev(none, after(head, at + 1)).read('candles', candlesKey(MINT), parseCandles, 'state', 'H11');
    expect(!r1.ok && r1.reason.code).toBe('missing');

    const gap = build().push(coverage(tradesStream, 'gap', { fromSlot: head - 1n, toSlot: null, reason: 'disconnect', via: `logs:${POOL}` }, head - 1n, at - 10), slotNotice(head, at));
    const r2 = ev(gap, after(head, at + 1)).read('candles', candlesKey(MINT), parseCandles, 'state', 'H11');
    expect(!r2.ok && r2.reason.code).toBe('degraded');

    const late = build([coverage(tradesStream, 'start', { fromSlot: migrate.slot + 1n, via: `logs:${POOL}` }, migrate.slot - 1n, atOf(migrate) - 500)]).push(slotNotice(head, at));
    const r3 = ev(late, after(head, at + 1)).read('candles', candlesKey(MINT), parseCandles, 'state', 'H11');
    expect(!r3.ok && r3.reason.code).toBe('gap');

    // A bounded gap after the pool opened also breaks the claim; a resume that restored the range in full does not.
    const bounded = build().push(coverage(tradesStream, 'gap', { fromSlot: head - 2n, toSlot: head - 1n, reason: 'disconnect', via: `logs:${POOL}` }, head - 1n, at - 10), slotNotice(head, at));
    expect(ev(bounded, after(head, at + 1)).read('candles', candlesKey(MINT), parseCandles, 'state', 'H11').ok).toBe(false);
    const resumed = build().push(
      coverage(tradesStream, 'gap', { fromSlot: head - 2n, toSlot: null, reason: 'disconnect', via: `logs:${POOL}` }, head - 1n, at - 20),
      coverage(tradesStream, 'resume', { fromSlot: head - 2n, toSlot: head - 1n, via: `logs:${POOL}` }, head - 1n, at - 10),
      slotNotice(head, at),
    );
    expect(ev(resumed, after(head, at + 1)).read('candles', candlesKey(MINT), parseCandles, 'state', 'H11').ok).toBe(true);
  });

  it('a cut log on the pool watch is a hole in the trade stream', () => {
    const head = swaps.at(-1)!.slot + 1n;
    const at = atOf(swaps.at(-1)!) + 1000;
    const cut: MarketEvent = { kind: 'market', id: 'log:cut:truncated', moment: { slot: head - 1n, txIndex: 2 ** 33, ixIndex: 2 ** 36, receivedAt: at - 5 }, key: `logs:truncated:logs:${POOL}`, value: { signature: 'cut', source: 'alchemy', backfilled: false, seq: 1 } };
    const w = build().push(cut, slotNotice(head, at));
    const r = ev(w, after(head, at + 1)).read('candles', candlesKey(MINT), parseCandles, 'state', 'H11');
    expect(!r.ok && r.reason.code).toBe('gap');
  });

  it('the same trade from a fetched transaction and a confirmed log line counts once', () => {
    const once = parseCandles(build().last(candlesKey(MINT)))!;
    const w = new FactWorld();
    w.push(...covered(), ...txEvents(create), ...txEvents(complete), ...txEvents(migrate));
    for (const x of swaps) w.push(...txEvents(x), ...logEvents(x, 'confirmed'));
    expect(parseCandles(w.last(candlesKey(MINT)))!.candles).toEqual(once.candles);
  });

  /** The real swaps re-stamped 40 s apart (reserves unchanged), so they span many minutes. */
  const spread = (): MarketEvent[] => {
    let i = 0;
    return swaps.flatMap((x) => txEvents(x)).map((e) => {
      if (!e.key.startsWith('pump_amm:BuyEvent:') && !e.key.startsWith('pump_amm:SellEvent:')) return e;
      const v = e.value as { event: { data: Record<string, unknown> } };
      const timestamp = 1_791_032_673n + BigInt(40 * ++i);
      return { ...e, value: { ...v, event: { ...v.event, data: { ...v.event.data, timestamp } } } };
    });
  };
  const spreadWorld = (): FactWorld => new FactWorld().push(...covered(), ...txEvents(create), ...txEvents(complete), ...txEvents(migrate), ...spread());

  it('keeps the candles from the pool opening and the newest ones, and drops the middle', () => {
    const c = parseCandles(spreadWorld().last(candlesKey(MINT)))!;
    const open = 1_791_032_673_000; // the pool's opening time: the kept window counts from it
    const newest = c.candles.at(-1)!.startMs;
    expect(newest - open).toBeGreaterThan(OPTIONS.candleFirstMs + OPTIONS.candleLastMs);
    for (const k of c.candles) expect(k.startMs < open + OPTIONS.candleFirstMs || k.startMs >= newest - OPTIONS.candleLastMs).toBe(true);
    expect(c.candles.some((k) => k.startMs >= open + OPTIONS.candleFirstMs)).toBe(true);
    // Exactly the minutes that traded inside the two windows: the migration's own buy, then one swap every 40 s.
    const minutes = [...new Set([open, ...spread().filter((e) => /BuyEvent|SellEvent/.test(e.key)).map((e) => Number((e.value as { event: { data: { timestamp: bigint } } }).event.data.timestamp) * 1000)]
      .map((t) => Math.floor(t / 60_000) * 60_000))];
    expect(c.candles.map((k) => k.startMs)).toEqual(minutes.filter((m) => m < open + OPTIONS.candleFirstMs || m >= newest - OPTIONS.candleLastMs));
    expect(c.obs.quality).toEqual([]);
  });

  it('a trade stamped before the newest candle, or one whose price cannot be formed, flags the candles partial', () => {
    const w = spreadWorld();
    const last = spread().filter((e) => e.key.startsWith('pump_amm:BuyEvent:')).at(-1)!;
    const v = last.value as { event: { data: Record<string, unknown> } };
    const late = (id: string, data: Record<string, unknown>, ix: number): MarketEvent => ({ ...last, id, moment: { ...last.moment, slot: last.moment.slot + 10n, ixIndex: ix }, value: { ...v, event: { ...v.event, signature: id, data: { ...v.event.data, ...data } } } });
    const early = spreadWorld().push(late('ev:early:1', { timestamp: 1_791_032_673n }, 1));
    expect(parseCandles(early.last(candlesKey(MINT)))!.obs.quality).toEqual(['partial']);
    const empty = w.push(late('ev:empty:1', { poolBaseTokenReserves: v.event.data['baseAmountOut'], timestamp: 1_791_040_000n }, 2));
    expect(parseCandles(empty.last(candlesKey(MINT)))!.obs.quality).toEqual(['partial']);
  });

  it('a later copy of an earlier trade is not counted again', () => {
    const w = spreadWorld();
    const first = spread().find((e) => e.key.startsWith('pump_amm:BuyEvent:'))!;
    const copy: MarketEvent = { ...first, id: 'log:copy:00000', key: `logs:${first.key}`, moment: { slot: swaps.at(-1)!.slot + 20n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: atOf(swaps.at(-1)!) + 9000 }, value: { ...(first.value as object), signature: (first.value as { event: { signature: string } }).event.signature, commitment: 'confirmed' } };
    w.push(copy);
    expect(parseCandles(w.last(candlesKey(MINT)))!.obs.quality).toEqual([]);
  });

  describe('the repeat window (OOM-SEEN, TRADE_REPEAT_WINDOW_MS)', () => {
    type Ev = { event: { signature: string; data: Record<string, unknown> } };
    const W = OPTIONS.tradeRepeatMs;
    const trades = (): MarketEvent[] => spread().filter((e) => /^pump_amm:(Buy|Sell)Event:/.test(e.key));
    const atMsOf = (e: MarketEvent): number => Number((e.value as Ev).event.data['timestamp']) * 1000;
    const base = trades().at(-1)!;
    let at = atOf(swaps.at(-1)!) + 60_000;
    let slot = swaps.at(-1)!.slot + 100n;
    const next = (): Moment => ({ slot: (slot += 10n), txIndex: 0, ixIndex: 0, receivedAt: (at += 1_000) });
    /** A new trade (its own signature, the last trade's reserves) stamped `atMs`, released after everything so far. */
    const newer = (atMs: number, n: number): MarketEvent => {
      const v = base.value as Ev;
      return { ...base, id: `ev:newer:${n}`, moment: next(), value: { ...v, event: { ...v.event, signature: `newer${n}`, data: { ...v.event.data, timestamp: BigInt(Math.floor(atMs / 1000)) } } } };
    };
    /** The first trade again as a confirmed log line, released now. */
    const repeat = (): MarketEvent => {
      const first = trades()[0]!;
      return { ...first, id: 'log:repeat:00000', key: `logs:${first.key}`, moment: { ...next(), txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN }, value: { ...(first.value as object), signature: (first.value as Ev).event.signature, commitment: 'confirmed' } };
    };
    const state = (w: FactWorld) => ({ candles: parseCandles(w.last(candlesKey(MINT)))!, book: w.producer.candleBook(POOL)! });

    it('a repeat just inside the window (W − 1 s behind the newest trade) counts once: candles and reserve unchanged, not partial', () => {
      const w = spreadWorld().push(newer(atMsOf(trades()[0]!) + W - 1_000, 1));
      const before = state(w);
      w.push(repeat());
      const after = state(w);
      expect(after.candles.candles).toEqual(before.candles.candles);
      expect(after.candles.obs.quality).toEqual([]);
      expect(after.book.reserve).toEqual(before.book.reserve);
      expect(after.book.ids).toBe(before.book.ids);
    });

    it('a repeat exactly W behind the newest trade is still inside the window: counted once, not partial', () => {
      const w = spreadWorld().push(newer(atMsOf(trades()[0]!) + W, 1));
      const before = state(w);
      w.push(repeat());
      const after = state(w);
      expect(after.candles).toEqual(before.candles);
      expect(after.book.reserve).toEqual(before.book.reserve);
    });

    it('the repeat id is the same from a log line and from the fetched transaction of every recorded swap, and two swaps in one transaction differ', () => {
      type Swap = { name: string; data: { poolBaseTokenReserves: bigint; poolQuoteTokenReserves: bigint } };
      const ids = (events: MarketEvent[]) => events.filter((e) => /pump_amm:(Buy|Sell)Event:/.test(e.key)).map((e) => {
        const v = e.value as { signature?: string; event: Swap & { signature?: string } };
        return tradeRepeatId((v.signature ?? v.event.signature)!, v.event.data.poolBaseTokenReserves, v.event.data.poolQuoteTokenReserves);
      });
      const chain = TRANSACTIONS.map((t) => recordFromRpc(t.signature, t.base64 as never));
      for (const x of [...swaps, migrate, ...RECORDS.map((r) => r.rec), ...chain]) {
        const fromTx = ids(txEvents(x));
        expect(ids(logEvents(x, 'confirmed')), x.signature).toEqual(fromTx);
        expect(new Set(fromTx).size, x.signature).toBe(fromTx.length);
      }
      // A recorded transaction with two PumpSwap swaps (a sell then a buy): two different ids.
      expect(chain.some((r) => ids(txEvents(r)).length > 1)).toBe(true);
      // Compact: a fresh 22 + up to 7 character string, never the whole signature.
      for (const id of ids(txEvents(swaps[0]!))) expect(id.length).toBeLessThanOrEqual(29);
    });

    it('a repeat just outside the window (W + 1 s behind) is never applied: reserve unchanged, the candles partial, H11 refuses them', () => {
      // W − 1 s first (a sweep runs there and keeps the first trade's id), then W + 1 s two seconds later (no sweep): the
      // id is still remembered when the repeat arrives, so only the window refuses it.
      const w = spreadWorld().push(newer(atMsOf(trades()[0]!) + W - 1_000, 1));
      const kept = w.producer.candleBook(POOL)!.ids;
      w.push(newer(atMsOf(trades()[0]!) + W + 1_000, 2));
      expect(w.producer.candleBook(POOL)!.ids).toBe(kept + 1);
      const before = state(w);
      w.push(repeat());
      const after = state(w);
      expect(after.candles.candles).toEqual(before.candles.candles);
      expect(after.candles.obs.quality).toEqual(['partial']);
      expect(after.book.reserve).toEqual(before.book.reserve);
      const head = slot + 10n;
      w.push(slotNotice(head, at + 500));
      expect(ev(w, { slot: head, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: at + 501 }).read('candles', candlesKey(MINT), parseCandles, 'state', 'H11').ok).toBe(false);
    });

    it('the same swaps from live log lines and, half an hour later, from a gap fill\'s fetched transactions count once', () => {
      const w = new FactWorld();
      w.push(...covered(), ...txEvents(create), ...txEvents(complete), ...txEvents(migrate));
      for (const x of swaps) w.push(...logEvents(x, 'confirmed'));
      w.push(newer(atOf(swaps.at(-1)!) + 30 * 60_000, 1));
      const before = state(w);
      // The fill: every swap again from its fetched transaction, backfilled, released after everything so far.
      for (const x of swaps) w.push(...txEvents(x).map((e) => ({ ...e, moment: next(), value: { ...(e.value as object), backfilled: true } })));
      const after = state(w);
      expect(after.candles.candles).toEqual(before.candles.candles);
      expect(after.candles.obs.quality).toEqual([]);
      expect(after.book.reserve).toEqual(before.book.reserve);
    });

    it('a catch-up: the fill\'s fetched transactions first, then the same swaps as held log lines released after, count once', () => {
      const once = state(build());
      const w = new FactWorld();
      w.push(...covered(), ...txEvents(create), ...txEvents(complete), ...txEvents(migrate), ...swapEvents());
      for (const x of swaps) w.push(...logEvents(x, 'confirmed').map((e) => ({ ...e, moment: { ...next(), txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN } })));
      const after = state(w);
      expect(after.candles.candles).toEqual(once.candles.candles);
      expect(after.candles.obs.quality).toEqual([]);
      expect(after.book.reserve).toEqual(once.book.reserve);
    });

    it('OOM-MINT: once its pool and mint are retired, no later trade is applied and nothing is built again: a new trade, a repeat, the migration re-delivered', () => {
      const w = build();
      const candlesBefore = w.facts(candlesKey(MINT)).length;
      const migrationBefore = w.facts(migrationKey(MINT)).length;
      w.producer.retire([MINT, POOL]);
      expect(w.producer.candleBook(POOL)).toBeUndefined();
      const again = (events: MarketEvent[]) => events.map((e) => ({ ...e, moment: { ...next(), txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN } }));
      w.push(newer(atOf(swaps.at(-1)!) + 60_000, 1));
      w.push(repeat());
      w.push(...again(txEvents(complete)), ...again(txEvents(migrate)), ...again(swapEvents()));
      expect(w.producer.candleBook(POOL)).toBeUndefined();
      expect(w.facts(candlesKey(MINT)).length).toBe(candlesBefore);
      expect(w.facts(migrationKey(MINT)).length).toBe(migrationBefore);
    });

    it('OOM-MINT: a retired mint leaves the wallets\' mint lists it was in (creator and buyers), and the tombstones stay capped', () => {
      const w = build();
      const before = w.producer.sizes();
      expect(before.walletMints).toBeGreaterThan(0);
      w.producer.retire([MINT, POOL]);
      const after = w.producer.sizes();
      // This world's wallets hold only this mint: every list it was in is gone with it.
      expect(after.walletMints).toBe(0);
      expect(after.mints).toBe(before.mints - 1);
      expect([after.retiredMints, after.retiredPools]).toEqual([1, 1]);
      expect(RETIRED_KEEP).toBe(100_000);
      // The cap: the oldest go first, the newest stay, never more than the cap.
      const set = new Set<string>();
      for (let k = 0; k < 10; k++) cappedAdd(set, `Gone${k}`, 4);
      expect([...set]).toEqual(['Gone6', 'Gone7', 'Gone8', 'Gone9']);
    });

    it('the remembered ids level off: 3,072 trades a second apart with a one-minute window keep at most a window and a quarter and a minute, and a sweep never forgets a trade inside the window', () => {
      const w = new FactWorld({ ...OPTIONS, tradeRepeatMs: 60_000 });
      w.push(...covered(), ...txEvents(create), ...txEvents(complete), ...txEvents(migrate));
      const start = atOf(migrate) + 60_000;
      const sizes: number[] = [];
      for (let k = 0; k < 3_072; k += 64) {
        w.push(...Array.from({ length: 64 }, (_, j) => newer(start + (k + j) * 1_000, k + j)));
        sizes.push(w.producer.candleBook(POOL)!.ids);
        // The batch's last 20 trades again (the same ids, released later): inside the window, each counts once.
        const before = parseCandles(w.last(candlesKey(MINT)))!;
        w.push(...Array.from({ length: 20 }, (_, j) => newer(start + (k + 44 + j) * 1_000, k + 44 + j)));
        expect(parseCandles(w.last(candlesKey(MINT)))!, `after trade ${k + 63}`).toEqual(before);
      }
      // Kept: the trades of the window, a quarter window between sweeps and the minute a trade's time is rounded to (135 a
      // second apart) at most, whatever the run's length.
      expect(Math.max(...sizes.slice(2))).toBeLessThanOrEqual(136);
      expect(Math.min(...sizes.slice(2))).toBeGreaterThanOrEqual(60);
      expect(parseCandles(w.last(candlesKey(MINT)))!.obs.quality).toEqual([]);
    });
  });

  it('a second pool of the same mint, created by anyone, never feeds the coin\'s candles', () => {
    const w = build();
    const before = w.facts(candlesKey(MINT)).length;
    // A CreatePoolEvent for the same base mint at another address (not the migration's pool), then a swap on it.
    const fake = 'Fake111111111111111111111111111111111111111';
    const cp = txEvents(migrate).find((e) => e.key.startsWith('pump_amm:CreatePoolEvent:'))!;
    const v = cp.value as { event: { data: Record<string, unknown> } };
    const head = swaps.at(-1)!.slot + 5n;
    const ev2 = (id: string, ix: number, data: Record<string, unknown>, name: string): MarketEvent => ({
      ...cp, id, key: `pump_amm:${name}:${fake}`, moment: { slot: head, txIndex: 2 ** 33, ixIndex: ix, receivedAt: atOf(swaps.at(-1)!) + 3000 },
      value: { ...v, txSlot: head, event: { ...v.event, name, signature: 'fakesig', data } },
    });
    const buy = swaps.flatMap((x) => txEvents(x)).find((e) => e.key.startsWith('pump_amm:BuyEvent:'))!;
    const bv = buy.value as { event: { data: Record<string, unknown> } };
    w.push(ev2('ev:fake:1', 1, { ...v.event.data, pool: fake }, 'CreatePoolEvent'), ev2('ev:fake:2', 2, { ...bv.event.data, pool: fake }, 'BuyEvent'));
    expect(w.facts(candlesKey(MINT)).length).toBe(before);
  });

  it('swaps seen only in processed log lines make no candles beyond the empty opening set', () => {
    const w = new FactWorld();
    w.push(...covered(), ...txEvents(complete), ...txEvents(migrate));
    w.push(...swaps.flatMap((s) => logEvents(s)));
    const all = w.facts(candlesKey(MINT));
    const c = parseCandles(all.at(-1)!.value)! as CandlesFact;
    // Only the migration transaction's own buy (fetched, confirmed) is in.
    expect(c.candles.length).toBe(1);
  });
});

describe('mint, pool and LP from a confirmed account read', () => {
  const read = () => ({ ...FIX.accountsRead, slot: BigInt(FIX.accountsRead.slot) });
  const at = 1_791_100_000_000;
  const slot = BigInt(FIX.accountsRead.slot);

  it('decodes the real mint, the canonical pool with both vaults and the LP mint', () => {
    const w = new FactWorld().push(...lifecycle(), offchain(RAW.accounts(MINT), read(), slot, at, 'helius'));
    const m = parseMint(w.last(mintKey(MINT)))!;
    expect(m.obs).toMatchObject({ slot, commitment: 'confirmed' });
    expect(m.account).toMatchObject({ mintAuthority: null, freezeAuthority: null });
    const p = parsePool(w.last(poolKey(MINT)))!;
    expect(p.address).toBe(POOL);
    expect(p.pool.baseMint).toBe(MINT);
    expect(p.quoteVault).toBeGreaterThan(0n);
    // H17 inputs (TX-1b): the pool account's size and its cashback and creator fields, from the same read.
    const extra = p as unknown as { accountBytes: number; pool: { isCashbackCoin?: boolean; coinCreator?: string } };
    expect(extra.accountBytes).toBe(Buffer.from(FIX.accountsRead.accounts[1]!.data!, 'base64').length);
    expect(typeof extra.pool.isCashbackCoin).toBe('boolean');
    expect(typeof extra.pool.coinCreator).toBe('string');
    const lp = parseLp(w.last(lpKey(MINT)))!;
    expect(lp.lpMint).toBe(p.pool.lpMint);
    // GATE-1 on the real accounts, two slots later: H1-H7 judged, no evidence failure among them.
    const r = evaluateHardRejects(w.ctx(after(slot + 2n, at + 800)), { session, mode: 'backtest' }, request(), { stopAtFirst: false });
    for (const g of ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7']) expect(r.evaluated).toContain(g);
    expect(r.reasons.filter((x) => ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7'].includes(x.neededBy ?? x.gate) && x.gate === 'H16')).toEqual([]);
  });

  it('a processed read makes nothing; three slots later the state is stale', () => {
    const p = new FactWorld().push(offchain(RAW.accounts(MINT), { ...read(), commitment: 'processed' }, slot, at));
    expect(p.facts(mintKey(MINT))).toEqual([]);
    const w = new FactWorld().push(...lifecycle(), offchain(RAW.accounts(MINT), read(), slot, at));
    const r = ev(w, after(slot + 3n, at + 1200)).read('mint', mintKey(MINT), parseMint, 'state', 'H1');
    expect(!r.ok && r.reason.code).toBe('stale');
  });

  it('a read without a vault, or with a vault of the wrong owner, makes no pool fact', () => {
    const r = read();
    const noVault = { ...r, accounts: r.accounts.map((a, i) => (i === 3 ? { ...a, owner: null, data: null } : a)) };
    expect(new FactWorld().push(offchain(RAW.accounts(MINT), noVault, slot, at)).facts(poolKey(MINT))).toEqual([]);
    // Swap the vault addresses: each account is then not the token account its slot names.
    const swapped = { ...r, accounts: r.accounts.map((a, i) => (i === 2 ? { ...a, data: r.accounts[3]!.data, owner: r.accounts[3]!.owner } : i === 3 ? { ...a, data: r.accounts[2]!.data, owner: r.accounts[2]!.owner } : a)) };
    expect(new FactWorld().push(offchain(RAW.accounts(MINT), swapped, slot, at)).facts(poolKey(MINT))).toEqual([]);
  });

  it('a malformed read, or one filed under another mint, is ignored', () => {
    expect(new FactWorld().push(offchain(RAW.accounts(MINT), { ...read(), slot: 'x' }, slot, at)).released.filter((e) => e.id.includes('~'))).toEqual([]);
    expect(new FactWorld().push(offchain(RAW.accounts(POOL), read(), slot, at)).released.filter((e) => e.id.includes('~'))).toEqual([]);
  });
});

describe('holders', () => {
  const h = FIX.holdersRaw;
  const holdersRead = () => ({
    mint: MINT, slot: BigInt(Math.min(h.largest.context.slot, h.tokenAccountsSlot, h.ownersSlot)), commitment: 'confirmed',
    supply: BigInt(supplyOf()), accounts: h.largest.value.map((a, i) => ({ address: a.address, owner: h.owners[i]!.owner, ownerProgram: h.owners[i]!.program === '11111111111111111111111111111111' ? null : h.owners[i]!.program, amount: BigInt(a.amount), delegate: null, delegatedAmount: 0n })),
  });
  const supplyOf = (): bigint => {
    const w = new FactWorld().push(offchain(RAW.accounts(MINT), { ...FIX.accountsRead, slot: BigInt(FIX.accountsRead.slot) }, BigInt(FIX.accountsRead.slot), 1));
    return parseMint(w.last(mintKey(MINT)))!.account!.supply;
  };

  it('the largest accounts with owners classified make the holders fact (coverage "largest")', () => {
    const r = holdersRead();
    const w = new FactWorld().push(offchain(RAW.holders(MINT), r, r.slot, 1_791_100_000_000, 'helius'));
    const f = parseHolders(w.last(holdersKey(MINT)))!;
    expect(f.coverage).toBe('largest');
    expect(f.accounts).toHaveLength(r.accounts.length);
    expect(f.obs).toMatchObject({ slot: r.slot, commitment: 'confirmed' });
  });

  it('a processed or malformed holders read makes nothing', () => {
    const r = holdersRead();
    expect(new FactWorld().push(offchain(RAW.holders(MINT), { ...r, commitment: 'processed' }, r.slot, 1)).facts(holdersKey(MINT))).toEqual([]);
    expect(new FactWorld().push(offchain(RAW.holders(MINT), { ...r, supply: -1n }, r.slot, 1)).facts(holdersKey(MINT))).toEqual([]);
  });
});

describe('insiders', () => {
  const s0 = create.slot;
  const stream = STREAMS.mintTxs(MINT);
  const window = RECORDS.filter((r) => r.label === 'creation window' || r.label === 'first buyers').map((r) => r.rec);
  const funders = () => FIX.funders.map((f) => ({ ...f, asOfSlot: BigInt(f.asOfSlot), slot: f.slot === null ? null : BigInt(f.slot) }));
  const run = (opts: { cover?: boolean; funders?: ReturnType<typeof funders>; head?: boolean } = {}): FactWorld => {
    const w = new FactWorld();
    if (opts.cover ?? true) w.push(coverage(stream, 'start', { fromSlot: s0, via: `sigs:${MINT}` }, s0 - 1n, atOf(create) - 1000));
    w.push(...window.flatMap((r) => txEvents(r)));
    const last = window.at(-1)!;
    for (const f of opts.funders ?? funders()) w.push(offchain(RAW.funder(f.wallet), f, last.slot, atOf(last) + 100));
    if (opts.head ?? true) w.push(slotNotice(last.slot + 3n, atOf(last) + 2000));
    return w;
  };

  it('creation-slot buyers and dev-funded first buyers, complete only with coverage and every funder found', () => {
    const w = run();
    const f = parseInsiders(w.last(insidersKey(MINT)))!;
    // The first buyers by the slot rule, from the real transactions: complete only if each has a complete funder read.
    const firstSlot = new Map<string, bigint>();
    let curveDone: bigint | null = null;
    for (const r of window) for (const e of transactionEvents(r)) {
      if (e.name === 'TradeEvent' && e.data.isBuy && e.data.mint === MINT && !firstSlot.has(e.data.user)) firstSlot.set(e.data.user, e.slot);
      if (e.name === 'CompleteEvent' && e.data.mint === MINT) curveDone ??= e.slot;
    }
    const slots = [...firstSlot.values()].sort((a, b) => (a < b ? -1 : 1));
    const through = slots.length >= 20 ? slots[19]! : curveDone!;
    const expected = [...firstSlot].filter(([, at]) => at <= through).map(([x]) => x);
    const found = new Map(FIX.funders.map((x) => [x.wallet, x.complete]));
    expect(f.complete).toBe([FIX.meta.creator, ...expected].every((x) => found.get(x) === true));
    // Every creation-slot buyer from the real transactions is listed (the dev aside: the gate adds the dev).
    const creator = parseCreate(w.last(createKey(MINT)))!.creator;
    const buyers = new Set<string>();
    for (const r of window) for (const e of transactionEvents(r)) if (e.name === 'TradeEvent' && e.data.isBuy && e.data.mint === MINT && e.slot <= s0 + 2n && e.data.user !== creator) buyers.add(e.data.user);
    for (const b of buyers) expect(f.insiders).toContain(b);
    // Cluster = first buyers funded by the dev or by the dev's own first funder (on this coin: a real bundle).
    const devFunder = FIX.funders.find((x) => x.wallet === creator)?.funder ?? null;
    const funded = FIX.funders.filter((x) => x.wallet !== creator && (x.funder === creator || (devFunder !== null && x.funder === devFunder))).map((x) => x.wallet).sort();
    expect(funded.length).toBeGreaterThan(0);
    expect(f.devCluster).toEqual(funded);
    expect(w.last('gates/soft:' + MINT)).toMatchObject({ creationSlotBuyers: expect.any(Number) });
  });

  it('a missing or incomplete funder, no coverage, or a head short of the window: H13 rejects as not covered', () => {
    const missing = run({ funders: funders().slice(1) });
    expect(parseInsiders(missing.last(insidersKey(MINT)))!.complete).toBe(false);
    const incomplete = run({ funders: funders().map((f, i) => (i === 0 ? { ...f, complete: false, funder: null, signature: null, slot: null } : f)) });
    expect(parseInsiders(incomplete.last(insidersKey(MINT)))!.complete).toBe(false);
    expect(run({ cover: false }).facts(insidersKey(MINT))).toEqual([]);
    // Coverage that starts after the creation slot, an open gap inside the window, or no slot head yet.
    const lateStart = new FactWorld().push(coverage(stream, 'start', { fromSlot: s0 + 1n, via: `sigs:${MINT}` }, s0 - 1n, atOf(create) - 1000));
    lateStart.push(...window.flatMap((r) => txEvents(r)));
    for (const f of funders()) lateStart.push(offchain(RAW.funder(f.wallet), f, window.at(-1)!.slot, atOf(window.at(-1)!) + 100));
    lateStart.push(slotNotice(window.at(-1)!.slot + 3n, atOf(window.at(-1)!) + 2000));
    expect(parseInsiders(lateStart.last(insidersKey(MINT)))!.complete).toBe(false);
    const open = new FactWorld().push(
      coverage(stream, 'start', { fromSlot: s0, via: `sigs:${MINT}` }, s0 - 1n, atOf(create) - 1000),
      coverage(stream, 'gap', { fromSlot: s0 + 1n, toSlot: null, reason: 'x', via: `sigs:${MINT}` }, s0 - 1n, atOf(create) - 900),
    );
    open.push(...window.flatMap((r) => txEvents(r)));
    for (const f of funders()) open.push(offchain(RAW.funder(f.wallet), f, window.at(-1)!.slot, atOf(window.at(-1)!) + 100));
    open.push(slotNotice(window.at(-1)!.slot + 3n, atOf(window.at(-1)!) + 2000));
    expect(parseInsiders(open.last(insidersKey(MINT)))!.complete).toBe(false);
    expect(parseInsiders(run({ head: false }).last(insidersKey(MINT)))!.complete).toBe(false);
    // The control: the same inputs with coverage from s0 and the head past the window are complete.
    expect(parseInsiders(run().last(insidersKey(MINT)))!.complete).toBe(true);
    const gap = run({ head: false }).push(coverage(stream, 'gap', { fromSlot: s0 + 1n, toSlot: s0 + 1n, reason: 'x', via: `sigs:${MINT}` }, window.at(-1)!.slot + 4n, atOf(window.at(-1)!) + 3000));
    expect(parseInsiders(gap.last(insidersKey(MINT)))!.complete).toBe(false);
  });
});

describe('funding as of the decision', () => {
  const s0 = create.slot;
  const stream = STREAMS.mintTxs(MINT);
  const window = RECORDS.filter((r) => r.label === 'creation window').map((r) => r.rec);
  const base = () => FIX.funders.map((f) => ({ ...f, asOfSlot: BigInt(f.asOfSlot), slot: f.slot === null ? null : BigInt(f.slot) }));
  const world = (fs: ReturnType<typeof base>, at: bigint) => {
    const w = new FactWorld().push(coverage(stream, 'start', { fromSlot: s0, via: `sigs:${MINT}` }, s0 - 1n, atOf(create) - 1000));
    w.push(...window.flatMap((r) => txEvents(r)));
    const last = window.at(-1)!;
    for (const f of fs) w.push(offchain(RAW.funder(f.wallet), f, last.slot, atOf(last) + 100));
    w.push(slotNotice(at, atOf(last) + 2000));
    return w;
  };

  it('a funding dated after now does not count, and "no transaction yet" holds only up to its own slot', () => {
    const at = window.at(-1)!.slot + 3n;
    expect(parseInsiders(world(base(), at).last(insidersKey(MINT)))!.complete).toBe(true);
    const future = base().map((f, i) => (i === 1 && f.slot !== null ? { ...f, slot: at + 1_000n, asOfSlot: at + 1_000n } : f));
    expect(parseInsiders(world(future, at).last(insidersKey(MINT)))!.complete).toBe(false);
    const stale = base().map((f, i) => (i === 1 ? { ...f, funder: null, signature: null, slot: null, atMs: null, asOfSlot: s0 - 1n } : f));
    expect(parseInsiders(world(stale, at).last(insidersKey(MINT)))!.complete).toBe(false);
  });

  it('soft values are read at a real decision, an hour after migration', () => {
    const at = window.at(-1)!.slot + 3n;
    const w = world(base(), at);
    const later: Moment = { slot: migrate.slot + 9_000n, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: 1_791_032_673_000 + 3_600_000 };
    w.push(slotNotice(later.slot, later.receivedAt));
    const r = evaluateSoftFeatures(w.ctx(later), { session, mode: 'backtest' }, MINT);
    const v = (n: string) => r.features.find((f) => f.name === n)?.value;
    expect(v('creationSlotBuyers')).not.toBeNull();
    expect(v('devBuySameTx')).not.toBeNull();
  });

  it('the dev\'s own funder is required, and soft counts linked, independent and unresolved first buyers', () => {
    const at = window.at(-1)!.slot + 3n;
    const noDev = base().filter((f) => f.wallet !== FIX.meta.creator);
    expect(parseInsiders(world(noDev, at).last(insidersKey(MINT)))!.complete).toBe(false);
    const soft = world(base(), at).last('gates/soft:' + MINT) as Record<string, unknown>;
    const n = (soft['knownLinkedOwners'] as number) + (soft['supportedIndependentOwners'] as number) + (soft['unresolvedOwners'] as number);
    expect(n).toBe(FIX.meta.firstBuyers.filter((b) => b !== FIX.meta.creator).length);
    expect(soft['knownLinkedOwners']).toBeGreaterThan(0);
    expect(soft['completeness']).toBe('complete');
  });
});

describe('insider links (funding.ts)', () => {
  const read = (wallet: string, funder: string | null, complete = true) => ({ wallet, asOfSlot: 100n, complete, funder, signature: funder === null ? null : 'sig', slot: funder === null ? null : 10n, atMs: funder === null ? null : 1 });
  const dev = 'Dev1111111111111111111111111111111111111111';
  const b1 = 'Buy1111111111111111111111111111111111111111';
  const b2 = 'Buy2111111111111111111111111111111111111111';
  const links = (rs: ReturnType<typeof read>[]) => insiderLinks(dev, [b1, b2], (w) => rs.find((r) => r.wallet === w));

  it('links buyers funded by the dev or by the dev\'s funder', () => {
    expect(links([read(dev, 'Src1111111111111111111111111111111111111111'), read(b1, dev), read(b2, 'Src1111111111111111111111111111111111111111')])).toMatchObject({ funded: [b1], devCluster: [b1, b2] });
  });

  it('a complete read without a funder is unknown, not unlinked', () => {
    expect(links([read(dev, 'Src1111111111111111111111111111111111111111'), read(b1, dev), read(b2, null)])).toBeNull();
  });

  it('an unknown dev funder makes the links unknown', () => {
    expect(links([read(b1, dev), read(b2, dev)])).toBeNull();
    expect(links([read(dev, null), read(b1, dev), read(b2, dev)])).toBeNull();
    expect(links([read(dev, 'Src1111111111111111111111111111111111111111', false), read(b1, dev), read(b2, dev)])).toBeNull();
  });
});

describe('complete holder set', () => {
  const hc = FIX.holdersComplete;
  const read = (over: Partial<Record<string, unknown>> = {}) => ({
    mint: MINT, slot: BigInt(hc.gpa.slot), commitment: 'confirmed', program: hc.mint.owner, mintSlot: BigInt(hc.mint.slot), mintData: hc.mint.data,
    accounts: hc.gpa.accounts, ownerPrograms: [], ...over,
  });
  const fact = (r: unknown) => new FactWorld().push(offchain(RAW.holdersAll(MINT), r, BigInt(hc.gpa.slot), 1_791_100_000_000, 'helius')).last(holdersKey(MINT));

  it('one real program-account read gives every holder, summing to the supply exactly (coverage all)', () => {
    const f = parseHolders(fact(read()))!;
    expect(f.coverage).toBe('all');
    expect((f as unknown as { completeness: string }).completeness).toBe('complete');
    expect(f.accounts.reduce((s, a) => s + a.amount, 0n)).toBe(f.supply);
    // Token-2022 accounts carry extensions: 170 bytes or more, and they are in.
    expect(hc.gpa.accounts.some((a) => Buffer.from(a.data, 'base64').length >= 170)).toBe(true);
    expect(f.accounts.every((a) => (a as unknown as { mint: string }).mint === MINT)).toBe(true);
  });

  it('the indexed Token-2022 filter (AccountType at 165) drops only extension-less accounts: here all four are empty', () => {
    const typed = hc.gpa.accounts.filter((a) => { const b = Buffer.from(a.data, 'base64'); return b.length > 165 && b[165] === 2; });
    expect(hc.gpa.accounts.length - typed.length).toBe(4);
    const f = parseHolders(fact(read({ accounts: typed })))!;
    expect(f.accounts.reduce((s, a) => s + a.amount, 0n)).toBe(f.supply);
    // Delegates ride along for GATE-1e.
    expect(f.accounts.every((a) => 'delegate' in a && 'delegatedAmount' in a)).toBe(true);
  });

  it('an extension-less Token-2022 account that holds tokens, dropped by the indexed filter: no holder fact, H12 rejects, abstention counted', () => {
    // Move half of one holder's balance into a 165-byte account: the full set still sums to the supply.
    const bufs = hc.gpa.accounts.map((a) => Buffer.from(a.data, 'base64'));
    const holder = bufs.findIndex((b) => b.length > 165 && b.readBigUInt64LE(64) > 1n);
    const plain = bufs.findIndex((b) => b.length === 165);
    const v = bufs[holder]!.readBigUInt64LE(64);
    bufs[holder]!.writeBigUInt64LE(v - v / 2n, 64);
    bufs[plain]!.writeBigUInt64LE(v / 2n, 64);
    const all = hc.gpa.accounts.map((a, i) => ({ ...a, data: bufs[i]!.toString('base64') }));
    expect(parseHolders(fact(read({ accounts: all })))!.coverage).toBe('all');
    const indexed = all.filter((_, i) => bufs[i]!.length > 165 && bufs[i]![165] === 2);
    const w = new FactWorld().push(...lifecycle(), offchain(RAW.holdersAll(MINT), read({ accounts: indexed }), BigInt(hc.gpa.slot), 1_791_100_000_000, 'helius'));
    expect(w.facts(holdersKey(MINT))).toEqual([]);
    expect(w.last(HOLDER_ABSTENTIONS_KEY)).toMatchObject({ day: Math.floor(1_791_100_000_000 / 86_400_000), counts: { 'sum-mismatch': 1 }, last: { mint: MINT, reason: 'sum-mismatch' } });
    const r = evaluateHardRejects(w.ctx(after(BigInt(hc.gpa.slot) + 1n, 1_791_100_000_500)), { session, mode: 'backtest' }, request(), { stopAtFirst: false });
    expect(r.reasons.some((x) => x.gate === 'H16' && x.neededBy === 'H12' && x.input === 'holders')).toBe(true);
  });

  it('a fallback after a refused mint-only scan is counted, and an indexed answer missing a holding account forms no fact', () => {
    const bufs = hc.gpa.accounts.map((a) => Buffer.from(a.data, 'base64'));
    const holder = bufs.findIndex((b) => b.length > 165 && b.readBigUInt64LE(64) > 1n);
    const plain = bufs.findIndex((b) => b.length === 165);
    const v = bufs[holder]!.readBigUInt64LE(64);
    bufs[holder]!.writeBigUInt64LE(v - v / 2n, 64);
    bufs[plain]!.writeBigUInt64LE(v / 2n, 64);
    const all = hc.gpa.accounts.map((a, i) => ({ ...a, data: bufs[i]!.toString('base64') }));
    // Mint only (the default) counts the extension-less holder: the sum matches.
    expect(parseHolders(fact(read({ accounts: all, filter: 'mintOnly', fallback: false })))!.accounts.some((a) => a.address === all[plain]!.address)).toBe(true);
    const indexed = all.filter((_, i) => bufs[i]!.length > 165 && bufs[i]![165] === 2);
    const w = new FactWorld().push(offchain(RAW.holdersAll(MINT), read({ accounts: indexed, filter: 'indexed', fallback: true }), BigInt(hc.gpa.slot), 1_791_100_000_000, 'helius'));
    expect(w.facts(holdersKey(MINT))).toEqual([]);
    expect(w.last(HOLDER_ABSTENTIONS_KEY)).toMatchObject({ counts: { 'mint-only-refused': 1, 'sum-mismatch': 1 } });
    // A fallback whose indexed answer is complete still forms the fact, and is still counted.
    const ok = new FactWorld().push(offchain(RAW.holdersAll(MINT), read({ filter: 'indexed', fallback: true }), BigInt(hc.gpa.slot), 1_791_100_000_000, 'helius'));
    expect(ok.facts(holdersKey(MINT))).toHaveLength(1);
    expect(ok.last(HOLDER_ABSTENTIONS_KEY)).toMatchObject({ counts: { 'mint-only-refused': 1 } });
  });

  it('a repeated address, a wrong program, a mint read after the scan or a wrong total proves nothing', () => {
    expect(fact(read({ accounts: [...hc.gpa.accounts, hc.gpa.accounts[0]!] }))).toBeUndefined();
    expect(fact(read({ accounts: hc.gpa.accounts.map((a, i) => (i === 0 ? { ...a, owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' } : a)) }))).toBeUndefined();
    expect(fact(read({ mintSlot: BigInt(hc.gpa.slot) + 1n }))).toBeUndefined();
    // One holding account missing: the balances no longer sum to the supply.
    const holding = hc.gpa.accounts.findIndex((a) => Buffer.from(a.data, 'base64').readBigUInt64LE(64) > 0n);
    expect(fact(read({ accounts: hc.gpa.accounts.filter((_, i) => i !== holding) }))).toBeUndefined();
    expect(fact(read({ commitment: 'processed' }))).toBeUndefined();
    // A mint that can still mint: the supply could grow, so no set is complete. Set the COption tag and an authority.
    const mint = Buffer.from(hc.mint.data, 'base64');
    mint.writeUInt32LE(1, 0);
    mint.fill(7, 4, 36);
    expect(fact(read({ mintData: mint.toString('base64') }))).toBeUndefined();
    // A token account of another mint in the answer.
    const other = Buffer.from(hc.gpa.accounts[0]!.data, 'base64');
    other.fill(9, 0, 32);
    expect(fact(read({ accounts: hc.gpa.accounts.map((a, i) => (i === 0 ? { ...a, data: other.toString('base64') } : a)) }))).toBeUndefined();
  });
});

describe('coverage and window bounds (review mutants)', () => {
  const s0 = create.slot;
  const stream = STREAMS.mintTxs(MINT);
  const window = RECORDS.filter((r) => r.label === 'creation window').map((r) => r.rec);
  const reads = () => FIX.funders.map((f) => ({ ...f, asOfSlot: BigInt(f.asOfSlot), slot: f.slot === null ? null : BigInt(f.slot) }));
  const last = window.at(-1)!;
  const insidersWith = (cover: MarketEvent[], extra: MarketEvent[] = []) => {
    const w = new FactWorld().push(...cover);
    w.push(...window.flatMap((r) => txEvents(r)));
    for (const f of reads()) w.push(offchain(RAW.funder(f.wallet), f, last.slot, atOf(last) + 100));
    w.push(...extra, slotNotice(last.slot + 3n, atOf(last) + 2000));
    return w;
  };
  const start = (from: bigint, n = 0) => coverage(stream, 'start', { fromSlot: from, via: `sigs:${MINT}` }, s0 - 1n, atOf(create) - 1000 + n);

  it('a bounded gap inside the window leaves the insiders incomplete, with the head past it', () => {
    expect(parseInsiders(insidersWith([start(s0)]).last(insidersKey(MINT)))!.complete).toBe(true);
    const gap = coverage(stream, 'gap', { fromSlot: s0 + 1n, toSlot: s0 + 1n, reason: 'x', via: `sigs:${MINT}` }, s0 - 1n, atOf(create) - 900);
    expect(parseInsiders(insidersWith([start(s0), gap]).last(insidersKey(MINT)))!.complete).toBe(false);
  });

  it('a restart after an open gap keeps the missed range as a gap', () => {
    const open = coverage(stream, 'gap', { fromSlot: s0 + 1n, toSlot: null, reason: 'disconnect', via: `sigs:${MINT}` }, s0 - 1n, atOf(create) - 900);
    expect(parseInsiders(insidersWith([start(s0), open, start(s0 + 3n, 200)]).last(insidersKey(MINT)))!.complete).toBe(false);
  });

  it('the creation window is s0..s0+2: a buy at s0+3 is not a creation-slot buyer', () => {
    const base = parseInsiders(insidersWith([start(s0)]).last(insidersKey(MINT)))!;
    const buy = window.flatMap((r) => txEvents(r)).find((e) => e.key.startsWith('pump:TradeEvent:') && ((e.value as { event: { data: { isBuy: boolean } } }).event.data.isBuy))!;
    const v = buy.value as { event: { data: Record<string, unknown> } };
    const late: MarketEvent = { ...buy, id: 'ev:late-buyer:00000:00000', moment: { ...buy.moment, slot: s0 + 3n, txIndex: 2 ** 33 }, value: { ...v, txSlot: s0 + 3n, event: { ...v.event, signature: 'late-buyer', data: { ...v.event.data, user: 'LateBuyer1111111111111111111111111111111111' } } } };
    const f = parseInsiders(insidersWith([start(s0)], [late]).last(insidersKey(MINT)))!;
    expect(f.insiders).toEqual(base.insiders);
    // Once the curve completed, a later buyer is not a first buyer either: the set and its completeness stand.
    expect(f.complete).toBe(base.complete);
    // Without the completion (so every buyer is kept), the window alone keeps it out of the creation-slot buyers.
    const noComplete = (e: MarketEvent) => !e.key.startsWith('pump:CompleteEvent:');
    const w2 = new FactWorld().push(start(s0));
    w2.push(...window.flatMap((r) => txEvents(r)).filter(noComplete), late, slotNotice(last.slot + 3n, atOf(last) + 2000));
    expect(parseInsiders(w2.last(insidersKey(MINT)))!.insiders).not.toContain('LateBuyer1111111111111111111111111111111111');
  });

  it('a cut log carrying events opens a hole in its stream', () => {
    const tradesStream = STREAMS.trades(POOL);
    const head = swaps.at(-1)!.slot + 1n;
    const at = atOf(swaps.at(-1)!) + 1000;
    const w = new FactWorld().push(coverage(tradesStream, 'start', { fromSlot: migrate.slot, via: `logs:${POOL}` }, migrate.slot - 1n, atOf(migrate) - 500));
    w.push(...txEvents(complete), ...txEvents(migrate));
    for (const x of swaps.slice(0, -1)) w.push(...txEvents(x));
    // The last swap arrives only as confirmed log lines, cut after its events.
    w.push(...logEvents(swaps.at(-1)!, 'confirmed').map((e) => ({ ...e, value: { ...(e.value as object), truncated: true } })));
    w.push(slotNotice(head, at));
    const r = ev(w, after(head, at + 1)).read('candles', candlesKey(MINT), parseCandles, 'state', 'H11');
    expect(!r.ok && r.reason.code).toBe('gap');
  });

  it('survival takes only a reserve from before the mark', () => {
    const mark = 1_791_032_673_000 + 30 * 60_000;
    const w = new FactWorld();
    w.push(coverage(STREAMS.trades(POOL), 'start', { fromSlot: migrate.slot, via: `logs:${POOL}` }, migrate.slot - 1n, atOf(migrate) - 500), ...txEvents(complete), ...txEvents(migrate));
    w.push(slotNotice(migrate.slot + 1n, atOf(migrate) + 400));
    // A swap stamped after the mark (on-chain clock) arrives before the first event at the mark.
    const sw = swaps.flatMap((x) => txEvents(x)).find((e) => e.key.startsWith('pump_amm:BuyEvent:'))!;
    const v = sw.value as { event: { data: Record<string, unknown> } };
    w.push({ ...sw, id: 'ev:after-mark:00000:00000', moment: { ...sw.moment, slot: migrate.slot + 10n, receivedAt: mark - 1000 }, value: { ...v, txSlot: migrate.slot + 10n, event: { ...v.event, signature: 'after-mark', data: { ...v.event.data, timestamp: BigInt((mark + 10_000) / 1000) } } } });
    w.push(slotNotice(migrate.slot + 4600n, mark + 5));
    expect(w.facts(GRADUATES_KEY)).toEqual([]);
  });

  it('an older account read never overwrites newer state', () => {
    const r = { ...FIX.accountsRead, slot: BigInt(FIX.accountsRead.slot) };
    const quoteVault = (w: FactWorld) => parsePool(w.last(poolKey(MINT)))!.quoteVault;
    const w = new FactWorld().push(...lifecycle(), offchain(RAW.accounts(MINT), r, r.slot, 1_791_100_000_000));
    const before = quoteVault(w);
    // The same accounts read at an older slot with an emptied quote vault (bytes 64..72 are the amount).
    const data = Buffer.from(r.accounts[3]!.data!, 'base64');
    data.writeBigUInt64LE(1n, 64);
    const older = { ...r, slot: r.slot - 5n, accounts: r.accounts.map((a, i) => (i === 3 ? { ...a, data: data.toString('base64') } : a)) };
    w.push(offchain(RAW.accounts(MINT), older, r.slot, 1_791_100_000_100));
    expect(quoteVault(w)).toBe(before);
    expect(parsePool(w.last(poolKey(MINT)))!.obs.slot).toBe(r.slot);
  });
});

describe('cross-checks, simulation and execution health (live-only vetoes)', () => {
  const tp = FIX.thirdParty;
  const slot = 453_000_000n;
  const at = 1_791_100_000_000;
  const reads = (t: number): MarketEvent[] => [
    offchain(RAW.rugcheck(MINT), { mint: MINT, mintAuthority: tp.rugcheck.mintAuthority, freezeAuthority: tp.rugcheck.freezeAuthority }, slot, t, 'rugcheck'),
    ...(tp.goplus === null ? [] : [offchain(RAW.goplus(MINT), { mint: MINT, mintable: tp.goplus.mintable.status, freezable: tp.goplus.freezable.status }, slot, t + 1, 'goplus')]),
    ...(tp.jupiter === null ? [] : [offchain(RAW.jupiter(MINT), { mint: MINT, mintAuthorityDisabled: tp.jupiter.mintAuthorityDisabled ?? null, freezeAuthorityDisabled: tp.jupiter.freezeAuthorityDisabled ?? null }, slot, t + 2, 'jupiter')]),
  ];

  it('real third-party reads agree that both authorities are revoked', () => {
    const w = new FactWorld().push(...reads(at));
    const x = parseXcheck(w.last(xcheckKey(MINT)))!;
    expect(x.sources.length).toBeGreaterThanOrEqual(1);
    for (const s of x.sources) expect([s.mintAuthority, s.freezeAuthority]).toEqual(['none', 'none']);
    expect(x.obs.receivedAt).toBe(at);
  });

  it('a read older than the quote age is left out; the fact is as old as its oldest read', () => {
    const w = new FactWorld().push(...reads(at));
    w.push(offchain(RAW.rugcheck(MINT), { mint: MINT, mintAuthority: 'Auth1111111111111111111111111111111111111111', freezeAuthority: null }, slot + 10n, at + 5_000, 'rugcheck'));
    const x = parseXcheck(w.last(xcheckKey(MINT)))!;
    expect(x.sources).toEqual([{ provider: 'rugcheck', mintAuthority: 'set', freezeAuthority: 'none' }]);
    expect(x.obs.receivedAt).toBe(at + 5_000);
  });

  it('a simulation answer makes the sim fact; a malformed one nothing', () => {
    const w = new FactWorld().push(offchain(RAW.sim(MINT), { mint: MINT, slot, spend: 50_000_000n, ok: true, paid: 50_100_000n, proceeds: 48_000_000n, error: null }, slot, at));
    expect(parseSim(w.last(simKey(MINT)))).toMatchObject({ ok: true, spend: 50_000_000n, obs: { slot, receivedAt: at } });
    expect(new FactWorld().push(offchain(RAW.sim(MINT), { mint: MINT, slot, spend: 1n, ok: 'yes' }, slot, at)).facts(simKey(MINT))).toEqual([]);
  });

  it('execution health is never green without owner-set limits, and judged against them when set', () => {
    const stats = { attempts: 40, failed: 2, landingSlotsP50: 2, quoteErrorBpsP50: 30 };
    const w = new FactWorld().push(offchain(RAW.exec, stats, slot, at));
    expect(w.last(EXEC_HEALTH_KEY)).toMatchObject({ green: false, detail: expect.stringContaining('no execution-health limits') });
    const limits = { minAttempts: 20, maxFailedBps: 1000, maxLandingSlots: 4, maxQuoteErrorBps: 100 };
    const lw = new FactWorld({ ...OPTIONS, execHealth: limits }).push(offchain(RAW.exec, stats, slot, at));
    expect(lw.last(EXEC_HEALTH_KEY)).toMatchObject({ green: true });
    const bad = new FactWorld({ ...OPTIONS, execHealth: limits }).push(offchain(RAW.exec, { ...stats, failed: 10 }, slot, at));
    expect(bad.last(EXEC_HEALTH_KEY)).toMatchObject({ green: false, detail: expect.stringContaining('failure share') });
  });
});

describe('series: SOL/USD and chain volume', () => {
  const bars = (): { start: number; close: string }[] => {
    const NUM = '(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)';
    const re = new RegExp(`\\[\\s*(\\d+)\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*\\]`, 'g');
    return [...FIX.coinbase.matchAll(re)].map((m) => ({ start: Number(m[1]) * 1000, close: m[5]! })).sort((a, b) => a.start - b.start);
  };

  it('real hourly bars become SOL/USD points stamped at each bar\'s close, exact to the micro-dollar', () => {
    const b = bars();
    expect(b.length).toBeGreaterThan(40);
    const w = new FactWorld();
    b.forEach((x, i) => w.push(offchain(RAW.solUsd, x, BigInt(1000 + i), x.start + 2 * 3_600_000, 'coinbase')));
    const f = parseSolUsd(w.last(SOL_USD_KEY))!;
    const lastBar = b.at(-1)!;
    expect(f.points.at(-1)).toEqual({ tMs: lastBar.start + 3_600_000, price: decimalToMicro(lastBar.close) });
    // Only the kept window remains.
    expect(f.points[0]!.tMs).toBeGreaterThanOrEqual(f.points.at(-1)!.tMs - OPTIONS.solUsdKeepMs);
  });

  it('decimal prices round down to the micro-dollar and refuse anything else', () => {
    expect(decimalToMicro('150.1234569')).toBe(150_123_456n);
    expect(decimalToMicro('150')).toBe(150_000_000n);
    expect(decimalToMicro('0')).toBeNull();
    expect(decimalToMicro('-1')).toBeNull();
    expect(decimalToMicro('1e3')).toBeNull();
  });

  it('BT-1\'s bare series event and a bar not on an hour make no new point', () => {
    const w = new FactWorld().push(offchain(RAW.solUsd, { start: 1_791_000_000_001, close: '150' }, 1n, 1));
    expect(w.facts(SOL_USD_KEY)).toEqual([]);
    const bare: MarketEvent = { kind: 'market', id: 'x:sol-usd:1', moment: { slot: 1n, txIndex: OFF_CHAIN, ixIndex: 0, receivedAt: 1 }, key: 'sol-usd', value: { start: 1_790_996_400_000, close: '150.5', blockHeight: 1n } };
    expect(parseSolUsd(new FactWorld().push(bare).last(SOL_USD_KEY))!.points).toEqual([{ tMs: 1_791_000_000_000, price: 150_500_000n }]);
  });

  const hours = (day: number, lamports: (h: number) => bigint, uncovered: number[] = []) =>
    Array.from({ length: 24 }, (_, h) => ({ hourStartMs: day * 86_400_000 + h * 3_600_000, lamports: lamports(h), covered: !uncovered.includes(h) }));

  it('chain volume: complete UTC days summed in lamports, the same through the producer as through the shared function', () => {
    const day = 20_729; // 2026-10-02
    const rows = [...hours(day - 1, (h) => BigInt(h + 1) * 1_000_000_000n), ...hours(day, () => 2_000_000_000n)];
    const w = new FactWorld();
    rows.forEach((r, i) => w.push(offchain(RAW.volumeHour, r, BigInt(1000 + i), r.hourStartMs + 3_600_000 + 1)));
    const f = w.last(CURVE_VOLUME_KEY) as { days: { day: number; volumeLamports: bigint }[] };
    expect(f.days).toEqual(dailyChainVolume(rows));
    expect(f.days).toEqual([{ day: day - 1, volumeLamports: 300_000_000_000n }, { day, volumeLamports: 48_000_000_000n }]);
  });

  it('a day with an uncovered, missing or contradicting hour is unknown, never a smaller volume; an hour is used only after it ends', () => {
    const day = 20_729;
    expect(dailyChainVolume(hours(day, () => 1n, [5]))).toEqual([]);
    expect(dailyChainVolume(hours(day, () => 1n).slice(1))).toEqual([]);
    const twice = [...hours(day, () => 1n), { hourStartMs: day * 86_400_000, lamports: 2n, covered: true }];
    expect(dailyChainVolume(twice)).toEqual([]);
    const r = hours(day, () => 1n)[0]!;
    expect(new FactWorld().push(offchain(RAW.volumeHour, r, 1n, r.hourStartMs + 3_599_999)).facts(CURVE_VOLUME_KEY)).toEqual([]);
  });
});

describe('graduate survival', () => {
  it('a read of the pool within a minute after +30 min dates the graduate; a later one does not', () => {
    const mark = 1_791_032_673_000 + 30 * 60_000;
    const read = { ...FIX.accountsRead, slot: BigInt(FIX.accountsRead.slot) };
    const w = new FactWorld().push(...lifecycle(), offchain(RAW.accounts(MINT), read, migrate.slot + 4500n, mark + 20_000));
    const g = w.last(GRADUATES_KEY) as { items: { mint: string; migratedAtMs: number; reserveAfter: bigint }[] };
    const p = parsePool(w.last(poolKey(MINT)))!;
    expect(g.items).toEqual([{ mint: MINT, migratedAtMs: 1_791_032_673_000, reserveAfter: p.quoteVault + (p.pool.virtualQuoteReserves ?? 0n) }]);
    const late = new FactWorld().push(...lifecycle(), offchain(RAW.accounts(MINT), read, migrate.slot + 4600n, mark + 61_000));
    expect(late.facts(GRADUATES_KEY)).toEqual([]);
  });

  describe('PERSIST-2: graduates seeded from before this process', () => {
    const mark = 1_791_032_673_000 + 30 * 60_000;
    const read = { ...FIX.accountsRead, slot: BigInt(FIX.accountsRead.slot) };
    const live = () => new FactWorld().push(...lifecycle(), offchain(RAW.accounts(MINT), read, migrate.slot + 4500n, mark + 20_000));
    type Items = { mint: string; migratedAtMs: number; reserveAfter: bigint }[];
    const items = (w: FactWorld) => (w.last(GRADUATES_KEY) as { items: Items } | undefined)?.items;
    const seed = (its: Items, asOfMs: number, at = asOfMs, source = 'persist') => offchain(RAW.graduatesSeed, { source, asOfMs, items: its }, migrate.slot + 5000n, at);

    it('a seed gives the same series as the live build, and on overlap with it adds nothing', () => {
      const built = items(live())!;
      expect(built).toHaveLength(1);
      for (const source of ['persist', 'data-1']) {
        expect(items(new FactWorld().push(seed(built, mark + 30_000, mark + 30_000, source)))).toEqual(built);
        // The same graduate from the live build and the seed: counted once.
        const both = live().push(seed(built, mark + 30_000, mark + 40_000, source));
        expect(both.facts(GRADUATES_KEY)).toHaveLength(1);
        expect(items(both)).toEqual(built);
      }
    });

    it('is as-of honest: a seed dated after its release is refused, and an entry whose mark is after the seed\'s moment does not count', () => {
      const built = items(live())!;
      expect(new FactWorld().push(seed(built, mark + 30_000, mark + 29_999)).facts(GRADUATES_KEY)).toEqual([]);
      expect(new FactWorld().push(seed(built, mark - 1, mark + 30_000)).facts(GRADUATES_KEY)).toEqual([]);
      expect(items(new FactWorld().push(seed(built, mark, mark + 30_000)))).toEqual(built);
    });

    it('a graduate this process measures replaces its seeded entry: counted once, at the live value', () => {
      const built = items(live())!;
      // Saved before the restart with another reserve, released after the mark and before this process's own read.
      const seeded = { ...built[0]!, reserveAfter: built[0]!.reserveAfter + 7n };
      const w = new FactWorld().push(...lifecycle(), offchain(RAW.graduatesSeed, { source: 'persist', asOfMs: mark, items: [seeded] }, migrate.slot + 4400n, mark + 10_000), offchain(RAW.accounts(MINT), read, migrate.slot + 4500n, mark + 20_000));
      expect(w.facts(GRADUATES_KEY).map((f) => (f.value as { items: Items }).items)).toEqual([[seeded], built]);
    });

    it('every seed\'s outcome is a fact: taken with its count, or refused with its reason', () => {
      const built = items(live())!;
      expect(new FactWorld().push(seed(built, mark + 30_000)).last(GRADUATES_SEED_KEY)).toEqual({ source: 'persist', atMs: mark + 30_000, accepted: true, added: 1, reason: null });
      expect(new FactWorld().push(seed(built, mark + 30_000, mark + 29_999)).last(GRADUATES_SEED_KEY)).toEqual({ source: 'persist', atMs: mark + 29_999, accepted: false, added: 0, reason: `dated ${mark + 30_000}, after its release at ${mark + 29_999}` });
      const bad = live().push(seed([{ ...built[0]!, reserveAfter: 1n }], mark + 30_000, mark + 40_000, 'data-1'));
      expect(bad.last(GRADUATES_SEED_KEY)).toEqual({ source: 'data-1', atMs: mark + 40_000, accepted: false, added: 0, reason: `disagrees with the series on ${MINT}` });
      expect(new FactWorld().push(offchain(RAW.graduatesSeed, { source: 'x' }, 1n, mark)).last(GRADUATES_SEED_KEY)).toEqual({ source: null, atMs: mark, accepted: false, added: 0, reason: 'malformed seed' });
    });

    it('a seed that disagrees with the series on any graduate is refused whole', () => {
      const built = items(live())!;
      const other = { mint: 'Other1111111111111111111111111111111111111', migratedAtMs: mark - 40 * 60_000, reserveAfter: 5n };
      const w = live().push(seed([{ ...built[0]!, reserveAfter: built[0]!.reserveAfter + 1n }, other], mark + 30_000, mark + 40_000));
      expect(w.facts(GRADUATES_KEY)).toHaveLength(1);
      expect(items(w)).toEqual(built);
      // Without the disagreement the other graduate is added.
      expect(items(live().push(seed([...built, other], mark + 30_000, mark + 40_000)))!.map((g) => g.mint)).toEqual([other.mint, MINT]);
    });
  });

  it('with the pool\'s trades covered from migration, the last reserve before the mark dates it', () => {
    const w = new FactWorld();
    w.push(coverage(STREAMS.trades(POOL), 'start', { fromSlot: migrate.slot, via: `logs:${POOL}` }, migrate.slot - 1n, atOf(migrate) - 500), ...txEvents(complete));
    w.push(...txEvents(migrate), slotNotice(migrate.slot + 1n, atOf(migrate) + 400));
    w.push(slotNotice(migrate.slot + 4600n, 1_791_032_673_000 + 30 * 60_000 + 5));
    const g = w.last(GRADUATES_KEY) as { items: { reserveAfter: bigint }[] };
    // After the migration's own buy: vault 67,405,853,773 + 2,469,629,629 lp-adjusted, plus 17,584,505,289 virtual.
    expect(g.items).toEqual([{ mint: MINT, migratedAtMs: 1_791_032_673_000, reserveAfter: 67_405_853_773n + 2_469_629_629n + 17_584_505_289n }]);
  });
});

describe('graduates fact (pinned across the graduatesFact refactor)', () => {
  it('releases the whole fact exactly: kept items, sorted, obs as of the event', () => {
    const w = new FactWorld();
    w.push(coverage(STREAMS.trades(POOL), 'start', { fromSlot: migrate.slot, via: `logs:${POOL}` }, migrate.slot - 1n, atOf(migrate) - 500), ...txEvents(complete));
    w.push(...txEvents(migrate), slotNotice(migrate.slot + 1n, atOf(migrate) + 400));
    const at = 1_791_032_673_000 + 30 * 60_000 + 5;
    w.push(slotNotice(migrate.slot + 4600n, at));
    expect(w.last(GRADUATES_KEY)).toEqual({
      obs: { provider: 'facts', slot: null, receivedAt: at, quality: [] },
      items: [{ mint: MINT, migratedAtMs: 1_791_032_673_000, reserveAfter: 67_405_853_773n + 2_469_629_629n + 17_584_505_289n }],
      completeness: 'complete',
    });
  });

  it('graduatesFact keeps items inside the window, drops older ones, sorts by migration then mint', () => {
    const items = [
      { mint: 'B', migratedAtMs: 5_000, reserveAfter: 2n },
      { mint: 'A', migratedAtMs: 5_000, reserveAfter: 1n },
      { mint: 'C', migratedAtMs: 100, reserveAfter: 3n },
      { mint: 'D', migratedAtMs: 4_000, reserveAfter: 4n },
    ];
    const r = graduatesFact(items, 6_000, 2_000);
    expect(r.kept.map((x) => x.mint)).toEqual(['B', 'A', 'D']);
    expect(r.value).toEqual({ obs: { provider: 'facts', slot: null, receivedAt: 6_000, quality: [] }, items: [items[3], items[1], items[0]] });
    expect(items).toHaveLength(4);
  });
});

describe('graduate survival without trades', () => {
  it('with no trade after the boost, the boost\'s vault and virtual reserves are the reserve at the mark', () => {
    const w = new FactWorld();
    w.push(coverage(STREAMS.trades(POOL), 'start', { fromSlot: migrate.slot, via: `logs:${POOL}` }, migrate.slot - 1n, atOf(migrate) - 500), ...txEvents(complete));
    w.push(...txEvents(migrate).filter((e) => !e.key.startsWith('pump_amm:BuyEvent:')), slotNotice(migrate.slot + 1n, atOf(migrate) + 400));
    w.push(slotNotice(migrate.slot + 4600n, 1_791_032_673_000 + 30 * 60_000 + 5));
    expect((w.last(GRADUATES_KEY) as { items: { reserveAfter: bigint }[] }).items).toEqual([{ mint: MINT, migratedAtMs: 1_791_032_673_000, reserveAfter: 67_405_853_773n + 17_584_505_289n }]);
  });
});

describe('regime from produced facts', () => {
  it('missing series keep the regime off with typed reasons, never on', () => {
    const w = new FactWorld().push(...lifecycle());
    const r = evaluateRegime(w.ctx(after(migrate.slot + 10n, atOf(migrate) + 10_000)), { session, mode: 'live' });
    expect(r.on).toBe(false);
    expect(r.reasons.map((x) => x.input).sort()).toEqual(['curve-volume', 'graduates', 'sol-usd']);
  });
});

describe('FactFeed', () => {
  it('releases each fact after its source and before the next event, in key order', () => {
    const w = new FactWorld().push(...lifecycle());
    const ids = w.released.map((e) => e.id);
    for (let i = 1; i < w.released.length; i++) {
      const a = w.released[i - 1]!;
      const b = w.released[i]!;
      const cmp = a.moment.slot < b.moment.slot ? -1 : a.moment.slot > b.moment.slot ? 1 : a.moment.txIndex - b.moment.txIndex || a.moment.ixIndex - b.moment.ixIndex || a.moment.receivedAt - b.moment.receivedAt || (a.id < b.id ? -1 : 1);
      expect(cmp).toBeLessThan(0);
    }
    expect(ids.filter((i) => i.includes('~')).length).toBeGreaterThan(3);
  });

  it('is deterministic: the same events give the same facts, byte for byte', () => {
    const a = new FactWorld().push(...lifecycle()).released;
    const b = new FactWorld().push(...lifecycle()).released;
    expect(b).toEqual(a);
  });
});

describe('blind to the future', () => {
  it('a create planted later in a replay makes no fact before the replay releases it', () => {
    const events = lifecycle();
    const r = createReplay(events);
    const facts = new FactFeed(r.feed, new FactProducer(OPTIONS));
    const createAt = events.find((e) => e.key.startsWith('pump:CreateEvent:'))!.moment;
    const seen: { id: string; now: Moment }[] = [];
    while (r.advance()) {
      for (let e = facts.next(); e !== null; e = facts.next()) seen.push({ id: e.id, now: r.clock.now() });
    }
    const f = seen.find((x) => x.id.endsWith(`~${createKey(MINT)}`))!;
    expect(f).toBeDefined();
    // Released only once the clock reached the create's own moment, never earlier.
    expect(f.now.slot >= createAt.slot).toBe(true);
    expect(seen.filter((x) => x.id.includes('~')).every((x) => x.now.slot >= create.slot)).toBe(true);
  });
});

// Keep the unused-import guard quiet for helpers used only in some branches.
void streamKey;
void (null as unknown as TransactionRecord);
