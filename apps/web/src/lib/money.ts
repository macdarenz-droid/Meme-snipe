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
  const size = toMicro(sizeUsd);
  if (size <= 0n) return null;
  const n = toMicro(netUsd) * 10_000n;
  const a = n < 0n ? -n : n;
  const q = (2n * a + size) / (2n * size);
  return n < 0n ? -q : q;
}

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
