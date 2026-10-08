// Ported from Snipe-solana card C03 (#6 @ 6ae4d62); runner moved from node:test to Vitest.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import type { DecodedEvent, RawTransaction } from '@bot/types';
import { base58, createDecoders, decodeEvents, MAX_EVENT_DATA_BYTES, Reader, readRpcTransaction, UNKNOWN_EVENT_LOG_PERIOD_MS, type InnerIx, type PinnedIdl } from '../src/index.ts';
import { decoders, DEFAULT_PUBKEY, fixture, idls, programOf, WSOL } from './fixtures.ts';

interface TxRecord { signature: string; slot: number; version: unknown; json: Record<string, unknown> }
const d = decoders();
const PUMP = programOf('pump');
const PSWAP = programOf('pump_amm');
const raw = (rec: TxRecord): RawTransaction => {
  const r = readRpcTransaction(rec.signature, rec.json);
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  return r.value;
};
const tx = (rel: string): TxRecord => fixture<TxRecord>(rel);
const kinds = (evs: DecodedEvent[]): string[] => evs.map((e) => e.kind);
const pick = <K extends DecodedEvent['kind']>(evs: DecodedEvent[], kind: K): Array<Extract<DecodedEvent, { kind: K }>> =>
  evs.filter((e): e is Extract<DecodedEvent, { kind: K }> => e.kind === kind);

const CURVE_TRADES: TxRecord[] = [
  ...fixture<{ transactions: TxRecord[] }>('decoders/pump/trade_events_curve.json').transactions,
  ...fixture<{ pairs: Array<{ complete: TxRecord }> }>('decoders/pump/complete_before_migration.json').pairs.map((p) => p.complete),
  tx('decoders/tx/v1_transaction.json'),
];
const MIGRATIONS = ['tx_32tjvqFP', 'tx_3ho5U23D', 'tx_3xcn7YbY'].map((f) => tx(`mainnet/tx/migration/${f}.json`));
interface Pair { mint: string; migration_signature: string; migration_slot: number; complete: TxRecord }
const PAIRS = fixture<{ pairs: Pair[] }>('decoders/pump/complete_before_migration.json').pairs;
/** The buy that completed a curve 3 slots before its migration, routed through `FLASHX…` (fixtures/decoders/README.md). */
const LAGGED = PAIRS.find((p) => p.migration_slot - p.complete.slot === 3) as Pair;
const TRADE_DISC = 'bddb7fd34ee661ee';
const COMPLETE_DISC = '5f72619cd42e9808';
const SYSTEM = DEFAULT_PUBKEY;                                   // the System program
const SWAPS = ['2JncvkXg', '2Ta573eN', '2TipyhLt', '49MbpHBy', '54aFRgFw', '5KGXqZKp', '5Z6GNb2b', 'TvpwJWSt'].map((f) => tx(`mainnet/tx/pumpswap/tx_${f}.json`));

/** The raw IDL fields of every pump TradeEvent in a transaction (to read mayhem_mode, which the variant omits). */
function rawTrades(t: RawTransaction): Array<Record<string, unknown>> {
  const pump = idls().find((i) => i.name === 'pump') as PinnedIdl;
  const out: Array<Record<string, unknown>> = [];
  for (const g of t.meta.innerInstructions) for (const ix of g.instructions) {
    const data = Buffer.from(ix.dataB64, 'base64');
    const def = pump.events.get(data.subarray(8, 16).toString('hex'));
    if (def?.name === 'TradeEvent' && data.subarray(0, 8).toString('hex') === 'e445a52e51cb9a1d') out.push(def.read(new Reader(data.subarray(16))) as Record<string, unknown>);
  }
  return out;
}

const keysOf = (t: RawTransaction): string[] => [...t.message.accountKeys, ...t.message.loadedAddresses.writable, ...t.message.loadedAddresses.readonly];
const keyIndex = (t: RawTransaction, key: string): number => {
  const i = keysOf(t).indexOf(key);
  assert.ok(i >= 0, key);
  return i;
};
const isEvent = (ix: { dataB64: string }): boolean => Buffer.from(ix.dataB64, 'base64').subarray(0, 8).toString('hex') === 'e445a52e51cb9a1d';
const hasDisc = (ix: { dataB64: string }, disc: string): boolean => isEvent(ix) && Buffer.from(ix.dataB64, 'base64').subarray(8, 16).toString('hex') === disc;
/** The inner instructions (with their stack heights) of the group holding the event with this discriminator. */
const groupOf = (t: RawTransaction, disc: string): InnerIx[] => {
  const g = t.meta.innerInstructions.find((x) => x.instructions.some((ix) => hasDisc(ix, disc)));
  assert.ok(g !== undefined, disc);
  return g.instructions;
};
/** A non-event instruction of `program` at stack height h. */
const call = (t: RawTransaction, program: string, h: number): InnerIx => ({ programIdIndex: keyIndex(t, program), accounts: [], dataB64: 'AQID', stackHeight: h });

/** True when the transaction's TradeEvent sits under a top-level pump instruction. */
function underPump(t: RawTransaction): boolean {
  const keys = keysOf(t);
  return t.meta.innerInstructions.some((g) => keys[(t.message.instructions[g.index] as { programIdIndex: number }).programIdIndex] === PUMP
    && g.instructions.some((ix) => hasDisc(ix, TRADE_DISC)));
}

