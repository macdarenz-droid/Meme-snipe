// pump.fun bonding curve quotes (program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P), integer-exact.
// Formulas follow @pump-fun/pump-sdk 2.0.0 `bondingCurve.ts`/`fees.ts` and are checked against mainnet
// TradeEvents in test/amm/golden.test.ts.
import { BPS_DENOMINATOR, type Bps } from '../units/index.ts';
import { type CoinFlags, type FeeSplit, type FeeTier, type Quote, feeOf, marketCap, noQuote, selectFeeTier, unsupportedCoin } from './fees.ts';

/** The trading fields of the `BondingCurve` account (raw units: lamports and token base units). */
export interface CurveState {
  readonly virtualTokenReserves: bigint;
  readonly virtualQuoteReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly realQuoteReserves: bigint;
  readonly complete: boolean;
}

/** One million parts: the scale of `curveProgressPpm`. */
const PARTS_PER_MILLION = 1_000_000n;

/**
 * Launch and graduation parameters from the pump `Global` account. Pump has changed them before, so they are always
 * read from chain (DEC-1's decoded Global satisfies this type), never assumed.
 */
export interface PumpGlobalParams {
  readonly initialVirtualTokenReserves: bigint;
  readonly initialVirtualSolReserves: bigint;
  readonly initialRealTokenReserves: bigint;
  readonly tokenTotalSupply: bigint;
  /** Charged by `migrate` when the curve graduates to PumpSwap. */
  readonly poolMigrationFee: bigint;
}

declare const checkedGlobal: unique symbol;
/** Global parameters that passed `freshGlobal`. Only `freshGlobal` makes one, so unchecked values cannot be wired in. */
export type CheckedGlobal = PumpGlobalParams & { readonly [checkedGlobal]: true };

/** A decoded Global account with the slot it was read at; `value` is null when it could not be read. */
export interface PumpGlobalReading {
  readonly value: PumpGlobalParams | null;
  readonly readAtSlot: bigint;
}

/**
 * The Global parameters, or a no-quote reason when they are missing, unusable, older than `maxAgeSlots`, or read after
 * `currentSlot` (a backtest must only see data as of its simulated moment).
 */
export const freshGlobal = (reading: PumpGlobalReading, currentSlot: bigint, maxAgeSlots: bigint): Quote<CheckedGlobal> => {
  if (maxAgeSlots < 0n) throw new RangeError('max age must be >= 0');
  if (!reading.value) return noQuote('missing-params', 'pump Global account not read');
  if (reading.readAtSlot > currentSlot) return noQuote('stale-params', `pump Global read at slot ${reading.readAtSlot}, after the current slot ${currentSlot}`);
  if (currentSlot - reading.readAtSlot > maxAgeSlots) return noQuote('stale-params', `pump Global read at slot ${reading.readAtSlot}, now ${currentSlot}`);
  const v = reading.value;
  if (v.initialRealTokenReserves <= 0n || v.initialVirtualTokenReserves <= v.initialRealTokenReserves || v.tokenTotalSupply <= 0n || v.initialVirtualSolReserves <= 0n) {
    return noQuote('missing-params', 'pump Global parameters are not usable');
  }
  return { ok: true, trade: v as CheckedGlobal };
};

export interface CurveFeeContext {
  /** `fee_tiers` from the pump FeeConfig (`8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt`). */
  readonly feeTiers: readonly FeeTier[];
  /** Checked Global parameters: `token_total_supply` is the tier's market-cap supply for normal coins (pump-sdk `ONE_BILLION_SUPPLY`). */
  readonly global: CheckedGlobal;
  /** False when `BondingCurve.creator` is the default key: no creator fee is charged then. */
  readonly creatorFeeCharged: boolean;
  /** Coins priced differently (mayhem, Token-2022 transfer fee or hook) are refused. */
  readonly coin: CoinFlags;
}

/**
 * Fee rates for a curve trade, tiered by the pre-trade market cap (pump `compute_fees`). Live curve tiers have no LP
 * rate; if one appears it is charged like the others (on the net quote, rounded up) so cost is never understated.
 */
export const curveFees = (state: CurveState, ctx: CurveFeeContext): FeeSplit => {
  const tier = selectFeeTier(ctx.feeTiers, marketCap(state.virtualQuoteReserves, state.virtualTokenReserves, ctx.global.tokenTotalSupply));
  return { lp: tier.lp, protocol: tier.protocol, creator: ctx.creatorFeeCharged ? tier.creator : (0 as Bps) };
};

export interface CurveTrade {
  /** Tokens moved (received on a buy, sold on a sell). */
  readonly tokens: bigint;
  /** Lamports into or out of the curve, before fees (`TradeEvent.sol_amount`). */
  readonly quote: bigint;
  readonly lpFee: bigint;
  readonly protocolFee: bigint;
  readonly creatorFee: bigint;
  /** What the trader pays in (buy) or receives (sell), fees included. */
  readonly userQuote: bigint;
  /** Lamports lost to price impact against the pre-trade spot price (vQuote / vToken), exact. */
  readonly impact: bigint;
  readonly fees: FeeSplit;
  readonly after: CurveState;
}

const refuse = (state: CurveState, ctx: CurveFeeContext): Quote<never> | null =>
  unsupportedCoin(ctx.coin)
  ?? (state.complete || state.virtualTokenReserves === 0n || state.realTokenReserves === 0n ? noQuote('curve-complete', 'bonding curve is complete') : null);

// Value of `tokens` at the pre-trade spot price, floored.
const spotValue = (state: CurveState, tokens: bigint) => (tokens * state.virtualQuoteReserves) / state.virtualTokenReserves;

