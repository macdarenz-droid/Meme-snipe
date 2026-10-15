// SOL/USD once a minute from a deep on-chain SOL/USDC pool (card Z08, supervisor 2026-10-07; rulings Z08-7 and Z08-8).
// The pool is the Orca Whirlpool wSOL/USDC with tick spacing 4 (`REFERENCE.solUsdcWhirlpool`, @bot/venue/constants,
// with its sources; the addresses are injected as `ReferenceIds`). Profit is counted in SOL (CLAUDE.md "Profit is counted in SOL"): this price is a secondary display
// and a research input only, never a gain, a loss or a limit.
//
// Layout (orca-so/whirlpools programs/whirlpool/src/state/whirlpool.rs at cc683ec92acb5e7606caa3d8e514d9383e9c7c11,
// read 2026-10-15): 8-byte discriminator `account:Whirlpool` = 3f95d10ce1806309, then whirlpools_config 32 @8,
// whirlpool_bump 1 @40, tick_spacing u16 @41, fee_tier_index_seed 2 @43, fee_rate u16 @45, protocol_fee_rate u16 @47,
// liquidity u128 @49, sqrt_price u128 @65, tick_current_index i32 @81, protocol_fee_owed_a/b u64 @85/@93,
// token_mint_a @101, token_vault_a @133, fee_growth_global_a u128 @165, token_mint_b @181, token_vault_b @213,
// fee_growth_global_b u128 @245, reward_last_updated_timestamp u64 @261, reward_infos 384 @269; LEN 653.
// SPL token account [VF-07]: mint @0, owner @32, amount u64 @64, 165 bytes.
//
// Price: sqrt_price is Q64.64 of √(raw B per raw A) = √(micro-USDC per lamport); USD per SOL in micro-dollars is
// floor(sqrt_price² × 10^9 / 2^128) (× 10^(9−6) for the decimals, × 10^6 for micro). Exact bigint maths.
//
// Protection (ruling Z08-7): every read checks the pool's owner program, discriminator, config, mints and vaults, the
// vaults' owner program, mint and authority (the pool), and a depth floor of $1M on each side
// (`ref_price.min_depth_usd_e6`); any failure writes an `unavailable` record for that minute, never a stale price.
import type { Pubkey, Slot, UnixMs } from '@bot/types';

/**
 * The addresses the checks compare with, passed in by the composition root from `@bot/venue/constants` (`REFERENCE`,
 * `MINTS`, `PROGRAMS`: the one reviewed file of addresses), and the base58 encoder of `@bot/decoders`.
 */
export interface ReferenceIds {
  whirlpoolProgram: Pubkey; whirlpoolsConfig: Pubkey; pool: Pubkey; wsol: Pubkey; usdc: Pubkey; splToken: Pubkey;
  encodeKey: (bytes: Uint8Array) => Pubkey;
}

export const WHIRLPOOL_DISCRIMINATOR = Uint8Array.from([0x3f, 0x95, 0xd1, 0x0c, 0xe1, 0x80, 0x63, 0x09]);
export const WHIRLPOOL_LEN = 653;
export const TOKEN_ACCOUNT_LEN = 165;
export const READ_EVERY_MS = 60_000;
/** $1,000,000 in micro-dollars: the depth floor on each side (ruling Z08-7). */
export const MIN_DEPTH_USD_E6 = 1_000_000_000_000n;
const Q128 = 1n << 128n;

const u64At = (d: Uint8Array, at: number): bigint => {
  let v = 0n;
  for (let i = 7; i >= 0; i -= 1) v = (v << 8n) | BigInt(d[at + i] as number);
  return v;
};
const u128At = (d: Uint8Array, at: number): bigint => (u64At(d, at + 8) << 64n) | u64At(d, at);

export interface Whirlpool { config: Pubkey; tickSpacing: number; sqrtPriceX64: bigint; mintA: Pubkey; vaultA: Pubkey; mintB: Pubkey; vaultB: Pubkey }