describe('A-M02-03 pump curve trades [EX-37, EX-05]', () => {
  it('12 recorded TradeEvents: 95 and 30 bps on every non-mayhem trade; all 12 decode with their fields, the 2 router-routed ones included', () => {
    let recorded = 0;
    let decoded = 0;
    let routed = 0;
    for (const rec of CURVE_TRADES) {
      const t = raw(rec);
      const fields = rawTrades(t);
      for (const f of fields as Array<Record<string, bigint | boolean | string>>) {
        if (f.mayhem_mode !== false) continue;
        assert.deepEqual([f.fee_basis_points, f.creator_fee_basis_points], [95n, 30n], rec.signature);
        // The fee is 95 bps of the SOL amount, rounded up (within one lamport).
        const want = ((f.sol_amount as bigint) * 95n + 9_999n) / 10_000n;
        assert.ok(f.fee === want || f.fee === want - 1n, `${rec.signature}: ${String(f.fee)} vs ${want}`);
      }
      recorded += fields.length;
      const trades = pick(d.decodeTransactionEvents(t), 'pump_trade');
      if (!underPump(t)) routed++;
      assert.equal(trades.length, fields.length, rec.signature);
      for (const [i, e] of trades.entries()) {
        const f = fields[i] as Record<string, bigint | boolean | string>;
        assert.deepEqual([e.mint, e.isBuy, e.solAmount, e.tokenAmount, e.feeBps, e.fee, e.creatorFeeBps, e.creatorFee, e.quoteMint],
          [f.mint, f.is_buy, f.sol_amount, f.token_amount, Number(f.fee_basis_points), f.fee, Number(f.creator_fee_basis_points), f.creator_fee,
            f.quote_mint === DEFAULT_PUBKEY ? null : f.quote_mint]);                     // the default pubkey is native SOL: null (Z03 m6)
        assert.equal(e.slot, BigInt(rec.slot));
        assert.equal(e.signature, rec.signature);
        decoded++;
      }
    }
    assert.equal(recorded, 12);
    assert.equal(decoded, 12);
    assert.equal(routed, 2);                                   // fixtures/decoders/README.md: the v1 trade and the lagged completion
  });

  it('decodes a version-1 transaction [EX-V04]: inline addresses, no lookup tables', () => {
    const rec = tx('decoders/tx/v1_transaction.json');
    assert.equal(rec.version, 1);
    const t = raw(rec);
    assert.equal(t.version, 1);
    assert.deepEqual(t.message.loadedAddresses, { writable: [], readonly: [] });   // v1 has no lookup tables [LD-04]
    assert.notEqual(keysOf(t)[(t.message.instructions[0] as { programIdIndex: number }).programIdIndex], PUMP);   // a router at the top
    assert.deepEqual(kinds(d.decodeTransactionEvents(t)), ['pump_trade']);   // pump invoked its own event-CPI
  });

  it('a mayhem trade with zero fee fields decodes as-is [EX-05] (derived from a recorded trade)', () => {
    const t = raw(CURVE_TRADES[0] as TxRecord);
    const pump = idls().find((i) => i.name === 'pump') as PinnedIdl;
    const group = t.meta.innerInstructions.find((g) => g.instructions.some((ix) => Buffer.from(ix.dataB64, 'base64').subarray(8, 16).toString('hex') === 'bddb7fd34ee661ee'));
    const ix = group?.instructions.find((x) => Buffer.from(x.dataB64, 'base64').subarray(8, 16).toString('hex') === 'bddb7fd34ee661ee');
    assert.ok(ix !== undefined);
    const data = Buffer.from(ix.dataB64, 'base64');
    // TradeEvent payload: mint 0, sol_amount 32, token_amount 40, is_buy 48, user 49, timestamp 81, four u64 reserves
    // 89-120, fee_recipient 121, fee_basis_points 153, fee 161, creator 169, creator_fee_basis_points 201, creator_fee 209.
    for (const at of [153, 161, 201, 209]) data.fill(0, 16 + at, 16 + at + 8);
    ix.dataB64 = data.toString('base64');
    const [e] = pick(d.decodeTransactionEvents(t), 'pump_trade');
    assert.deepEqual([e?.feeBps, e?.fee, e?.creatorFeeBps, e?.creatorFee], [0, 0n, 0, 0n]);
    assert.ok(pump.events.size > 0);
  });
});

