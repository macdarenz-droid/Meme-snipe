// Card Z03 round 2 (supervisor rulings 2, 3, m5, m10, m11 of 8 Oct; docs/reviews/Z03.md): each case fails on 5702022e.
// Recorded mainnet data (C03 and C11 fixtures), changed byte by byte where a case needs a value the sample lacks.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { RawTransaction } from '@bot/types';
import { createDecoders, decodeEventsLocated, Reader, readRpcTransaction, type GapReason, type InnerIx, type PinnedIdl } from '../src/index.ts';
import { accountsOf, bytes, decoders, fixture, idls, role, TOKEN_PROGRAMS, WSOL, type FixtureAccount } from './fixtures.ts';

interface TxRecord { signature: string; json: Record<string, unknown> }
const TRADES = fixture<{ transactions: TxRecord[] }>('decoders/pump/trade_events_curve.json').transactions;
const SWAP = fixture<TxRecord>('mainnet/tx/pumpswap/tx_2TipyhLt.json');
const TRADE_DISC = 'bddb7fd34ee661ee';
const PREFIX = 'e445a52e51cb9a1d';

const raw = (rec: TxRecord): RawTransaction => {
  const r = readRpcTransaction(rec.signature, rec.json);
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  return r.value;
};
/** The TradeEvent inner instruction of a recorded curve trade. */
function tradeIx(t: RawTransaction): InnerIx {
  const ix = t.meta.innerInstructions.flatMap((g) => g.instructions)
    .find((x) => Buffer.from(x.dataB64, 'base64').subarray(0, 16).toString('hex') === `${PREFIX}${TRADE_DISC}`);
  assert.ok(ix !== undefined);
  return ix as InnerIx;
}
/** Body offset at which `field` of the pinned TradeEvent starts in `body` (fields read in order, as the decoder does). */
function offsetOf(body: Buffer, field: string): number {
  const pump = idls().find((i) => i.name === 'pump') as PinnedIdl;
  const def = pump.events.get(TRADE_DISC);
  assert.ok(def !== undefined);
  const r = new Reader(body);
  for (const f of def.fields) {
    if (f.name === field) return r.offset();
    f.read(r);
  }
  throw new Error(`no field ${field}`);
}
/** The pinned TradeEvent layout's length for this body (the bytes after it are the ones the IDL does not describe). */
function layoutLength(body: Buffer): number {
  const pump = idls().find((i) => i.name === 'pump') as PinnedIdl;
  const r = new Reader(body);
  (pump.events.get(TRADE_DISC) as { read: (r: Reader) => unknown }).read(r);
  return r.offset();
}
const run = (t: RawTransaction, wsolMint: string | null = WSOL) => {
  const gaps: GapReason[] = [];
  const extended: number[] = [];
  const located = decodeEventsLocated(t, idls(), { onGap: (g) => gaps.push(g), onLayoutExtended: (_k, n) => extended.push(n) }, wsolMint === null ? {} : { wsolMint });
  return { located, gaps, extended };
};

describe('ruling 2: bytes after the pinned event layout are flagged and counted', () => {
  it('a recorded trade carries the 8 bytes of 2026-10-02; the pinned layout alone is clean; 40 junk bytes more are flagged', () => {
    const t = raw(TRADES[0] as TxRecord);
    const ix = tradeIx(t);
    const data = Buffer.from(ix.dataB64, 'base64');
    const body = data.subarray(16);
    const exact = layoutLength(body);
    assert.equal(body.length - exact, 8);                        // creator_fee_unclaimed: u64 (pump-public-docs 8cda1fa)
    const recorded = run(t);
    assert.deepEqual([recorded.located.length, recorded.located[0]?.layoutExtended, recorded.extended], [1, true, [8]]);
    ix.dataB64 = data.subarray(0, 16 + exact).toString('base64');
    const clean = run(t);
    assert.deepEqual([clean.located[0]?.layoutExtended, clean.extended], [false, []]);
    ix.dataB64 = Buffer.concat([data, Buffer.alloc(40, 0xab)]).toString('base64');
    const junk = run(t);
    assert.deepEqual([junk.located[0]?.layoutExtended, junk.extended], [true, [48]]);
  });

  it('the decoders count decode_layout_extended_total{kind}', () => {
    const seen: string[] = [];
    const d = createDecoders(idls(), { wsolMint: WSOL, metrics: { counter: (name, l) => ({ inc: () => { if (name === 'decode_layout_extended_total') seen.push(String(l.kind)); } }) } });
    d.decodeTransactionEvents(raw(TRADES[0] as TxRecord));
    assert.deepEqual(seen, ['pump_trade']);
  });
});

