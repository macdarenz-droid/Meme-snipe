// The PumpSwap pool model M04 polls through (card Z07): recorded pool sets (fixtures/mainnet/pumpswap/pools) in, the
// same `CpPoolState` as A-M01-04's `normalisePool` out; every error path; and the ring-buffer record codec round trip.
import { strict as assert } from 'node:assert';
import { readdirSync } from 'node:fs';
import fc from 'fast-check';
import { describe, it } from 'vitest';
import type { Bps, Slot, UnixMs } from '@bot/types';
import type { RawAccount } from '../src/cache.ts';
import { MINTS, PROGRAMS, pumpPoolAuthorityPda } from '../src/constants.ts';
import { createPumpSwapPoolModel, POOL_RECORD_BYTES, type PoolAddresses } from '../src/pool-model.ts';
import type { CpPoolState } from '../src/pool.ts';
import { decoders } from './config.ts';
import { CORE2_INPUTS, pool, readJson, root } from './helpers.ts';

type FxAccount = { role: string; pubkey: string; owner: string; data_base64: string; context_slot: number };
const FILES = readdirSync(root('fixtures/mainnet/pumpswap/pools')).filter((f) => f.endsWith('.json'));
const setOf = (file: string) => {
  const f = readJson<{ accounts: FxAccount[]; selection: { pool_authority: string } }>(`fixtures/mainnet/pumpswap/pools/${file}`);
  const acc = (role: string): RawAccount & { pubkey: string } => {
    const a = f.accounts.find((x) => x.role === role) as FxAccount;
    return { pubkey: a.pubkey, owner: a.owner, data: new Uint8Array(Buffer.from(a.data_base64, 'base64')) };
  };
  return { pool: acc('pool'), base: acc('base_vault'), quote: acc('quote_vault'), mint: acc('base_mint'), authority: f.selection.pool_authority };
};
const model = createPumpSwapPoolModel({ decoder: decoders, fees: () => CORE2_INPUTS });
const ctx = (canonicalCreator: string | null) => ({ asOfSlot: 7n as Slot, observedAtMs: 9 as UnixMs, canonicalCreator });
const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => { if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value; };
const code = (r: { ok: boolean; error?: { code: string } }): string | null => (r.ok ? null : (r.error as { code: string }).code);