describe('A-M02-03 completion and migration [EX-03, EX-04, EX-V06]', () => {
  it('each recorded migration gives pump_migration: 206,900,000,000,000 base units and about 84.99 SOL', () => {
    for (const rec of MIGRATIONS) {
      const evs = d.decodeTransactionEvents(raw(rec));
      const [m] = pick(evs, 'pump_migration');
      assert.ok(m !== undefined, rec.signature);
      assert.equal(m.baseAmount, 206_900_000_000_000n);
      assert.ok(m.solAmount > 84_980_000_000n && m.solAmount < 85_000_000_000n, `${m.solAmount}`);
      assert.equal(m.poolMigrationFee, 15_000_001n);
      // PumpSwap's events inside pump's migrate CPI: the boost puts about 17.58 SOL into virtual reserves [EX-V01].
      const [boost] = pick(evs, 'pumpswap_init_boost');
      assert.equal(boost?.pool, m.pool);
      assert.ok((boost?.virtualQuoteReserves ?? 0n) > 17_000_000_000n);
      assert.deepEqual(kinds(evs), ['pumpswap_init_boost', 'pump_migration']);
    }
  });

  it('the completing buy: create-buy-complete in one transaction, migration in the same slot or 3 slots later', () => {
    const pump = idls().find((i) => i.name === 'pump') as PinnedIdl;
    const lags: number[] = [];
    for (const p of PAIRS) {
      const t = raw(p.complete);
      const evs = d.decodeTransactionEvents(t);
      assert.deepEqual(kinds(evs), ['pump_trade', 'pump_complete'], p.complete.signature);   // instruction order; CreateEvent is not used
      assert.equal(pick(evs, 'pump_complete')[0]?.mint, p.mint);
      // The completed curve holds the 206,900,000,000,000 base units its migration moves to the pool [EX-03].
      const ce = groupOf(t, COMPLETE_DISC).find((ix) => hasDisc(ix, COMPLETE_DISC)) as InnerIx;
      const curve = (pump.events.get(COMPLETE_DISC)?.read(new Reader(Buffer.from(ce.dataB64, 'base64').subarray(16))) as Record<string, unknown>).bonding_curve;
      const held = (p.complete.json.meta as { postTokenBalances: Array<{ owner: string; mint: string; uiTokenAmount: { amount: string } }> }).postTokenBalances
        .filter((b) => b.owner === curve && b.mint === p.mint).map((b) => BigInt(b.uiTokenAmount.amount));
      assert.deepEqual(held, [206_900_000_000_000n]);
      const mig = MIGRATIONS.find((m) => m.signature === p.migration_signature) as TxRecord;
      const [m] = pick(d.decodeTransactionEvents(raw(mig)), 'pump_migration');
      assert.ok(m !== undefined);
      assert.equal(m.mint, p.mint);
      assert.equal(m.baseAmount, 206_900_000_000_000n);
      assert.ok(m.solAmount > 84_980_000_000n && m.solAmount < 85_000_000_000n, `${m.solAmount}`);
      lags.push(p.migration_slot - p.complete.slot);
    }
    assert.deepEqual(lags.sort(), [0, 0, 3]);
    assert.deepEqual(PAIRS.map((p) => p.complete.version).sort(), [0, 0, 1]);
  });

  it('the lagged completion [EX-04] is router-routed and gives pump_complete: pump invoked its own event-CPI at height 3', () => {
    const t = raw(LAGGED.complete);
    assert.equal(underPump(t), false);
    const g = groupOf(t, COMPLETE_DISC);
    const at = g.findIndex((ix) => hasDisc(ix, COMPLETE_DISC));
    assert.equal(g[at]?.stackHeight, 3);
    assert.deepEqual(pick(d.decodeTransactionEvents(t), 'pump_complete'), [{ kind: 'pump_complete', mint: LAGGED.mint, slot: BigInt(LAGGED.complete.slot), signature: LAGGED.complete.signature }]);
  });
});

describe('A-M02-03 PumpSwap buys and sells [EX-07, EX-37]', () => {
  it('decodes BuyEvent and SellEvent with the fee tier bps and virtual quote reserves', () => {
    const seen = new Set<string>();
    for (const rec of SWAPS) {
      const evs = d.decodeTransactionEvents(raw(rec));
      assert.equal(evs.length, 1, rec.signature);
      const e = evs[0] as Extract<DecodedEvent, { kind: 'pumpswap_buy' | 'pumpswap_sell' }>;
      assert.ok(e.kind === 'pumpswap_buy' || e.kind === 'pumpswap_sell');
      assert.equal(e.pool, fixture<{ pool: string }>(`mainnet/tx/pumpswap/tx_${rec.signature.slice(0, 8)}.json`).pool);
      assert.ok(e.baseAmount > 0n && e.quoteAmount > 0n);                // virtual reserves may be negative [EX-09]
      seen.add(`${e.kind}:${e.lpFeeBps}/${e.protocolFeeBps}/${e.coinCreatorFeeBps}`);
    }
    assert.deepEqual([...seen].sort(), ['pumpswap_buy:2/93/30', 'pumpswap_buy:20/5/5', 'pumpswap_sell:2/93/30', 'pumpswap_sell:20/5/5']);
  });

  it('quoteAmount is the pool-side amount: user amount = quoteAmount ± lp, protocol and coin-creator fees', () => {
    const amm = idls().find((i) => i.name === 'pump_amm') as PinnedIdl;
    for (const rec of SWAPS) {
      const t = raw(rec);
      const [e] = d.decodeTransactionEvents(t) as Array<Extract<DecodedEvent, { kind: 'pumpswap_buy' | 'pumpswap_sell' }>>;
      const ix = t.meta.innerInstructions.flatMap((g) => g.instructions).find((x) => Buffer.from(x.dataB64, 'base64').subarray(0, 8).toString('hex') === 'e445a52e51cb9a1d');
      const data = Buffer.from((ix as { dataB64: string }).dataB64, 'base64');
      const v = amm.events.get(data.subarray(8, 16).toString('hex'))?.read(new Reader(data.subarray(16))) as Record<string, bigint>;
      const fees = (v.lp_fee as bigint) + (v.protocol_fee as bigint) + (v.coin_creator_fee as bigint);
      if (e?.kind === 'pumpswap_buy') assert.equal(v.user_quote_amount_in, e.quoteAmount + fees);
      else assert.equal(v.user_quote_amount_out, (e?.quoteAmount as bigint) - fees);
    }
  });
});