describe('ruling 3: Lamports only from a SOL quote', () => {
  it('a TradeEvent whose quote_mint is not native SOL is refused (non_sol_quote), never a pump_trade', () => {
    const t = raw(TRADES[0] as TxRecord);
    const ix = tradeIx(t);
    const data = Buffer.from(ix.dataB64, 'base64');
    const at = 16 + offsetOf(data.subarray(16), 'quote_mint');
    data.fill(7, at, at + 32);                                   // some mint other than Pubkey::default()
    ix.dataB64 = data.toString('base64');
    const r = run(t);
    assert.deepEqual([r.located.length, r.gaps], [0, ['non_sol_quote']]);
  });

  it('a PumpSwap trade is SOL-quoted only when its pool\'s quote mint is the wSOL mint given', () => {
    assert.deepEqual(run(raw(SWAP)).located.map((l) => l.event.kind), ['pumpswap_buy']);
    const other = run(raw(SWAP), TOKEN_PROGRAMS.splToken);       // any mint but the pool's quote mint
    assert.deepEqual([other.located.length, other.gaps], [0, ['non_sol_quote']]);
    const none = run(raw(SWAP), null);                           // no wSOL mint given: fail closed
    assert.deepEqual([none.located.length, none.gaps], [0, ['non_sol_quote']]);
  });
});

describe('ruling m5: meta.err is required', () => {
  it('a getTransaction result without meta.err is refused; null is success', () => {
    const json = JSON.parse(JSON.stringify((TRADES[0] as TxRecord).json)) as { meta: Record<string, unknown> };
    delete json.meta.err;
    const r = readRpcTransaction('s', json);
    assert.ok(!r.ok && r.error.code === 'E_TX_SHAPE' && r.error.message === 'meta.err missing');
    json.meta.err = null;
    assert.ok(readRpcTransaction('s', json).ok);
  });
});

describe('ruling m10: fees add up to at most 10,000 bps; an uninitialized mint is not a mint', () => {
  it('a TradeEvent whose fee and creator fee add up to more than 10,000 bps is refused', () => {
    const t = raw(TRADES[0] as TxRecord);
    const ix = tradeIx(t);
    const data = Buffer.from(ix.dataB64, 'base64');
    const body = data.subarray(16);
    data.writeBigUInt64LE(9_000n, 16 + offsetOf(body, 'fee_basis_points'));
    data.writeBigUInt64LE(1_001n, 16 + offsetOf(body, 'creator_fee_basis_points'));
    ix.dataB64 = data.toString('base64');
    const r = run(t);
    assert.deepEqual([r.located.length, r.gaps], [0, ['truncated']]);
  });

  it('a FeeConfig whose flat fees add up to more than 10,000 bps is unknown', () => {
    const d = decoders();
    const a = accountsOf('mainnet/config/fee_config_pumpswap.json')[0] as FixtureAccount;
    const data = Buffer.from(bytes(a));
    assert.equal(d.decodeAccount(a.owner, data).kind, 'pump_fee_config');
    // FeeConfig: discriminator 8, bump u8, admin pubkey, flat_fees { lp, protocol, creator } u64 each (pinned pump_fees.json).
    data.writeBigUInt64LE(5_000n, 8 + 1 + 32);
    data.writeBigUInt64LE(5_000n, 8 + 1 + 32 + 8);
    data.writeBigUInt64LE(1n, 8 + 1 + 32 + 16);
    assert.equal(d.decodeAccount(a.owner, data).kind, 'unknown');
  });

  it('a mint with is_initialized = false is unknown, not spl_mint', () => {
    const d = decoders();
    const wsol = role('mainnet/pumpswap/pools/pool_9jkXWMyt.json', 'quote_mint');
    const data = Buffer.from(bytes(wsol));
    assert.equal(d.decodeAccount(wsol.owner, data).kind, 'spl_mint');
    data[45] = 0;                                                // Mint.is_initialized (U-A08 layout)
    assert.equal(d.decodeAccount(wsol.owner, data).kind, 'unknown');
  });
});

describe('ruling m11: each event carries its place in the transaction', () => {
  it('a second delivery of the same transaction gives the same (signature, outerIx, innerIx); two events in one transaction differ', () => {
    const t = raw(TRADES[0] as TxRecord);
    const once = run(t).located.map((l) => [l.event.kind === 'unknown_event' ? '' : l.event.signature, l.outerIx, l.innerIx]);
    const again = run(raw(TRADES[0] as TxRecord)).located.map((l) => [l.event.kind === 'unknown_event' ? '' : l.event.signature, l.outerIx, l.innerIx]);
    assert.deepEqual(once, again);
    const group = t.meta.innerInstructions.find((g) => g.instructions.includes(tradeIx(t))) as RawTransaction['meta']['innerInstructions'][number];
    const k = group.instructions.indexOf(tradeIx(t));
    group.instructions.splice(k + 1, 0, { ...tradeIx(t), dataB64: tradeIx(t).dataB64 });   // the same fill emitted twice
    const twice = run(t).located;
    assert.equal(twice.length, 2);
    assert.deepEqual(twice[0]?.event, twice[1]?.event);           // equal events: only the ordinal tells them apart
    assert.notEqual(twice[0]?.innerIx, twice[1]?.innerIx);
  });
});