const afterBuy = (s: CurveState, tokens: bigint, quote: bigint): CurveState => ({
  virtualTokenReserves: s.virtualTokenReserves - tokens,
  virtualQuoteReserves: s.virtualQuoteReserves + quote,
  realTokenReserves: s.realTokenReserves - tokens,
  realQuoteReserves: s.realQuoteReserves + quote,
  complete: s.realTokenReserves - tokens === 0n,
});

const buyTrade = (state: CurveState, tokens: bigint, quote: bigint, fees: FeeSplit, feeBase = quote): Quote<CurveTrade> => {
  const lpFee = feeOf(feeBase, fees.lp);
  const protocolFee = feeOf(feeBase, fees.protocol);
  const creatorFee = feeOf(feeBase, fees.creator);
  return {
    ok: true,
    trade: {
      tokens, quote, lpFee, protocolFee, creatorFee, fees,
      userQuote: quote + lpFee + protocolFee + creatorFee,
      impact: quote - spotValue(state, tokens),
      after: afterBuy(state, tokens, quote),
    },
  };
};

/**
 * `buy` / `buy_v2`: exactly `tokens` out, cost rounded up. Buying exactly the real tokens left completes the curve
 * (mainnet vectors). Asking for more is refused: what the program does past the cap is not verified.
 */
export const curveBuyExactTokens = (state: CurveState, tokens: bigint, ctx: CurveFeeContext): Quote<CurveTrade> => {
  if (tokens <= 0n) throw new RangeError('tokens must be > 0');
  const no = refuse(state, ctx);
  if (no) return no;
  if (tokens > state.realTokenReserves) return noQuote('exceeds-reserves', 'more tokens than the curve has left');
  const quote = (tokens * state.virtualQuoteReserves) / (state.virtualTokenReserves - tokens) + 1n;
  return buyTrade(state, tokens, quote, curveFees(state, ctx));
};

/**
 * `buy_exact_sol_in` / `buy_exact_quote_in_v2`: spend at most `spend` lamports, fees included.
 * The net amount is floor(spend * 10,000 / (10,000 + fee bps)); the ceil fees are computed on it, then the net is
 * lowered by any excess so net + fees fits in `spend` (fees are not recomputed). Tokens out are priced on net - 1.
 * Verified on mainnet events, which show this order. A spend that would buy more than the real tokens left is refused.
 */
export const curveBuyExactQuoteIn = (state: CurveState, spend: bigint, ctx: CurveFeeContext): Quote<CurveTrade> => {
  if (spend <= 1n) throw new RangeError('spend must be > 1 lamport');
  const no = refuse(state, ctx);
  if (no) return no;
  const fees = curveFees(state, ctx);
  const totalBps = BigInt(fees.lp) + BigInt(fees.protocol) + BigInt(fees.creator);
  const untrimmed = (spend * BPS_DENOMINATOR) / (BPS_DENOMINATOR + totalBps);
  const over = untrimmed + feeOf(untrimmed, fees.lp) + feeOf(untrimmed, fees.protocol) + feeOf(untrimmed, fees.creator) - spend;
  const quote = over > 0n ? untrimmed - over : untrimmed;
  const input = quote - 1n;
  const tokens = (input * state.virtualTokenReserves) / (state.virtualQuoteReserves + input);
  if (tokens <= 0n) return noQuote('zero-output', 'spend buys no tokens');
  // Past the cap the program's behaviour is not verified on mainnet, so the quote is refused.
  if (tokens > state.realTokenReserves) return noQuote('exceeds-reserves', 'spend buys more tokens than the curve has left');
  return buyTrade(state, tokens, quote, fees, untrimmed);
};

/** `sell` / `sell_v2`: exactly `tokens` in; proceeds floored, fees rounded up and taken from them. */
export const curveSell = (state: CurveState, tokens: bigint, ctx: CurveFeeContext): Quote<CurveTrade> => {
  if (tokens <= 0n) throw new RangeError('tokens must be > 0');
  const no = refuse(state, ctx);
  if (no) return no;
  const fees = curveFees(state, ctx);
  const quote = (tokens * state.virtualQuoteReserves) / (state.virtualTokenReserves + tokens);
  if (quote > state.realQuoteReserves) return noQuote('exceeds-reserves', 'sell exceeds the real quote reserves');
  const lpFee = feeOf(quote, fees.lp);
  const protocolFee = feeOf(quote, fees.protocol);
  const creatorFee = feeOf(quote, fees.creator);
  const userQuote = quote - lpFee - protocolFee - creatorFee;
  if (userQuote <= 0n) return noQuote('zero-output', 'fees take all sell proceeds');
  return {
    ok: true,
    trade: {
      tokens, quote, lpFee, protocolFee, creatorFee, fees, userQuote,
      impact: spotValue(state, tokens) - quote,
      after: {
        virtualTokenReserves: state.virtualTokenReserves + tokens,
        virtualQuoteReserves: state.virtualQuoteReserves - quote,
        realTokenReserves: state.realTokenReserves + tokens,
        realQuoteReserves: state.realQuoteReserves - quote,
        complete: false,
      },
    },
  };
};

/** Share of the curve's sellable tokens already sold, in parts per million (floored). */
export const curveProgressPpm = (state: CurveState, pumpGlobal: CheckedGlobal): bigint => {
  const { initialRealTokenReserves } = pumpGlobal;
  if (initialRealTokenReserves <= 0n) throw new RangeError('initial real token reserves must be > 0');
  if (state.complete) return PARTS_PER_MILLION;
  return ((initialRealTokenReserves - state.realTokenReserves) * PARTS_PER_MILLION) / initialRealTokenReserves;
};
