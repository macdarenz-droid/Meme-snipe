// The PumpSwap pool model M04 polls through (card Z07): raw accounts in, `CpPoolState` out, and a fixed-size record
// codec for M04's ring buffer. M04 (`@bot/engine` m04) stays generic over this port, so venue layouts, decoding and
// normalisation stay in M01 (A-M01-04) and M02 (A-M02-02). Only PumpSwap pools are polled (D18; the curve is research).
// Pure apart from the injected decoder and fee snapshot.
import type { DecodedAccount } from '@bot/decoders';
import type { BaseUnits, Commitment, DecimalStr, Lamports, Pubkey, Result, Slot, UnixMs } from '@bot/types';
import type { RawAccount } from './cache.ts';
import { MINTS, PROGRAMS, pumpPoolAuthorityPda } from './constants.ts';
import { feeScheduleFor, type FeeInputs } from './fees.ts';
import { normalisePool } from './orientation.ts';
import type { CpPoolState } from './pool.ts';
import { spotSolPerToken } from './quote.ts';

/** What M04 learns from a pool account once: its vaults and token mint (they never change for a pool). */
export interface PoolAddresses { poolId: Pubkey; baseVault: Pubkey; quoteVault: Pubkey; tokenMint: Pubkey }
/**
 * Why a read gives no state: the pool account is gone (`E_CLOSED`, M04 publishes `pool.closed`); it, a vault or the
 * vault set changed hands (`E_OWNER_CHANGED`: quarantine and `pool.closed`); a vault is missing this cycle
 * (`E_PARTIAL`: skipped, `partial_read_total`); real + virtual is negative (`E_NEGATIVE_EFFECTIVE`: quarantine);
 * anything else (`E_LAYOUT`, `E_NOT_SOL_QUOTED`).
 */
export type PoolReadError = { code: 'E_CLOSED' | 'E_OWNER_CHANGED' | 'E_PARTIAL' | 'E_NEGATIVE_EFFECTIVE' | 'E_LAYOUT' | 'E_NOT_SOL_QUOTED'; detail: string };
export interface MintInfo { supply: BaseUnits; decimals: number }

/** One encoded snapshot of a pool's state is this many bytes (M04's ring buffer, A-M04-01 logic 6). */
export const POOL_RECORD_BYTES = 64;

export interface PoolModel {
  recordBytes: number;
  addresses(poolId: Pubkey, pool: RawAccount | null): Result<PoolAddresses, PoolReadError>;
  mint(raw: RawAccount | null): MintInfo | null;
  build(addr: PoolAddresses, accounts: { pool: RawAccount | null; baseVault: RawAccount | null; quoteVault: RawAccount | null }, mint: MintInfo,
    ctx: { asOfSlot: Slot; observedAtMs: UnixMs; canonicalCreator: Pubkey | null }): Result<CpPoolState, PoolReadError>;
  effectiveQuote(p: CpPoolState): Lamports;
  spot(p: CpPoolState): DecimalStr | null;
  /** The pool's per-side fee total now, or null when unknown (M04 then records 10,000: clarification C-08). */
  feeTotalBps(p: CpPoolState): number | null;
  encode(p: CpPoolState, out: Uint8Array, at: number): void;
  decode(addr: PoolAddresses, buf: Uint8Array, at: number): CpPoolState;
  /** A-M01-01: canonical when `pool.creator` is this PDA [EX-08]. */
  canonicalCreator(tokenMint: Pubkey): Promise<Pubkey>;
  /** The state's fields for M07's `pool_snapshot*` payloads: JSON values, big integers as decimal strings. */
  recordFields(p: CpPoolState): Record<string, string | number | boolean | null>;
}

const fail = (code: PoolReadError['code'], detail: string): { ok: false; error: PoolReadError } => ({ ok: false, error: { code, detail } });
const U64 = (1n << 64n) - 1n;
/** Tri-state flags in two bits: 0 null, 1 false, 2 true. */
const tri = (v: boolean | null): number => (v === null ? 0 : v ? 2 : 1);
const untri = (v: number): boolean | null => (v === 0 ? null : v === 2);