describe('Z03 round 3, ruling 14: the instructions trusted for a PumpSwap quote mint are built at IDL load', () => {
  it('the set is every pump_amm instruction whose quote_mint is bound to the pool, and nothing else', () => {
    const amm = idls().find((i) => i.name === 'pump_amm') as PinnedIdl;
    const names = [...amm.poolQuoteMint.keys()].map((h) => amm.instructions.get(h)?.name).sort();
    assert.deepEqual(names, ['boost_buy_and_burn', 'buy', 'buy_exact_quote_in', 'deposit', 'init_boost', 'sell', 'withdraw']);
    assert.ok([...amm.poolQuoteMint.values()].every((at) => at === 4));
    assert.equal((idls().find((i) => i.name === 'pump') as PinnedIdl).poolQuoteMint.size, 0);
  });

  it('an event invoked by another PumpSwap instruction (create_pool, whose quote_mint has no pool relation) gets no quote and is refused', () => {
    const t = raw(SWAP);
    assert.deepEqual(run(t).located.map((l) => l.event.kind), ['pumpswap_buy']);
    const amm = idls().find((i) => i.name === 'pump_amm') as PinnedIdl;
    const createPool = [...amm.instructions.entries()].find(([, d]) => d.name === 'create_pool')?.[0] as string;
    const buyIx = t.message.instructions.find((ix) => {
      const d = Buffer.from(ix.dataB64, 'base64');
      return amm.instructions.get(d.subarray(0, 8).toString('hex'))?.name === 'buy';
    });
    assert.ok(buyIx !== undefined);
    const data = Buffer.from(buyIx.dataB64, 'base64');
    Buffer.from(createPool, 'hex').copy(data, 0);                // same accounts, same quote_mint position, another instruction
    buyIx.dataB64 = data.toString('base64');
    const r = run(t);
    assert.deepEqual([r.located.length, r.gaps], [0, ['non_sol_quote']]);
  });
});

describe('Z03 round 3 addendum, ruling 17: a curve whose quote is not native SOL yields no Lamports', () => {
  it('a recorded curve with its quote_mint bytes patched is unknown and counted non_sol_quote', () => {
    const counted: string[] = [];
    const d = createDecoders(idls(), { tokenPrograms: TOKEN_PROGRAMS, wsolMint: WSOL, metrics: { counter: (name, l) => ({ inc: () => { if (name === 'decode_accounts_total') counted.push(`${l.kind}:${l.result}`); } }) } });
    const curve = accountsOf('mainnet/pump/curves/curve_586AJyoo.json').find((a) => a.role === 'bonding_curve') as FixtureAccount;
    const data = Buffer.from(bytes(curve));
    const ok = d.decodeAccount(curve.owner, data);
    assert.equal(ok.kind, 'pump_bonding_curve');
    assert.equal(ok.kind === 'pump_bonding_curve' ? ok.quoteMint : 'x', null);
    // BondingCurve body offset of quote_mint, read from the pinned layout field by field.
    const pump = idls().find((i) => i.name === 'pump') as PinnedIdl;
    const def = [...pump.accounts.values()].find((x) => x.name === 'BondingCurve');
    assert.ok(def !== undefined);
    const r = new Reader(data.subarray(8));
    let at = -1;
    for (const f of def.fields) { if (f.name === 'quote_mint') { at = 8 + r.offset(); break; } f.read(r); }
    assert.ok(at > 0);
    data.fill(9, at, at + 32);                                   // a quote mint other than Pubkey::default()
    const patched = d.decodeAccount(curve.owner, data);
    assert.equal(patched.kind, 'unknown');
    assert.ok(!('virtualQuote' in patched) && !('realQuote' in patched));
    assert.deepEqual(counted, ['pump_bonding_curve:ok', 'pump_bonding_curve:non_sol_quote']);
  });
});

describe('Z03 round 3 addendum, ruling 18: a migration event with a non-SOL quote_mint is refused', () => {
  it('CompletePumpAmmMigrationEvent with its quote_mint bytes patched gives no pump_migration and a non_sol_quote gap', () => {
    const t = raw(fixture<TxRecord>('mainnet/tx/migration/tx_32tjvqFP.json'));
    assert.ok(run(t).located.some((l) => l.event.kind === 'pump_migration'));
    const pump = idls().find((i) => i.name === 'pump') as PinnedIdl;
    const [disc, def] = [...pump.events.entries()].find(([, x]) => x.name === 'CompletePumpAmmMigrationEvent') as [string, PinnedIdl['events'] extends Map<string, infer V> ? V : never];
    const ix = t.meta.innerInstructions.flatMap((g) => g.instructions)
      .find((x) => Buffer.from(x.dataB64, 'base64').subarray(0, 16).toString('hex') === `${PREFIX}${disc}`) as InnerIx;
    const data = Buffer.from(ix.dataB64, 'base64');
    const r = new Reader(data.subarray(16));
    let at = -1;
    for (const f of def.fields) { if (f.name === 'quote_mint') { at = 16 + r.offset(); break; } f.read(r); }
    assert.ok(at > 0);
    data.fill(9, at, at + 32);
    ix.dataB64 = data.toString('base64');
    const out = run(t);
    assert.ok(!out.located.some((l) => l.event.kind === 'pump_migration'));
    assert.ok(out.gaps.includes('non_sol_quote'));
  });
});
