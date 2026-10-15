// Z01-COV: the decoder branches the main suites leave out (SPEC-A 640: 100% branch coverage for the decoders).
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { DecodedEvent, RawTransaction } from '@bot/types';
import { createAccountDecoder } from '../src/accounts.ts';
import {
  decodeEventsWithGaps, pumpBuyTotals, readRpcTransaction, type DecodedTransactionEvents, type GapReason, type LocatedEvent,
  type InnerIx, type PinnedIdl,
} from '../src/index.ts';
import { fixture, idls, role, TOKEN_PROGRAMS, WSOL } from './fixtures.ts';

interface TxRecord { signature: string; json: Record<string, unknown> }
const raw = (rec: TxRecord): RawTransaction => {
  const r = readRpcTransaction(rec.signature, rec.json);
  assert.ok(r.ok, r.ok ? '' : r.error.message);
  return r.value;
};
const swap = (): RawTransaction => raw(fixture<TxRecord>('mainnet/tx/pumpswap/tx_2TipyhLt.json'));
const run = (t: RawTransaction): { kinds: string[]; gaps: GapReason[] } => {
  const gaps: GapReason[] = [];
  const r = decodeEventsWithGaps(t, idls(), { onGap: (g) => gaps.push(g) }, { wsolMint: WSOL });
  return { kinds: r.events.map((l) => l.event.kind), gaps };
};
/** The top-level instruction that invokes the PumpSwap trade event. */
const invokerOf = (t: RawTransaction): RawTransaction['message']['instructions'][number] => {
  const amm = idls().find((i) => i.name === 'pump_amm') as PinnedIdl;
  const ix = t.message.instructions.find((x) => amm.poolQuoteMint.has(Buffer.from(x.dataB64, 'base64').subarray(0, 8).toString('hex')));
  assert.ok(ix !== undefined);
  return ix;
};

describe('event invokers: remaining branches', () => {
  it('an invoker whose data was longer than the decoder reads is unpinned_invoker', () => {
    const t = swap();
    (invokerOf(t) as { dataLength58?: number }).dataLength58 = 1_000_000;
    assert.deepEqual(run(t), { kinds: [], gaps: ['unpinned_invoker'] });
  });
  it('an invoker whose pool quote-mint account is missing or outside the key list gives no quote (non_sol_quote), never a guess', () => {
    const missing = swap();
    invokerOf(missing).accounts = [];
    assert.deepEqual(run(missing), { kinds: [], gaps: ['non_sol_quote'] });
    const outside = swap();
    const ix = invokerOf(outside);
    const amm = idls().find((i) => i.name === 'pump_amm') as PinnedIdl;
    const at = amm.poolQuoteMint.get(Buffer.from(ix.dataB64, 'base64').subarray(0, 8).toString('hex')) as number;
    ix.accounts = ix.accounts.map((a, i) => (i === at ? 60_000 : a));
    assert.deepEqual(run(outside), { kinds: [], gaps: ['non_sol_quote'] });
  });
});

describe('pumpBuyTotals: remaining branches', () => {
  it('events of other kinds and sells are not buyer totals', () => {
    const t = swap();
    const r = decodeEventsWithGaps(t, idls(), {}, { wsolMint: WSOL });
    assert.equal(r.events[0]?.event.kind, 'pumpswap_buy');
    assert.deepEqual(pumpBuyTotals(r), []);
    const sell = { ...(r.events[0] as LocatedEvent), event: { kind: 'pump_trade', isBuy: false } as unknown as DecodedEvent };
    const gapsOnly: DecodedTransactionEvents = { events: [sell], gaps: [] };
    assert.deepEqual(pumpBuyTotals(gapsOnly), []);
  });
});

describe('pump account decoder: remaining branches', () => {
  it('a short curve whose pinned layout lost the padded field is unknown, never guessed', () => {
    const pump = idls().find((i) => i.name === 'pump') as PinnedIdl;
    const accounts = new Map([...pump.accounts].map(([k, def]) => [k, def.name === 'BondingCurve' ? { ...def, fields: def.fields.filter((f) => f.name !== 'is_holder_reward') } : def]));
    const decoder = createAccountDecoder([{ ...pump, accounts }], TOKEN_PROGRAMS);
    const curve = Uint8Array.from(Buffer.from(role('mainnet/pump/curves/curve_586AJyoo.json', 'bonding_curve').data_base64, 'base64')).subarray(0, 100);
    assert.equal(decoder.decodeAccount(pump.program, curve).kind, 'unknown');
  });
});

describe('route detection: an ancestor of an unknown program is not a route', () => {
  it('a pump event under an instruction whose program index is outside the key list stays a plain buy', () => {
    const t = raw(fixture<TxRecord>('decoders/tx/v1_transaction.json'));
    const r = decodeEventsWithGaps(t, idls(), {}, { wsolMint: WSOL });
    const l = r.events.find((x) => x.event.kind === 'pump_trade') as LocatedEvent;
    const ixs = (t.meta.innerInstructions.find((g) => g.index === l.outerIx) as RawTransaction['meta']['innerInstructions'][number]).instructions as InnerIx[];
    const pumpAt = ixs.slice(0, l.innerIx).map((x, i) => [x, i] as const).filter(([x]) => x.stackHeight === 2).pop()?.[1] as number;
    let end = pumpAt + 1;
    while (end < ixs.length && (ixs[end]?.stackHeight ?? 0) > 2) end++;
    for (let i = pumpAt; i < end; i++) (ixs[i] as InnerIx).stackHeight = ((ixs[i] as InnerIx).stackHeight as number) + 1;
    ixs.splice(pumpAt, 0, { programIdIndex: 60_000, accounts: [], dataB64: '', stackHeight: 2 });
    const after = decodeEventsWithGaps(t, idls(), {}, { wsolMint: WSOL }).events.filter((x) => x.event.kind === 'pump_trade');
    assert.deepEqual(after.map((x) => [x.event, x.multiHop]), [[l.event, false]]);
  });
});