describe('A-M02-03 self-CPI by direct invoker (logic 3, supervisor ruling 2026-10-07)', () => {
  const lagged = (): RawTransaction => raw(LAGGED.complete);       // FLASHX top level; pump buy at height 2, its events at 3
  const direct = (): RawTransaction => raw(CURVE_TRADES[0] as TxRecord);   // top-level pump; its TradeEvent at height 2
  const decoded = (t: RawTransaction): string[] => kinds(d.decodeTransactionEvents(t));
  const strip = (t: RawTransaction): RawTransaction => {
    for (const g of t.meta.innerInstructions) for (const ix of g.instructions as InnerIx[]) delete ix.stackHeight;
    return t;
  };

  it('readRpcTransaction keeps every inner stackHeight the RPC reported', () => {
    let n = 0;
    for (const rec of [...SWAPS, ...MIGRATIONS, ...CURVE_TRADES]) {
      const want = (rec.json.meta as { innerInstructions: Array<{ instructions: Array<{ stackHeight: number }> }> }).innerInstructions.flatMap((g) => g.instructions.map((ix) => ix.stackHeight));
      const got = raw(rec).meta.innerInstructions.flatMap((g) => (g.instructions as InnerIx[]).map((ix) => ix.stackHeight));
      assert.deepEqual(got, want, rec.signature);
      n += got.length;
    }
    assert.ok(n > 200);
  });

  it('an event-CPI at height 3 whose direct invoker is another program is ignored, though pump is the top-level program', () => {
    const t = direct();
    const g = groupOf(t, TRADE_DISC);
    const at = g.findIndex((ix) => hasDisc(ix, TRADE_DISC));
    (g[at] as InnerIx).stackHeight = 3;
    g.splice(at, 0, call(t, SYSTEM, 2));                       // the System program "invokes" pump's event-CPI
    assert.deepEqual(pick(d.decodeTransactionEvents(t), 'pump_trade'), []);
    const control = direct();
    const cg = groupOf(control, TRADE_DISC);
    const cat = cg.findIndex((ix) => hasDisc(ix, TRADE_DISC));
    (cg[cat] as InnerIx).stackHeight = 3;
    cg.splice(cat, 0, call(control, PUMP, 2));                 // pump invokes it: accepted
    assert.equal(pick(d.decodeTransactionEvents(control), 'pump_trade').length, 1);
  });

  it('at height 4 the nearest earlier instruction at height 3 is the invoker: another program there is refused', () => {
    const at4 = (invokers: string[]): string[] => {
      const t = lagged();
      const g = groupOf(t, TRADE_DISC);
      const at = g.findIndex((ix) => hasDisc(ix, TRADE_DISC));
      (g[at] as InnerIx).stackHeight = 4;
      g.splice(at, 0, ...invokers.map((p) => call(t, p, 3)));
      return decoded(t);
    };
    assert.deepEqual(at4([PUMP]), ['pump_trade', 'pump_complete']);
    assert.deepEqual(at4([SYSTEM]), ['pump_complete']);          // the CompleteEvent at height 3 still has pump as invoker
    assert.deepEqual(at4([PUMP, SYSTEM]), ['pump_complete']);
    assert.deepEqual(at4([SYSTEM, PUMP]), ['pump_trade', 'pump_complete']);
  });

  it('an event-CPI at height 2 has the top-level instruction as its invoker: a router there is refused', () => {
    const t = lagged();
    const g = groupOf(t, TRADE_DISC);
    for (const ix of g) if (isEvent(ix)) (ix as InnerIx).stackHeight = 2;
    assert.deepEqual(decoded(t), []);
  });

  it('PumpSwap events inside pump\'s migrate have PumpSwap as their invoker and are accepted', () => {
    for (const rec of MIGRATIONS) {
      const t = raw(rec);
      const keys = keysOf(t);
      for (const g of t.meta.innerInstructions) {
        const ixs = g.instructions as InnerIx[];
        for (const [k, ix] of ixs.entries()) {
          if (!isEvent(ix) || keys[ix.programIdIndex] !== PSWAP) continue;
          const h = ix.stackHeight as number;
          const up = ixs.slice(0, k).reverse().find((x) => (x.stackHeight as number) < h) as InnerIx;
          assert.deepEqual([h, up.stackHeight, keys[up.programIdIndex]], [3, 2, PSWAP]);
        }
      }
      assert.deepEqual(decoded(t), ['pumpswap_init_boost', 'pump_migration']);
    }
  });

  it('an inconsistent call trace is refused: a skipped level, a first instruction above height 2, or missing or bad heights', () => {
    // pump at 3, then the System program at 2, then the TradeEvent at 4: the call to pump had returned, so the nearest
    // earlier instruction at height 3 is not the invoker; the CompleteEvent at 3 now sits under the System program.
    const skip = lagged();
    const sg = groupOf(skip, TRADE_DISC);
    const sat = sg.findIndex((ix) => hasDisc(ix, TRADE_DISC));
    (sg[sat] as InnerIx).stackHeight = 4;
    sg.splice(sat, 0, call(skip, PUMP, 3), call(skip, SYSTEM, 2));
    assert.deepEqual(decoded(skip), []);
    const first = lagged();
    const fg = groupOf(first, TRADE_DISC);
    fg.splice(0, fg.findIndex((ix) => hasDisc(ix, TRADE_DISC)));   // the event-CPIs at height 3 now open the group
    assert.deepEqual(decoded(first), []);
    for (const bad of [undefined, 1, 0, 2.5, -3]) {
      const t = lagged();
      const g = groupOf(t, TRADE_DISC);
      const ix = g[0] as InnerIx;
      if (bad === undefined) delete ix.stackHeight; else ix.stackHeight = bad;
      assert.deepEqual(decoded(t), [], String(bad));
    }
  });

  it('without stack heights the top-level parent rule applies', () => {
    for (const rec of [...CURVE_TRADES, ...SWAPS]) {
      const t = strip(raw(rec));
      assert.equal(decoded(t).length > 0, underPump(t) || SWAPS.includes(rec), rec.signature);
    }
    assert.deepEqual(decoded(strip(lagged())), []);              // router-routed: refused
    assert.deepEqual(decoded(strip(raw(tx('decoders/tx/v1_transaction.json')))), []);
    assert.deepEqual(decoded(strip(direct())), ['pump_trade']);
    // PumpSwap's events in pump's migrate: their top-level parent is pump, so only pump's own event is accepted.
    for (const rec of MIGRATIONS) assert.deepEqual(decoded(strip(raw(rec))), ['pump_migration']);
    // A null stackHeight from the RPC (an old transaction) reads as absent.
    const json = JSON.parse(JSON.stringify(LAGGED.complete.json)) as { meta: { innerInstructions: Array<{ instructions: Array<{ stackHeight: number | null }> }> } };
    for (const g of json.meta.innerInstructions) for (const ix of g.instructions) ix.stackHeight = null;
    const r = readRpcTransaction(LAGGED.complete.signature, json);
    assert.ok(r.ok);
    assert.ok(r.value.meta.innerInstructions.every((g) => g.instructions.every((ix) => !('stackHeight' in ix))));
    assert.deepEqual(decoded(r.value), []);
  });

  it('a router-routed transaction without inner instructions is a no_inner gap', () => {
    const gaps: string[] = [];
    const dd = createDecoders(idls(), { metrics: { counter: (name, l) => ({ inc: () => { if (name === 'decode_gap_total') gaps.push(String(l.reason)); } }) } });
    const t = lagged();
    t.meta.innerInstructions = [];
    assert.deepEqual(dd.decodeTransactionEvents(t), []);
    assert.deepEqual(gaps, ['no_inner']);
  });
});

