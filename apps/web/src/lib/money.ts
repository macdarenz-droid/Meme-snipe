/**
 * Exact money for the dashboard. The worker API sends US dollars as decimal
 * strings with at most 6 places (micro-dollars, the same unit as
 * packages/core MicroUsd). Sums and comparisons run on bigint micro-dollars;
 * a float appears only when a value is drawn (chart position) or printed.
 */

const SCALE = 6;
const MICRO = 1_000_000n;
const USD_RE = /^-?\d{1,15}(\.\d{1,6})?$/;
const DEC_RE = /^-?\d+(\.\d+)?$/;

export class MoneyError extends Error {}

export const isUsd = (s: unknown): s is string => typeof s === 'string' && USD_RE.test(s);
export const isDec = (s: unknown): s is string => typeof s === 'string' && DEC_RE.test(s);

/** "−12.5" → −12500000n. Throws on anything that is not an exact decimal. */
export function toMicro(s: string): bigint {
  if (!isUsd(s)) throw new MoneyError(`not a dollar amount: ${JSON.stringify(s)}`);
  const neg = s.startsWith('-');
  const [whole = '0', frac = ''] = (neg ? s.slice(1) : s).split('.');
  const v = BigInt(whole) * MICRO + BigInt(frac.padEnd(SCALE, '0'));
  return neg ? -v : v;
}

