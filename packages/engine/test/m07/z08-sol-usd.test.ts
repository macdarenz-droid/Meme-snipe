// Card Z08: SOL/USD once a minute from the Orca SOL/USDC Whirlpool (rulings Z08-7 and Z08-8). No live read (ruling
// Z08-7): every account below is SYNTHETIC, built from the pinned Whirlpool layout (orca-so/whirlpools
// state/whirlpool.rs at cc683ec92acb5e7606caa3d8e514d9383e9c7c11) and the SPL token layout [VF-07]. The one live check
// of the real pool is Z10's on-server acceptance (SPEC-A C-90).
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { base58, decodePubkey } from '@bot/decoders';
import type { Pubkey, Slot, UnixMs } from '@bot/types';
import { derivePda, MINTS, PROGRAMS, REFERENCE, REFERENCE_PDAS } from '@bot/venue/constants';
import {
  createSolUsdReader, decodeTokenAccount, decodeWhirlpool, MIN_DEPTH_USD_E6, priceOf, usdE6PerSol, WHIRLPOOL_DISCRIMINATOR, WHIRLPOOL_LEN,
  type RawAccount, type ReferenceIds, type RefPriceRecord, type ReferenceReader,
} from '../../src/m07/sol-usd.ts';
import { PROTECTED_STREAMS, STREAM_NAMES } from '../../src/recorder/streams.ts';
import { RecorderQueue } from '../../src/recorder/queue.ts';

const pubkeyBytes = (p: Pubkey): Uint8Array => decodePubkey(p);
/** What the composition root passes (Z10): the reviewed constants and the decoders' base58 encoder. */
const IDS: ReferenceIds = {
  whirlpoolProgram: PROGRAMS.orcaWhirlpools, whirlpoolsConfig: REFERENCE.orcaWhirlpoolsConfig, pool: REFERENCE.solUsdcWhirlpool,
  wsol: MINTS.wsol, usdc: MINTS.usdc, splToken: PROGRAMS.splToken, encodeKey: (b) => base58.encode(b) as Pubkey,
};
// Synthetic vault addresses (any 32 bytes).
const VAULT_A = base58.encode(new Uint8Array(32).fill(7)) as Pubkey;
const VAULT_B = base58.encode(new Uint8Array(32).fill(9)) as Pubkey;

/** isqrt by Newton's method. */
const isqrt = (n: bigint): bigint => {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) { x = y; y = (x + n / x) >> 1n; }
  return x;
};
/** sqrt_price (Q64.64) for a price in micro-dollars per SOL: √(usdE6 / 10^9) × 2^64. */
const sqrtFor = (usdE6: bigint): bigint => isqrt((usdE6 << 128n) / 1_000_000_000n);

const put = (d: Uint8Array, at: number, bytes: Uint8Array): void => { d.set(bytes, at); };
const le = (v: bigint, n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));

function syntheticPool(over: { config?: Pubkey; tick?: number; sqrt?: bigint; mintA?: Pubkey; mintB?: Pubkey; vaultA?: Pubkey; vaultB?: Pubkey; disc?: boolean; len?: number } = {}): Uint8Array {
  const d = new Uint8Array(over.len ?? WHIRLPOOL_LEN);
  if (over.disc !== false) put(d, 0, WHIRLPOOL_DISCRIMINATOR);
  put(d, 8, pubkeyBytes(over.config ?? REFERENCE.orcaWhirlpoolsConfig));
  put(d, 41, le(BigInt(over.tick ?? 4), 2));
  put(d, 65, le(over.sqrt ?? sqrtFor(150_000_000n), 16));
  put(d, 101, pubkeyBytes(over.mintA ?? MINTS.wsol));
  put(d, 133, pubkeyBytes(over.vaultA ?? VAULT_A));
  put(d, 181, pubkeyBytes(over.mintB ?? MINTS.usdc));
  put(d, 213, pubkeyBytes(over.vaultB ?? VAULT_B));
  return d;
}
function syntheticToken(mint: Pubkey, amount: bigint, authority: Pubkey = REFERENCE.solUsdcWhirlpool): Uint8Array {
  const d = new Uint8Array(165);
  put(d, 0, pubkeyBytes(mint));
  put(d, 32, pubkeyBytes(authority));
  put(d, 64, le(amount, 8));
  return d;
}
const SOL_DEEP = 20_000n * 1_000_000_000n;                                // 20,000 SOL ≈ $3M at $150
const USDC_DEEP = 3_000_000n * 1_000_000n;                                // $3M
const accounts = (o: { pool?: RawAccount | null; a?: RawAccount | null; b?: RawAccount | null } = {}): Array<RawAccount | null> => [
  o.pool === undefined ? { owner: PROGRAMS.orcaWhirlpools, data: syntheticPool() } : o.pool,
  o.a === undefined ? { owner: PROGRAMS.splToken, data: syntheticToken(MINTS.wsol, SOL_DEEP) } : o.a,
  o.b === undefined ? { owner: PROGRAMS.splToken, data: syntheticToken(MINTS.usdc, USDC_DEEP) } : o.b,
];

