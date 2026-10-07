// The daily summary (OPS-SUMMARY, docs/DECISIONS.md): what the paper worker did in one Melbourne day, built by the worker
// (packages/worker/src/run/summary.ts), posted signed to the watchdog's /summary, and written by the watchdog to a
// private GitHub repository the supervisor can read. It holds only the bot's own decisions and paper trades and public
// market data: never a key, token, URL, host, address on the network, chat id, wallet or personal data.
//
// Two guards, both run on both sides: `checkSummary` accepts only the exact shape below (every string an enum or a
// narrow pattern, no free text), and `forbiddenIn` refuses the whole text if any secret- or host-like pattern appears.
// No Cloudflare or Node API here: the worker imports this file too.

export const SUMMARY_VERSION = 1;
/** The largest body the watchdog accepts (bytes); the worker caps trades so a day fits. */
export const SUMMARY_MAX_BYTES = 64 * 1024;
/** The most trades one summary lists; the rest are counted in `trades_dropped`. */
export const SUMMARY_MAX_TRADES = 500;
/** How many refusal reasons the summary names; the rest are summed in `refused_other`. */
export const SUMMARY_TOP_REASONS = 10;

/** How the previous process ended, as counted in `worker.exits` (RESTART-CAUSE). */
export const EXIT_KINDS = ['clean', 'crash', 'killed', 'planned', 'oom'] as const;
/** The most crash sites one summary lists, most frequent first. */
export const SUMMARY_MAX_CRASH_SITES = 8;

/** Where a crash happened (RESTART-CAUSE): the error's name, the first frame inside packages/, and the event kind. Never a message. */
export interface CrashSite {
  readonly error: string;
  /** Null when no frame of the stack is inside packages/. */
  readonly file: string | null;
  readonly line: number | null;
  readonly event: string | null;
  readonly count: number;
}

export interface CodeCount {
  readonly code: string;
  readonly count: number;
}
export interface ReasonCount {
  readonly gate: string;
  readonly code: string;
  readonly count: number;
}
/**
 * H16-WHY: refused candidates by an H16 reason of their last refusal: its code, the input it names and the hard gate
 * that needed it. Fixed names only (a FactName and H1–H17); null when the journal line named none (a line from before
 * H16-WHY, or an evidence reason without one). A candidate counts once under each of its distinct H16 reasons.
 */