describe('A-M02-03 trust rules and gaps', () => {
  const buy = (): RawTransaction => raw(SWAPS[2] as TxRecord);       // top-level PumpSwap buy at instruction 6
  type Group = RawTransaction['meta']['innerInstructions'][number];
  const eventGroup = (t: RawTransaction): Group => t.meta.innerInstructions.find((g) => g.instructions.some(isEvent)) as Group;

  it('an event-CPI under a program other than its parent is ignored', () => {
    const t = buy();
    const group = eventGroup(t);
    const parent = t.message.instructions[group.index] as RawTransaction['message']['instructions'][number];
    parent.programIdIndex = t.message.instructions[0]?.programIdIndex as number;      // a ComputeBudget parent
    assert.deepEqual(d.decodeTransactionEvents(t), []);
  });

  it('a PumpSwap event-CPI whose direct invoker is pump is ignored', () => {
    const t = buy();
    const group = eventGroup(t);
    const keys = keysOf(t);
    t.message.accountKeys.push(PUMP);
    (t.message.instructions[group.index] as { programIdIndex: number }).programIdIndex = keys.length;
    const pswapIndex = keys.indexOf(PSWAP);
    group.instructions = group.instructions.filter((ix) => ix.programIdIndex !== pswapIndex || isEvent(ix));
    assert.deepEqual(d.decodeTransactionEvents(t), []);
  });

  it('failed transactions give no events', () => {
    const t = buy();
    t.meta.err = { InstructionError: [6, { Custom: 6004 }] };
    assert.deepEqual(d.decodeTransactionEvents(t), []);
  });

  it('an unknown discriminator is unknown_event, logged once per hour; a truncated payload gives no event', () => {
    const logged: string[] = [];
    let now = 0;
    const gaps: string[] = [];
    const dd = createDecoders(idls(), {
      unknownEventLog: { log: { event: (_l, code, f) => { logged.push(`${code} ${String(f.discriminator)}`); } }, clock: { nowMs: () => now } },
      metrics: { counter: (name, l) => ({ inc: () => { if (name === 'decode_gap_total') gaps.push(String(l.reason)); } }) },
    });
    const t = buy();
    const ix = t.meta.innerInstructions.flatMap((g) => g.instructions).find((x) => Buffer.from(x.dataB64, 'base64').subarray(0, 8).toString('hex') === 'e445a52e51cb9a1d') as { dataB64: string };
    const data = Buffer.from(ix.dataB64, 'base64');
    data.fill(0xab, 8, 16);
    ix.dataB64 = data.toString('base64');
    assert.deepEqual(dd.decodeTransactionEvents(t), [{ kind: 'unknown_event', programId: PSWAP, discriminatorHex: 'abababababababab', signature: t.signature }]);
    dd.decodeTransactionEvents(t);
    now = UNKNOWN_EVENT_LOG_PERIOD_MS;
    dd.decodeTransactionEvents(t);
    assert.deepEqual(logged, ['m02.unknown_event abababababababab', 'm02.unknown_event abababababababab']);
    const short = buy();
    const six = short.meta.innerInstructions.flatMap((g) => g.instructions).find((x) => Buffer.from(x.dataB64, 'base64').subarray(0, 8).toString('hex') === 'e445a52e51cb9a1d') as { dataB64: string };
    six.dataB64 = Buffer.from(six.dataB64, 'base64').subarray(0, 40).toString('base64');
    assert.deepEqual(dd.decodeTransactionEvents(short), []);
    const prefixOnly = buy();
    const p = prefixOnly.meta.innerInstructions.flatMap((g) => g.instructions).find((x) => Buffer.from(x.dataB64, 'base64').subarray(0, 8).toString('hex') === 'e445a52e51cb9a1d') as { dataB64: string };
    p.dataB64 = Buffer.from(p.dataB64, 'base64').subarray(0, 12).toString('base64');
    assert.equal(dd.decodeTransactionEvents(prefixOnly)[0]?.kind, 'unknown_event');
    assert.deepEqual(gaps, ['unknown_disc', 'unknown_disc', 'unknown_disc', 'truncated', 'unknown_disc']);
    const plain = createDecoders(idls());
    assert.equal(plain.decodeTransactionEvents(t)[0]?.kind, 'unknown_event');
  });

  it('a fee above 10,000 bps in an event is refused (gap), and a transaction without inner instructions is a gap', () => {
    const gaps: string[] = [];
    const events: string[] = [];
    const dd = createDecoders(idls(), { wsolMint: WSOL, metrics: { counter: (name, l) => ({ inc: () => { if (name === 'decode_gap_total') gaps.push(String(l.reason)); else if (name === 'decode_events_total') events.push(String(l.kind)); } }) } });
    dd.decodeTransactionEvents(buy());
    assert.deepEqual(events, ['pumpswap_buy']);                // decode_events_total{kind}
    const t = raw(CURVE_TRADES[0] as TxRecord);
    const ix = t.meta.innerInstructions.flatMap((g) => g.instructions).find((x) => Buffer.from(x.dataB64, 'base64').subarray(8, 16).toString('hex') === 'bddb7fd34ee661ee') as { dataB64: string };
    const data = Buffer.from(ix.dataB64, 'base64');
    data.writeBigUInt64LE(10_001n, 16 + 153);
    ix.dataB64 = data.toString('base64');
    assert.deepEqual(dd.decodeTransactionEvents(t), []);
    const none = buy();
    none.meta.innerInstructions = [];
    assert.deepEqual(dd.decodeTransactionEvents(none), []);
    const noPump = buy();
    noPump.meta.innerInstructions = [];
    noPump.message.instructions = noPump.message.instructions.slice(0, 2);
    const other = (k: string): string => (k === PSWAP || k === PUMP ? SYSTEM : k);           // no pump program at all
    noPump.message.accountKeys = noPump.message.accountKeys.map(other);
    noPump.message.loadedAddresses = { writable: noPump.message.loadedAddresses.writable.map(other), readonly: noPump.message.loadedAddresses.readonly.map(other) };
    assert.deepEqual(dd.decodeTransactionEvents(noPump), []);
    assert.deepEqual(gaps, ['truncated', 'no_inner']);
  });

  it('ignores groups whose parent index or program index is out of range, and non-event pump CPIs', () => {
    const t = buy();
    t.meta.innerInstructions.push({ index: 99, instructions: [] });
    const outOfRange: InnerIx = { programIdIndex: 999, accounts: [], dataB64: '', stackHeight: 2 };
    eventGroup(t).instructions.unshift(outOfRange);
    assert.equal(d.decodeTransactionEvents(t).length, 1);
  });

  it('refuses a transaction version other than legacy, 0 or 1', () => {
    const t = buy();
    (t as { version: unknown }).version = 2;
    assert.throws(() => d.decodeTransactionEvents(t), /version must be legacy, 0 or 1/);
    assert.equal(decodeEvents(buy(), idls(), {}, { wsolMint: WSOL }).length, 1);
    assert.equal(decodeEvents(buy(), idls()).length, 0);                                // no wSOL mint given: no PumpSwap trade is SOL-quoted (Z03 ruling 3)
  });

  it('never throws on random inner-instruction data and stack heights (property)', () => {
    const height = fc.oneof(fc.constant(undefined), fc.integer({ min: -2, max: 8 }), fc.double());
    fc.assert(fc.property(fc.uint8Array({ maxLength: 400 }), fc.boolean(), fc.integer({ min: 0, max: 40 }), height, fc.nat(), fc.array(height, { maxLength: 12 }), fc.boolean(),
      (bytes, prefixed, program, h, pos, others, routed) => {
        const t = routed ? raw(LAGGED.complete) : buy();
        const group = t.meta.innerInstructions[pos % t.meta.innerInstructions.length] as Group;
        const ixs = group.instructions as InnerIx[];
        for (const [i, o] of others.entries()) {
          const ix = ixs[i];
          if (ix === undefined) break;
          if (o === undefined) delete ix.stackHeight; else ix.stackHeight = o;
        }
        const data = prefixed ? Uint8Array.from([0xe4, 0x45, 0xa5, 0x2e, 0x51, 0xcb, 0x9a, 0x1d, ...bytes]) : bytes;
        const extra: InnerIx = { programIdIndex: program, accounts: [], dataB64: Buffer.from(data).toString('base64') };
        if (h !== undefined) extra.stackHeight = h;
        ixs.splice(pos % (ixs.length + 1), 0, extra);
        assert.ok(Array.isArray(d.decodeTransactionEvents(t)));
      }), { numRuns: 1_000 });
  });
});

