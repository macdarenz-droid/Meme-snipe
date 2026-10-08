// Card IDL-REPIN (docs/reviews/Z03.md "IDL-REPIN"; findings in docs/reviews/VERIFYNEXT.md, V22): the IDLs re-pinned to
// pump-public-docs 8cda1fa; PumpSwap v2 trades get their quote mint; `PostCompleteBuyEvent` is counted into the buyer's
// total; a trade invoked by an instruction the pin does not list, or by `multi_hop_swap`, is `unpinned_invoker`.
// Each case fails on 6fab4c99 (the Z03 head). Recorded mainnet data (C03 and C11 fixtures), changed where a case
// needs an instruction the sample lacks.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { RawTransaction } from '@bot/types';
import {
  base58, decodeEvents, decodeEventsWithGaps, type LocatedEvent, type LocatedGap, decodeEventsLocated, IDL_COMMIT, PINNED_IDLS, pumpBuyTotals, readRpcTransaction,
  type GapReason, type InnerIx, type PinnedIdl,
} from '../src/index.ts';
import { accountsOf, bytes, decoders, fixture, idls, WSOL, type FixtureAccount } from './fixtures.ts';

interface TxRecord { signature: string; json: Record<string, unknown> }
const TRADES = fixture<{ transactions: TxRecord[] }>('decoders/pump/trade_events_curve.json').transactions;
const SWAP = (): TxRecord => fixture<TxRecord>('mainnet/tx/pumpswap/tx_2TipyhLt.json');
const PREFIX = 'e445a52e51cb9a1d';

const raw = (rec: TxRecord): RawTransaction => {
  const r = readRpcTransaction(rec.signature, rec.json);
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  return r.value;
};
const idl = (name: PinnedIdl['name']): PinnedIdl => idls().find((i) => i.name === name) as PinnedIdl;
const discOf = (map: Map<string, { name: string }>, name: string): string => {
  const hit = [...map.entries()].find(([, d]) => d.name === name);
  assert.ok(hit !== undefined, name);
  return hit[0];
};
const run = (t: RawTransaction) => {
  const gaps: GapReason[] = [];
  const { events: located, gaps: placed } = decodeEventsWithGaps(t, idls(), { onGap: (g) => gaps.push(g) }, { wsolMint: WSOL });
  return { located, gaps, placed, kinds: located.map((l) => l.event.kind) };
};

/** The recorded PumpSwap `buy` (top-level) and its accounts by IDL name. */
function swapBuy(t: RawTransaction): { ix: RawTransaction['message']['instructions'][number]; at: (name: string) => number } {
  const amm = idl('pump_amm');
  const ix = t.message.instructions.find((x) => amm.instructions.get(Buffer.from(x.dataB64, 'base64').subarray(0, 8).toString('hex'))?.name === 'buy');
  assert.ok(ix !== undefined);
  const names = amm.instructions.get(discOf(amm.instructions, 'buy'))?.accounts ?? [];
  return { ix, at: (name) => ix.accounts[names.indexOf(name)] as number };
}
const withDisc = (dataB64: string, disc: string): string => {
  const data = Buffer.from(dataB64, 'base64');
  Buffer.from(disc, 'hex').copy(data, 0);
  return data.toString('base64');
};