export interface H16Count {
  readonly code: string;
  readonly input: string | null;
  readonly needed_by: string | null;
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
/** HELIUS-EXHAUSTED: the provider's "credits used up" answers since boot, and the first one's time (null: none). */
export interface CreditExhaustion {
  readonly count: number;
  readonly first_at: string | null;
}
export interface ProviderCredits {
  readonly provider: string;
  readonly used_since_boot: number;
  readonly monthly: number | null;
  /** HELIUS-EXHAUSTED: credits since boot by class (P0–P3; stream bytes count as P3). With `exhausted`, only on Helius. */
  readonly by_class?: readonly [number, number, number, number];
  readonly exhausted?: CreditExhaustion;
}
export interface LastDeath {
  readonly at: string;
  readonly uptime_s: number | null;
  readonly heap_used_mb: number | null;
  readonly heap_limit_mb: number | null;
  readonly spaces: readonly { readonly space: string; readonly used_mb: number }[];
  readonly sample: { readonly at: string; readonly heap_used_mb: number; readonly heap_limit_mb: number; readonly rss_mb: number; readonly external_mb: number; readonly array_buffers_mb: number } | null;
  /**
   * MEM-PROBE: the worker's last memory probe samples before the death, oldest first: heap, old and large-object MB, a
   * save in progress, and the size of each major collection by code. Counts only. Optional: a worker from before it
   * still posts.
   */
  readonly recent?: readonly ProbeRow[];
}
export interface ProbeRow {
  readonly at: string;
  readonly heap_used_mb: number;
  readonly old_mb: number;
  readonly large_object_mb: number;
  readonly saving: boolean;
  readonly counts: readonly CodeCount[];
}

/** At most this many heap spaces in `last_death`. */
export const SUMMARY_MAX_SPACES = 16;
/** At most this many probe samples in `last_death.recent`, and counts in each. */
export const SUMMARY_MAX_PROBES = 10;
export const SUMMARY_MAX_PROBE_COUNTS = 96;

export interface Summary {
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
    // RESTART-CAUSE: all three or none. A worker from before them still posts (a deploy is not atomic: the watchdog
    // and the server update minutes or hours apart, in either order).
    /** Restarts that day other than the first boot, by kind. */
    readonly restarts?: { readonly planned: number; readonly deploy: number; readonly unplanned: number };
    /** How each previous process ended, as read at that day's boots; codes from EXIT_KINDS. */
    readonly exits?: readonly CodeCount[];
    /** That day's crashes by site, most frequent first, at most SUMMARY_MAX_CRASH_SITES. */
    readonly crash_sites?: readonly CrashSite[];
    /**
     * MEM-SUMMARY: the memory of that day's last process to die with no stop line, or null: when (node's fatal report, else
     * the last sample), its uptime, its heap used and limit, MB used per V8 space, and the last mem.json sample. Only
     * alongside RESTART-CAUSE's keys; a worker from before it still posts.
     */
    readonly last_death?: LastDeath | null;
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
    /**
     * H16-WHY: both or neither; present only when a refused candidate's last refusal had an H16 reason. Refused
     * candidates by H16 reason (code, input, needing gate), most frequent first, at most SUMMARY_TOP_REASONS; the rest
     * summed in `h16_other`. A candidate counts under each of its distinct H16 reasons. A worker from before them still posts.
     */
    readonly h16_by_input?: readonly H16Count[];
    readonly h16_other?: number;
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

/**
 * Narrow patterns for every string field. None allows '@' or whitespace. None allows ':' and '/' together: TIME and
 * EVENT allow ':' (no '/', no '.'), FILE allows '/' (no ':').
 */
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
  /** An Error's name, or 'non-error' for a thrown value that is not an Error (RESTART-CAUSE). */
  ERROR: /^[A-Za-z][A-Za-z0-9_-]{0,39}$/,
  /** A source file inside the repo's packages: the one pattern with '/', and it has no ':', so no URL fits. */
  FILE: /^packages\/[a-z0-9_-]+\/(src|test)\/[a-z0-9_\/.-]{1,120}\.[cm]?[jt]s$/,
  /** An engine event's kind, up to 3 parts joined by ':'. Every part starts with a letter and has no '.', so no host:port fits. */
  EVENT: /^[A-Za-z][A-Za-z0-9_-]{0,23}(:[A-Za-z][A-Za-z0-9_-]{0,23}){0,2}$/,
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

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> =>
  isObj(v) && Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k));
const count = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const str = (v: unknown, re: RegExp): boolean => typeof v === 'string' && re.test(v);
const strOrNull = (v: unknown, re: RegExp): boolean => v === null || str(v, re);
const list = (v: unknown, max: number, item: (x: unknown) => boolean): boolean => Array.isArray(v) && v.length <= max && v.every(item);

const codeCount = (x: unknown) => exact(x, ['code', 'count']) && str(x['code'], PATTERNS.CODE) && count(x['count']);
const reasonCount = (x: unknown) => exact(x, ['gate', 'code', 'count']) && str(x['gate'], PATTERNS.GATE) && str(x['code'], PATTERNS.CODE) && count(x['count']);
const h16Count = (x: unknown) =>
  exact(x, ['code', 'input', 'needed_by', 'count']) && str(x['code'], PATTERNS.CODE) && strOrNull(x['input'], PATTERNS.CODE) &&
  strOrNull(x['needed_by'], PATTERNS.GATE) && count(x['count']);
/** H16-WHY's keys of `candidates`: present both together or not at all. */
export const H16_KEYS = ['h16_by_input', 'h16_other'] as const;
const CANDIDATE_KEYS = ['seen', 'entered', 'refused', 'refused_by_reason', 'refused_other'] as const;
const candidates = (c: unknown): boolean =>
  (exact(c, CANDIDATE_KEYS) || (exact(c, [...CANDIDATE_KEYS, ...H16_KEYS]) && list(c['h16_by_input'], SUMMARY_TOP_REASONS, h16Count) && count(c['h16_other']))) &&
  count(c['seen']) && count(c['entered']) && count(c['refused']) && list(c['refused_by_reason'], SUMMARY_TOP_REASONS, reasonCount) && count(c['refused_other']);
