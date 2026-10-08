// Account decoders (A-M02-02): pump bonding curve, PumpSwap pool, fee configs, PumpSwap global config, pump global,
// SPL Token / Token-2022 mints and token accounts. The owner is checked before dispatch, so an account of another
// program is never read as one of these. Every read is bounds-checked; anything that does not decode is `unknown`.
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62), review fixes C03-R1-4 (legacy curves on field boundaries) included.
import type { BaseUnits, Bps, Lamports, Pubkey } from '@bot/types';
import { base58, DecodeError, Reader, toHex } from './codec.ts';
import type { IdlTypeDef, PinnedIdl } from './idl.ts';

/** ARCH `DecodedAccount` with the C-03 variants; `pump_fee_config.raw` holds the stable and exotic tiers (logic 4). */
export type DecodedAccount =
  | { kind: 'pump_bonding_curve'; virtualQuote: Lamports; virtualToken: BaseUnits; realQuote: Lamports; realToken: BaseUnits;
      complete: boolean; quoteMint: null /* native SOL: a curve with another quote is unknown (Z03 m6, ruling 17) */; creator: Pubkey }
  | { kind: 'pumpswap_pool'; baseMint: Pubkey; quoteMint: Pubkey; creator: Pubkey; virtualQuoteReserves: bigint /* i128 */;
      baseVault: Pubkey; quoteVault: Pubkey; lpMint: Pubkey; lpSupply: bigint }
  | { kind: 'pump_fee_config'; tiers: Array<{ thresholdLamports: Lamports; lpBps: Bps; protocolBps: Bps; creatorBps: Bps }>;
      flat: { lpBps: Bps; protocolBps: Bps; creatorBps: Bps }; raw: Record<string, unknown> }
  | { kind: 'spl_token_account'; mint: Pubkey; owner: Pubkey; amount: BaseUnits; delegate: Pubkey | null; state: 'initialized' | 'frozen' }
  | { kind: 'pumpswap_global_config'; disableFlags: number; raw: Record<string, unknown> }
  | { kind: 'pump_global'; raw: Record<string, unknown> }
  | { kind: 'spl_mint'; tokenProgram: 'spl_token' | 'token_2022'; mintAuthority: Pubkey | null; supply: BaseUnits;
      decimals: number; isInitialized: boolean; freezeAuthority: Pubkey | null; extensionBytes: number }
  | { kind: 'raydium_cpmm_pool' | 'raydium_amm_v4_pool' | 'raydium_amm_config'; fields: Record<string, unknown> }
  | { kind: 'unknown'; owner: Pubkey; discriminatorHex: string };

/**
 * `layoutExtended`: non-zero bytes after the part the pinned IDL describes (zero bytes are allocated capacity, not
 * data); callers alert (`m02.layout_extended`). `shortLegacy`: a BondingCurve, pump Global or PumpSwap Pool written
 * before its trailing fields were added, read with those fields as 0 / false / Pubkey::default() [DA-15, DA-V01; card
 * IDL-REPIN for Global and Pool].
 */
export interface DecodeFlags { layoutExtended: boolean; shortLegacy: boolean }

// SPL Token layouts. VERIFY (U-A08): solana-program/token interface/src/state.rs at
// 8185db13640f0df038266c7cf4306c212d81380a (file last changed in e1400276bbc590df1aaff6470c43e37a1e40c5cd), read
// 2026-10-07. Mint (82 bytes): mint_authority COption<Pubkey> (u32 tag 0 or 1, then 32 bytes), supply u64 at 36,
// decimals u8 at 44, is_initialized u8 at 45 (0 or 1), freeze_authority COption<Pubkey> at 46. Account (165 bytes):
// mint 0, owner 32, amount u64 64, delegate COption<Pubkey> 72, state u8 108 (0 uninitialized, 1 initialized,
// 2 frozen), is_native COption<u64> 109, delegated_amount u64 121, close_authority COption<Pubkey> 129. A tag other
// than 0 or 1 is invalid account data. Multisig accounts are 355 bytes.
// Token-2022 extended accounts. VERIFY: solana-program/token-2022 interface/src/extension/mod.rs at
// 1436a91674fb3679e6473661f5f1e6a6b41f093d (2026-10-07): an account with extensions is longer than 165 bytes and has
// its AccountType at byte 165 (1 = Mint, 2 = Account); a mint's bytes 82-164 are zero padding.
export const MINT_LEN = 82;
export const TOKEN_ACCOUNT_LEN = 165;
const MULTISIG_LEN = 355;
const ACCOUNT_TYPE_INDEX = 165;
const ACCOUNT_TYPE_MINT = 1;
const ACCOUNT_TYPE_ACCOUNT = 2;