describe('card Z08 SOL/USD reference price (synthetic fixtures)', () => {
  it('the reference pool is the PDA of [whirlpool, config, wSOL, USDC, tick spacing 4] under the Whirlpool program', async () => {
    for (const p of REFERENCE_PDAS) {
      const d = await derivePda(p.program, p.seeds());
      assert.deepEqual([d.address, d.bump], [REFERENCE[p.name], p.bump]);
    }
  });

  it('ref_price is a never-dropped stream ranked right after venue_config (ruling Z08-8)', () => {
    assert.equal(STREAM_NAMES.indexOf('ref_price'), STREAM_NAMES.indexOf('venue_config') + 1);
    assert.ok(PROTECTED_STREAMS.has('ref_price'));
  });

  it('decodes the pinned layout; prices sqrt_price exactly ($150.000000 a SOL)', () => {
    const w = decodeWhirlpool(syntheticPool(), IDS);
    assert.ok(w !== null);
    assert.deepEqual([w.config, w.tickSpacing, w.mintA, w.vaultA, w.mintB, w.vaultB], [REFERENCE.orcaWhirlpoolsConfig, 4, MINTS.wsol, VAULT_A, MINTS.usdc, VAULT_B]);
    const p = usdE6PerSol(w.sqrtPriceX64);
    assert.ok(p >= 149_999_999n && p <= 150_000_000n, String(p));
    assert.equal(usdE6PerSol(1n << 64n), 1_000_000_000n);                 // sqrt 1.0: 1 micro-USDC per lamport = $1,000 a SOL
    assert.equal(decodeWhirlpool(syntheticPool({ disc: false }), IDS), null);
    assert.equal(decodeWhirlpool(syntheticPool({ len: WHIRLPOOL_LEN - 1 }), IDS), null);
    assert.equal(decodeTokenAccount(new Uint8Array(164), IDS), null);
    assert.equal(decodeTokenAccount(syntheticToken(MINTS.usdc, 7n), IDS)?.amount, 7n);
  });

  it('every check refuses with its reason (owner, layout, config, mints, vaults, price, vault accounts, depth)', () => {
    const v = { a: VAULT_A, b: VAULT_B };
    const run = (o: Parameters<typeof accounts>[0]) => { const [p, a, b] = accounts(o); return priceOf(IDS, p ?? null, a ?? null, b ?? null, v, MIN_DEPTH_USD_E6); };
    const reason = (o: Parameters<typeof accounts>[0]) => { const r = run(o); return r.ok ? 'ok' : r.reason; };
    assert.equal(reason({}), 'ok');
    assert.equal(reason({ pool: null }), 'pool_missing');
    assert.equal(reason({ pool: { owner: PROGRAMS.raydiumClmm, data: syntheticPool() } }), 'pool_owner');
    assert.equal(reason({ pool: { owner: PROGRAMS.orcaWhirlpools, data: syntheticPool({ disc: false }) } }), 'pool_layout');
    assert.equal(reason({ pool: { owner: PROGRAMS.orcaWhirlpools, data: syntheticPool({ config: MINTS.usdc }) } }), 'pool_config');
    assert.equal(reason({ pool: { owner: PROGRAMS.orcaWhirlpools, data: syntheticPool({ tick: 64 }) } }), 'pool_config');
    assert.equal(reason({ pool: { owner: PROGRAMS.orcaWhirlpools, data: syntheticPool({ mintA: MINTS.usdc, mintB: MINTS.wsol }) } }), 'pool_mints');
    assert.equal(reason({ pool: { owner: PROGRAMS.orcaWhirlpools, data: syntheticPool({ vaultB: VAULT_A }) } }), 'vaults_changed');
    assert.equal(reason({ pool: { owner: PROGRAMS.orcaWhirlpools, data: syntheticPool({ sqrt: 0n }) } }), 'zero_price');
    assert.equal(reason({ a: null }), 'vault_account');
    assert.equal(reason({ b: { owner: PROGRAMS.token2022, data: syntheticToken(MINTS.usdc, USDC_DEEP) } }), 'vault_account');
    assert.equal(reason({ a: { owner: PROGRAMS.splToken, data: syntheticToken(MINTS.usdc, SOL_DEEP) } }), 'vault_mismatch');
    assert.equal(reason({ b: { owner: PROGRAMS.splToken, data: syntheticToken(MINTS.usdc, USDC_DEEP, VAULT_A) } }), 'vault_mismatch');
    // Depth floor $1M a side: USDC side, then SOL side (6,000 SOL × $150 = $900k).
    assert.equal(reason({ b: { owner: PROGRAMS.splToken, data: syntheticToken(MINTS.usdc, 999_999_999_999n) } }), 'shallow');
    assert.equal(reason({ a: { owner: PROGRAMS.splToken, data: syntheticToken(MINTS.wsol, 6_000n * 1_000_000_000n) } }), 'shallow');
    const ok = run({});
    assert.ok(ok.ok && ok.solVaultLamports === SOL_DEEP && ok.usdcVaultE6 === USDC_DEEP);
  });

  it('the reader: one record a minute (a price, or `unavailable` with its reason — never a stale price); vaults learnt once; P3 reads only', async () => {
    let t = 1_790_000_000_000;
    const reads: Array<{ keys: readonly Pubkey[]; priority: number }> = [];
    let script: (keys: readonly Pubkey[]) => Awaited<ReturnType<ReferenceReader['read']>> = (keys) => ({
      ok: true, value: { contextSlot: 99n as Slot, accounts: keys.length === 1 ? [accounts()[0] as RawAccount] : accounts() },
    });
    const reader: ReferenceReader = { read: async (keys, o) => { reads.push({ keys, priority: o.priority }); return script(keys); } };
    const out: RefPriceRecord[] = [];
    const q = new RecorderQueue();
    const r = createSolUsdReader({ ids: IDS, reader, nowMs: () => t as UnixMs, append: (x) => { out.push(x); assert.equal(q.append(x), 'queued'); } });
    await r.tick(t as UnixMs);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.payload.kind, 'price');
    assert.equal(out[0]?.slot, 99n);
    assert.deepEqual(reads.map((x) => x.keys.length), [1, 3]);            // vaults learnt, then one 3-account read
    assert.ok(reads.every((x) => x.priority === 3));
    await r.tick((t + 59_999) as UnixMs);
    assert.equal(out.length, 1);                                          // not due
    t += 60_000;
    await r.tick(t as UnixMs);
    assert.deepEqual(reads.map((x) => x.keys.length), [1, 3, 3]);
    // A short answer and a shallow pool → unavailable for that minute; the vaults stay learnt.
    script = (keys) => ({ ok: true, value: { contextSlot: 98n as Slot, accounts: keys.length === 1 ? [accounts()[0] as RawAccount] : [] } });
    t += 60_000;
    await r.tick(t as UnixMs);
    assert.equal((out.at(-1)?.payload as { reason: string }).reason, 'pool_missing');
    script = (keys) => ({ ok: true, value: { contextSlot: 98n as Slot, accounts: keys.length === 1 ? [accounts()[0] as RawAccount]
      : accounts({ b: { owner: PROGRAMS.splToken, data: syntheticToken(MINTS.usdc, 1n) } }) } });
    t += 60_000;
    await r.tick(t as UnixMs);
    assert.equal((out.at(-1)?.payload as { reason: string }).reason, 'shallow');
    assert.equal(reads.filter((x) => x.keys.length === 1).length, 1);
    // A failed read → unavailable for that minute.
    script = () => ({ ok: false, error: { code: 'E_RATE_LIMITED' } });
    t += 60_000;
    await r.tick(t as UnixMs);
    assert.deepEqual(out.at(-1)?.payload, { kind: 'unavailable', pair: 'SOL/USD', pool: REFERENCE.solUsdcWhirlpool, reason: 'read:E_RATE_LIMITED' });
    // Vaults changed on chain → unavailable, then learnt again.
    script = (keys) => ({ ok: true, value: { contextSlot: 100n as Slot, accounts: keys.length === 1
      ? [{ owner: PROGRAMS.orcaWhirlpools, data: syntheticPool({ vaultA: VAULT_B, vaultB: VAULT_A }) }]
      : accounts({ pool: { owner: PROGRAMS.orcaWhirlpools, data: syntheticPool({ vaultA: VAULT_B, vaultB: VAULT_A }) } }) } });
    t += 60_000;
    await r.tick(t as UnixMs);
    assert.equal((out.at(-1)?.payload as { reason: string }).reason, 'vaults_changed');
    const before = reads.length;
    t += 60_000;
    await r.tick(t as UnixMs);
    assert.equal(reads[before]?.keys.length, 1);                          // learnt again
    // A pool that cannot be decoded at the learning read, or is missing, or the read fails there.
    for (const [acc, why] of [[null, 'pool_missing'], [{ owner: PROGRAMS.orcaWhirlpools, data: new Uint8Array(10) }, 'pool_layout'], [{ owner: PROGRAMS.splToken, data: syntheticPool() }, 'pool_layout']] as const) {
      const fresh = createSolUsdReader({ ids: IDS, reader: { read: async () => ({ ok: true, value: { contextSlot: 1n as Slot, accounts: [acc] } }) }, nowMs: () => t as UnixMs, append: (x) => out.push(x) });
      await fresh.tick(t as UnixMs);
      assert.equal((out.at(-1)?.payload as { reason: string }).reason, why);
    }
    const failing = createSolUsdReader({ ids: IDS, reader: { read: async () => ({ ok: false, error: { code: 'E_TIMEOUT' } }) }, nowMs: () => t as UnixMs, append: (x) => out.push(x) });
    await failing.tick(t as UnixMs);
    assert.equal((out.at(-1)?.payload as { reason: string }).reason, 'read:E_TIMEOUT');
    const throwing = createSolUsdReader({ ids: IDS, reader: { read: async () => { throw new Error('bug'); } }, nowMs: () => t as UnixMs, append: (x) => out.push(x) });
    await throwing.tick(t as UnixMs);
    assert.equal((out.at(-1)?.payload as { reason: string }).reason, 'internal_error');
    // One read at a time: a tick while a read is in flight does nothing.
    const waiting: Array<() => void> = [];
    let slowReads = 0;
    const slow = createSolUsdReader({ ids: IDS,
      reader: { read: async (keys) => { slowReads += 1; await new Promise<void>((res) => { waiting.push(res); }); return script(keys); } },
      nowMs: () => t as UnixMs, append: (x) => out.push(x),
    });
    const first = slow.tick(t as UnixMs);
    await slow.tick((t + 120_000) as UnixMs);
    assert.equal(slowReads, 1);
    while (slowReads < 2) { waiting.shift()?.(); await new Promise((res) => setImmediate(res)); }
    waiting.shift()?.();
    await first;
    assert.equal(q.take(1_000, 's').length, 7);                           // every record of the first reader serialised and queued
  });
});