export function createPumpSwapPoolModel(deps: { decoder: { decodeAccount(owner: Pubkey, data: Uint8Array): DecodedAccount }; fees(): FeeInputs | null }): PoolModel {
  const token = (owner: Pubkey): boolean => owner === PROGRAMS.splToken || owner === PROGRAMS.token2022;
  const decodePool = (raw: RawAccount): Result<Extract<DecodedAccount, { kind: 'pumpswap_pool' }>, PoolReadError> => {
    if (raw.owner !== PROGRAMS.pumpSwap) return fail('E_OWNER_CHANGED', 'the pool account is not owned by PumpSwap');
    const d = deps.decoder.decodeAccount(raw.owner, raw.data);
    return d.kind === 'pumpswap_pool' ? { ok: true, value: d } : fail('E_LAYOUT', 'not a PumpSwap pool');
  };
  return {
    recordBytes: POOL_RECORD_BYTES,
    canonicalCreator: pumpPoolAuthorityPda,
    recordFields: (p) => ({
      baseReserve: p.baseReserve.toString(), quoteReserveReal: p.quoteReserveReal.toString(), quoteReserveVirtual: p.quoteReserveVirtual.toString(),
      baseMintSupply: p.baseMintSupply.toString(), asOfSlot: p.asOfSlot.toString(), isCanonical: p.isCanonical, coinCreatorSet: p.coinCreatorSet,
      creatorFeeBps: p.creatorFeeBps, isMayhemMode: p.isMayhemMode, baseDecimals: p.baseDecimals, swappedMints: p.swappedMints,
    }),
    addresses(poolId, raw) {
      if (raw === null) return fail('E_CLOSED', 'pool account missing');
      const p = decodePool(raw);
      if (!p.ok) return p;
      const { baseMint, quoteMint } = p.value;
      const tokenMint = quoteMint === MINTS.wsol && baseMint !== MINTS.wsol ? baseMint : baseMint === MINTS.wsol && quoteMint !== MINTS.wsol ? quoteMint : null;
      if (tokenMint === null) return fail('E_NOT_SOL_QUOTED', 'neither mint is wSOL, or both are');
      return { ok: true, value: { poolId, baseVault: p.value.baseVault, quoteVault: p.value.quoteVault, tokenMint } };
    },
    mint(raw) {
      if (raw === null || !token(raw.owner)) return null;
      const m = deps.decoder.decodeAccount(raw.owner, raw.data);
      return m.kind === 'spl_mint' ? { supply: m.supply, decimals: m.decimals } : null;
    },
    build(addr, accounts, mint, ctx) {
      if (accounts.pool === null) return fail('E_CLOSED', 'pool account missing');
      const p = decodePool(accounts.pool);
      if (!p.ok) return p;
      if (p.value.baseVault !== addr.baseVault || p.value.quoteVault !== addr.quoteVault) return fail('E_OWNER_CHANGED', 'the pool names other vaults');
      if (accounts.baseVault === null || accounts.quoteVault === null) return fail('E_PARTIAL', 'a vault is missing from this read');
      if (!token(accounts.baseVault.owner) || !token(accounts.quoteVault.owner)) return fail('E_OWNER_CHANGED', 'a vault is not a token account');
      const n = normalisePool('pumpswap', p.value, {
        baseVault: deps.decoder.decodeAccount(accounts.baseVault.owner, accounts.baseVault.data),
        quoteVault: deps.decoder.decodeAccount(accounts.quoteVault.owner, accounts.quoteVault.data),
      }, { address: addr.tokenMint, supplyBase: mint.supply, decimals: mint.decimals }, { poolId: addr.poolId, asOfSlot: ctx.asOfSlot, commitment: 'confirmed', observedAtMs: ctx.observedAtMs, canonicalCreator: ctx.canonicalCreator });
      // `normalisePool` for PumpSwap fails only on the mints (`E_NOT_SOL_QUOTED`) or a vault of another mint or owner.
      if (!n.ok) return fail(n.error.code === 'E_NOT_SOL_QUOTED' ? 'E_NOT_SOL_QUOTED' : 'E_OWNER_CHANGED', n.error.detail);
      if (n.value.quoteReserveReal + n.value.quoteReserveVirtual < 0n) return fail('E_NEGATIVE_EFFECTIVE', 'real + virtual quote reserve is negative');
      return n;
    },
    effectiveQuote: (p) => p.quoteReserveReal + p.quoteReserveVirtual,
    spot: (p) => (p.baseDecimals === null || p.baseReserve <= 0n ? null : spotSolPerToken(p.quoteReserveReal + p.quoteReserveVirtual, p.baseReserve, p.baseDecimals)),
    feeTotalBps(p) {
      const inputs = deps.fees();
      if (inputs === null) return null;
      const f = feeScheduleFor(p, inputs);
      return f.ok ? f.value.totalBps : null;
    },
    encode(p, out, at) {
      const v = new DataView(out.buffer, out.byteOffset + at, POOL_RECORD_BYTES);
      v.setBigUint64(0, p.baseReserve & U64, true);
      v.setBigUint64(8, p.quoteReserveReal & U64, true);
      v.setBigUint64(16, p.quoteReserveVirtual & U64, true);              // i128: low half, then the high half signed
      v.setBigInt64(24, p.quoteReserveVirtual >> 64n, true);
      v.setBigUint64(32, p.baseMintSupply & U64, true);
      v.setBigUint64(40, p.asOfSlot & U64, true);
      v.setFloat64(48, p.observedAtMs, true);
      v.setUint16(56, p.creatorFeeBps, true);
      v.setUint8(58, p.baseDecimals ?? 255);
      v.setUint8(59, tri(p.isCanonical) | (tri(p.coinCreatorSet) << 2) | (p.isMayhemMode ? 16 : 0) | (p.swappedMints ? 32 : 0));
    },
    decode(addr, buf, at) {
      const v = new DataView(buf.buffer, buf.byteOffset + at, POOL_RECORD_BYTES);
      const flags = v.getUint8(59);
      const swapped = (flags & 32) !== 0;
      const decimals = v.getUint8(58);
      return {
        venue: 'pumpswap', poolId: addr.poolId, baseMint: addr.tokenMint, quoteMint: MINTS.wsol,
        baseReserve: v.getBigUint64(0, true), quoteReserveReal: v.getBigUint64(8, true),
        quoteReserveVirtual: (v.getBigInt64(24, true) << 64n) | v.getBigUint64(16, true),
        baseMintSupply: v.getBigUint64(32, true), isCanonical: untri(flags & 3), curveComplete: null,
        asOfSlot: v.getBigUint64(40, true) as Slot, commitment: 'confirmed' as Commitment, observedAtMs: v.getFloat64(48, true) as UnixMs,
        coinCreatorSet: untri((flags >> 2) & 3), creatorFeeBps: v.getUint16(56, true), isMayhemMode: (flags & 16) !== 0,
        baseDecimals: decimals === 255 ? null : decimals, realBaseReserve: null, swappedMints: swapped,
      };
    },
  };
}
