// The daily summary (OPS-SUMMARY, docs/DECISIONS.md): what the paper worker did in one Melbourne day, built by the worker
// (packages/worker/src/run/summary.ts), posted signed to the watchdog's /summary, and written by the watchdog to a
// private GitHub repository the supervisor can read. It holds only the bot's own decisions and paper trades and public
// market data: never a key, token, URL, host, address on the network, chat id, wallet or personal data.
//
// Two guards, both run on both sides: `checkSummary` accepts only the exact shape below (every string an enum or a
// narrow pattern, no free text), and `forbiddenIn` refuses the whole text if any secret- or host-like pattern appears.
// No Cloudflare or Node API here: the worker imports this file too.

export const SUMMARY_VERSION = 2;
/** The most open positions one summary lists; the rest are counted in `open.unlisted`. */
export const SUMMARY_MAX_OPEN = 64;
/** The largest body the watchdog accepts (bytes); the worker caps trades so a day fits. */
export const SUMMARY_MAX_BYTES = 64 * 1024;
/** The most trades one summary lists; the rest are counted in `trades_dropped`. */
export const SUMMARY_MAX_TRADES = 500;
/** How many refusal reasons the summary names; the rest are summed in `refused_other`. */
export const SUMMARY_TOP_REASONS = 10;

export interface CodeCount {
  readonly code: string;
  readonly count: number;
}
export interface ReasonCount {
  readonly gate: string;
  readonly code: string;
  readonly count: number;
}
export interface SummaryTrade {
  readonly mint: string;
  readonly opened_at: string;
  readonly closed_at: string | null;
  readonly size_usd: string;
  readonly exit_reason: string | null;
  readonly net_lamports: string | null;
  readonly net_usd: string | null;
}
export interface ProviderCredits {
  readonly provider: string;
  readonly used_since_boot: number;
  readonly monthly: number | null;
}
/** An open paper position, valued now at what selling the whole size would return (null when it cannot be quoted). */
export interface SummaryOpenPosition {
  readonly mint: string;
  readonly opened_at: string;
  readonly cost_lamports: string;
  readonly value_lamports: string | null;
  readonly marked_net_lamports: string | null;
}
export interface Summary extends Omit<SummaryV1, 'v'> {
  readonly v: 2;
  /**
   * The owner's measure (CLAUDE.md, 2026-10-05): profit is counted in SOL, never dollars; dollar fields elsewhere are
   * secondary. Equity is the paper wallet plus what selling every open position would return now; it is null while a
   * position cannot be quoted or before the wallet has a SOL amount, never a guess.
   */
  readonly headline: {
    /** The paper wallet's SOL balance (never its address). */
    readonly balance_sol: string | null;
    readonly equity_sol: string | null;
    /** Trades closed this day. */
    readonly day_net_sol: string;
    /** Open positions, quotable ones only (see open.unquotable). */
    readonly open_marked_net_sol: string;
    /** This day's last equity minus the last equity of the previous day that has one; null without both. */
    readonly day_change_sol: string | null;
  };
  /** Open paper positions marked to their liquidation value now. An unquotable one is counted, never read as zero. */
  readonly open: {
    readonly positions: readonly SummaryOpenPosition[];
    /** Sum over the quotable positions only. */
    readonly marked_net_lamports: string;
    readonly unquotable: number;
    readonly unlisted: number;
  };
  /** The worker's resident memory (process.memoryUsage().rss, as /health reports it), sampled at each post that day. */
  readonly memory: {
    readonly rss_min_bytes: number | null;
    readonly rss_max_bytes: number | null;
    readonly rss_last_bytes: number | null;
    /** Today's last sample minus the previous day's last sample; null without both. */
    readonly rss_change_bytes: number | null;
  };
}
/** The first version (OPS-SUMMARY #155), still accepted from a worker that has not updated yet. */
export interface SummaryV1 {
  readonly v: 1;
  /** The Melbourne date (YYYY-MM-DD) this summary covers. */
  readonly day: string;
  /** True once the day has ended (the post after Melbourne midnight); false while it is still running. */
  readonly final: boolean;
  readonly generated_at: string;
  readonly mode: 'paper';
  readonly worker: {
    readonly git_sha: string;
    readonly entry_rule: string;
    readonly uptime_s: number;
    /** Worker starts journaled that day (the first boot of the day counts too). */
    readonly starts: number;
    readonly recorder: 'on' | 'off' | null;
  };
  /** Critical alerts raised that day, by code. */
  readonly alerts: readonly CodeCount[];
  /** Entry halts started that day, by reason code. */
  readonly halts: readonly CodeCount[];
  readonly candidates: {
    readonly seen: number;
    readonly entered: number;
    readonly refused: number;
    /** Each refused candidate's last refusal reason, most frequent first, at most SUMMARY_TOP_REASONS. */
    readonly refused_by_reason: readonly ReasonCount[];
    readonly refused_other: number;
  };
  /** Paper trades opened or closed that day, plus those still open. */
  readonly trades: readonly SummaryTrade[];
  readonly trades_dropped: number;
  /** Trades closed that day: their count and summed paper net. */
  readonly pnl: { readonly closed_trades: number; readonly net_lamports: string; readonly net_usd: string };
  readonly open_positions: number;
  /** Provider credits the scheduler counted since the worker's boot (Helius credits, Alchemy compute units). */
  readonly provider_credits: readonly ProviderCredits[];
}