/** Minimum BondingCurve: discriminator and the fields through `complete` (8 + 5 × 8 + 1 bytes). */
export const CURVE_MIN_LEN = 49;
const MAX_BPS = 10_000;
const U64_MAX = 2n ** 64n - 1n;

export interface TokenPrograms { splToken: Pubkey; token2022: Pubkey }

function coptionKey(r: Reader): Pubkey | null {
  const tag = r.u32();
  const key = r.pubkey();
  if (tag > 1) throw new DecodeError('E_BAD_VALUE', 'a COption tag is 0 or 1');
  return tag === 1 ? key : null;
}

function decodeMint(data: Uint8Array, tokenProgram: 'spl_token' | 'token_2022'): DecodedAccount {
  const r = new Reader(data);
  const mintAuthority = coptionKey(r);
  const supply = r.u64();
  const decimals = r.u8();
  const isInitialized = r.bool();
  const freezeAuthority = coptionKey(r);
  // Z03 ruling m10: an uninitialized mint is not a mint yet.
  if (!isInitialized) throw new DecodeError('E_BAD_VALUE', 'mint not initialized');
  return { kind: 'spl_mint', tokenProgram, mintAuthority, supply, decimals, isInitialized, freezeAuthority, extensionBytes: data.length - MINT_LEN };
}

function decodeTokenAccount(data: Uint8Array, owner: Pubkey): DecodedAccount {
  const r = new Reader(data);
  const mint = r.pubkey();
  const holder = r.pubkey();
  const amount = r.u64();
  const delegate = coptionKey(r);
  const state = r.u8();
  if (state !== 1 && state !== 2) return { kind: 'unknown', owner, discriminatorHex: '' };
  return { kind: 'spl_token_account', mint, owner: holder, amount, delegate, state: state === 1 ? 'initialized' : 'frozen' };
}

/** Length-based dispatch for the token programs (logic 1, 5, 6), with Token-2022's AccountType for longer accounts. */
function decodeToken(owner: Pubkey, data: Uint8Array, t22: boolean): DecodedAccount {
  const program = t22 ? 'token_2022' : 'spl_token';
  if (data.length === MINT_LEN) return decodeMint(data, program);
  if (data.length === TOKEN_ACCOUNT_LEN) return decodeTokenAccount(data, owner);
  if (t22 && data.length > ACCOUNT_TYPE_INDEX && data.length !== MULTISIG_LEN) {
    const type = data[ACCOUNT_TYPE_INDEX];
    if (type === ACCOUNT_TYPE_MINT && data.subarray(MINT_LEN, ACCOUNT_TYPE_INDEX).every((b) => b === 0)) return decodeMint(data, program);
    if (type === ACCOUNT_TYPE_ACCOUNT) return decodeTokenAccount(data, owner);
  }
  return { kind: 'unknown', owner, discriminatorHex: '' };
}

const bps = (v: unknown): Bps => {
  if (typeof v !== 'bigint' || v > BigInt(MAX_BPS)) throw new DecodeError('E_BAD_VALUE', 'a fee is at most 10,000 bps');
  return Number(v);
};
const fees = (f: unknown): { lpBps: Bps; protocolBps: Bps; creatorBps: Bps } => {
  const x = f as { lp_fee_bps: bigint; protocol_fee_bps: bigint; creator_fee_bps: bigint };
  const out = { lpBps: bps(x.lp_fee_bps), protocolBps: bps(x.protocol_fee_bps), creatorBps: bps(x.creator_fee_bps) };
  // Z03 ruling m10: one tier's fees add up to at most 10,000 bps, or the account is `unknown`.
  if (out.lpBps + out.protocolBps + out.creatorBps > MAX_BPS) throw new DecodeError('E_BAD_VALUE', 'fees add up to more than 10,000 bps');
  return out;
};

/** `Pubkey::default()`; as a curve's `quote_mint` it means native SOL [DA-V01] and becomes null (Z03 m6). */
const DEFAULT_PUBKEY = base58.encode(new Uint8Array(32));

/** Thrown for a curve whose quote is not native SOL (Z03 ruling 17); the account is `unknown`, counted `non_sol_quote`. */
class NonSolQuote extends Error {}

