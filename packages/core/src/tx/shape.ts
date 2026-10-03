// The one supported-transaction-shape check (TX-1b). The builders refuse a trade outside it, and the hard reject H17
// rejects a candidate outside it before any entry is proposed, live and in the backtest. One rule in one place, so a
// coin can never pass eligibility and then be impossible to trade. If the builders and a gate ever differ, the gate
// tightens; the builders and the signer policy are never loosened to fit (docs/DECISIONS.md, TX-1b).
import { type Address, NATIVE_MINT, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM } from '../chain/index.ts';

/**
 * Token-2022 mint extensions the builders support: they add nothing to a holder's token account (so the ATA is
 * sized exactly) and change no amount. pump `create_v2` mints carry exactly these two. Every other extension, known
 * or not, is unsupported until a golden transaction proves it.
 */
export const SUPPORTED_MINT_EXTENSIONS: ReadonlySet<string> = new Set(['MetadataPointer', 'TokenMetadata']);

/** pump-swap-sdk `POOL_ACCOUNT_NEW_SIZE`: shorter pools need `extend_account` first, which the builders do not send. */
export const POOL_ACCOUNT_MIN_BYTES = 300;

/** Unset optional pubkeys in pump accounts read as the all-zero key. */
const DEFAULT_KEY = SYSTEM_PROGRAM;

/**
 * What a trade's transaction depends on. `undefined` is "not read": unknown is unsupported. Venue-specific fields are
 * required for their venue: `curveComplete` for the curve, `poolAccountBytes` for the pool (it decides the PumpSwap
 * account layout, our v1 instruction set's version requirement).
 */
export interface TradeShape {
  readonly venue: 'curve' | 'pool';
  /** The program that owns the mint account. */
  readonly mintProgram: string | undefined;
  /** Kinds of the mint's Token-2022 extensions (empty for SPL Token); unknown types as `unknown`. */
  readonly extensions: readonly string[] | undefined;
  /** The venue's quote mint. Curves written before the field existed are SOL-quoted, so the curve may leave it unset. */
  readonly quoteMint: string | undefined;
  readonly mayhem: boolean | undefined;
  /** Curves written before cashback existed carry no flag and are not cashback coins; a pool must state it. */
  readonly cashback: boolean | undefined;
  readonly coinCreator: string | undefined;
  readonly curveComplete?: boolean | undefined;
  readonly poolAccountBytes?: number | undefined;
}

export type ShapeRefusalReason = 'unsupported-venue' | 'unsupported-coin' | 'curve-complete' | 'not-sol-quoted' | 'missing-chain-field' | 'pool-layout-outdated' | 'unsupported-mint';
export type ShapeCheck = { readonly ok: true } | { readonly ok: false; readonly reason: ShapeRefusalReason; readonly detail: string };

const no = (reason: ShapeRefusalReason, detail: string): ShapeCheck => ({ ok: false, reason, detail });
const OK: ShapeCheck = { ok: true };

/** The mint program and its extensions, the same for both venues. */
const mintShape = (s: TradeShape): ShapeCheck => {
  if (s.mintProgram === undefined) return no('missing-chain-field', 'mint program is unread');
  if (s.mintProgram !== TOKEN_PROGRAM && s.mintProgram !== TOKEN_2022_PROGRAM) return no('unsupported-mint', 'base token program is not a token program');
  if (s.extensions === undefined) return no('missing-chain-field', 'mint extensions are unread');
  if (s.mintProgram === TOKEN_PROGRAM && s.extensions.length > 0) return no('unsupported-mint', 'an SPL Token mint has no extensions');
  const unsupported = s.extensions.filter((k) => !SUPPORTED_MINT_EXTENSIONS.has(k));
  return unsupported.length === 0 ? OK : no('unsupported-mint', `mint extension ${unsupported.join(', ')} is not supported`);
};

/** Checks one trade's shape against what the TX-1 builders support. Pure; the order of checks is fixed. */
export const checkShape = (s: TradeShape): ShapeCheck => {
  if (s.venue === 'curve') {
    if (s.curveComplete === undefined) return no('missing-chain-field', 'curve completion is unread');
    if (s.curveComplete) return no('curve-complete', 'the curve has completed; trade on the pool');
    if (s.mayhem !== false) return no('unsupported-coin', 'mayhem-mode coin (or the flag is unread)');
    if (s.cashback === true) return no('unsupported-coin', 'cashback coin');
    if (s.quoteMint !== undefined && s.quoteMint !== DEFAULT_KEY && s.quoteMint !== NATIVE_MINT) return no('not-sol-quoted', 'curve quote mint is not SOL');
    if (s.coinCreator === undefined) return no('missing-chain-field', 'curve creator is unread');
    return mintShape(s);
  }
  if (s.venue === 'pool') {
    if (s.quoteMint !== NATIVE_MINT) return no('not-sol-quoted', 'pool quote mint is not wrapped SOL (or it is unread)');
    if (s.poolAccountBytes === undefined) return no('missing-chain-field', 'pool account size is unread');
    if (s.poolAccountBytes < POOL_ACCOUNT_MIN_BYTES) return no('pool-layout-outdated', `pool account is ${s.poolAccountBytes} bytes; it needs extend_account first`);
    if (s.mayhem !== false) return no('unsupported-coin', 'mayhem-mode pool (or the flag is unread)');
    if (s.cashback !== false) return no('unsupported-coin', 'cashback pool (or the flag is unread)');
    if (s.coinCreator === undefined) return no('missing-chain-field', 'pool coin creator is unread');
    return mintShape(s);
  }
  return no('unsupported-venue', `venue ${String((s as { venue: unknown }).venue)} has no builder`);
};

/** Program owner of a decoded mint, as the builders' `Mint` names it. */
export const mintProgramOf = (program: 'spl-token' | 'token-2022'): Address => (program === 'spl-token' ? TOKEN_PROGRAM : TOKEN_2022_PROGRAM);