describe('A-M02-03 untrusted traces and hostile data (review C03 R2, R9)', () => {
  const direct = (): RawTransaction => raw(CURVE_TRADES[0] as TxRecord);   // top-level pump; its TradeEvent at height 2
  const lagged = (): RawTransaction => raw(LAGGED.complete);       // FLASHX top level; pump buy at height 2, its events at 3
  const run = (t: RawTransaction): [string[], string[]] => {
    const gaps: string[] = [];
    return [kinds(decodeEvents(t, idls(), { onGap: (g) => { gaps.push(g); } })), gaps];
  };
  const tradeGroup = (t: RawTransaction): RawTransaction['meta']['innerInstructions'][number] =>
    t.meta.innerInstructions.find((g) => g.instructions.some((ix) => hasDisc(ix, TRADE_DISC))) as RawTransaction['meta']['innerInstructions'][number];

  it('an event-CPI whose invoker cannot be told counts a bad_trace gap', () => {
    const v1 = raw(tx('decoders/tx/v1_transaction.json'));
    assert.deepEqual(run(v1), [['pump_trade'], []]);
    delete (tradeGroup(v1).instructions[0] as InnerIx).stackHeight;          // heights now partly missing
    assert.deepEqual(run(v1), [[], ['bad_trace']]);
    const skipped = lagged();                                                 // the TradeEvent two levels below pump
    const sg = groupOf(skipped, TRADE_DISC);
    (sg.find((ix) => hasDisc(ix, TRADE_DISC)) as InnerIx).stackHeight = 5;
    assert.deepEqual(run(skipped), [['pump_complete'], ['bad_trace']]);
    const noParent = direct();
    tradeGroup(noParent).index = 99;                                          // no top-level instruction 99
    assert.deepEqual(run(noParent), [[], ['bad_trace']]);
    const noProgram = direct();
    (noProgram.message.instructions[tradeGroup(noProgram).index] as { programIdIndex: number }).programIdIndex = 999;
    assert.deepEqual(run(noProgram), [[], ['bad_trace']]);
    const noInvoker = lagged();                                               // the pump buy at height 2 loses its program
    const ng = groupOf(noInvoker, TRADE_DISC);
    const at = ng.findIndex((ix) => hasDisc(ix, TRADE_DISC));
    const invoker = ng.slice(0, at).reverse().find((ix) => ix.stackHeight === 2) as InnerIx;
    invoker.programIdIndex = 999;
    const [evs, gaps] = run(noInvoker);
    assert.deepEqual(evs, []);
    assert.ok(gaps.length >= 1 && gaps.every((g) => g === 'bad_trace'), gaps.join());
  });

  it('reads and decodes a transaction carrying 62 inner instructions of 10 KiB within the time budget', { timeout: 2_000 }, async () => {
    const rec = CURVE_TRADES[0] as TxRecord;
    const json = JSON.parse(JSON.stringify(rec.json)) as { transaction: { message: { accountKeys: string[] } }; meta: { innerInstructions: Array<{ instructions: unknown[] }> } };
    const keys = json.transaction.message.accountKeys;
    const big = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.repeat(242).slice(0, 13_985);   // about 10 KiB
    const pumpAt = keys.indexOf(PUMP);
    const systemAt = keys.indexOf(SYSTEM);
    assert.ok(pumpAt >= 0 && systemAt >= 0);
    const group = json.meta.innerInstructions.find((g) => g.instructions.length > 0) as { instructions: unknown[] };
    for (let i = 0; i < 31; i++) {
      group.instructions.push({ programIdIndex: pumpAt, accounts: [], data: big, stackHeight: 2 });     // Anchor ignores trailing data
      group.instructions.push({ programIdIndex: systemAt, accounts: [], data: big, stackHeight: 2 });
    }
    const r = readRpcTransaction(rec.signature, json);
    assert.ok(r.ok);
    const [evs, gaps] = run(r.value);
    assert.deepEqual(evs, ['pump_trade']);
    assert.deepEqual(gaps, new Array<string>(31).fill('oversized'));         // pump's long data is never decoded
    await new Promise<void>((done) => { setTimeout(done, 1); });               // lets the runner's timeout fire if overrun
    // The data stays exact for any consumer that reads it, once.
    const ix = r.value.meta.innerInstructions.flatMap((g) => g.instructions).find((x) => (x as InnerIx).dataLength58 === big.length) as InnerIx;
    assert.deepEqual(Buffer.from(ix.dataB64, 'base64'), Buffer.from(base58.decode(big)));
    assert.equal(ix.dataB64, ix.dataB64);
    ix.dataB64 = 'AQID';                                                      // assigning drops the base58 length
    assert.ok(!('dataLength58' in ix));
    assert.equal(ix.dataB64, 'AQID');
  });

  it('a pump instruction longer than any event counts an oversized gap when built from base64 too', () => {
    const t = direct();
    const g = tradeGroup(t);
    g.instructions.push({ programIdIndex: keyIndex(t, PUMP), accounts: [], dataB64: Buffer.alloc(3_000, 1).toString('base64'), stackHeight: 2 } as InnerIx);
    assert.deepEqual(run(t), [['pump_trade'], ['oversized']]);
    assert.equal(MAX_EVENT_DATA_BYTES, 2_048);
  });

  it('refuses instruction data outside the base58 alphabet when reading (the lazy decode cannot fail later)', () => {
    const json = JSON.parse(JSON.stringify((SWAPS[0] as TxRecord).json)) as { meta: { innerInstructions: Array<{ instructions: Array<{ data: string }> }> } };
    (json.meta.innerInstructions[0]?.instructions[0] as { data: string }).data = 'abc0';
    const r = readRpcTransaction('s', json);
    assert.deepEqual(r.ok ? 'ok' : [r.error.code, r.error.message], ['E_TX_SHAPE', 'character outside the base58 alphabet']);
  });
});