describe('pool model on the 13 recorded pools', () => {
  it('addresses, mint and build give the normalised state: wSOL quote, token base, vault reserves, canonical by the PDA', async () => {
    assert.equal(FILES.length, 13);
    for (const file of FILES) {
      const s = setOf(file);
      const addr = ok(model.addresses(s.pool.pubkey, s.pool));
      assert.deepEqual([addr.baseVault, addr.quoteVault], [s.base.pubkey, s.quote.pubkey]);
      assert.equal(await pumpPoolAuthorityPda(addr.tokenMint), s.authority);
      const mint = model.mint(s.mint);
      assert.ok(mint !== null && mint.decimals === 6);
      const p = ok(model.build(addr, { pool: s.pool, baseVault: s.base, quoteVault: s.quote }, mint, ctx(s.authority)));
      assert.deepEqual([p.baseMint, p.quoteMint, p.isCanonical, p.asOfSlot, p.observedAtMs], [addr.tokenMint, MINTS.wsol, true, 7n, 9]);
      assert.ok(p.baseReserve > 0n && p.quoteReserveReal > 0n);
      assert.equal(model.effectiveQuote(p), p.quoteReserveReal + p.quoteReserveVirtual);
      assert.ok((model.spot(p) as string).includes('.'));
      assert.ok((model.feeTotalBps(p) as number) >= 30 && (model.feeTotalBps(p) as number) <= 125, file);
      // Round trip through the ring-buffer record.
      const buf = new Uint8Array(POOL_RECORD_BYTES * 2);
      model.encode(p, buf, POOL_RECORD_BYTES);
      assert.deepEqual(model.decode(addr, buf, POOL_RECORD_BYTES), p);
    }
  });

  it('errors: a missing pool is E_CLOSED; another owner, other vaults, a non-token vault or a vault of another mint is E_OWNER_CHANGED; a missing vault is E_PARTIAL', () => {
    const s = setOf(FILES[0] as string);
    const addr = ok(model.addresses(s.pool.pubkey, s.pool));
    const mint = model.mint(s.mint) as NonNullable<ReturnType<typeof model.mint>>;
    const build = (over: Partial<{ pool: RawAccount | null; baseVault: RawAccount | null; quoteVault: RawAccount | null }>, a: PoolAddresses = addr) =>
      code(model.build(a, { pool: s.pool, baseVault: s.base, quoteVault: s.quote, ...over }, mint, ctx(null)));
    assert.equal(code(model.addresses('x', null)), 'E_CLOSED');
    assert.equal(code(model.addresses('x', { owner: PROGRAMS.pumpCurve, data: s.pool.data })), 'E_OWNER_CHANGED');
    assert.equal(code(model.addresses('x', { owner: PROGRAMS.pumpSwap, data: new Uint8Array(40) })), 'E_LAYOUT');
    assert.equal(build({ pool: null }), 'E_CLOSED');
    assert.equal(build({ pool: { owner: PROGRAMS.splToken, data: s.pool.data } }), 'E_OWNER_CHANGED');
    assert.equal(build({ pool: { owner: PROGRAMS.pumpSwap, data: new Uint8Array(40) } }), 'E_LAYOUT');
    assert.equal(build({}, { ...addr, baseVault: 'elsewhere' }), 'E_OWNER_CHANGED');
    assert.equal(build({ baseVault: null }), 'E_PARTIAL');
    assert.equal(build({ quoteVault: null }), 'E_PARTIAL');
    assert.equal(build({ baseVault: { owner: PROGRAMS.pumpSwap, data: s.base.data } }), 'E_OWNER_CHANGED');
    assert.equal(build({ quoteVault: { owner: s.quote.owner, data: s.base.data } }), 'E_OWNER_CHANGED');   // the token vault read as the SOL vault
    assert.equal(build({}, { ...addr, tokenMint: MINTS.usdc }), 'E_OWNER_CHANGED');
    assert.equal(build({ baseVault: { owner: s.base.owner, data: new Uint8Array(10) } }), 'E_OWNER_CHANGED');
  });

  it('a negative effective reserve is E_NEGATIVE_EFFECTIVE; mints neither or both wSOL are E_NOT_SOL_QUOTED (synthetic bytes)', () => {
    const s = setOf(FILES[5] as string);                         // 9jkXWMyt: virtual reserve +17.58 SOL [EX-09]
    const addr = ok(model.addresses(s.pool.pubkey, s.pool));
    const mint = model.mint(s.mint) as NonNullable<ReturnType<typeof model.mint>>;
    const neg = new Uint8Array(s.pool.data);
    neg.fill(0xff, 245, 261);
    neg[245] = 0;                                               // a large negative i128 (−256 + … ): real + virtual < 0
    neg.fill(0x80, 260, 261);
    assert.equal(code(model.build(addr, { pool: { owner: PROGRAMS.pumpSwap, data: neg }, baseVault: s.base, quoteVault: s.quote }, mint, ctx(null))), 'E_NEGATIVE_EFFECTIVE');
    const quoteMintAt = 8 + 1 + 2 + 32 + 32;                    // bump, index, creator, base_mint, then quote_mint
    const both = new Uint8Array(s.pool.data);
    both.set(both.subarray(quoteMintAt, quoteMintAt + 32), quoteMintAt - 32);
    assert.equal(code(model.addresses('x', { owner: PROGRAMS.pumpSwap, data: both })), 'E_NOT_SOL_QUOTED');
    assert.equal(code(model.build(addr, { pool: { owner: PROGRAMS.pumpSwap, data: both }, baseVault: s.base, quoteVault: s.quote }, mint, ctx(null))), 'E_NOT_SOL_QUOTED');
    // Mints swapped (base wSOL): the token is the quote mint.
    const swapped = new Uint8Array(s.pool.data);
    swapped.set(s.pool.data.subarray(quoteMintAt, quoteMintAt + 32), quoteMintAt - 32);
    swapped.set(s.pool.data.subarray(quoteMintAt - 32, quoteMintAt), quoteMintAt);
    assert.equal(ok(model.addresses('x', { owner: PROGRAMS.pumpSwap, data: swapped })).tokenMint, addr.tokenMint);
  });

  it('mint: only token-program mints; fees: unknown when the cache has no snapshot or the pool fee is unknown; spot: null without decimals', () => {
    const s = setOf(FILES[0] as string);
    assert.equal(model.mint(null), null);
    assert.equal(model.mint({ owner: PROGRAMS.pumpSwap, data: s.mint.data }), null);
    assert.equal(model.mint(s.base), null);                      // a token account, not a mint
    const p = pool();
    assert.equal(createPumpSwapPoolModel({ decoder: decoders, fees: () => null }).feeTotalBps(p), null);
    assert.equal(model.feeTotalBps({ ...p, isCanonical: null }), null);
    assert.equal(model.spot({ ...p, baseDecimals: null }), null);
    assert.equal(model.spot({ ...p, baseReserve: 0n }), null);
  });

  it('codec property: any state round-trips through the 64-byte record (fast-check, fixed seed, 10,000 cases)', () => {
    const tri = fc.constantFrom<boolean | null>(true, false, null);
    const u64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n });
    const addr: PoolAddresses = { poolId: 'p', baseVault: 'b', quoteVault: 'q', tokenMint: 't' };
    fc.assert(fc.property(u64, u64, fc.bigInt({ min: -(1n << 127n), max: (1n << 127n) - 1n }), u64, u64, fc.integer({ min: 0, max: 2 ** 52 }), fc.integer({ min: 0, max: 10_000 }),
      fc.option(fc.integer({ min: 0, max: 18 }), { nil: null }), tri, tri, fc.boolean(), fc.boolean(),
      (base, real, virt, supply, slot, ms, cfb, dec, canon, creator, mayhem, swapped) => {
        const p: CpPoolState = pool({ poolId: 'p', baseMint: 't', baseReserve: base, quoteReserveReal: real, quoteReserveVirtual: virt, baseMintSupply: supply, asOfSlot: slot as Slot,
          observedAtMs: ms as UnixMs, creatorFeeBps: cfb as Bps, baseDecimals: dec, isCanonical: canon, coinCreatorSet: creator, isMayhemMode: mayhem, swappedMints: swapped });
        const buf = new Uint8Array(POOL_RECORD_BYTES);
        model.encode(p, buf, 0);
        assert.deepEqual(model.decode(addr, buf, 0), p);
        return true;
      }), { numRuns: 10_000, seed: 7_041 });
  });
});