/** −12500000n → "-12.5" (shortest exact form). */
export function fromMicro(v: bigint): string {
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = (a / MICRO).toString();
  const frac = (a % MICRO).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

export const addUsd = (...xs: string[]): string => fromMicro(xs.reduce((s, x) => s + toMicro(x), 0n));
export const subUsd = (a: string, b: string): string => fromMicro(toMicro(a) - toMicro(b));
export const negUsd = (a: string): string => fromMicro(-toMicro(a));
export const cmpUsd = (a: string, b: string): number => {
  const d = toMicro(a) - toMicro(b);
  return d > 0n ? 1 : d < 0n ? -1 : 0;
};
export const signOf = (a: string): -1 | 0 | 1 => cmpUsd(a, '0') as -1 | 0 | 1;
export const maxUsd = (xs: string[]): string => xs.reduce((m, x) => (cmpUsd(x, m) > 0 ? x : m));
export const minUsd = (xs: string[]): string => xs.reduce((m, x) => (cmpUsd(x, m) < 0 ? x : m));

/** Running drawdown from the high-water mark of a cumulative series (each value ≤ 0). */
export function drawdownsUsd(cum: string[]): string[] {
  let peak: bigint | null = null;
  return cum.map((c) => {
    const v = toMicro(c);
    peak = peak === null || v > peak ? v : peak;
    return fromMicro(v - peak);
  });
}

/** Rounds micro-dollars to cents, half away from zero. */
function roundCents(v: bigint): bigint {
  const unit = 10_000n;
  const a = v < 0n ? -v : v;
  const c = (a + unit / 2n) / unit;
  return v < 0n ? -c : c;
}

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const MINUS = '−';

/** "$1,234.56"; signed adds + or − (true minus sign). Same output as lib/format formatUsd, but exact. */
export function formatUsdExact(s: string, signed = false): string {
  const cents = roundCents(toMicro(s));
  const a = cents < 0n ? -cents : cents;
  const body = `$${group((a / 100n).toString())}.${(a % 100n).toString().padStart(2, '0')}`;
  if (cents < 0n) return `${MINUS}${body}`;
  if (signed && cents > 0n) return `+${body}`;
  return body;
}

/** An exact SOL amount ("-0.004000000") as "−0.004 SOL"; signed adds + or −. Never rounded. */
export function formatSolExact(s: string, signed = false): string {
  if (!isDec(s)) throw new MoneyError(`not a decimal: ${JSON.stringify(s)}`);
  const neg = s.startsWith('-');
  const [whole = '0', frac = ''] = (neg ? s.slice(1) : s).split('.');
  const f = frac.replace(/0+$/, '');
  const zero = /^0*$/.test(whole) && f === '';
  const body = `${group(BigInt(whole).toString())}${f ? `.${f}` : ''} SOL`;
  if (neg && !zero) return `${MINUS}${body}`;
  if (signed && !zero) return `+${body}`;
  return body;
}

/** A dollar amount as a plain number for drawing and for short labels only. Never sum the result. */
export const usdToPlot = (s: string): number => Number(toMicro(s)) / 1e6;

/** A decimal string as a number for drawing only. */
export const decToPlot = (s: string): number => {
  if (!isDec(s)) throw new MoneyError(`not a decimal: ${JSON.stringify(s)}`);
  return Number(s);
};

/** Token prices are tiny and only displayed: four places from a cent up, else three significant digits. */
export function formatPriceDec(s: string): string {
  const v = decToPlot(s);
  if (v === 0) return formatUsdExact('0');
  if (Math.abs(v) >= 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toPrecision(3)}`;
}

/**
 * Return on size (APP-TRADE), the one formula the open trade and closed trades use: net ÷ size in hundredths of a
 * percent, exact, rounded half away from zero. Null when the size is not above zero.
 */
export function returnHundredths(netUsd: string, sizeUsd: string): bigint | null {
  return ratioHundredths(toMicro(netUsd), toMicro(sizeUsd));
}

/** n ÷ d in hundredths of a percent, exact, rounded half away from zero; null when d is not above zero. */
export function ratioHundredths(n: bigint, d: bigint): bigint | null {
  if (d <= 0n) return null;
  const x = n * 10_000n;
  const a = x < 0n ? -x : x;
  const q = (2n * a + d) / (2n * d);
  return x < 0n ? -q : q;
}

/** Return on SOL (APP-SOL, the owner's measure): net lamports ÷ entry lamports, as `returnHundredths`. */
export const returnLamports = (net: string, size: string): bigint | null => ratioHundredths(toLamports(net), toLamports(size));

const LAMPORTS_RE = /^-?\d{1,20}$/;
const PER_SOL = 1_000_000_000n;

/** "−12500" → −12500n. Throws on anything that is not an exact whole number of lamports. */
export function toLamports(s: string): bigint {
  if (!LAMPORTS_RE.test(s)) throw new MoneyError(`not lamports: ${JSON.stringify(s)}`);
  return BigInt(s);
}

/**
 * Lamports as SOL (APP-SOL): "+0.0123 SOL". Four decimals, rounded half away from zero; an amount under 0.0001 SOL
 * keeps four significant digits ("0.000005 SOL"), so a fee never reads 0.0000. Exact from the integer, never a float.
 */
export function formatSol(lamports: string, signed = false): string {
  const v = toLamports(lamports);
  const a = v < 0n ? -v : v;
  let body: string;
  if (a === 0n) body = '0.0000';
  else if (a >= 100_000n) {
    const t = (a + 50_000n) / 100_000n; // ten-thousandths of a SOL
    body = `${group((t / 10_000n).toString())}.${(t % 10_000n).toString().padStart(4, '0')}`;
  } else {
    const digits = a.toString().length;
    const drop = digits > 4 ? 10n ** BigInt(digits - 4) : 1n;
    const r = ((a + drop / 2n) / drop) * drop;
    body = `0.${r.toString().padStart(9, '0').replace(/0+$/, '')}`;
  }
  const sign = v < 0n ? MINUS : signed && v > 0n ? '+' : '';
  return `${sign}${body} SOL`;
}

/** Lamports in dollars at a SOL price (micro-dollars per SOL as a dollar string): the small line under a SOL figure. */
export function lamportsAtPrice(lamports: string, solPriceUsd: string, signed = false): string {
  const v = toLamports(lamports);
  const micro = (v * toMicro(solPriceUsd)) / PER_SOL;
  return formatUsdExact(fromMicro(micro), signed);
}

/** Colour follows the sign of the SOL amount: any non-zero amount is printed non-zero. */
export const toneOfLamports = (s: string): 'gain' | 'loss' | '' => {
  const v = toLamports(s);
  return v > 0n ? 'gain' : v < 0n ? 'loss' : '';
};

/** Lamports as SOL for drawing only. */
export const lamportsToPlot = (s: string): number => Number(toLamports(s)) / 1e9;

/** A return, signed with 2 places: "+12.35%", "−0.40%", "0.00%"; "—" when there is none. */
export function formatReturn(h: bigint | null): string {
  if (h === null) return '—';
  const a = h < 0n ? -h : h;
  const body = `${a / 100n}.${(a % 100n).toString().padStart(2, '0')}%`;
  return h < 0n ? `${MINUS}${body}` : h > 0n ? `+${body}` : body;
}

/** Colour follows the printed return, so 0.00% is never green or red. */
export const toneOfReturn = (h: bigint | null): 'gain' | 'loss' | '' => (h === null || h === 0n ? '' : h > 0n ? 'gain' : 'loss');

/** A token price as the exit triggers show it (worker api.ts triggerPrice): "$" and 4 significant digits. Display only. */
export function formatPrice4(s: string): string {
  return `$${decToPlot(s).toLocaleString('en-US', { maximumSignificantDigits: 4, useGrouping: false })}`;
}

/** R multiple, signed: "+1.52R", "−0.80R". */
export function formatR(s: string): string {
  const v = decToPlot(s);
  const abs = Math.abs(v).toFixed(2);
  if (abs === '0.00') return '0.00R';
  return `${v < 0 ? MINUS : '+'}${abs}R`;
}

/** A ratio from 0 to 1 as a percentage, e.g. "0.4125" → "41.3%". */
export function formatShare(s: string, digits = 1): string {
  return `${(decToPlot(s) * 100).toFixed(digits)}%`;
}

/** Colour follows the printed cents, so an amount shown as $0.00 is never green or red. */
export const toneOf = (s: string): 'gain' | 'loss' | '' => {
  const c = roundCents(toMicro(s));
  return c > 0n ? 'gain' : c < 0n ? 'loss' : '';
};
