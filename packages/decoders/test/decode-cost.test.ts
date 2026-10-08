// Card Z03: fail-before evidence for C03 review fix R2's two cost guards, which the 2 s timing test cannot see now that
// base58 decoding is fast (Z03 mutation run): instruction data is decoded from base58 only when it is first read, and
// pump data whose base58 text is too long for any event is refused on its length, without decoding it. Both are
// counted here as calls to base58.decode, which events.ts reaches through the exported `base58` object.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { base58, decodeEvents, readRpcTransaction, type GapReason, type InnerIx } from '../src/index.ts';
import { fixture, idls, programOf } from './fixtures.ts';

interface TxRecord { signature: string; json: Record<string, unknown> }
const REC = fixture<{ transactions: TxRecord[] }>('decoders/pump/trade_events_curve.json').transactions[0] as TxRecord;
const BIG = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.repeat(242).slice(0, 13_985);   // about 10 KiB

/** Runs `fn` with base58.decode counted; restores it afterwards. */
function counted<T>(fn: () => T): [T, number] {
  const real = base58.decode;
  let calls = 0;
  base58.decode = (s: string): Uint8Array => { calls += 1; return real(s); };
  try {
    return [fn(), calls];
  } finally {
    base58.decode = real;
  }
}

/** The recorded trade with one more pump inner instruction of about 10 KiB (Anchor ignores trailing data). */
function withLongPumpData(): Record<string, unknown> {
  const json = JSON.parse(JSON.stringify(REC.json)) as { transaction: { message: { accountKeys: string[] } }; meta: { innerInstructions: Array<{ instructions: unknown[] }> } };
  const pumpAt = json.transaction.message.accountKeys.indexOf(programOf('pump'));
  assert.ok(pumpAt >= 0);
  const group = json.meta.innerInstructions.find((g) => g.instructions.length > 0) as { instructions: unknown[] };
  group.instructions.push({ programIdIndex: pumpAt, accounts: [], data: BIG, stackHeight: 2 });
  return json;
}

describe('R2 cost guards (Z03 fail-before evidence)', () => {
  it('reading a transaction decodes no instruction data; reading dataB64 decodes it once', () => {
    const [r, atRead] = counted(() => readRpcTransaction(REC.signature, REC.json));
    assert.ok(r.ok);
    assert.equal(atRead, 0, 'readRpcTransaction must not decode base58 data');
    const ix = r.value.message.instructions[0] as InnerIx;
    const [, first] = counted(() => ix.dataB64);
    const [, again] = counted(() => ix.dataB64);
    assert.deepEqual([first, again], [1, 0]);
  });

  it('pump data too long for any event is refused on its base58 length, never decoded', () => {
    const r = readRpcTransaction(REC.signature, withLongPumpData());
    assert.ok(r.ok);
    const long = r.value.meta.innerInstructions.flatMap((g) => g.instructions).find((x) => (x as InnerIx).dataLength58 === BIG.length) as InnerIx;
    const gaps: GapReason[] = [];
    const real = base58.decode;
    const seen: number[] = [];
    base58.decode = (s: string): Uint8Array => { seen.push(s.length); return real(s); };
    try {
      decodeEvents(r.value, idls(), { onGap: (g) => gaps.push(g) });
    } finally {
      base58.decode = real;
    }
    assert.deepEqual(gaps, ['oversized']);
    assert.ok(!seen.includes(BIG.length), 'the long data was decoded');
    assert.ok(long.dataLength58 === BIG.length, 'still undecoded afterwards');
  });
});