describe('re-pin to pump-public-docs 8cda1fa', () => {
  it('pins the commit and the three sha256 values of VERIFY-NEXT V22, and loads PostCompleteBuyEvent and multi_hop_swap', () => {
    assert.equal(IDL_COMMIT, '8cda1fa30ea658b20909d8aedf002047119388d2');
    assert.deepEqual(PINNED_IDLS.map((p) => [p.file, p.sha256]), [
      ['pump.json', '38b8abcc5b279bda85cf473e7c6f67bd15eb89df658cf93434687a43c88ad937'],
      ['pump_amm.json', 'b7d8c57a4d9c4dd0109a9ab893052352333252d4eedced10ac091d4d66cab89b'],
      ['pump_fees.json', 'f111d2e5c9aa3d4e64d6a4e6b6f34300ccb1eaf6abc46834fe491836dc90aa74'],
    ]);
    assert.ok([...idl('pump').events.values()].some((d) => d.name === 'PostCompleteBuyEvent'));
    assert.deepEqual(idl('pump_amm').multiHopSwap, { disc: discOf(idl('pump_amm').instructions, 'multi_hop_swap'), fixedAccounts: 16 });
    assert.equal(idl('pump').multiHopSwap, null);
  });

  it('the v2 trades bind quote_mint to the pool at account 4, as the v1 trades do', () => {
    const amm = idl('pump_amm');
    for (const name of ['buy_v2', 'buy_exact_quote_in_v2', 'sell_v2']) assert.equal(amm.poolQuoteMint.get(discOf(amm.instructions, name)), 4, name);
  });

  it('a recorded trade event is described in full: creator_fee_unclaimed is no longer extra bytes', () => {
    const r = run(raw(TRADES[0] as TxRecord));
    assert.deepEqual([r.kinds, r.located[0]?.layoutExtended, r.located[0]?.shortLegacy], [['pump_trade'], false, false]);
    const s = run(raw(SWAP()));
    assert.deepEqual([s.kinds, s.located[0]?.layoutExtended, s.located[0]?.shortLegacy], [['pumpswap_buy'], false, false]);
  });

  it('an event emitted before creator_fee_unclaimed existed reads it as 0 (shortLegacy); data ending inside a field is truncated', () => {
    for (const [rec, kind] of [[TRADES[0] as TxRecord, 'pump_trade'], [SWAP(), 'pumpswap_buy']] as const) {
      const full = run(raw(rec));
      const cut = (n: number): ReturnType<typeof run> => {
        const t = raw(rec);
        const l = full.located[0];
        assert.ok(l !== undefined);
        const ix = (t.meta.innerInstructions.find((g) => g.index === l.outerIx)?.instructions[l.innerIx]) as InnerIx;
        const data = Buffer.from(ix.dataB64, 'base64');
        ix.dataB64 = data.subarray(0, data.length - n).toString('base64');
        return run(t);
      };
      const old = cut(8);                                        // the layout of the previous pin cb188ce
      assert.deepEqual([old.kinds, old.gaps, old.located[0]?.shortLegacy, old.located[0]?.layoutExtended], [[kind], [], true, false]);
      assert.deepEqual(old.located[0]?.event, full.located[0]?.event);   // creator_fee_unclaimed is not mapped; every mapped field equal
      assert.deepEqual([cut(4).kinds, cut(4).gaps], [[], ['truncated']]);
      assert.deepEqual([cut(9).kinds, cut(9).gaps], [[], ['truncated']]);   // shorter than the previous pin: never padded
      // Ruling 33: data ending on the boundary before the cb188ce last field (holder_rewards) is truncated, not padded.
      assert.deepEqual([cut(16).kinds, cut(16).gaps], [[], ['truncated']]);
    }
  });
});

describe('PumpSwap v2 trades and unpinned invokers', () => {
  it('a buy_v2 on a SOL pool decodes (it was dropped as non_sol_quote under cb188ce)', () => {
    const t = raw(SWAP());
    const { ix } = swapBuy(t);
    ix.dataB64 = withDisc(ix.dataB64, discOf(idl('pump_amm').instructions, 'buy_v2'));
    const r = run(t);
    assert.deepEqual([r.kinds, r.gaps], [['pumpswap_buy'], []]);
  });

  it('an invoker the pin does not list is counted unpinned_invoker, never non_sol_quote', () => {
    const t = raw(SWAP());
    const { ix } = swapBuy(t);
    ix.dataB64 = withDisc(ix.dataB64, '0102030405060708');
    const r = run(t);
    assert.deepEqual([r.kinds, r.gaps], [[], ['unpinned_invoker']]);
  });

  it('an invoker whose data is shorter than a discriminator is unpinned_invoker', () => {
    const t = raw(SWAP());
    const { ix } = swapBuy(t);
    ix.dataB64 = Buffer.from([1, 2, 3]).toString('base64');
    assert.deepEqual(run(t).gaps, ['unpinned_invoker']);
  });
});

