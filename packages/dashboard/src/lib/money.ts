// The dashboard's one formatting library (UI-T03; docs/UI.md "Number, unit and identifier formatting" and the
// View-model contract conventions). Pure functions; every quantity is parsed with BigInt from its decimal string, never
// through a JS number, so no u64/i64 value loses precision. The lint rule bot/no-number-formatting keeps toFixed,
// toPrecision and toLocaleString out of every other dashboard module.
//
// Each formatter returns a Formatted value: `text` (what is shown), `exact` (the exact value), `tooltip` (the tooltip
// text: exact value plus units) and `label` (the accessible text: unabbreviated, with words for −, +, < and ±).
// A null input returns UNKNOWN: the `—` marker (never 0). A malformed input throws ContractError.

/** A view-model value that breaks the contract (UI.md VM conventions 2 and 5). */
export class ContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

export interface Formatted { text: string; exact: string; tooltip: string; label: string }

/** The unknown marker (DS principle 1): shown for null, never coerced to 0. Components add the reason code. */
export const UNKNOWN: Formatted = { text: '—', exact: '—', tooltip: 'Not available', label: 'Not available' };

export const MINUS = '−';
export const ELLIPSIS = '…';
const U64_MAX = 18446744073709551615n;
const I64_MIN = -9223372036854775808n;
const I64_MAX = 9223372036854775807n;
const LAMPORTS_PER_SOL_DIGITS = 9;

const show = (s: string): string => JSON.stringify(s.length > 48 ? `${s.slice(0, 48)}${ELLIPSIS}` : s);

/** Parses a `U64Str` (`^(0|[1-9][0-9]{0,19})$`, at most 2^64 − 1). */
export function parseU64Str(s: string): bigint {
  if (!/^(0|[1-9][0-9]{0,19})$/.test(s)) throw new ContractError('E_U64', `not a U64Str: ${show(s)}`);
  const v = BigInt(s);
  if (v > U64_MAX) throw new ContractError('E_U64', `U64Str out of range: ${show(s)}`);
  return v;
}

/** Parses an `I64Str` (`^-?(0|[1-9][0-9]{0,18})$` within i64). `-0` is refused as non-canonical. */
export function parseI64Str(s: string): bigint {
  if (!/^-?(0|[1-9][0-9]{0,18})$/.test(s) || s === '-0') throw new ContractError('E_I64', `not an I64Str: ${show(s)}`);
  const v = BigInt(s);
  if (v < I64_MIN || v > I64_MAX) throw new ContractError('E_I64', `I64Str out of range: ${show(s)}`);
  return v;
}

/** Parses an `I128Str` (`^-?(0|[1-9][0-9]{0,38})$`, signed token deltas). */
export function parseI128Str(s: string): bigint {
  if (!/^-?(0|[1-9][0-9]{0,38})$/.test(s) || s === '-0') throw new ContractError('E_I128', `not an I128Str: ${show(s)}`);
  return BigInt(s);
}

/** A decimal parsed exactly: value = units / 10^scale. */
export interface Decimal { units: bigint; scale: number }

/** Parses a `DecimalStr` (`^-?(0|[1-9][0-9]*)(\.[0-9]{1,30})?$`, no exponent). */
export function parseDecimalStr(s: string): Decimal {
  const m = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]{1,30}))?$/.exec(s);
  if (m === null || /^-0(\.0+)?$/.test(s)) throw new ContractError('E_DECIMAL', `not a DecimalStr: ${show(s)}`);
  const frac = m[3] ?? '';
  return { units: BigInt(`${m[1] as string}${m[2] as string}${frac}`), scale: frac.length };
}

/** Groups an unsigned integer's digits in threes with commas, in linear time (a DecimalStr has no length limit). */
export function groupThousands(digits: string): string {
  const head = digits.length % 3 === 0 ? 3 : digits.length % 3;
  const groups = [digits.slice(0, head)];
  for (let i = head; i < digits.length; i += 3) groups.push(digits.slice(i, i + 3));
  return groups.join(',');
}