const trade = (x: unknown) =>
  exact(x, ['mint', 'opened_at', 'closed_at', 'size_usd', 'exit_reason', 'net_lamports', 'net_usd']) &&
  str(x['mint'], PATTERNS.MINT) && str(x['opened_at'], PATTERNS.TIME) && strOrNull(x['closed_at'], PATTERNS.TIME) &&
  str(x['size_usd'], PATTERNS.USD) && strOrNull(x['exit_reason'], PATTERNS.CODE) &&
  strOrNull(x['net_lamports'], PATTERNS.LAMPORTS) && strOrNull(x['net_usd'], PATTERNS.USD);
const exitCount = (x: unknown) => exact(x, ['code', 'count']) && (EXIT_KINDS as readonly unknown[]).includes(x['code']) && count(x['count']);
const crashSite = (x: unknown) =>
  exact(x, ['error', 'file', 'line', 'event', 'count']) && str(x['error'], PATTERNS.ERROR) && strOrNull(x['file'], PATTERNS.FILE) &&
  (x['file'] === null ? x['line'] === null : count(x['line'])) && strOrNull(x['event'], PATTERNS.EVENT) && count(x['count']);
const restarts = (x: unknown) => exact(x, ['planned', 'deploy', 'unplanned']) && count(x['planned']) && count(x['deploy']) && count(x['unplanned']);
/** HELIUS-EXHAUSTED's keys of a provider's credits: `by_class` alone, or with `exhausted` (Helius); absent on an older worker. */
export const CREDIT_DETAIL_KEYS = ['by_class', 'exhausted'] as const;
const CREDIT_KEYS = ['provider', 'used_since_boot', 'monthly'] as const;
const byClass = (x: unknown) => Array.isArray(x) && x.length === 4 && x.every(count);
const exhaustion = (x: unknown) =>
  exact(x, ['count', 'first_at']) && count(x['count']) && (x['count'] === 0 ? x['first_at'] === null : str(x['first_at'], PATTERNS.TIME));
const credits = (x: unknown) =>
  (exact(x, CREDIT_KEYS) || (exact(x, [...CREDIT_KEYS, 'by_class']) && byClass(x['by_class'])) ||
    (exact(x, [...CREDIT_KEYS, ...CREDIT_DETAIL_KEYS]) && byClass(x['by_class']) && x['provider'] === 'helius' && exhaustion(x['exhausted']))) &&
  str(x['provider'], PATTERNS.CODE) && count(x['used_since_boot']) && (x['monthly'] === null || count(x['monthly']));

const WORKER_KEYS = ['git_sha', 'entry_rule', 'uptime_s', 'starts', 'recorder'] as const;
/** RESTART-CAUSE's keys of `worker`: present all together or not at all. */
export const RESTART_CAUSE_KEYS = ['restarts', 'exits', 'crash_sites'] as const;
const countOrNull = (v: unknown): boolean => v === null || count(v);
const probeRow = (y: unknown): boolean =>
  exact(y, ['at', 'heap_used_mb', 'old_mb', 'large_object_mb', 'saving', 'counts']) && str(y['at'], PATTERNS.TIME) &&
  count(y['heap_used_mb']) && count(y['old_mb']) && count(y['large_object_mb']) && typeof y['saving'] === 'boolean' &&
  list(y['counts'], SUMMARY_MAX_PROBE_COUNTS, (c) => exact(c, ['code', 'count']) && str(c['code'], PATTERNS.CODE) && count(c['count']));
const lastDeath = (x: unknown): boolean => x === null || (
  exact(x, ['at', 'uptime_s', 'heap_used_mb', 'heap_limit_mb', 'spaces', 'sample', ...(typeof x === 'object' && Object.hasOwn(x, 'recent') ? ['recent'] : [])]) && str(x['at'], PATTERNS.TIME) &&
  (!Object.hasOwn(x, 'recent') || list(x['recent'], SUMMARY_MAX_PROBES, probeRow)) &&
  countOrNull(x['uptime_s']) && countOrNull(x['heap_used_mb']) && countOrNull(x['heap_limit_mb']) &&
  list(x['spaces'], SUMMARY_MAX_SPACES, (y) => exact(y, ['space', 'used_mb']) && str(y['space'], PATTERNS.CODE) && count(y['used_mb'])) &&
  (x['sample'] === null || (exact(x['sample'], ['at', 'heap_used_mb', 'heap_limit_mb', 'rss_mb', 'external_mb', 'array_buffers_mb']) &&
    str(x['sample']['at'], PATTERNS.TIME) && ['heap_used_mb', 'heap_limit_mb', 'rss_mb', 'external_mb', 'array_buffers_mb'].every((k) => count((x['sample'] as Record<string, unknown>)[k])))));