/** Narrow patterns for every string field. None allows ':', '/', '@' or whitespace; only `MINT` and `DAY`/`TIME` allow nothing wider. */
export const PATTERNS = {
  DAY: /^\d{4}-\d{2}-\d{2}$/,
  TIME: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  /** At least one letter, so a bare number (a chat id) never passes as a sha, a code or a name. */
  SHA: /^(?:(?=[0-9]*[a-f])[0-9a-f]{7,40}|unknown)$/,
  /** A strategy name: none, S0 or a registered one. */
  RULE: /^(?=[^A-Za-z]*[A-Za-z])[A-Za-z0-9_-]{1,40}$/,
  /** Alert, halt and refusal codes, exit reasons and provider names. */
  CODE: /^(?=[^a-z]*[a-z])[a-z0-9_-]{1,48}$/,
  /** H1–H16, regime, worker, stop, R1–R14. */
  GATE: /^(?=[0-9]*[A-Za-z])[A-Za-z0-9]{1,16}$/,
  MINT: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  LAMPORTS: /^-?\d{1,20}$/,
  /** SOL as an exact decimal (lamports / 1e9, trailing zeros dropped). */
  SOL: /^-?\d{1,11}(\.\d{1,9})?$/,
  USD: /^-?\d{1,15}(\.\d{1,6})?$/,
} as const;

/**
 * Patterns that must never appear anywhere in a summary's text. A backstop: the shape check already leaves no room for
 * free text. Each name says what it catches.
 */