export function decodeWhirlpool(data: Uint8Array, ids: Pick<ReferenceIds, 'encodeKey'>): Whirlpool | null {
  const keyAt = (d: Uint8Array, at: number): Pubkey => ids.encodeKey(d.subarray(at, at + 32));
  if (data.length < WHIRLPOOL_LEN) return null;
  for (let i = 0; i < 8; i += 1) if (data[i] !== WHIRLPOOL_DISCRIMINATOR[i]) return null;
  return {
    config: keyAt(data, 8), tickSpacing: (data[41] as number) | ((data[42] as number) << 8), sqrtPriceX64: u128At(data, 65),
    mintA: keyAt(data, 101), vaultA: keyAt(data, 133), mintB: keyAt(data, 181), vaultB: keyAt(data, 213),
  };
}

export interface TokenAccount { mint: Pubkey; authority: Pubkey; amount: bigint }
export function decodeTokenAccount(data: Uint8Array, ids: Pick<ReferenceIds, 'encodeKey'>): TokenAccount | null {
  const keyAt = (d: Uint8Array, at: number): Pubkey => ids.encodeKey(d.subarray(at, at + 32));
  if (data.length < TOKEN_ACCOUNT_LEN) return null;
  return { mint: keyAt(data, 0), authority: keyAt(data, 32), amount: u64At(data, 64) };
}

/** USD per SOL in micro-dollars from the pool's sqrt price. */
export const usdE6PerSol = (sqrtPriceX64: bigint): bigint => (sqrtPriceX64 * sqrtPriceX64 * 1_000_000_000n) / Q128;

export interface RawAccount { owner: Pubkey; data: Uint8Array }
export type PriceCheck =
  | { ok: true; usdE6PerSol: bigint; sqrtPriceX64: bigint; solVaultLamports: bigint; usdcVaultE6: bigint }
  | { ok: false; reason: string };

/** Checks one read of [pool, vaultA, vaultB] and prices it (pure). */
export function priceOf(ids: ReferenceIds, pool: RawAccount | null, vaultA: RawAccount | null, vaultB: RawAccount | null, expectVaults: { a: Pubkey; b: Pubkey }, minDepthUsdE6: bigint): PriceCheck {
  if (pool === null) return { ok: false, reason: 'pool_missing' };
  if (pool.owner !== ids.whirlpoolProgram) return { ok: false, reason: 'pool_owner' };
  const w = decodeWhirlpool(pool.data, ids);
  if (w === null) return { ok: false, reason: 'pool_layout' };
  if (w.config !== ids.whirlpoolsConfig || w.tickSpacing !== 4) return { ok: false, reason: 'pool_config' };
  if (w.mintA !== ids.wsol || w.mintB !== ids.usdc) return { ok: false, reason: 'pool_mints' };
  if (w.vaultA !== expectVaults.a || w.vaultB !== expectVaults.b) return { ok: false, reason: 'vaults_changed' };
  if (w.sqrtPriceX64 === 0n) return { ok: false, reason: 'zero_price' };
  const va = vaultA === null || vaultA.owner !== ids.splToken ? null : decodeTokenAccount(vaultA.data, ids);
  const vb = vaultB === null || vaultB.owner !== ids.splToken ? null : decodeTokenAccount(vaultB.data, ids);
  if (va === null || vb === null) return { ok: false, reason: 'vault_account' };
  if (va.mint !== ids.wsol || vb.mint !== ids.usdc || va.authority !== ids.pool || vb.authority !== ids.pool) {
    return { ok: false, reason: 'vault_mismatch' };
  }
  const price = usdE6PerSol(w.sqrtPriceX64);
  if (vb.amount < minDepthUsdE6 || (va.amount * price) / 1_000_000_000n < minDepthUsdE6) return { ok: false, reason: 'shallow' };
  return { ok: true, usdE6PerSol: price, sqrtPriceX64: w.sqrtPriceX64, solVaultLamports: va.amount, usdcVaultE6: vb.amount };
}

