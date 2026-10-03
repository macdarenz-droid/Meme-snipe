import { toMicro } from '../lib/money.ts';

/**
 * Exact SOL amounts. A SOL amount is a decimal string with at most 9 places;
 * arithmetic runs on bigint lamports. Nothing here uses floating point.
 */
const LAMPORTS = 1_000_000_000n;
const SOL_RE = /^\d{1,12}(\.\d{1,9})?$/;

export const isSolAmount = (s: unknown): s is string => typeof s === 'string' && SOL_RE.test(s);

/** "0.015" → 15000000n. Null when the text is not an exact SOL amount. */
export function parseSol(s: string): bigint | null {
  if (!isSolAmount(s)) return null;
  const [whole = '0', frac = ''] = s.split('.');
  return BigInt(whole) * LAMPORTS + BigInt(frac.padEnd(9, '0'));
}

/** 15000000n → "0.015" (shortest exact form). */
export function fromLamports(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const frac = (a % LAMPORTS).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / LAMPORTS}${frac ? `.${frac}` : ''}`;
}

/** "1,234.5 SOL" from lamports. */
export function formatLamports(v: bigint): string {
  const [whole = '0', frac] = fromLamports(v).split('.');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''} SOL`;
}

export const formatSolExact = (s: string): string => {
  const v = parseSol(s);
  return v === null ? '—' : formatLamports(v);
};

/** A$ value of an amount of lamports at a SOL/AUD price, rounded to cents (half up). Null if the price is unusable. */
export function audCents(lamports: bigint, solAud: string | null): bigint | null {
  if (solAud === null) return null;
  let micro: bigint;
  try {
    micro = toMicro(solAud);
  } catch {
    return null;
  }
  if (micro <= 0n) return null;
  // lamports × (micro-AUD per SOL) ÷ 1e9 = micro-AUD; ÷ 1e4 = cents.
  const unit = LAMPORTS * 10_000n;
  return (lamports * micro + unit / 2n) / unit;
}

/** "A$12.34", or an empty string when there is no price. */
export function formatAud(lamports: bigint, solAud: string | null): string {
  const c = audCents(lamports, solAud);
  if (c === null) return '';
  const whole = (c / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `A$${whole}.${(c % 100n).toString().padStart(2, '0')}`;
}
