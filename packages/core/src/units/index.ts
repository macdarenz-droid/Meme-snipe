// Exact on-chain amounts. Every chain quantity is an integer bigint; floats never touch money.
// Brands stop a lamport amount being passed where a raw token amount or micro-dollar is expected.

declare const unit: unique symbol;
type Unit<B, U extends string> = B & { readonly [unit]: U };

/** SOL in lamports (1 SOL = 1e9 lamports). */
export type Lamports = Unit<bigint, 'lamports'>;
/** A token amount in its smallest unit (scale given by the mint's decimals). */
export type RawAmount = Unit<bigint, 'raw'>;
/** US dollars in millionths (1 USD = 1e6). */
export type MicroUsd = Unit<bigint, 'micro-usd'>;
/** Basis points, an integer from 0 to 10,000. */
export type Bps = Unit<number, 'bps'>;

export type Rounding = 'floor' | 'ceil';

export const LAMPORTS_PER_SOL = 1_000_000_000n;
export const MICRO_PER_USD = 1_000_000n;
export const BPS_DENOMINATOR = 10_000n;

const asInteger = (value: bigint | number, what: string): bigint => {
  if (typeof value === 'bigint') return value;
  if (!Number.isSafeInteger(value)) throw new RangeError(`${what} must be a safe integer, got ${value}`);
  return BigInt(value);
};

export const lamports = (value: bigint | number): Lamports => {
  const v = asInteger(value, 'lamports');
  if (v < 0n) throw new RangeError(`lamports must be >= 0, got ${v}`);
  return v as Lamports;
};

export const raw = (value: bigint | number): RawAmount => {
  const v = asInteger(value, 'raw amount');
  if (v < 0n) throw new RangeError(`raw amount must be >= 0, got ${v}`);
  return v as RawAmount;
};

/** Micro-dollars may be negative (P&L, drawdown). */
export const microUsd = (value: bigint | number): MicroUsd => asInteger(value, 'micro-usd') as MicroUsd;

export const bps = (value: number): Bps => {
  if (!Number.isInteger(value) || value < 0 || value > Number(BPS_DENOMINATOR)) throw new RangeError(`bps must be an integer 0..10000, got ${value}`);
  return value as Bps;
};

/** a * b / d with explicit rounding toward -inf (floor) or +inf (ceil). d must be positive. */
export const mulDiv = (a: bigint, b: bigint, d: bigint, rounding: Rounding): bigint => {
  if (d <= 0n) throw new RangeError(`divisor must be > 0, got ${d}`);
  const n = a * b;
  const q = n / d; // truncates toward zero
  const r = n % d;
  if (r === 0n) return q;
  if (rounding === 'floor') return n < 0n ? q - 1n : q;
  return n > 0n ? q + 1n : q;
};

/** amount * bps / 10,000, rounded as asked. Use 'ceil' for costs you pay, 'floor' for amounts you receive. */
export const applyBps = (amount: bigint, rate: Bps, rounding: Rounding): bigint =>
  mulDiv(amount, BigInt(rate), BPS_DENOMINATOR, rounding);

/** A price of 1 SOL in micro-dollars, from a decimal string such as "119.36" (no float rounding). */
export const solPriceMicroUsd = (usdPerSol: string): MicroUsd => {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(usdPerSol.trim());
  if (!m) throw new RangeError(`price must be a decimal with at most 6 places, got "${usdPerSol}"`);
  const whole = BigInt(m[1] ?? '0');
  const frac = BigInt((m[2] ?? '').padEnd(6, '0'));
  const v = whole * MICRO_PER_USD + frac;
  if (v <= 0n) throw new RangeError('price must be > 0');
  return v as MicroUsd;
};

export const lamportsToMicroUsd = (amount: Lamports, price: MicroUsd, rounding: Rounding): MicroUsd =>
  mulDiv(amount, price, LAMPORTS_PER_SOL, rounding) as MicroUsd;

export const microUsdToLamports = (usd: MicroUsd, price: MicroUsd, rounding: Rounding): Lamports => {
  if (usd < 0n) throw new RangeError('cannot convert a negative dollar amount to lamports');
  return mulDiv(usd, LAMPORTS_PER_SOL, price, rounding) as Lamports;
};

/** Display-only conversion. Never feed the result back into money arithmetic. */
export const toDecimalString = (value: bigint, decimals: number): string => {
  if (!Number.isInteger(decimals) || decimals < 0) throw new RangeError(`decimals must be an integer >= 0, got ${decimals}`);
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
};