const abs = (v: bigint): bigint => (v < 0n ? -v : v);
const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Rounds |units| / 10^scale to `dp` decimals, half away from zero; returns the rounded magnitude in units of 10^-dp. */
function roundTo(magnitude: bigint, scale: number, dp: number): bigint {
  if (dp >= scale) return magnitude * pow10(dp - scale);
  const div = pow10(scale - dp);
  return (magnitude + div / 2n) / div;
}

/** `int.frac` text of a magnitude in units of 10^-dp, with thousands separators. */
function fixed(units: bigint, dp: number): string {
  const s = units.toString().padStart(dp + 1, '0');
  const int = groupThousands(s.slice(0, s.length - dp));
  return dp === 0 ? int : `${int}.${s.slice(s.length - dp)}`;
}

/** The exact decimal of `magnitude / 10^scale` with every digit (no rounding), grouped. */
function exactText(magnitude: bigint, scale: number): string {
  return fixed(magnitude, scale);
}

const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi'];

/**
 * Compact form from 1,000,000 up (DS: `12.4M`): three significant digits and a short-scale suffix (M, B, T, Qa, Qi).
 * Null below a million, and above the largest suffix (the value is then shown in full).
 */
function compactText(magnitude: bigint, scale: number): string | null {
  const intLen = (magnitude / pow10(scale)).toString().length;
  const group = Math.floor((intLen - 1) / 3);
  if (group < 2 || group >= SUFFIXES.length) return null;
  const dp = 3 - (intLen - 3 * group);
  const rounded = roundTo(magnitude, scale + 3 * group, dp);
  if (rounded < 1000n * pow10(dp)) return `${fixed(rounded, dp)}${SUFFIXES[group] as string}`;
  return group + 1 < SUFFIXES.length ? `1.00${SUFFIXES[group + 1] as string}` : null;
}

const SPOKEN: ReadonlyArray<[string, string]> = [['≈', 'approximately '], ['±', ''], [MINUS, 'minus '], ['+', 'plus '], ['<', 'less than ']];

/** Words for the leading symbols a screen reader may not read (DS Accessibility "Language and numbers"). */
export function spoken(text: string): string {
  let out = '';
  let rest = text;
  for (let hit = true; hit;) {
    const prefix = SPOKEN.find(([symbol]) => rest.startsWith(symbol));
    hit = prefix !== undefined;
    if (prefix !== undefined) {
      out += prefix[1];
      rest = rest.slice(prefix[0].length);
    }
  }
  return out + rest;
}

type Sign = '' | '+' | typeof MINUS | '±';

/** The sign prefix: `signed` shows + for positive and ± for zero; a negative value always shows U+2212. */
function signOf(v: bigint, signed: boolean): Sign {
  if (v < 0n) return MINUS;
  if (!signed) return '';
  return v === 0n ? '±' : '+';
}

interface AmountParts { text: string; exactValue: string; labelText: string }

/**
 * The display text of v / 10^scale at `dp` decimals: grouped, signed, compact above 1,000,000 when asked, `<0.0001`
 * when a non-zero value rounds to zero, and `±0` for an exact zero when signed.
 */
function amount(v: bigint, scale: number, dp: number, signed: boolean, compact: boolean): AmountParts {
  const sign = signOf(v, signed);
  const magnitude = abs(v);
  const exactValue = `${sign === '±' ? '' : sign}${exactText(magnitude, scale)}`;
  if (v === 0n && signed) return { text: '±0', exactValue, labelText: '±0' };
  const rounded = roundTo(magnitude, scale, dp);
  const full = rounded === 0n && magnitude !== 0n ? `${sign}<${fixed(1n, dp)}` : `${sign}${fixed(rounded, dp)}`;
  const short = compact ? compactText(magnitude, scale) : null;
  // A compact value is shown abbreviated but read out in full (DS Accessibility "Language and numbers").
  return { text: short === null ? full : `${sign}${short}`, exactValue, labelText: full };
}