/** Maps a decoded Anchor struct to its variant; null for a type that has none (decoded as `unknown`). */
function variant(def: IdlTypeDef, idl: PinnedIdl['name'], v: Record<string, unknown>): DecodedAccount | null {
  const key = `${idl}.${def.name}`;
  if (key === 'pump.BondingCurve') {
    // Z03 ruling 17 (ruling 3 for accounts): the reserves are Lamports only on a SOL curve.
    if (v.quote_mint !== DEFAULT_PUBKEY) throw new NonSolQuote();
    return {
      kind: 'pump_bonding_curve', virtualQuote: v.virtual_quote_reserves as bigint, virtualToken: v.virtual_token_reserves as bigint,
      realQuote: v.real_quote_reserves as bigint, realToken: v.real_token_reserves as bigint, complete: v.complete as boolean,
      quoteMint: null, creator: v.creator as Pubkey,
    };
  }
  if (key === 'pump.Global') return { kind: 'pump_global', raw: v };
  if (key === 'pump_amm.Pool') {
    return {
      kind: 'pumpswap_pool', baseMint: v.base_mint as Pubkey, quoteMint: v.quote_mint as Pubkey, creator: v.creator as Pubkey,
      virtualQuoteReserves: v.virtual_quote_reserves as bigint, baseVault: v.pool_base_token_account as Pubkey,
      quoteVault: v.pool_quote_token_account as Pubkey, lpMint: v.lp_mint as Pubkey, lpSupply: v.lp_supply as bigint,
    };
  }
  if (key === 'pump_amm.GlobalConfig') return { kind: 'pumpswap_global_config', disableFlags: v.disable_flags as number, raw: v };
  if (key === 'pump_fees.FeeConfig') {
    const tiers = (v.fee_tiers as Array<{ market_cap_lamports_threshold: bigint; fees: unknown }>).map((t) => {
      if (t.market_cap_lamports_threshold > U64_MAX) throw new DecodeError('E_BAD_VALUE', 'a tier threshold above u64');
      return { thresholdLamports: t.market_cap_lamports_threshold, ...fees(t.fees) };
    });
    return { kind: 'pump_fee_config', tiers, flat: fees(v.flat_fees), raw: v };
  }
  return null;
}

const NO_FLAGS: Readonly<DecodeFlags> = Object.freeze({ layoutExtended: false, shortLegacy: false });

/**
 * POLICY (card IDL-REPIN): the last field each padded type had at the previous pin cb188ce. pump-public-docs 8cda1fa
 * appends fields to all three (BondingCurve: `creator_fee` to `post_complete_quote_in`; Global: `max_curve_depth`;
 * Pool: `protocol_fees`, `creator_fees`) and says accounts written before are shorter and read the missing trailing
 * fields as 0 (docs/PUMP_PROGRAM_README.md "Fields appended to `BondingCurve`", docs/PUMP_SWAP_README.md "Pools written
 * before an appended field existed", docs/instructions/SWEEP_FEES.md "Account layout"; `extend_account` grows `Global`
 * "to allow adding new fields to the existing account types"). From that field's end on, an account is padded when it
 * ends on a field boundary, or when its bytes past the last boundary are all zero (allocated capacity under the
 * previous pin, never data), so every account the previous pin decoded still decodes, with the new fields as 0.
 * Shorter Global and Pool accounts stay `unknown`, as under the previous pin.
 */
const PADDED_FROM: Readonly<Record<string, string>> = {
  'pump.BondingCurve': 'is_holder_reward', 'pump.Global': 'is_holder_reward_enabled', 'pump_amm.Pool': 'is_holder_reward',
};
const fieldEndsOf = new WeakMap<IdlTypeDef, readonly number[]>();
/** Zero bytes read to measure a padded type's field ends: more than its full size (Global is 1,080 bytes at 8cda1fa). */
const FIELD_ENDS_PROBE = 8_192;

/**
 * Body offsets at which each field of a struct of fixed-size fields (BondingCurve, Global, Pool) ends, measured once by
 * reading zero bytes; the last one is the full size. A legacy account ends on one of these boundaries.
 */
function fieldEnds(def: IdlTypeDef): readonly number[] {
  let ends = fieldEndsOf.get(def);
  if (ends === undefined) {
    const r = new Reader(new Uint8Array(FIELD_ENDS_PROBE));
    ends = def.fields.map((f) => { f.read(r); return r.offset(); });
    fieldEndsOf.set(def, ends);
  }
  return ends;
}