describe('multi_hop_swap: dropped as unpinned_invoker until a real multi-hop fixture proves the hop check', () => {
  /** The recorded buy rewritten as a `multi_hop_swap` with one SOL-pool hop (5 accounts) after 16 fixed accounts. */
  function multiHop(): RawTransaction {
    const t = raw(SWAP());
    const { ix, at } = swapBuy(t);
    ix.dataB64 = withDisc(ix.dataB64, discOf(idl('pump_amm').instructions, 'multi_hop_swap'));
    ix.accounts = [...ix.accounts.slice(0, 16), at('base_mint'), at('quote_mint'), at('pool'), at('pool_base_token_account'), at('pool_quote_token_account')];
    return t;
  }

  it('a pool hop on a SOL pool is refused as unpinned_invoker, never non_sol_quote and never a guessed quote', () => {
    const r = run(multiHop());
    assert.deepEqual([r.kinds, r.gaps], [[], ['unpinned_invoker']]);
  });
});

describe('PostCompleteBuyEvent: the pool part of a completing buy, counted into the buyer\'s total', () => {
  /** A recorded curve buy with a PostCompleteBuyEvent emitted right after its TradeEvent (same program, same height). */
  function completingBuy(quoteMint: Uint8Array = new Uint8Array(32)): { t: RawTransaction; mint: string } {
    const rec = TRADES.find((x) => run(raw(x)).located.some((l) => l.event.kind === 'pump_trade' && l.event.isBuy));
    assert.ok(rec !== undefined);
    const t = raw(rec);
    const trade = run(t).located[0];
    assert.ok(trade?.event.kind === 'pump_trade');
    const group = t.meta.innerInstructions.find((g) => g.index === trade.outerIx) as RawTransaction['meta']['innerInstructions'][number];
    const tradeIx = group.instructions[trade.innerIx] as InnerIx;
    const u64 = (v: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
    const key = (k: string): Buffer => Buffer.from(base58.decode(k));
    // PostCompleteBuyEvent fields in the order of the pinned pump.json.
    const body = Buffer.concat([
      key(trade.event.mint), key(trade.event.mint), key(trade.event.mint), Buffer.from(quoteMint), u64(1_760_000_000n),
      u64(5_000_000n) /* base_out */, u64(250_000_000n) /* quote_in */, u64(95n), u64(2_375_000n), u64(5n), u64(125_000n),
      u64(0n), u64(206_900_000_000_000n), u64(85_000_000_000n), u64(206_895_000_000_000n), u64(85_250_000_000n),
    ]);
    const disc = discOf(idl('pump').events, 'PostCompleteBuyEvent');
    group.instructions.splice(trade.innerIx + 1, 0, { ...tradeIx, dataB64: Buffer.concat([Buffer.from(PREFIX + disc, 'hex'), body]).toString('base64') });
    return { t, mint: trade.event.mint };
  }

  it('decodes the pool part as pump_post_complete_buy with its amounts and fees', () => {
    const { t, mint } = completingBuy();
    const r = run(t);
    assert.deepEqual([r.kinds, r.gaps], [['pump_trade', 'pump_post_complete_buy'], []]);
    const post = r.located[1];
    assert.equal(post?.layoutExtended, false);
    assert.deepEqual(post?.event, {
      kind: 'pump_post_complete_buy', mint, solAmount: 250_000_000n, tokenAmount: 5_000_000n, feeBps: 95, fee: 2_375_000n,
      creatorFeeBps: 5, creatorFee: 125_000n, quoteMint: null, slot: t.slot, signature: t.signature,
    });
  });

  it('the buyer\'s total is the TradeEvent amounts plus the PostCompleteBuyEvent amounts', () => {
    const { t, mint } = completingBuy();
    const r = run(t);
    const trade = r.located[0]?.event;
    assert.ok(trade?.kind === 'pump_trade');
    assert.deepEqual(pumpBuyTotals(r.located, r.placed), [{
      signature: t.signature, outerIx: r.located[0]?.outerIx, mint, solAmount: trade.solAmount + 250_000_000n,
      tokenAmount: trade.tokenAmount + 5_000_000n, fee: trade.fee + 2_375_000n, creatorFee: trade.creatorFee + 125_000n,
      incomplete: false,
    }]);
  });

  it('decodeEvents keeps to DecodedEvent (the frozen @bot/types has no such variant); the decoders count it', () => {
    const { t } = completingBuy();
    assert.deepEqual(decodeEvents(t, idls(), {}, { wsolMint: WSOL }).map((e) => e.kind), ['pump_trade']);
    assert.deepEqual(decoders().decodeTransactionEvents(t).map((e) => e.kind), ['pump_trade']);
    const kinds: string[] = [];
    decodeEventsLocated(t, idls(), { onEvent: (k) => kinds.push(k) }, { wsolMint: WSOL });
    assert.deepEqual(kinds, ['pump_trade', 'pump_post_complete_buy']);
  });

  it('a pool part whose quote mint is not native SOL is refused (non_sol_quote)', () => {
    const { t } = completingBuy(new Uint8Array(32).fill(7));
    const r = run(t);
    assert.deepEqual([r.kinds, r.gaps], [['pump_trade'], ['non_sol_quote']]);
  });

  it('sells are not counted; a trade without a pool part is its own total', () => {
    const sell = TRADES.map(raw).find((t) => run(t).located.some((l) => l.event.kind === 'pump_trade' && !l.event.isBuy));
    if (sell !== undefined) assert.deepEqual(pumpBuyTotals(run(sell).located, run(sell).placed), []);
    const buy = TRADES.map(raw).find((t) => run(t).located.some((l) => l.event.kind === 'pump_trade' && l.event.isBuy)) as RawTransaction;
    const e = run(buy).located[0]?.event;
    assert.ok(e?.kind === 'pump_trade');
    assert.deepEqual(pumpBuyTotals(run(buy).located, run(buy).placed).map((x) => [x.solAmount, x.tokenAmount]), [[e.solAmount, e.tokenAmount]]);
  });
});

describe('accounts the new pin lengthens', () => {
  const d = decoders();
  it('the recorded pump Global (written before max_curve_depth) reads it as 0, flagged shortLegacy', () => {
    const g = accountsOf('mainnet/config/pump_global.json').find((a) => a.role === 'pump_global') as FixtureAccount;
    const r = d.decodeAccountWithFlags(g.owner, bytes(g));
    assert.equal(r.account.kind, 'pump_global');
    assert.equal(r.account.kind === 'pump_global' ? r.account.raw.max_curve_depth : -1, 0);
    assert.deepEqual(r.flags, { layoutExtended: false, shortLegacy: true });
  });

  it('a Pool cut to the previous pin\'s layout reads protocol_fees and creator_fees as 0; shorter, or cut inside a field with data, is unknown', () => {
    const pool = accountsOf('mainnet/pumpswap/pools/pool_9jkXWMyt.json').find((a) => a.role === 'pool') as FixtureAccount;
    const full = bytes(pool);
    const ok = d.decodeAccountWithFlags(pool.owner, full);
    assert.equal(ok.account.kind, 'pumpswap_pool');
    const old = d.decodeAccountWithFlags(pool.owner, full.slice(0, 8 + 263));          // cb188ce Pool: 263 bytes after the discriminator
    assert.deepEqual([old.account, old.flags], [ok.account, { layoutExtended: false, shortLegacy: true }]);
    assert.equal(d.decodeAccount(pool.owner, full.slice(0, 8 + 262)).kind, 'unknown');  // below the previous pin's layout
    const inside = Uint8Array.from(full.slice(0, 8 + 267));                              // 4 bytes into protocol_fees
    inside[8 + 266] = 1;
    assert.equal(d.decodeAccount(pool.owner, inside).kind, 'unknown');
    inside.fill(0, 8 + 263, 8 + 267);                                                    // zero bytes: capacity, read as 0
    assert.equal(d.decodeAccountWithFlags(pool.owner, inside).flags.shortLegacy, true);
  });
});

describe('round 2 (rulings 33-38)', () => {
  const d = decoders();
  const trade = (signature: string, outerIx: number, mint: string, solAmount: bigint, extra: Partial<LocatedEvent> = {}): LocatedEvent => ({
    event: { kind: 'pump_trade', mint, isBuy: true, solAmount, tokenAmount: solAmount * 10n, feeBps: 95, fee: 1n, creatorFeeBps: 30, creatorFee: 1n, quoteMint: null, slot: 1n, signature },
    outerIx, innerIx: 0, layoutExtended: false, shortLegacy: false, multiHop: false, ...extra,
  });

  it('ruling 33: two top-level instructions buying the same coin in one transaction give two totals', () => {
    const totals = pumpBuyTotals([trade('s', 2, 'm', 100n), trade('s', 3, 'm', 50n), trade('s', 2, 'm', 7n)], []);
    assert.deepEqual(totals.map((t) => [t.outerIx, t.solAmount]), [[2, 107n], [3, 50n]]);
  });

  it('ruling 37: a total is incomplete when a TradeEvent, a PostCompleteBuyEvent or an unnamed event gapped in its instruction', () => {
    const gap = (outerIx: number, event: string | null, signature = 's'): LocatedGap => ({ signature, outerIx, innerIx: 9, reason: 'truncated', event });
    const events = [trade('s', 2, 'm', 100n), trade('s', 3, 'm', 50n)];
    const flags = (gaps: LocatedGap[]) => pumpBuyTotals(events, gaps).map((t) => t.incomplete);
    assert.deepEqual(flags([]), [false, false]);
    assert.deepEqual(flags([gap(2, 'PostCompleteBuyEvent')]), [true, false]);
    assert.deepEqual(flags([gap(3, 'TradeEvent')]), [false, true]);
    assert.deepEqual(flags([gap(2, null)]), [true, false]);
    assert.deepEqual(flags([gap(2, 'BuyEvent'), gap(3, 'TradeEvent', 'other')]), [false, false]);   // another event, another transaction
  });

  it('ruling 37: onGapAt reports the place and the event of a gap that drops a PostCompleteBuyEvent', () => {
    const rec = TRADES.find((x) => run(raw(x)).located.some((l) => l.event.kind === 'pump_trade' && l.event.isBuy)) as TxRecord;
    const t = raw(rec);
    const l = run(t).located[0] as LocatedEvent;
    const group = t.meta.innerInstructions.find((g) => g.index === l.outerIx) as RawTransaction['meta']['innerInstructions'][number];
    const tradeIx = group.instructions[l.innerIx] as InnerIx;
    const disc = discOf(idl('pump').events, 'PostCompleteBuyEvent');
    group.instructions.splice(l.innerIx + 1, 0, { ...tradeIx, dataB64: Buffer.from(PREFIX + disc + '00', 'hex').toString('base64') });   // a cut pool part
    const gaps: LocatedGap[] = [];
    const located = decodeEventsLocated(t, idls(), { onGapAt: (g) => gaps.push(g) }, { wsolMint: WSOL });
    assert.deepEqual(gaps, [{ signature: t.signature, outerIx: l.outerIx, innerIx: l.innerIx + 1, reason: 'truncated', event: 'PostCompleteBuyEvent' }]);
    assert.deepEqual(pumpBuyTotals(located, gaps).map((x) => x.incomplete), [true]);
    // Ruling 43: the Decoders path gives the gaps with the events, so the gapped pool part marks the total incomplete.
    const both = decoders().decodeTransactionEventsWithGaps(t);
    assert.deepEqual(both.gaps, gaps);
    assert.deepEqual(pumpBuyTotals(both.events, both.gaps).map((x) => x.incomplete), [true]);
  });

  it('ruling 38: a TradeEvent under a multi_hop_swap still decodes, is flagged multiHop and is left out of the buyer totals', () => {
    const rec = fixture<TxRecord>('decoders/tx/v1_transaction.json');
    const base = raw(rec);
    const plain = run(base).located.filter((l) => l.event.kind === 'pump_trade');
    assert.ok(plain.length > 0 && plain.every((l) => !l.multiHop));
    assert.equal(pumpBuyTotals(plain, run(base).placed).length, plain.filter((l) => l.event.kind === 'pump_trade' && l.event.isBuy).length > 0 ? 1 : 0);
    const t = raw(rec);
    const outer = t.message.instructions[plain[0]?.outerIx as number];
    assert.ok(outer !== undefined);
    t.message.accountKeys[outer.programIdIndex] = idl('pump_amm').program;      // the aggregator's place taken by PumpSwap
    outer.dataB64 = withDisc(Buffer.alloc(24).toString('base64'), discOf(idl('pump_amm').instructions, 'multi_hop_swap'));
    const hop = run(t).located.filter((l) => l.event.kind === 'pump_trade');
    assert.deepEqual(hop.map((l) => [l.event, l.multiHop]), plain.map((l) => [l.event, true]));
    assert.deepEqual(pumpBuyTotals(hop, run(t).placed), []);
    // A buy flagged multiHop stays out of the totals; the same buy without the flag is counted.
    assert.deepEqual(pumpBuyTotals([trade('s', 2, 'm', 100n, { multiHop: true })], []), []);
    assert.equal(pumpBuyTotals([trade('s', 2, 'm', 100n)], []).length, 1);
  });

  it('ruling 38: a multi_hop_swap invoked by an aggregator (an inner instruction) flags the pump events below it', () => {
    const rec = fixture<TxRecord>('decoders/tx/v1_transaction.json');
    const t = raw(rec);
    const l = run(t).located.find((x) => x.event.kind === 'pump_trade') as LocatedEvent;
    const group = t.meta.innerInstructions.find((g) => g.index === l.outerIx) as RawTransaction['meta']['innerInstructions'][number];
    const ixs = group.instructions as InnerIx[];
    // The event's invoker (pump, height 2) and the instructions it invoked move one level down, under a new PumpSwap
    // multi_hop_swap at height 2; the top-level instruction stays the aggregator's.
    const pumpAt = ixs.slice(0, l.innerIx).map((x, i) => [x, i] as const).filter(([x]) => x.stackHeight === 2).pop()?.[1] as number;
    let end = pumpAt + 1;
    while (end < ixs.length && (ixs[end]?.stackHeight ?? 0) > 2) end++;
    for (let i = pumpAt; i < end; i++) (ixs[i] as InnerIx).stackHeight = ((ixs[i] as InnerIx).stackHeight as number) + 1;
    t.message.accountKeys.push(idl('pump_amm').program);
    const hopIx: InnerIx = { programIdIndex: t.message.accountKeys.length - 1, accounts: [], dataB64: withDisc(Buffer.alloc(24).toString('base64'), discOf(idl('pump_amm').instructions, 'multi_hop_swap')), stackHeight: 2 };
    ixs.splice(pumpAt, 0, hopIx);
    const after = run(t).located.filter((x) => x.event.kind === 'pump_trade');
    assert.deepEqual(after.map((x) => [x.event, x.multiHop]), [[l.event, true]]);
  });

  it('ruling 34: in a short account, any non-zero byte of a partial field past the old end is unknown', () => {
    const pool = accountsOf('mainnet/pumpswap/pools/pool_9jkXWMyt.json').find((a) => a.role === 'pool') as FixtureAccount;
    const full = bytes(pool);
    for (let end = 8 + 264; end < 8 + 271; end++) {                              // inside protocol_fees (263..271)
      for (let at = 8 + 263; at < end; at++) {
        const cut = Uint8Array.from(full.slice(0, end));
        cut.fill(0, 8 + 263);
        cut[at] = 1;
        assert.equal(d.decodeAccount(pool.owner, cut).kind, 'unknown', `${end - 8} bytes, byte ${at - 8} set`);
      }
      const zero = Uint8Array.from(full.slice(0, end)).fill(0, 8 + 263);
      assert.equal(d.decodeAccountWithFlags(pool.owner, zero).flags.shortLegacy, true, `${end - 8} bytes, zeros`);
    }
  });

  it('ruling 35: shortLegacy is set exactly when an appended field was read as zero (accounts and events)', () => {
    const pool = accountsOf('mainnet/pumpswap/pools/pool_9jkXWMyt.json').find((a) => a.role === 'pool') as FixtureAccount;
    const full = bytes(pool);
    assert.equal(d.decodeAccountWithFlags(pool.owner, full.slice(0, 8 + 279)).flags.shortLegacy, false);   // the whole 8cda1fa layout
    for (const n of [263, 271]) assert.equal(d.decodeAccountWithFlags(pool.owner, full.slice(0, 8 + n)).flags.shortLegacy, true, `${n}`);
    const t = raw(TRADES[0] as TxRecord);
    assert.equal(run(t).located[0]?.shortLegacy, false);
    const l = run(t).located[0] as LocatedEvent;
    const ix = t.meta.innerInstructions.find((g) => g.index === l.outerIx)?.instructions[l.innerIx] as InnerIx;
    const data = Buffer.from(ix.dataB64, 'base64');
    ix.dataB64 = data.subarray(0, data.length - 8).toString('base64');
    assert.equal(run(t).located[0]?.shortLegacy, true);
  });
});

describe('round 3 (ruling 44): unclear routes stay out of the buyer totals', () => {
  /** The v1 fixture's pump TradeEvent, its group, and the index of its pump invoker (height 2). */
  function setup(): { t: RawTransaction; l: LocatedEvent; ixs: InnerIx[]; pumpAt: number; end: number } {
    const t = raw(fixture<TxRecord>('decoders/tx/v1_transaction.json'));
    const l = run(t).located.find((x) => x.event.kind === 'pump_trade') as LocatedEvent;
    const ixs = (t.meta.innerInstructions.find((g) => g.index === l.outerIx) as RawTransaction['meta']['innerInstructions'][number]).instructions as InnerIx[];
    const pumpAt = ixs.slice(0, l.innerIx).map((x, i) => [x, i] as const).filter(([x]) => x.stackHeight === 2).pop()?.[1] as number;
    let end = pumpAt + 1;
    while (end < ixs.length && (ixs[end]?.stackHeight ?? 0) > 2) end++;
    return { t, l, ixs, pumpAt, end };
  }

  it('an invoker chain that cannot be followed above the event counts as a route', () => {
    const { t, l, ixs, pumpAt, end } = setup();
    assert.equal(l.multiHop, false);
    // The pump invoker and its subtree move two levels down under a height-2 instruction of another program, so the
    // event's own invoker is still pump (self-CPI) but the pump instruction's invoker cannot be told.
    for (let i = pumpAt; i < end; i++) (ixs[i] as InnerIx).stackHeight = ((ixs[i] as InnerIx).stackHeight as number) + 2;
    ixs.splice(pumpAt, 0, { programIdIndex: t.message.instructions[l.outerIx]?.programIdIndex as number, accounts: [], dataB64: '', stackHeight: 2 });
    const after = run(t).located.filter((x) => x.event.kind === 'pump_trade');
    assert.deepEqual(after.map((x) => [x.event, x.multiHop]), [[l.event, true]]);
    assert.deepEqual(pumpBuyTotals(after, run(t).placed), []);
  });

  it('a TradeEvent whose invoker is pump multi_hop_curve_swap is a route hop', () => {
    const { t, l, ixs, pumpAt } = setup();
    const pumpIx = ixs[pumpAt] as InnerIx;
    pumpIx.dataB64 = withDisc(Buffer.alloc(24).toString('base64'), discOf(idl('pump').instructions, 'multi_hop_curve_swap'));
    const after = run(t).located.filter((x) => x.event.kind === 'pump_trade');
    assert.deepEqual(after.map((x) => [x.event, x.multiHop]), [[l.event, true]]);
    assert.deepEqual(pumpBuyTotals(after, run(t).placed), []);
    assert.deepEqual([...idl('pump').routeInstructions].map((h) => idl('pump').instructions.get(h)?.name), ['multi_hop_curve_swap']);
    assert.deepEqual([...idl('pump_amm').routeInstructions].map((h) => idl('pump_amm').instructions.get(h)?.name), ['multi_hop_swap']);
  });
});