export interface SolOptions { dp?: number; signed?: boolean; compact?: boolean }

/**
 * A SOL amount from lamports (1 lamport = 0.000000001 SOL, UI-F30). Default 4 decimals (balances and positions; 6 for
 * fees). `signed` reads an I64Str (PnL, deltas) and always shows the sign; otherwise the value is a U64Str balance.
 * Tooltip: the exact 9-decimal SOL and the exact lamports, e.g. `0.000000001 SOL (1 lamport)`.
 */
export function formatSol(lamports: string | null, opts: SolOptions = {}): Formatted {
  if (lamports === null) return UNKNOWN;
  const signed = opts.signed === true;
  const v = signed ? parseI64Str(lamports) : parseU64Str(lamports);
  const parts = amount(v, LAMPORTS_PER_SOL_DIGITS, opts.dp ?? 4, signed, opts.compact === true);
  const exact = `${parts.exactValue} SOL`;
  const lamportText = `${v < 0n ? MINUS : ''}${groupThousands(abs(v).toString())} ${abs(v) === 1n ? 'lamport' : 'lamports'}`;
  const text = `${parts.text} SOL`;
  return { text, exact, tooltip: `${exact} (${lamportText})`, label: spoken(`${parts.labelText} SOL`) };
}

/** A lamport amount as plain lamports: `5,000 lamports` (`1 lamport`). */
export function formatLamports(lamports: string | null): Formatted {
  if (lamports === null) return UNKNOWN;
  const v = parseU64Str(lamports);
  const text = `${groupThousands(v.toString())} ${v === 1n ? 'lamport' : 'lamports'}`;
  const sol = formatSol(lamports, { dp: 9 }).exact;
  return { text, exact: text, tooltip: `${text} (${sol})`, label: text };
}

/** Per-transaction fees (fee per signature, priority fee): lamports under 0.001 SOL, SOL (6 decimals) above. Tooltip shows both. */
export function formatFeeLamports(lamports: string | null): Formatted {
  if (lamports === null) return UNKNOWN;
  const v = parseU64Str(lamports);
  const asLamports = formatLamports(lamports);
  if (v < 1_000_000n) return asLamports;
  const sol = formatSol(lamports, { dp: 6 });
  return { ...sol, tooltip: `${sol.exact} (${asLamports.text})` };
}

/** A compute-unit price (`*_micro_lamports_per_cu`; 1,000,000 micro-lamports = 1 lamport, UI-F30). */
export function formatMicroLamportsPerCu(microLamports: string | null): Formatted {
  if (microLamports === null) return UNKNOWN;
  const v = parseU64Str(microLamports);
  const text = `${groupThousands(v.toString())} micro-lamports/CU`;
  const lamports = `${exactText(v, 6)} lamports per CU`;
  return { text, exact: text, tooltip: `${text} (${lamports})`, label: `${groupThousands(v.toString())} micro-lamports per compute unit` };
}

export interface TokenOptions { dp?: number; signed?: boolean; compact?: boolean }

/** Mint decimals: an integer 0-255 (u8, UI-F30). */
function checkDecimals(decimals: number): number {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new ContractError('E_DECIMALS', `decimals must be an integer 0-255, got ${String(decimals)}`);
  return decimals;
}

/**
 * A token amount `base / 10^decimals` (u64 base units, or an I128Str delta when `signed`). Tables round to 4 decimals
 * (never more than 6); compact `12.4M` above 1,000,000 when asked. Exact: every digit; tooltip adds base units and decimals.
 */
