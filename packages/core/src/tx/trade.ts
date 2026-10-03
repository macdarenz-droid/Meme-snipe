// Unsigned entry and exit transactions: compute budget, account setup, the swap, account cleanup and the Sender tip,
// compiled to v0. Pure: no network, no signing, no clock. Every amount comes from the inputs (the CORE-2 quote, the
// execution policy, rent and fee rates read live); nothing has a default.
import { type Address, type Mint, NATIVE_MINT, PUMP_AMM_PROGRAM, PUMP_PROGRAM, TOKEN_PROGRAM } from '../chain/index.ts';
import type { QuoteContext } from '../domain/index.ts';
import { BPS_DENOMINATOR, type Bps, type Lamports, bps } from '../units/index.ts';
import { type CuCalibration, type TxShape } from './calibration.ts';
import { type CompiledMessage, type LookupTableInput, compileV0 } from './compile.ts';
import type { Instruction } from './instruction.ts';
import { closeAccount, createAssociatedTokenIdempotent, setComputeUnitLimit, setComputeUnitPrice, syncNative, transfer } from './native.ts';
import { JITO_DONT_FRONT, associatedTokenAddress, poolCoinCreatorVaultAuthority, pumpCreatorVault, userVolumeAccumulator } from './programs.ts';
import { type RentRate, USER_VOLUME_ACCUMULATOR_SIZE, associatedTokenAccountSize, rentExempt, TOKEN_ACCOUNT_SIZE } from './rent.ts';
import { type TradeShape, checkShape } from './shape.ts';
import {
  type CurveMarket,
  type PoolMarket,
  type Refusal,
  curveAccounts,
  curveShape,
  curveBuyIx,
  curveSellIx,
  poolAccounts,
  poolBuyIx,
  poolSellIx,
  poolShape,
  refuse,
} from './venues.ts';

/** Micro-lamports per lamport: compute-unit prices are quoted in micro-lamports per unit. */
export const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;
/**
 * Data length pump grows an old bonding curve to on a trade, at the trader's expense. pump BUY.md (pinned) says 115;
 * pump-sdk 2.0.0 extends curves to 151 (`BONDING_CURVE_NEW_SIZE`). The larger is used so the worst case never
 * undercounts.
 */
export const BONDING_CURVE_TARGET_BYTES = 151;

/**
 * Execution limits. Configuration, never constants (CLAUDE.md "capital and trade size scale"): the worker loads
 * them with the session's policy, and only the owner raises them.
 */
export interface ExecutionPolicy {
  /** Highest slippage any request may use (entries 2–3% per §10; exit rungs set their own within this). */
  readonly maxSlippageBps: number;
  /** Ceiling on one transaction's priority fee, in lamports (§10: about 50k for entries; the ladder cap for exits). */
  readonly maxPriorityFeeLamports: Lamports;
  /** The Sender SWQoS-only tip paid on every transaction (5,000 lamports on 2026-10-03, execution.md F9). */
  readonly tipLamports: Lamports;
  /** Ceiling on the tip; a path that needs more is rejected (§10: never a 0.001 SOL flat tip). */
  readonly maxTipLamports: Lamports;
  /** Allowed Sender tip accounts, read at startup. */
  readonly tipAccounts: readonly Address[];
  /** Add the jitodontfront read-only marker (§10). */
  readonly jitoDontFront: boolean;
  readonly calibration: CuCalibration;
}

/** Chain rates read live for this build. */
export interface ChainRates {
  readonly rent: RentRate;
  /** Base fee per signature (5,000 lamports today), from getFeeForMessage or the fee calculator. */
  readonly lamportsPerSignature: Lamports;
}

