// AmountInput parsing (UI-T04, C08): user text to an exact integer string in the stored unit. SOL to lamports (at
// most 9 decimals), token amounts to base units (at most the mint's decimals), bps as an integer, percent to bps (at
// most 2 decimals). Never rounds: too many decimals is invalid. SOL and token amounts refuse commas outright (Z05 round
// 2, red team M4: `0,250` must never read as 250 SOL, and `1,500` is as likely 1.5 as 1500; round 3, ruling 16); bps and
// percent accept thousands separators only as real groups that do not start with 0 (`1,000`). The UI is English-only (open question Q-09).
import { formatSol, formatTokenAmount, groupThousands } from './money.ts';

export type AmountUnit = 'sol' | 'token' | 'bps' | 'percent';

export interface AmountSpec {
  unit: AmountUnit;
  /** Mint decimals, for unit `token`. */
  decimals?: number;
  /** Bounds and limit in the stored unit (lamports, base units or bps), as integer strings. */
  min?: string;
  max?: string;
  limit?: string;
}

export type AmountResult =
  | { kind: 'empty' }
  | { kind: 'invalid'; message: string }
  | { kind: 'valid'; value: string }
  | { kind: 'out-of-range'; value: string; message: string }
  | { kind: 'exceeds-limit'; value: string; message: string };

const U64_MAX = 18446744073709551615n;

/** Decimal places the unit accepts and the scale to the stored integer. */
export function unitScale(spec: AmountSpec): number {
  switch (spec.unit) {
    case 'sol': return 9;
    case 'token': return spec.decimals ?? 0;
    case 'bps': return 0;
    case 'percent': return 2;
  }
}

/** The exact text of a stored integer in the spec's unit, trailing zeros dropped (`0.01 SOL`, `35 bps`, `2.50%`). */
export function formatStored(value: string, spec: AmountSpec): string {
  const trim = (s: string): string => s.replace(/(\.\d*?)0+(?=\D*$)/, '$1').replace(/\.(?=\D*$)/, '');
  switch (spec.unit) {
    case 'sol': return trim(formatSol(value).exact);
    case 'token': return trim(formatTokenAmount(value, spec.decimals ?? 0).exact);
    // From the bigint, never through Number (Z05 round 3, ruling 12): a stored value past 2^53 keeps every digit.
    case 'bps': return `${groupThousands(BigInt(value).toString())} bps`;
    case 'percent': {
      const v = BigInt(value);
      return `${groupThousands((v / 100n).toString())}.${(v % 100n).toString().padStart(2, '0')}%`;
    }
  }
}

const UNIT_NAME: Readonly<Record<AmountUnit, string>> = { sol: 'SOL', token: 'the token', bps: 'basis points', percent: 'a percentage' };

/** Parses `text` for `spec`. */
export function parseAmountInput(text: string, spec: AmountSpec): AmountResult {
  const trimmed = text.trim();
  if (trimmed === '') return { kind: 'empty' };
  if (trimmed.startsWith('-')) return { kind: 'invalid', message: 'Enter an amount of zero or more' };
  let plain = trimmed;
  if (plain.includes(',')) {
    // Z05 round 2 (M4) and round 3 (ruling 16): SOL and token amounts refuse commas outright.
    if (spec.unit === 'sol') return { kind: 'invalid', message: 'Use a dot for decimals; no commas in SOL amounts' };
    if (spec.unit === 'token') return { kind: 'invalid', message: 'Use a dot for decimals; no commas in token amounts' };
    if (!/^[1-9]\d{0,2}(,\d{3})+(\.\d*)?$/.test(plain)) return { kind: 'invalid', message: 'Use a dot for decimals; commas only between thousands' };
    plain = plain.replace(/,/g, '');
  }
  const m = /^(\d*)(?:\.(\d*))?$/.exec(plain);
  if (m === null || (m[1] === '' && (m[2] ?? '') === '')) return { kind: 'invalid', message: 'Enter a number' };
  const scale = unitScale(spec);
  const frac = m[2] ?? '';
  if (frac.length > scale) {
    return { kind: 'invalid', message: scale === 0 ? `Enter a whole number of ${UNIT_NAME[spec.unit]}` : `${spec.unit === 'sol' ? 'SOL' : 'This amount'} has at most ${scale} decimals` };
  }
  const value = BigInt(`${m[1] === '' ? '0' : m[1] as string}${frac.padEnd(scale, '0')}`);
  if (value > U64_MAX) return { kind: 'invalid', message: 'This amount is too large' };
  const v = value.toString();
  const show = (s: string): string => formatStored(s, spec);
  if ((spec.min !== undefined && value < BigInt(spec.min)) || (spec.max !== undefined && value > BigInt(spec.max))) {
    const range = spec.min !== undefined && spec.max !== undefined ? `between ${show(spec.min)} and ${show(spec.max)}`
      : spec.min !== undefined ? `at least ${show(spec.min)}` : `at most ${show(spec.max as string)}`;
    return { kind: 'out-of-range', value: v, message: `Enter ${range}` };
  }
  if (spec.limit !== undefined && value > BigInt(spec.limit)) {
    return { kind: 'exceeds-limit', value: v, message: `Above the limit of ${show(spec.limit)}` };
  }
  return { kind: 'valid', value: v };
}

/**
 * The stored value only when the input is valid: an out-of-range or over-limit value is never handed on (Z05 round 2,
 * red team M4), so a caller cannot submit it by reading the value and ignoring the kind.
 */
export function amountValue(result: AmountResult): string | null {
  return result.kind === 'valid' ? result.value : null;
}

/** The parsed value read back in the field's unit (`Reads as 0.25 SOL`), so the operator sees what will be used. */
export function readBack(result: AmountResult, spec: AmountSpec): string | null {
  return result.kind === 'empty' || result.kind === 'invalid' ? null : `Reads as ${formatStored(result.value, spec)}`;
}