export function formatTokenAmount(base: string | null, decimals: number | null, opts: TokenOptions = {}): Formatted {
  if (base === null || decimals === null) return UNKNOWN;
  const d = checkDecimals(decimals);
  const signed = opts.signed === true;
  const v = signed ? parseI128Str(base) : parseU64Str(base);
  const dp = Math.min(opts.dp ?? 4, 6);
  const parts = amount(v, d, dp, signed, opts.compact === true);
  const baseText = `${v < 0n ? MINUS : ''}${groupThousands(abs(v).toString())}`;
  return {
    text: parts.text,
    exact: parts.exactValue,
    tooltip: `${parts.exactValue} (${baseText} base units, ${d} decimals)`,
    label: spoken(parts.labelText),
  };
}

const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
const subscript = (n: number): string => [...n.toString()].map((c) => SUBSCRIPT[Number(c)] as string).join('');

export interface PriceOptions { sig?: number }

/**
 * A price per whole token (`*_sol_per_token`, `*_usd_per_token` DecimalStr): `sig` (default 4) significant digits, never
 * fewer integer digits than the value has; trailing zeros dropped. Below 0.001: zero-compressed `0.0₅4321` (the
 * subscript counts the zeros after the point). The label and tooltip are the full decimal string.
 */
export function formatPrice(decimal: string | null, opts: PriceOptions = {}): Formatted {
  if (decimal === null) return UNKNOWN;
  const { units, scale } = parseDecimalStr(decimal);
  const sig = opts.sig ?? 4;
  const magnitude = abs(units);
  const sign = units < 0n ? MINUS : '';
  const exact = `${sign}${decimal.replace(/^-/, '')}`;
  const result = (text: string): Formatted => ({ text, exact, tooltip: exact, label: spoken(exact) });
  if (magnitude === 0n) return result('0');
  // value = d.ddd × 10^exponent; keep `sig` significant digits but every integer digit.
  const exponent = magnitude.toString().length - scale - 1;
  const dp = Math.max(0, sig - 1 - exponent);
  const rounded = roundTo(magnitude, scale, dp);
  if (rounded * 1000n < pow10(dp)) {
    const zeros = dp - rounded.toString().length;
    return result(`${sign}0.0${subscript(zeros)}${rounded.toString().replace(/0+$/, '')}`);
  }
  const text = fixed(rounded, dp);
  return result(`${sign}${dp > 0 ? text.replace(/\.?0+$/, '') : text}`);
}

export interface UsdOptions { approx?: boolean; signed?: boolean }

/**
 * US dollars from `*_usd_e6` (I64Str micro-USD): `$1,234.56`; under one cent `<$0.01`; `≈` first when derived from a
 * SOL/USD rate (the component adds the rate, source and as-of to the tooltip). Signed PnL shows `+`, `−` or `±`.
 */
export function formatUsdE6(usdE6: string | null, opts: UsdOptions = {}): Formatted {
  if (usdE6 === null) return UNKNOWN;
  const v = parseI64Str(usdE6);
  const signed = opts.signed === true;
  const approx = opts.approx === true ? '≈' : '';
  const sign = signOf(v, signed);
  const magnitude = abs(v);
  const exactSign = sign === '±' ? '' : sign;
  const exact = `${exactSign}$${exactText(magnitude, 6)}`;
  const cents = roundTo(magnitude, 6, 2);
  const body = v === 0n ? '$0.00' : cents === 0n ? '<$0.01' : `$${fixed(cents, 2)}`;
  const text = `${approx}${sign}${body}`;
  return { text, exact, tooltip: exact, label: spoken(text) };
}

export interface BpsOptions { as: 'bps' | 'pct'; signed?: boolean }

/**
 * Basis points (`*_bps`, integer; 1 bps = 0.01%). `bps`: fees, slippage, impact and cost ratios as `35 bps` (tooltip
 * `0.35%`). `pct`: returns, win rate, drawdown and limit usage as `35.00%`, two decimals (tooltip `3,500 bps`).
 */
