// Card Z03: DEC-1's mainnet goldens (fixtures/dec1/README.md). The Z03 decoders must give, on every account and
// transaction DEC-1 read from mainnet on 2026-10-03, the values DEC-1's own decoders gave. This sample holds cases the
// C03 and C11 sets lack: a 2024-layout bonding curve, a mayhem coin, a non-canonical pool, negative virtual quote
// reserves, the 8 bytes pump appended to its events on 2026-10-02, and a migration with four events in one transaction.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { readRpcTransaction, type DecodedAccount, type GapReason } from '../src/index.ts';
import { decoders, idls } from './fixtures.ts';
import { decodeEvents } from '../src/events.ts';

const DIR = new URL('../../../fixtures/dec1/', import.meta.url);
const raw = (name: string): Buffer => readFileSync(new URL(name, DIR));
const read = <T>(name: string): T => JSON.parse(raw(name).toString('utf8')) as T;

interface AccountFx { label: string; address: string; owner: string; dataBase64: string }
interface TxFx {
  label: string; signature: string; version: 'legacy' | 0 | 1; jsonMessage: Record<string, unknown>;
  base64: { slot: number; blockTime: number | null; version: 'legacy' | 0 | 1; meta: Record<string, unknown> };
}
interface Goldens {
  accounts: Array<{ address: string; label: string; kind: DecodedAccount['kind']; flags: { layoutExtended: boolean; shortLegacy: boolean }; expected: Record<string, unknown> | null }>;
  transactions: Array<{ signature: string; label: string; expected: Array<Record<string, unknown>>; skipped: string[] }>;
}

const ACCOUNTS = read<{ accounts: AccountFx[] }>('accounts.json').accounts;
const TXS = read<{ transactions: TxFx[] }>('transactions.json').transactions;
const GOLDENS = read<Goldens>('goldens.json');
/** bigints as decimal strings, as goldens.json writes them. */
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x)));
const pick = (o: Record<string, unknown>, keys: string[]): Record<string, unknown> => Object.fromEntries(keys.map((k) => [k, o[k]]));

describe('DEC-1 mainnet goldens (Z03)', () => {
  it('the fixture files are the recorded ones (sha256 as in fixtures/dec1/README.md)', () => {
    const sha = (n: string): string => createHash('sha256').update(raw(n)).digest('hex');
    assert.equal(sha('accounts.json'), '9bd58ceb4fc5c5cd28cdef4b60f88b9f0320008b2c62a3ef24bef7504c7c1dab');
    assert.equal(sha('transactions.json'), 'bd6e07a18d97d38654963210d91f73be982995efb6c837c5d0b7cfed5ec7ef15');
    assert.equal(GOLDENS.accounts.length, 29);
    assert.equal(GOLDENS.transactions.length, 22);
  });

  const d = decoders();
  for (const [i, a] of ACCOUNTS.entries()) {
    const g = GOLDENS.accounts[i] as Goldens['accounts'][number];
    it(`account ${a.label} (${a.address.slice(0, 8)}) decodes as DEC-1 decoded it`, () => {
      assert.equal(g.address, a.address);
      const r = d.decodeAccountWithFlags(a.owner, new Uint8Array(Buffer.from(a.dataBase64, 'base64')));
      assert.equal(r.account.kind, g.kind);
      assert.deepEqual(r.flags, g.flags);
      if (g.expected !== null) assert.deepEqual(pick(plain(r.account) as Record<string, unknown>, Object.keys(g.expected)), g.expected);
    });
  }

  it('only the address lookup table is unknown; the 2024 curve reads in full, the mayhem curve and the negative pool decode', () => {
    assert.deepEqual(GOLDENS.accounts.filter((g) => g.kind === 'unknown').map((g) => g.label), ['address lookup table']);
    assert.ok(GOLDENS.accounts.every((g) => g.kind === 'unknown' || g.expected !== null));
    const negative = GOLDENS.accounts.find((g) => g.label.startsWith('PumpSwap pool with negative'));
    assert.equal(negative?.expected?.virtualQuoteReserves, '-184915875');
    assert.equal(negative?.flags.layoutExtended, true);
  });

  for (const [i, t] of TXS.entries()) {
    const g = GOLDENS.transactions[i] as Goldens['transactions'][number];
    it(`transaction ${t.label} (${t.signature.slice(0, 8)}, version ${String(t.version)}) gives DEC-1's events`, () => {
      assert.equal(g.signature, t.signature);
      // DEC-1 stored a trimmed meta without `fee`; event decoding does not read it (README).
      const json = { slot: t.base64.slot, blockTime: t.base64.blockTime, version: t.base64.version, transaction: { message: t.jsonMessage }, meta: { fee: 0, ...t.base64.meta } };
      const tx = readRpcTransaction(t.signature, json);
      assert.ok(tx.ok, tx.ok ? '' : tx.error.message);
      const gaps: GapReason[] = [];
      const events = decodeEvents(tx.value, idls(), { onGap: (r) => gaps.push(r) });
      assert.deepEqual(gaps, []);
      assert.equal(events.length, g.expected.length);
      for (const [k, e] of events.entries()) {
        const want = g.expected[k] as Record<string, unknown>;
        assert.deepEqual(pick(plain(e) as Record<string, unknown>, Object.keys(want)), want, `event ${k}`);
        assert.equal(e.kind === 'unknown_event' ? '' : e.signature, t.signature);
      }
    });
  }

  it('the sample covers every event kind A-M02-03 maps, both legacy and v0/v1 messages, and a failed transaction', () => {
    const kinds = new Set(GOLDENS.transactions.flatMap((t) => t.expected.map((e) => e.kind)));
    assert.deepEqual([...kinds].sort(), ['pump_complete', 'pump_migration', 'pump_trade', 'pumpswap_buy', 'pumpswap_init_boost', 'pumpswap_sell']);
    assert.deepEqual(new Set(TXS.map((t) => t.version)), new Set(['legacy', 0, 1]));
    assert.ok(TXS.some((t) => t.base64.meta.err !== null && t.base64.meta.err !== undefined));
    assert.deepEqual([...new Set(GOLDENS.transactions.flatMap((t) => t.skipped))].sort(), ['BoostBuyAndBurnEvent', 'CreateEvent', 'CreatePoolEvent']);
  });
});