export interface BuildCommon {
  /** The bot wallet: fee payer and only signer. */
  readonly wallet: Address;
  readonly recentBlockhash: Address;
  /** Block height after which this blockhash can never land (from getLatestBlockhash at `confirmed`). */
  readonly lastValidBlockHeight: bigint;
  readonly slippageBps: number;
  /** Total priority fee for this transaction, chosen by the fee policy (entry cap or exit ladder rung). */
  readonly priorityFeeLamports: Lamports;
  /** Seeded choices, so a replay builds identical bytes. */
  readonly choice: { readonly feeRecipient: number; readonly buybackRecipient: number; readonly tipAccount: number };
  readonly rates: ChainRates;
  /**
   * Accounts read on chain as already existing (with enough lamports). Every account the swap may create or top up
   * at the wallet's expense that is NOT listed here is charged at full rent in the worst-case SOL accounting.
   */
  readonly existing: ReadonlySet<Address>;
  readonly lookupTables: readonly LookupTableInput[];
  /** Slot the CORE-2 quote was computed at, for the lifecycle's QuoteContext. */
  readonly quotedAtSlot: bigint | null;
}

/**
 * What the CORE-2 quote for this trade promised. Structural, so the CORE-2 trade fits once unwrapped. Buys carry the
 * spend the quote was computed for: it must equal the request's spend, so min-out is never sized for a smaller trade.
 */
export type CurveBuyQuote = { readonly spend: bigint; readonly tokens: bigint; readonly userQuote: bigint };
export type CurveSellQuote = { readonly tokens: bigint; readonly userQuote: bigint };
export type PoolBuyQuote = { readonly spend: bigint; readonly base: bigint; readonly userQuote: bigint };
export type PoolSellQuote = { readonly base: bigint; readonly userQuote: bigint };

export type TradeRequest =
  | { readonly venue: 'curve'; readonly side: 'buy'; readonly market: CurveMarket; readonly mint: Mint; readonly spend: Lamports; readonly quote: CurveBuyQuote }
  | { readonly venue: 'curve'; readonly side: 'sell'; readonly market: CurveMarket; readonly mint: Mint; readonly quote: CurveSellQuote; readonly closeTokenAccount: boolean }
  | { readonly venue: 'pool'; readonly side: 'buy'; readonly market: PoolMarket; readonly mint: Mint; readonly spend: Lamports; readonly quote: PoolBuyQuote }
  | { readonly venue: 'pool'; readonly side: 'sell'; readonly market: PoolMarket; readonly mint: Mint; readonly quote: PoolSellQuote; readonly closeTokenAccount: boolean };

/** Worst-case lamports leaving the wallet, itemised. Rent created and closed inside the transaction nets to zero. */
export interface SolOut {
  readonly baseFee: bigint;
  readonly priorityFee: bigint;
  readonly tip: bigint;
  /** SOL paid into the swap (buys: the full spend; sells: 0). */
  readonly swap: bigint;
  /** Rent and top-ups for accounts the transaction may create and does not close. */
  readonly rent: bigint;
  readonly total: bigint;
}

export interface BuiltTransaction {
  readonly shape: TxShape;
  readonly instructions: readonly Instruction[];
  readonly compiled: CompiledMessage;
  readonly computeUnitLimit: number;
  readonly computeUnitPriceMicroLamports: bigint;
  /** ceil(price × limit / 10^6): what the network bills, at most the requested priority fee. */
  readonly priorityFee: bigint;
  readonly solOut: SolOut;
  /** For the lifecycle's `prepare` event. */
  readonly quote: QuoteContext;
  readonly lastValidBlockHeight: bigint;
}

export type BuildResult = { readonly ok: true; readonly tx: BuiltTransaction } | Refusal;

/**
 * Lamports an exact-spend quote may leave unspent: the fee components (LP, protocol, creator) are each rounded up
 * once. Measured 0 on 40,000 random curve and pool quotes; a quote further from its spend was made for another trade.
 */
export const MAX_SPEND_ROUNDING_LAMPORTS = 3n;

const quoteMatchesSpend = (spend: bigint, q: { readonly spend: bigint; readonly userQuote: bigint }): boolean =>
  q.spend === spend && q.userQuote <= spend && spend - q.userQuote <= MAX_SPEND_ROUNDING_LAMPORTS;