export function formatBps(bps: number | null, opts: BpsOptions): Formatted {
  if (bps === null) return UNKNOWN;
  if (!Number.isSafeInteger(bps)) throw new ContractError('E_BPS', `bps must be an integer, got ${String(bps)}`);
  const v = BigInt(bps);
  const signText = signOf(v, opts.signed === true);
  const bpsText = `${groupThousands(abs(v).toString())} bps`;
  const pctText = `${fixed(abs(v), 2)}%`;
  const [text, tooltip] = opts.as === 'bps' ? [`${signText}${bpsText}`, `${signText}${pctText}`] : [`${signText}${pctText}`, `${signText}${bpsText}`];
  return { text, exact: text, tooltip, label: spoken(text) };
}

/** Latency or duration in milliseconds (`*_ms`, a number ≥ 0): `<1 ms`, `85 ms`, `1.2 s`; a minute or more as an age. */
export function formatDuration(ms: number | null): Formatted {
  if (ms === null) return UNKNOWN;
  if (!Number.isFinite(ms) || ms < 0) throw new ContractError('E_MS', `a duration must be a finite number of ms ≥ 0, got ${String(ms)}`);
  const whole = Math.round(ms);
  let text: string;
  if (ms < 1) text = '<1 ms';
  else if (whole < 1000) text = `${whole} ms`;
  else if (Math.round(ms / 100) < 600) text = `${fixed(BigInt(Math.round(ms / 100)), 1)} s`;
  else text = ageText(Math.round(ms / 1000));
  return { text, exact: `${ms} ms`, tooltip: `${ms} ms`, label: spoken(text) };
}

const two = (n: number): string => n.toString().padStart(2, '0');

/** `12s`, `4m 05s`, `2h 03m`, `3d 4h` for an age in whole seconds. */
function ageText(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${two(seconds % 60)}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${two(minutes % 60)}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** An age in milliseconds as `12s`, `4m 05s`, `2h 03m` or `3d 4h` (whole seconds, rounded down; negative counts as 0). */
export function formatAgeMs(ms: number): string {
  return ageText(Math.floor(Math.max(0, ms) / 1000));
}

/**
 * Time left on a Countdown (C44, UI-T07) as `0:42`, `12:05` or `1:02:03`: whole seconds rounded up, so `0:00` shows
 * only when nothing is left; a negative time shows as `0:00` (the countdown never goes below 0).
 */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms)) throw new ContractError('E_MS', `a countdown must be a finite number of ms, got ${String(ms)}`);
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}:${two(minutes % 60)}:${two(seconds % 60)}` : `${minutes}:${two(seconds % 60)}`;
}

const RFC3339_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Parses an `_at` timestamp (RFC 3339 UTC with milliseconds and `Z`) to epoch ms. The value must be a real instant
 * written canonically: it must read back unchanged, so a date that does not exist (2026-02-30, 2026-06-31) or 24:00,
 * which Date.parse silently rolls forward, is refused.
 */
export function parseAt(iso: string): number {
  const ms = RFC3339_MS_Z.test(iso) ? Date.parse(iso) : Number.NaN;
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== iso) throw new ContractError('E_AT', `not an RFC 3339 UTC timestamp with milliseconds: ${show(iso)}`);
  return ms;
}

/**
 * The age of `fromIso` at local time `nowMs` corrected by the server clock offset (`now + offset − as_of`, DS Data
 * freshness model), as `4m 12s`. A negative age (server clock ahead) shows as 0s. Tooltip: the full ISO 8601 time.
 */
export function formatAge(fromIso: string | null, nowMs: number, offsetMs: number): Formatted {
  if (fromIso === null) return UNKNOWN;
  const ageMs = Math.max(0, nowMs + offsetMs - parseAt(fromIso));
  const text = ageText(Math.floor(ageMs / 1000));
  return { text, exact: fromIso, tooltip: fromIso, label: text };
}

/** A table time `14:02:11` in UTC (the column header says UTC) or in local time when the setting asks. Tooltip: full ISO 8601. */
export function formatTime(iso: string | null, zone: 'utc' | 'local' = 'utc'): Formatted {
  if (iso === null) return UNKNOWN;
  const d = new Date(parseAt(iso));
  const [h, m, s] = zone === 'utc' ? [d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()] : [d.getHours(), d.getMinutes(), d.getSeconds()];
  const text = `${two(h)}:${two(m)}:${two(s)}`;
  return { text, exact: iso, tooltip: iso, label: text };
}

/** A slot (`*_slot` U64Str): plain digits, no separators (shown in mono). */
export function formatSlot(slot: string | null): Formatted {
  if (slot === null) return UNKNOWN;
  const text = parseU64Str(slot).toString();
  return { text, exact: text, tooltip: text, label: text };
}

/** Middle-truncates an address, mint or signature: the first `head` and last `tail` characters around `…`. */
export function truncateMiddle(value: string, head = 4, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}${ELLIPSIS}${value.slice(value.length - tail)}`;
}