/** MEM-SUMMARY's key of `worker`: optional, and only with RESTART-CAUSE's. */
export const MEM_SUMMARY_KEY = 'last_death';
const restartCause = (w: Record<string, unknown>): boolean =>
  RESTART_CAUSE_KEYS.some((k) => Object.hasOwn(w, k))
    ? exact(w, [...WORKER_KEYS, ...RESTART_CAUSE_KEYS, ...(Object.hasOwn(w, MEM_SUMMARY_KEY) ? [MEM_SUMMARY_KEY] : [])]) && restarts(w['restarts']) &&
      list(w['exits'], EXIT_KINDS.length, exitCount) && list(w['crash_sites'], SUMMARY_MAX_CRASH_SITES, crashSite) && (!Object.hasOwn(w, MEM_SUMMARY_KEY) || lastDeath(w[MEM_SUMMARY_KEY]))
    : exact(w, WORKER_KEYS);

/** The keys of every object in the shape, for the key-name test. */
export const SHAPE_KEYS: readonly string[] = [
  'v', 'day', 'final', 'generated_at', 'mode', 'worker', 'alerts', 'halts', 'candidates', 'trades', 'trades_dropped', 'pnl', 'open_positions', 'provider_credits',
  'git_sha', 'entry_rule', 'uptime_s', 'starts', 'recorder', 'restarts', 'exits', 'crash_sites', 'last_death',
  'at', 'heap_used_mb', 'heap_limit_mb', 'spaces', 'space', 'used_mb', 'sample', 'rss_mb', 'external_mb', 'array_buffers_mb',
  'recent', 'old_mb', 'large_object_mb', 'saving', 'counts',
  'planned', 'deploy', 'unplanned', 'error', 'file', 'line', 'event',
  'code', 'count', 'gate',
  'seen', 'entered', 'refused', 'refused_by_reason', 'refused_other', 'h16_by_input', 'h16_other', 'input', 'needed_by',
  'mint', 'opened_at', 'closed_at', 'size_usd', 'exit_reason', 'net_lamports', 'net_usd',
  'closed_trades',
  'provider', 'used_since_boot', 'monthly',
  'by_class', 'exhausted', 'first_at',
];

/** True only for a value of exactly the summary's shape. */
export const isSummary = (x: unknown): x is Summary => {
  if (!exact(x, SHAPE_KEYS.slice(0, 14))) return false;
  const w = x['worker'];
  const c = x['candidates'];
  const p = x['pnl'];
  return (
    x['v'] === SUMMARY_VERSION && str(x['day'], PATTERNS.DAY) && typeof x['final'] === 'boolean' && str(x['generated_at'], PATTERNS.TIME) && x['mode'] === 'paper' &&
    isObj(w) && restartCause(w) && str(w['git_sha'], PATTERNS.SHA) && str(w['entry_rule'], PATTERNS.RULE) &&
    count(w['uptime_s']) && count(w['starts']) && (w['recorder'] === null || w['recorder'] === 'on' || w['recorder'] === 'off') &&
    list(x['alerts'], 64, codeCount) && list(x['halts'], 64, codeCount) &&
    candidates(c) &&
    list(x['trades'], SUMMARY_MAX_TRADES, trade) && count(x['trades_dropped']) &&
    exact(p, ['closed_trades', 'net_lamports', 'net_usd']) && count(p['closed_trades']) && str(p['net_lamports'], PATTERNS.LAMPORTS) && str(p['net_usd'], PATTERNS.USD) &&
    count(x['open_positions']) && list(x['provider_credits'], 16, credits)
  );
};

export type SummaryCheck = { readonly ok: true; readonly summary: Summary; readonly text: string } | { readonly ok: false; readonly reason: string };

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