/** floor(quoted × (10,000 − slippage) / 10,000). */
export const minOutFromQuote = (quotedOut: bigint, slippage: Bps): bigint => (quotedOut * (BPS_DENOMINATOR - BigInt(slippage))) / BPS_DENOMINATOR;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** The request's transaction shape, for `checkShape`: the venue's market plus the mint's extensions. */
export const requestShape = (req: TradeRequest): TradeShape => ({
  ...(req.venue === 'curve' ? curveShape(req.market) : poolShape(req.market)),
  extensions: req.mint.extensions.map((e) => e.kind),
});

export const buildTrade = (req: TradeRequest, c: BuildCommon, policy: ExecutionPolicy): BuildResult => {
  // ---- policy and amounts ----
  if (!Number.isInteger(c.slippageBps) || c.slippageBps < 0 || c.slippageBps >= Number(BPS_DENOMINATOR)) return refuse('invalid-amount', 'slippage must be 0..9,999 bps');
  if (c.slippageBps > policy.maxSlippageBps) return refuse('over-policy', `slippage ${c.slippageBps} bps is above the ${policy.maxSlippageBps} bps policy`);
  if (c.priorityFeeLamports > policy.maxPriorityFeeLamports) return refuse('over-policy', 'priority fee is above the policy cap');
  if (policy.tipLamports > policy.maxTipLamports) return refuse('over-policy', 'tip is above the policy ceiling');
  if (policy.tipLamports <= 0n || policy.tipAccounts.length === 0) return refuse('over-policy', 'the Sender needs a tip and a tip account');
  const slippage = bps(c.slippageBps);

  const shape: TxShape = req.side === 'buy' ? `${req.venue}-buy` : req.closeTokenAccount ? `${req.venue}-sell-close` : `${req.venue}-sell`;
  const cuLimit = policy.calibration[shape];
  if (cuLimit === undefined) return refuse('over-policy', `no compute calibration for ${shape}`);
  // Sender requires a compute-unit price instruction; a price that rounds to zero is refused, never sent as 0.
  const price = (c.priorityFeeLamports * MICRO_LAMPORTS_PER_LAMPORT) / BigInt(cuLimit);
  if (price <= 0n) return refuse('invalid-amount', 'priority fee is too small for the compute limit');
  const priorityFee = ceilDiv(price * BigInt(cuLimit), MICRO_LAMPORTS_PER_LAMPORT);

  const baseTokenProgram = req.market.baseTokenProgram;
  // The mint must belong to the market's token program; then the one supported-shape check (shared with H17).
  const ataSize = associatedTokenAccountSize(req.mint, baseTokenProgram);
  if (!ataSize.ok) return refuse('unsupported-mint', ataSize.reason);
  const supported = checkShape(requestShape(req));
  if (!supported.ok) return refuse(supported.reason, supported.detail);
  const rent = (bytes: number) => rentExempt(bytes, c.rates.rent);
  const missing = (a: Address) => !c.existing.has(a);

  const user = c.wallet;
  const ixs: Instruction[] = [setComputeUnitLimit(cuLimit), setComputeUnitPrice(price)];
  let quotedOut: bigint;
  let minOut: bigint;
  let inAmount: bigint;
  let swapSol = 0n;
  let rentOut = 0n;
  /** Wallet-owned accounts and transfer destinations: the signer policy requires them as static keys (§12.1). */
  const mustBeStatic = new Set<Address>([user]);

  if (req.venue === 'curve') {
    const acc = curveAccounts(req.market, req.mint, user, c.choice.feeRecipient, c.choice.buybackRecipient);
    if (!acc.ok) return acc;
    const a = acc.accounts;
    const uva = userVolumeAccumulator(PUMP_PROGRAM, user);
    // The v2 interface also names the wallet's wrapped-SOL ATA and the accumulator's quote ATA (seed-checked only).
    mustBeStatic.add(a.userBaseAta).add(uva).add(associatedTokenAddress(user, NATIVE_MINT, TOKEN_PROGRAM)).add(associatedTokenAddress(uva, NATIVE_MINT, TOKEN_PROGRAM));
    const creatorVault = pumpCreatorVault(req.market.curve.creator!);
    // Old curves are grown to the target size at the trader's expense; the creator vault is topped up to rent-exempt.
    const curveTopUp = BigInt(Math.max(0, BONDING_CURVE_TARGET_BYTES - req.market.accountBytes)) * c.rates.rent.lamportsPerByte;
    const vaultTopUp = missing(creatorVault) ? rent(0) : 0n;
    if (req.side === 'buy') {
      if (req.spend <= 0n || req.quote.tokens <= 0n) return refuse('invalid-amount', 'the buy must spend lamports and buy tokens');
      if (!quoteMatchesSpend(req.spend, req.quote)) return refuse('invalid-amount', 'the quote was not computed for this spend');
      quotedOut = req.quote.tokens;
      inAmount = req.spend;
      minOut = minOutFromQuote(quotedOut, slippage);
      if (minOut <= 0n) return refuse('invalid-amount', 'min-out rounds to zero');
      swapSol = req.spend;
      ixs.push(createAssociatedTokenIdempotent(user, a.userBaseAta, user, req.market.mint, baseTokenProgram));
      ixs.push(curveBuyIx(req.market, a, user, req.spend, minOut));
      rentOut += (missing(a.userBaseAta) ? rent(ataSize.bytes) : 0n) + (missing(uva) ? rent(USER_VOLUME_ACCUMULATOR_SIZE) : 0n) + curveTopUp + vaultTopUp;
    } else {
      if (req.quote.tokens <= 0n || req.quote.userQuote <= 0n) return refuse('invalid-amount', 'the quote must sell tokens for SOL');
      quotedOut = req.quote.userQuote;
      inAmount = req.quote.tokens;
      minOut = minOutFromQuote(quotedOut, slippage);
      if (minOut <= 0n) return refuse('invalid-amount', 'min-out rounds to zero');
      ixs.push(curveSellIx(req.market, a, user, req.quote.tokens, minOut));
      if (req.closeTokenAccount) ixs.push(closeAccount(a.userBaseAta, user, user, baseTokenProgram));
      rentOut += (missing(uva) ? rent(USER_VOLUME_ACCUMULATOR_SIZE) : 0n) + curveTopUp + vaultTopUp;
    }
  } else {
    const acc = poolAccounts(req.market, req.mint, user, c.choice.feeRecipient, c.choice.buybackRecipient);
    if (!acc.ok) return acc;
    const a = acc.accounts;
    if (req.mint.program !== (baseTokenProgram === TOKEN_PROGRAM ? 'spl-token' : 'token-2022')) return refuse('unsupported-mint', 'mint does not match the base token program');
    mustBeStatic.add(a.userBaseAta).add(a.userQuoteAta);
    const p = req.market.state;
    // Created at the wallet's expense if missing (PumpSwap IDL docs on buy_exact_quote_in and sell). The buyback
    // recipient's quote ATA is not listed there and all eight exist on chain, but the program is not open source, so
    // it is charged too unless read as existing.
    const protocolAta = associatedTokenAddress(a.protocolFeeRecipient, NATIVE_MINT, TOKEN_PROGRAM);
    const creatorAta = associatedTokenAddress(poolCoinCreatorVaultAuthority(p.coinCreator!), NATIVE_MINT, TOKEN_PROGRAM);
    const buybackAta = associatedTokenAddress(a.buybackFeeRecipient, NATIVE_MINT, TOKEN_PROGRAM);
    const venueInits = [protocolAta, creatorAta, buybackAta].reduce((t, k) => t + (missing(k) ? rent(TOKEN_ACCOUNT_SIZE) : 0n), 0n);
    // The wrapped-SOL account is created and closed in this transaction: its rent comes back, so it nets to zero.
    ixs.push(createAssociatedTokenIdempotent(user, a.userQuoteAta, user, NATIVE_MINT, TOKEN_PROGRAM));
    if (req.side === 'buy') {
      if (req.spend <= 0n || req.quote.base <= 0n) return refuse('invalid-amount', 'the buy must spend lamports and buy tokens');
      if (!quoteMatchesSpend(req.spend, req.quote)) return refuse('invalid-amount', 'the quote was not computed for this spend');
      quotedOut = req.quote.base;
      inAmount = req.spend;
      minOut = minOutFromQuote(quotedOut, slippage);
      if (minOut <= 0n) return refuse('invalid-amount', 'min-out rounds to zero');
      swapSol = req.spend;
      const uva = userVolumeAccumulator(PUMP_AMM_PROGRAM, user);
      mustBeStatic.add(uva);
      ixs.push(transfer(user, a.userQuoteAta, req.spend), syncNative(a.userQuoteAta, TOKEN_PROGRAM));
      ixs.push(createAssociatedTokenIdempotent(user, a.userBaseAta, user, p.baseMint, baseTokenProgram));
      ixs.push(poolBuyIx(req.market, a, user, req.spend, minOut));
      ixs.push(closeAccount(a.userQuoteAta, user, user, TOKEN_PROGRAM));
      rentOut += (missing(a.userBaseAta) ? rent(ataSize.bytes) : 0n) + (missing(uva) ? rent(USER_VOLUME_ACCUMULATOR_SIZE) : 0n) + venueInits;
    } else {
      if (req.quote.base <= 0n || req.quote.userQuote <= 0n) return refuse('invalid-amount', 'the quote must sell tokens for SOL');
      quotedOut = req.quote.userQuote;
      inAmount = req.quote.base;
      minOut = minOutFromQuote(quotedOut, slippage);
      if (minOut <= 0n) return refuse('invalid-amount', 'min-out rounds to zero');
      ixs.push(poolSellIx(req.market, a, user, req.quote.base, minOut));
      ixs.push(closeAccount(a.userQuoteAta, user, user, TOKEN_PROGRAM));
      if (req.closeTokenAccount) ixs.push(closeAccount(a.userBaseAta, user, user, baseTokenProgram));
      rentOut += venueInits;
    }
  }

  const tipTo = policy.tipAccounts[c.choice.tipAccount % policy.tipAccounts.length]!;
  mustBeStatic.add(tipTo);
  ixs.push(transfer(user, tipTo, policy.tipLamports, policy.jitoDontFront ? [JITO_DONT_FRONT] : []));

  // Venue and infrastructure accounts may come from a table; wallet-owned ones and transfer destinations never do.
  const venueOnly = (k: Address) => !mustBeStatic.has(k);
  let compiled: CompiledMessage;
  try {
    compiled = compileV0(user, ixs, c.recentBlockhash, c.lookupTables, venueOnly);
  } catch (e) {
    return refuse('invalid-amount', `transaction does not compile: ${(e as Error).message}`);
  }

  // One signature: the wallet's.
  const baseFee: bigint = c.rates.lamportsPerSignature;
  const solOut: SolOut = {
    baseFee,
    priorityFee,
    tip: policy.tipLamports,
    swap: swapSol,
    rent: rentOut,
    total: baseFee + priorityFee + policy.tipLamports + swapSol + rentOut,
  };
  return {
    ok: true,
    tx: {
      shape,
      instructions: ixs,
      compiled,
      computeUnitLimit: cuLimit,
      computeUnitPriceMicroLamports: price,
      priorityFee,
      solOut,
      quote: { provider: `direct-${req.venue}`, requestId: null, inAmount, quotedOut, minOut, slippage, quotedAtSlot: c.quotedAtSlot },
      lastValidBlockHeight: c.lastValidBlockHeight,
    },
  };
};