export const FORBIDDEN: readonly (readonly [string, RegExp])[] = [
  ['url', /[a-z][a-z0-9+.-]*:\/\//i],
  ['tailnet', /\.ts\.net\b|tailscale/i],
  ['hostname', /\b[a-z0-9-]+\.(?:[a-z0-9-]+\.)*(?:com|net|org|io|dev|app|cloud|internal|local|lan|xyz|sh|ai|co)\b/i],
  ['ipv4', /\b(?:\d{1,3}\.){3}\d{1,3}\b/],
  ['ipv6', /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{0,4}\b|[0-9a-f]{0,4}::[0-9a-f]{0,4}/i],
  ['github token', /github_pat_|\bgh[pousr]_[A-Za-z0-9]{16,}/],
  ['age key', /AGE-SECRET-KEY-|\bage1[a-z0-9]{50,}/i],
  ['telegram token', /\b\d{6,12}:[A-Za-z0-9_-]{30,}/],
  ['uuid key', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['long hex', /[0-9a-fA-F]{48,}/],
  ['long base58', /[1-9A-HJ-NP-Za-km-z]{60,}/],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/],
  ['private key', /PRIVATE KEY|BEGIN [A-Z ]+-----/],
];

/** Key names that must never be added to the shape (the shape test checks every key against this). */
export const FORBIDDEN_KEY = /chat|wallet|key|token|secret|host|ip$|^ip|addr|url|tailnet|password|seed|email|phone|name$/i;

/** The first forbidden pattern found in `text`, by name, or null. */
export const forbiddenIn = (text: string): string | null => {
  for (const [name, re] of FORBIDDEN) if (re.test(text)) return name;
  return null;
};

/** A value fits a field: it matches the field's pattern and holds no forbidden pattern. The worker keeps only these. */
export const fits = (v: unknown, re: RegExp): v is string => typeof v === 'string' && re.test(v) && forbiddenIn(v) === null;

/** Lamports as an exact SOL decimal string. */
export const solText = (lamports: bigint): string => {
  const neg = lamports < 0n;
  const a = neg ? -lamports : lamports;
  const frac = (a % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${a / 1_000_000_000n}${frac === '' ? '' : `.${frac}`}`;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  isObj(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const count = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const str = (v: unknown, re: RegExp): boolean => typeof v === 'string' && re.test(v);
const strOrNull = (v: unknown, re: RegExp): boolean => v === null || str(v, re);
const list = (v: unknown, max: number, item: (x: unknown) => boolean): boolean => Array.isArray(v) && v.length <= max && v.every(item);

const codeCount = (x: unknown) => exact(x, ['code', 'count']) && str(x['code'], PATTERNS.CODE) && count(x['count']);
const reasonCount = (x: unknown) => exact(x, ['gate', 'code', 'count']) && str(x['gate'], PATTERNS.GATE) && str(x['code'], PATTERNS.CODE) && count(x['count']);
const trade = (x: unknown) =>
  exact(x, ['mint', 'opened_at', 'closed_at', 'size_usd', 'exit_reason', 'net_lamports', 'net_usd']) &&
  str(x['mint'], PATTERNS.MINT) && str(x['opened_at'], PATTERNS.TIME) && strOrNull(x['closed_at'], PATTERNS.TIME) &&
  str(x['size_usd'], PATTERNS.USD) && strOrNull(x['exit_reason'], PATTERNS.CODE) &&
  strOrNull(x['net_lamports'], PATTERNS.LAMPORTS) && strOrNull(x['net_usd'], PATTERNS.USD);
const credits = (x: unknown) =>
  exact(x, ['provider', 'used_since_boot', 'monthly']) && str(x['provider'], PATTERNS.CODE) && count(x['used_since_boot']) && (x['monthly'] === null || count(x['monthly']));

/** The keys of every object in the shape, for the key-name test. */
export const SHAPE_KEYS: readonly string[] = [
  'v', 'day', 'final', 'generated_at', 'mode', 'worker', 'alerts', 'halts', 'candidates', 'trades', 'trades_dropped', 'pnl', 'open_positions', 'provider_credits',
  'git_sha', 'entry_rule', 'uptime_s', 'starts', 'recorder',
  'code', 'count', 'gate',
  'seen', 'entered', 'refused', 'refused_by_reason', 'refused_other',
  'mint', 'opened_at', 'closed_at', 'size_usd', 'exit_reason', 'net_lamports', 'net_usd',
  'closed_trades',
  'provider', 'used_since_boot', 'monthly',
  'open', 'memory', 'positions', 'cost_lamports', 'value_lamports', 'marked_net_lamports', 'unquotable', 'unlisted',
  'rss_min_bytes', 'rss_max_bytes', 'rss_last_bytes', 'rss_change_bytes',
  'headline', 'balance_sol', 'equity_sol', 'day_net_sol', 'open_marked_net_sol', 'day_change_sol',
];

const V1_KEYS = SHAPE_KEYS.slice(0, 14);
const int = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v);
const countOrNull = (v: unknown): boolean => v === null || count(v);
const openPosition = (x: unknown) =>
  exact(x, ['mint', 'opened_at', 'cost_lamports', 'value_lamports', 'marked_net_lamports']) && str(x['mint'], PATTERNS.MINT) && str(x['opened_at'], PATTERNS.TIME) &&
  str(x['cost_lamports'], PATTERNS.LAMPORTS) && strOrNull(x['value_lamports'], PATTERNS.LAMPORTS) && strOrNull(x['marked_net_lamports'], PATTERNS.LAMPORTS) &&
  (x['value_lamports'] === null) === (x['marked_net_lamports'] === null);

/** True only for a value of exactly the summary's shape (version 2, or version 1 from a worker not yet updated). */
export const isSummary = (x: unknown): x is Summary | SummaryV1 => {
  if (isObj(x) && x['v'] === 2) {
    if (!exact(x, [...V1_KEYS, 'headline', 'open', 'memory'])) return false;
    const hl = x['headline'];
    if (!(exact(hl, ['balance_sol', 'equity_sol', 'day_net_sol', 'open_marked_net_sol', 'day_change_sol']) && strOrNull(hl['balance_sol'], PATTERNS.SOL) &&
      strOrNull(hl['equity_sol'], PATTERNS.SOL) && str(hl['day_net_sol'], PATTERNS.SOL) && str(hl['open_marked_net_sol'], PATTERNS.SOL) &&
      strOrNull(hl['day_change_sol'], PATTERNS.SOL))) return false;
    const o = x['open'];
    const m = x['memory'];
    if (!(exact(o, ['positions', 'marked_net_lamports', 'unquotable', 'unlisted']) && list(o['positions'], SUMMARY_MAX_OPEN, openPosition) &&
      str(o['marked_net_lamports'], PATTERNS.LAMPORTS) && count(o['unquotable']) && count(o['unlisted']))) return false;
    if (!(exact(m, ['rss_min_bytes', 'rss_max_bytes', 'rss_last_bytes', 'rss_change_bytes']) && countOrNull(m['rss_min_bytes']) &&
      countOrNull(m['rss_max_bytes']) && countOrNull(m['rss_last_bytes']) && (m['rss_change_bytes'] === null || int(m['rss_change_bytes'])))) return false;
    const { headline: _h, open: _o, memory: _m, ...rest } = x;
    return isCommon({ ...rest, v: 1 });
  }
  return isCommon(x);
};

/** The fields both versions share, checked as version 1. */
const isCommon = (x: unknown): boolean => {
  if (!exact(x, V1_KEYS)) return false;
  const w = x['worker'];
  const c = x['candidates'];
  const p = x['pnl'];
  return (
    x['v'] === 1 && str(x['day'], PATTERNS.DAY) && typeof x['final'] === 'boolean' && str(x['generated_at'], PATTERNS.TIME) && x['mode'] === 'paper' &&
    exact(w, ['git_sha', 'entry_rule', 'uptime_s', 'starts', 'recorder']) && str(w['git_sha'], PATTERNS.SHA) && str(w['entry_rule'], PATTERNS.RULE) &&
    count(w['uptime_s']) && count(w['starts']) && (w['recorder'] === null || w['recorder'] === 'on' || w['recorder'] === 'off') &&
    list(x['alerts'], 64, codeCount) && list(x['halts'], 64, codeCount) &&
    exact(c, ['seen', 'entered', 'refused', 'refused_by_reason', 'refused_other']) && count(c['seen']) && count(c['entered']) && count(c['refused']) &&
    list(c['refused_by_reason'], SUMMARY_TOP_REASONS, reasonCount) && count(c['refused_other']) &&
    list(x['trades'], SUMMARY_MAX_TRADES, trade) && count(x['trades_dropped']) &&
    exact(p, ['closed_trades', 'net_lamports', 'net_usd']) && count(p['closed_trades']) && str(p['net_lamports'], PATTERNS.LAMPORTS) && str(p['net_usd'], PATTERNS.USD) &&
    count(x['open_positions']) && list(x['provider_credits'], 16, credits)
  );
};

export type SummaryCheck = { readonly ok: true; readonly summary: Summary | SummaryV1; readonly text: string } | { readonly ok: false; readonly reason: string };

/** Both guards on a body: size, JSON, exact shape, then no forbidden pattern anywhere. The reason names no value. */
export const checkSummary = (text: string): SummaryCheck => {
  if (new TextEncoder().encode(text).length > SUMMARY_MAX_BYTES) return { ok: false, reason: 'too large' };
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (!isSummary(x)) return { ok: false, reason: 'not the summary shape' };
  const bad = forbiddenIn(text);
  if (bad !== null) return { ok: false, reason: `forbidden pattern: ${bad}` };
  return { ok: true, summary: x, text };
};