/** The `ref_price` record payload (public market data; ruling Z08-8). Amounts are decimal strings. */
export type RefPricePayload =
  | { kind: 'price'; pair: 'SOL/USD'; pool: Pubkey; usdE6PerSol: string; sqrtPriceX64: string; solVaultLamports: string; usdcVaultE6: string }
  | { kind: 'unavailable'; pair: 'SOL/USD'; pool: Pubkey; reason: string };

export interface RefPriceRecord { stream: 'ref_price'; recvMs: UnixMs; slot: Slot | null; commitment: 'confirmed'; source: 'm07'; payload: RefPricePayload }

export interface ReferenceReader {
  read(keys: readonly Pubkey[], o: { priority: 0 | 1 | 2 | 3 | 4 }): Promise<{ ok: true; value: { contextSlot: Slot; accounts: ReadonlyArray<RawAccount | null> } } | { ok: false; error: { code: string } }>;
}

/**
 * One read a minute at P3 (unmetered primary only; refused in degraded mode, A-M14-02), one record a minute. The vaults
 * are learnt from the pool once (one extra read at start or after they change), then each minute reads
 * [pool, vaultA, vaultB] in one getMultipleAccounts.
 */
export function createSolUsdReader(o: {
  ids: ReferenceIds; reader: ReferenceReader; append: (r: RefPriceRecord) => void; nowMs: () => UnixMs; minDepthUsdE6?: bigint; everyMs?: number;
}): { tick(nowMs: UnixMs): Promise<void> } {
  const pool = o.ids.pool;
  const every = o.everyMs ?? READ_EVERY_MS;
  const floor = o.minDepthUsdE6 ?? MIN_DEPTH_USD_E6;
  let vaults: { a: Pubkey; b: Pubkey } | null = null;
  let lastRun: number | null = null;
  let busy = false;
  const record = (payload: RefPricePayload, slot: Slot | null): void => {
    o.append({ stream: 'ref_price', recvMs: o.nowMs(), slot, commitment: 'confirmed', source: 'm07', payload });
  };
  const unavailable = (reason: string, slot: Slot | null = null): void => record({ kind: 'unavailable', pair: 'SOL/USD', pool, reason }, slot);
  const run = async (): Promise<void> => {
    if (vaults === null) {
      const r = await o.reader.read([pool], { priority: 3 });
      if (!r.ok) return unavailable(`read:${r.error.code}`);
      const acc = r.value.accounts[0] ?? null;
      const w = acc === null || acc.owner !== o.ids.whirlpoolProgram ? null : decodeWhirlpool(acc.data, o.ids);
      if (w === null) return unavailable(acc === null ? 'pool_missing' : 'pool_layout', r.value.contextSlot);
      vaults = { a: w.vaultA, b: w.vaultB };
    }
    const v = vaults;
    const r = await o.reader.read([pool, v.a, v.b], { priority: 3 });
    if (!r.ok) return unavailable(`read:${r.error.code}`);
    const [p, a, b] = [r.value.accounts[0] ?? null, r.value.accounts[1] ?? null, r.value.accounts[2] ?? null];
    const c = priceOf(o.ids, p, a, b, v, floor);
    if (!c.ok) {
      if (c.reason === 'vaults_changed') vaults = null;                  // learnt again next minute
      return unavailable(c.reason, r.value.contextSlot);
    }
    record({
      kind: 'price', pair: 'SOL/USD', pool, usdE6PerSol: c.usdE6PerSol.toString(), sqrtPriceX64: c.sqrtPriceX64.toString(),
      solVaultLamports: c.solVaultLamports.toString(), usdcVaultE6: c.usdcVaultE6.toString(),
    }, r.value.contextSlot);
  };
  return {
    async tick(nowMs: UnixMs): Promise<void> {
      if (busy || (lastRun !== null && nowMs - lastRun < every && nowMs >= lastRun)) return;
      busy = true;
      lastRun = nowMs;
      try {
        await run();
      } catch {
        unavailable('internal_error');
      } finally {
        busy = false;
      }
    },
  };
}
