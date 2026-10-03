// FACTS-1 producers on recorded mainnet data (fixtures/facts.json, DEC-1's migration fixtures). Each producer is
// checked for the fact it makes from real inputs, then for the rule: missing, stale, processed or failed input makes
// no fact (or a flagged one) and GATE-1 rejects. Facts go through the FactFeed into an as-of store, as in the engine.
import { describe, expect, it } from 'vitest';
import { transactionEvents, type TransactionRecord } from '../../src/chain/index.ts';
import { startSession, TRIAL_POLICY } from '../../src/config/index.ts';
import { pumpSwapRoundTrip } from '../../src/costs/index.ts';
import { OFF_CHAIN, createReplay, type MarketEvent, type Moment } from '../../src/engine/index.ts';
import {
  CURVE_VOLUME_KEY, EXEC_HEALTH_KEY, GRADUATES_KEY, SOL_USD_KEY, Evidence, candlesKey, createKey, curveKey, evaluateHardRejects, evaluateRegime,
  holdersKey, insidersKey, lpKey, migrationKey, mintKey, parseCandles, parseCreate, parseHolders, parseInsiders, parseLp, parseMigration, parseMint,
  parsePool, parseSim, parseSolUsd, parseXcheck, poolKey, simKey, streamKey, xcheckKey, type CandlesFact, type GateRequest,
} from '../../src/gates/index.ts';
import { FACT_KINDS, FactFeed, FactProducer, RAW, STREAMS, decimalToMicro, producerOptions } from '../../src/facts/index.ts';
import { lamports, microUsd } from '../../src/units/index.ts';
import { FEE_CONTEXT } from '../gates/world.ts';
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
      quoteAtMigration: 84_990_359_062n, price: { quote: 84_990_359_062n, base: 206_900_000_000_000n },
    });
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
    supply: BigInt(supplyOf()), accounts: h.largest.value.map((a, i) => ({ address: a.address, owner: h.owners[i]!.owner, ownerProgram: h.owners[i]!.program === '11111111111111111111111111111111' ? null : h.owners[i]!.program, amount: BigInt(a.amount) })),
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
  const funders = () => FIX.funders.map((f) => ({ ...f, slot: f.slot === null ? null : BigInt(f.slot) }));
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
    expect(f.complete).toBe(expected.every((x) => found.get(x) === true));
    // Every creation-slot buyer from the real transactions is listed (the dev aside: the gate adds the dev).
    const creator = parseCreate(w.last(createKey(MINT)))!.creator;
    const buyers = new Set<string>();
    for (const r of window) for (const e of transactionEvents(r)) if (e.name === 'TradeEvent' && e.data.isBuy && e.data.mint === MINT && e.slot <= s0 + 2n && e.data.user !== creator) buyers.add(e.data.user);
    for (const b of buyers) expect(f.insiders).toContain(b);
    // Cluster = first buyers whose first funder is the dev.
    const funded = FIX.funders.filter((x) => x.funder === creator).map((x) => x.wallet).filter((x) => x !== creator).sort();
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

describe('series: SOL/USD and curve volume', () => {
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

  it('a real DefiLlama snapshot is the curve-volume fact, dated at its fetch', () => {
    const days = FIX.llama.map(([t, v]) => ({ day: t / 86_400, volumeUsd: BigInt(Math.floor(v)) }));
    const fetchedAt = Date.parse(FIX.meta.fetchedAt);
    const w = new FactWorld().push(offchain(RAW.curveVolume, { fetchedAt, days }, 5n, fetchedAt, 'defillama'));
    expect(w.last(CURVE_VOLUME_KEY)).toMatchObject({ obs: { receivedAt: fetchedAt }, days });
    expect(new FactWorld().push(offchain(RAW.curveVolume, { fetchedAt, days: [{ day: 1, volumeUsd: -5n }] }, 5n, 1)).facts(CURVE_VOLUME_KEY)).toEqual([]);
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
