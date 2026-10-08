// Ported from Snipe-solana card C03 (#6 @ 6ae4d62); runner moved from node:test to Vitest.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { base58, createDecoders, decodePubkey, verifyPinnedIdls, VENDORED_IDL_DIR } from '@bot/decoders';
import { ACCOUNTS, derivePda, deriveAndCheckAll, MINTS, PDAS, PROGRAMS, pumpPoolAuthorityPda } from '../src/constants.ts';
import * as venue from '../src/index.ts';

interface PoolSet { selection: { pool_authority: string }; accounts: Array<{ role: string; pubkey: string; owner: string; data_base64: string }> }
const POOLS = ['3Asuat6N', '7Nj7mBE7', '8JZiCe7y', '9GBXHym9', '9ebYNt7c', '9jkXWMyt', 'ArB5efrE', 'CHtrRatG', 'DA4pM4xS', 'Dh39kXkx', 'DreMAMRc', 'FnzKY6x7', 'Hd9zdnVc']
  .map((p) => JSON.parse(readFileSync(new URL(`../../../fixtures/mainnet/pumpswap/pools/pool_${p}.json`, import.meta.url), 'utf8')) as PoolSet);
const idls = verifyPinnedIdls(VENDORED_IDL_DIR);
assert.ok(idls.ok);
const decoders = createDecoders(idls.value, { tokenPrograms: { splToken: PROGRAMS.splToken, token2022: PROGRAMS.token2022 } });
const decodedPool = (set: PoolSet) => {
  const a = set.accounts.find((x) => x.role === 'pool') as PoolSet['accounts'][number];
  const p = decoders.decodeAccount(a.owner, Buffer.from(a.data_base64, 'base64'));
  assert.equal(p.kind, 'pumpswap_pool');
  return p as Extract<typeof p, { kind: 'pumpswap_pool' }>;
};

describe('A-M01-01 constants registry', () => {
  it('re-derives the four PDAs from their EX-01 seeds: they equal the literals, bumps 255, 255, 253, 255', async () => {
    const logged: string[] = [];
    assert.deepEqual(await deriveAndCheckAll({ event: (level, code, f) => { logged.push(`${level} ${code} ${String(f.result)}`); } }), { ok: true, value: true });
    assert.deepEqual(logged, ['info m01.constants_checked ok']);
    const derived = await Promise.all(PDAS.map(async (p) => [p.name, await derivePda(p.program, p.seeds()), p.bump] as const));
    for (const [name, d, bump] of derived) {
      assert.equal(d.address, ACCOUNTS[name], name);
      assert.equal(d.bump, bump, name);
    }
    assert.deepEqual(PDAS.map((p) => p.bump), [255, 255, 253, 255]);
    assert.ok((await deriveAndCheckAll()).ok);
  });

  it('one seed byte changed → E_CONSTANT_MISMATCH, logged critical', async () => {
    const changed = PDAS.map((p) => (p.name === 'feeConfigCurve' ? { ...p, seeds: () => { const s = p.seeds(); const k = Uint8Array.from(s[1] as Uint8Array); k[0] = (k[0] as number) ^ 1; return [s[0] as string, k]; } } : p));
    const logged: string[] = [];
    const r = await deriveAndCheckAll({ event: (level, code, f) => { logged.push(`${level} ${code} ${String(f.result)} ${String(f.name)}`); } }, changed);
    assert.ok(!r.ok);
    assert.equal(r.error.code, 'E_CONSTANT_MISMATCH');
    assert.equal(r.error.name, 'feeConfigCurve');
    assert.equal(r.error.expected, ACCOUNTS.feeConfigCurve);
    assert.notEqual(r.error.derived, ACCOUNTS.feeConfigCurve);
    assert.deepEqual(logged, ['critical m01.constants_checked mismatch feeConfigCurve']);
    const seedText = PDAS.map((p) => (p.name === 'pumpGlobal' ? { ...p, seeds: () => ['globaL'] } : p));
    assert.equal((await deriveAndCheckAll(undefined, seedText)).ok, false);
  });

  it('every literal is a 32-byte base58 key; the objects are frozen; the package root re-exports them', () => {
    for (const v of [...Object.values(PROGRAMS), ...Object.values(MINTS), ...Object.values(ACCOUNTS)]) assert.equal(decodePubkey(v).length, 32, v);
    assert.equal(Object.values(PROGRAMS).length, 14);
    for (const o of [PROGRAMS, MINTS, ACCOUNTS]) assert.ok(Object.isFrozen(o));
    assert.equal(venue.PROGRAMS, PROGRAMS);
  });

  it('agrees with the pinned IDLs and the recorded accounts (owners, wSOL)', () => {
    assert.deepEqual(idls.value.map((i) => i.program), [PROGRAMS.pumpCurve, PROGRAMS.pumpSwap, PROGRAMS.pumpFees]);
    for (const set of POOLS) {
      const pool = set.accounts.find((a) => a.role === 'pool');
      assert.equal(pool?.owner, PROGRAMS.pumpSwap);
      assert.equal(set.accounts.find((a) => a.role === 'quote_mint')?.pubkey, MINTS.wsol);
      assert.ok(([PROGRAMS.splToken, PROGRAMS.token2022] as string[]).includes(set.accounts.find((a) => a.role === 'base_mint')?.owner as string));
    }
  });
});

describe('A-M01-01 pump pool-authority PDA (U-A01: ["pool-authority", base_mint] under pump)', () => {
  it('equals pool.creator for every recorded canonical pool (13 pools) [EX-08]', async () => {
    for (const set of POOLS) {
      const p = decodedPool(set);
      const pda = await pumpPoolAuthorityPda(p.baseMint);
      assert.equal(pda, p.creator, p.baseMint);
      assert.equal(pda, set.selection.pool_authority);
    }
  });

  it('differs from a pool creator for another mint (no recorded non-canonical pool exists; C11 found none)', async () => {
    const a = decodedPool(POOLS[0] as PoolSet);
    const b = decodedPool(POOLS[1] as PoolSet);
    assert.notEqual(await pumpPoolAuthorityPda(b.baseMint), a.creator);
    const mint = decodePubkey(a.baseMint);
    mint[31] = (mint[31] as number) ^ 1;
    const other = base58.encode(mint);
    assert.notEqual(await pumpPoolAuthorityPda(other), a.creator);
  });
});