export interface Sanitised {
  /** Display text: controls removed, whitespace collapsed, capped at maxChars with `…`. */
  text: string;
  /** The cleaned text before the cap (for the tooltip). */
  full: string;
  truncated: boolean;
  /** Bidi controls or other invisible characters were removed (an override attempt, or a look-alike). */
  removedControls: boolean;
  /** The letters come from more than one script. */
  mixedScript: boolean;
  /** Some letter is not Latin script (DS: show the "?" badge for non-Latin or mixed scripts). */
  nonLatin: boolean;
}

/**
 * Every format character (\p{Cf}: the bidi controls and marks, zero-width characters, U+FEFF, the soft hyphen U+00AD,
 * the invisible operators U+2060–U+2064, U+180E, the tag characters U+E0001–U+E007F) and every other default-ignorable
 * code point (variation selectors, Hangul fillers, U+034F): characters that render as nothing or reorder text.
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Cleans an untrusted string (token symbol or name, UI.md `Untrusted<string>`): strips every invisible character
 * (INVISIBLE: bidi controls, zero-width and other format characters, default-ignorable code points) and other control
 * characters; collapses whitespace; caps the length (symbol 12, name 32) with an ellipsis; reports mixed and non-Latin
 * scripts. Rendered as text only, never as HTML.
 */
export function sanitizeUntrusted(input: string, maxChars: number): Sanitised {
  const stripped = input.replace(INVISIBLE, '');
  const full = stripped.replace(/[\s\p{Cc}]+/gu, ' ').trim();
  const chars = [...full];
  const truncated = chars.length > maxChars;
  const text = truncated ? `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}${ELLIPSIS}` : full;
  const scripts = new Set([...full].filter((c) => /\p{L}/u.test(c)).map(scriptOf));
  return {
    text, full, truncated,
    removedControls: stripped.length !== input.length,
    mixedScript: scripts.size > 1,
    nonLatin: [...scripts].some((s) => s !== 'Latin'),
  };
}

const SCRIPTS: ReadonlyArray<[string, RegExp]> = [
  ['Latin', /\p{Script=Latin}/u], ['Cyrillic', /\p{Script=Cyrillic}/u], ['Greek', /\p{Script=Greek}/u],
  ['Armenian', /\p{Script=Armenian}/u], ['Hebrew', /\p{Script=Hebrew}/u], ['Arabic', /\p{Script=Arabic}/u],
  ['Han', /\p{Script=Han}/u], ['Hiragana', /\p{Script=Hiragana}/u], ['Katakana', /\p{Script=Katakana}/u],
  ['Hangul', /\p{Script=Hangul}/u], ['Thai', /\p{Script=Thai}/u], ['Devanagari', /\p{Script=Devanagari}/u],
  ['Cherokee', /\p{Script=Cherokee}/u], ['Georgian', /\p{Script=Georgian}/u],
];

/** The script of a letter (one of SCRIPTS, else "Other"). */
export function scriptOf(letter: string): string {
  return SCRIPTS.find(([, re]) => re.test(letter))?.[0] ?? 'Other';
}