/** Decodes an Anchor account of a pinned program (logic 1-4, 7). Anything that does not decode is `unknown`. */
function decodeAnchor(owner: Pubkey, data: Uint8Array, idl: PinnedIdl): { account: DecodedAccount; flags: DecodeFlags; nonSolQuote?: true } {
  const disc = data.length >= 8 ? toHex(data.subarray(0, 8)) : '';
  const unknown = { account: { kind: 'unknown', owner, discriminatorHex: disc } as DecodedAccount, flags: { ...NO_FLAGS } };
  const def = idl.accounts.get(disc);
  if (def === undefined) return unknown;
  let body = data.subarray(8);
  let shortLegacy = false;
  const isCurve = idl.name === 'pump' && def.name === 'BondingCurve';
  const paddedFrom = PADDED_FROM[`${idl.name}.${def.name}`];
  if (isCurve && data.length < CURVE_MIN_LEN) return unknown;
  if (paddedFrom !== undefined) {
    // Short legacy account: read as if the missing trailing fields were zero [DA-15, DA-V01]. Below the previous pin's
    // end, a real legacy curve ends on a field boundary of the pinned layout (49, 81, 82, 83, 115, 123 or 124 bytes);
    // any other short length would build a field from real and zero bytes, so it is `unknown` (review C03-R1-4).
    const ends = fieldEnds(def);
    const full = ends[ends.length - 1] as number;
    const at = def.fields.findIndex((f) => f.name === paddedFrom);
    if (at < 0) return unknown;                                   // the pinned layout lost the field: never guess
    const floor = ends[at] as number;
    if (body.length < full) {
      const below = body.length < floor;
      if (below && !isCurve) return unknown;
      if (!ends.includes(body.length)) {
        const last = Math.max(...ends.filter((e) => e < body.length));
        if (below || body.subarray(last).some((b) => b !== 0)) return unknown;
      }
      shortLegacy = true;
      const padded = new Uint8Array(full);
      padded.set(body);
      body = padded;
    }
  }
  try {
    const r = new Reader(body);
    const value = def.read(r) as Record<string, unknown>;
    const account = variant(def, idl.name, value);
    if (account === null) return unknown;
    const layoutExtended = data.subarray(Math.min(8 + r.offset(), data.length)).some((b) => b !== 0);
    return { account, flags: { layoutExtended, shortLegacy } };
  } catch (e) {
    return e instanceof NonSolQuote ? { ...unknown, nonSolQuote: true } : unknown;   // E_SHORT, E_BAD_VALUE: fail closed
  }
}

export interface AccountDecoder {
  decodeAccount(owner: Pubkey, data: Uint8Array): DecodedAccount;
  decodeAccountWithFlags(owner: Pubkey, data: Uint8Array): { account: DecodedAccount; flags: DecodeFlags };
}

export function createAccountDecoder(idls: readonly PinnedIdl[], tokenPrograms: TokenPrograms | undefined,
  count?: (kind: DecodedAccount['kind'], result: 'ok' | 'unknown' | 'non_sol_quote') => void): AccountDecoder {
  const byProgram = new Map(idls.map((i) => [i.program, i]));
  const withFlags = (owner: Pubkey, data: Uint8Array): { account: DecodedAccount; flags: DecodeFlags } => {
    const idl = byProgram.get(owner);
    let out: { account: DecodedAccount; flags: DecodeFlags; nonSolQuote?: true };
    if (idl !== undefined) {
      out = decodeAnchor(owner, data, idl);
      // Z03 ruling 17: counted as decode_accounts_total{kind="pump_bonding_curve",result="non_sol_quote"}.
      if (out.nonSolQuote === true) {
        count?.('pump_bonding_curve', 'non_sol_quote');
        return { account: out.account, flags: out.flags };
      }
    } else if (tokenPrograms !== undefined && (owner === tokenPrograms.splToken || owner === tokenPrograms.token2022)) {
      let account: DecodedAccount;
      try {
        account = decodeToken(owner, data, owner === tokenPrograms.token2022);
      } catch {
        account = { kind: 'unknown', owner, discriminatorHex: '' };
      }
      out = { account, flags: { ...NO_FLAGS } };
    } else {
      out = { account: { kind: 'unknown', owner, discriminatorHex: data.length >= 8 ? toHex(data.subarray(0, 8)) : '' }, flags: { ...NO_FLAGS } };
    }
    count?.(out.account.kind, out.account.kind === 'unknown' ? 'unknown' : 'ok');
    return out;
  };
  return {
    decodeAccountWithFlags: withFlags,
    decodeAccount: (owner, data) => withFlags(owner, data).account,
  };
}