describe('A-M02-03 transaction reader', () => {
  it('reads json-encoded getTransaction results of every version, data re-encoded to base64', () => {
    for (const rec of [...SWAPS, ...MIGRATIONS, ...CURVE_TRADES]) {
      const t = raw(rec);
      assert.equal(t.signature, rec.signature);
      assert.equal(t.slot, BigInt(rec.slot));
      const m = rec.json.transaction as { message: { instructions: Array<{ data: string }> } };
      assert.deepEqual(Buffer.from(t.message.instructions[0]?.dataB64 as string, 'base64'), Buffer.from(base58.decode(m.message.instructions[0]?.data as string)));
      assert.equal(typeof t.meta.feeLamports, 'bigint');
    }
  });

  it('refuses other encodings, missing versions and malformed results', () => {
    const rec = SWAPS[0] as TxRecord;
    const j = (): Record<string, unknown> => JSON.parse(JSON.stringify(rec.json)) as Record<string, unknown>;
    const code = (v: unknown): string => { const r = readRpcTransaction('s', v); return r.ok ? 'ok' : `${r.error.code} ${r.error.message}`; };
    assert.match(code(null), /E_TX_SHAPE not a getTransaction result/);
    assert.match(code({ ...j(), version: undefined }), /E_TX_VERSION/);
    assert.match(code({ ...j(), version: 2 }), /E_TX_VERSION/);
    const parsed = j();
    ((parsed.transaction as { message: { accountKeys: unknown[] } }).message.accountKeys[0]) = { pubkey: 'x', signer: true };
    assert.match(code(parsed), /must be json-encoded/);
    const loaded = j();
    (loaded.meta as Record<string, unknown>).loadedAddresses = { writable: [1] };
    assert.match(code(loaded), /bad loadedAddresses/);
    const ix = j();
    ((ix.transaction as { message: { instructions: unknown[] } }).message.instructions[0]) = { programIdIndex: 1, accounts: ['a'], data: '' };
    assert.match(code(ix), /bad instruction/);
    const inner = j();
    (inner.meta as Record<string, unknown>).innerInstructions = 'x';
    assert.match(code(inner), /bad innerInstructions/);
    const group = j();
    (group.meta as Record<string, unknown>).innerInstructions = [{ index: 'a' }];
    assert.match(code(group), /bad inner group/);
    const fee = j();
    (fee.meta as Record<string, unknown>).fee = -1;
    assert.match(code(fee), /not an integer/);
    for (const h of [1, 0, 2.5, '3', -2]) {
      const sh = j();
      ((sh.meta as { innerInstructions: Array<{ instructions: Array<Record<string, unknown>> }> }).innerInstructions[0]?.instructions[0] as Record<string, unknown>).stackHeight = h;
      assert.match(code(sh), /E_TX_SHAPE bad stackHeight/, String(h));
    }
    const sparse = j();
    const meta = sparse.meta as Record<string, unknown>;
    for (const k of ['loadedAddresses', 'innerInstructions', 'preBalances', 'preTokenBalances', 'postTokenBalances', 'computeUnitsConsumed']) delete meta[k];
    meta.err = null;                                                          // meta.err is required (Z03 ruling m5), null is success
    meta.logMessages = [1];
    sparse.blockTime = null;
    sparse.slot = 2n ** 64n - 1n;
    const r = readRpcTransaction('s', sparse);
    assert.ok(r.ok);
    assert.deepEqual([r.value.meta.innerInstructions, r.value.meta.preBalances, r.value.meta.logMessages, r.value.meta.computeUnitsConsumed, r.value.blockTimeS, r.value.meta.err],
      [[], [], null, null, null, null]);
    assert.equal(r.value.slot, 2n ** 64n - 1n);
  });
});
