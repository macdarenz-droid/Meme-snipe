// OPS-SUMMARY: the daily summary the worker posts to the watchdog's /summary (signed like the heartbeat), which writes
// it to the private reports repository (packages/ops/src/watchdog/reports.ts). The shape and both guards live in
// packages/ops/src/watchdog/summary.ts and run here before every post.
//
// Counts come from journal.jsonl, read forward from a saved byte offset (summary.json in the state directory, written
// atomically with the counts), so a restart neither loses nor double-counts a line. Trades come from the paper account
// (account.json). Everything here is best effort and never throws to its caller: trading and recording never wait on a
// summary or fail because of one.
import { createHmac } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import {
  CREDIT_DETAIL_KEYS, EXIT_KINDS, MEM_SUMMARY_KEY, PATTERNS, RESTART_CAUSE_KEYS, type LastDeath, SUMMARY_MAX_BYTES, SUMMARY_MAX_CRASH_SITES, fits, SUMMARY_MAX_TRADES, SUMMARY_TOP_REASONS, SUMMARY_VERSION, checkSummary,
  type CodeCount, type CrashSite, type ProviderCredits, type ReasonCount, type Summary, type SummaryTrade,
} from '../../../ops/src/watchdog/summary.ts';
import type { MicroUsd } from '../../../core/src/units/index.ts';
import { HELIUS_EXHAUSTED, type HttpClient } from '../providers/index.ts';
import type { PaperTrade } from './account.ts';
import { lamportsUsd, melbourneDate, usdText } from './api.ts';
import { SEEDING } from '../engine/strategy.ts';
import { DISK_LOW } from './disk.ts';
import { StateFile } from './state.ts';
import { parseDeathMem, type DeathMem } from './mem-trace.ts';
import { melbourneDay } from '../../../core/src/risk/index.ts';
import type { TimerHandle, Timers } from '../scheduler/timers.ts';

/** One day's counts, folded from its journal lines. */
export interface DayFold {
  starts: number;
  recorder: 'on' | 'off' | null;
  gitSha: string | null;
  entryRule: string | null;
  alerts: Record<string, number>;
  halts: Record<string, number>;
  /** Per candidate mint: its last refusal (gate, code) or null, and whether it was entered. */
  cands: Record<string, { gate: string | null; code: string | null; entered: boolean }>;
  /** RESTART-CAUSE: restarts by kind, previous exits by kind, and crashes by site (a JSON key of error, file, line, event). Absent in older state. */
  restarts?: Record<string, number>;
  exits?: Record<string, number>;
  crashSites?: Record<string, number>;
  /** MEM-SUMMARY: the day's last start line's `death_mem` (the process before it died with no stop line). Absent in older state. */
  lastDeath?: DeathMem;
}

export interface SummaryState {
  readonly v: 1;
  /** Bytes of journal.jsonl already folded (always at the end of a whole line). */
  offset: number;
  /** The halt codes up at the last halt or resume line, so a halt is counted when it starts, not on every line. */
  halts: string[];
  days: Record<string, DayFold>;
  /** The last day posted (kept across restarts), so the day that ended gets its final post once. */
  lastDay?: string | null;
  /** When the watchdog last took a post (SUMMARY-CLOCK): a start soon after one does not post again. */
  last_posted_ms?: number | null;
}

export const emptySummaryState = (): SummaryState => ({ v: 1, offset: 0, halts: [], days: {}, lastDay: null });
/** Days kept in summary.json: today, yesterday (its final post) and one spare. */
const KEEP_DAYS = 3;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export const summaryFile = (dir: string) =>
  new StateFile<SummaryState>(dir, 'summary.json', (v) => (isObj(v) && v['v'] === 1 && typeof v['offset'] === 'number' && Array.isArray(v['halts']) && isObj(v['days']) ? (v as unknown as SummaryState) : null));

const emptyDay = (): DayFold => ({ starts: 0, recorder: null, gitSha: null, entryRule: null, alerts: {}, halts: {}, cands: {} });
const code = (v: unknown): string | null => (fits(v, PATTERNS.CODE) ? v : null);
const bump = (m: Record<string, number>, k: string): void => void (m[k] = (m[k] ?? 0) + 1);

/** A halt reason (worker.ts #checkHalt and the start's sell-only and divergence lines) as a fixed code; never its text. */
export const haltCode = (reason: string): string => {
  const feed = /^feed \S+ (dropped by drill|disconnected|stale)$/.exec(reason);
  if (feed !== null) return feed[1] === 'dropped by drill' ? 'feed-drill' : `feed-${feed[1]}`;
  if (reason === 'owner pause (watchdog)') return 'owner-pause';
  if (reason === 'second price path unavailable') return 'second-path-unavailable';
  if (reason === SEEDING) return 'seeding';
  if (reason === DISK_LOW) return 'disk-low';
  if (reason === HELIUS_EXHAUSTED) return 'helius-exhausted';
  if (reason === 'starting') return 'starting';
  if (reason.startsWith('sell-only')) return 'sell-only';
  if (reason.startsWith('ledger and book diverged') || reason.startsWith('ledger refused')) return 'ledger-diverged';
  return 'other';
};

/** A refusal's reason: the first typed gate reason (`gate_reasons`), or the worker's own when none is typed. */
const refusal = (line: Record<string, unknown>): { gate: string; code: string } => {
  const g = Array.isArray(line['gate_reasons']) ? line['gate_reasons'][0] : undefined;
  if (isObj(g) && fits(g['gate'], PATTERNS.GATE)) {
    const c = code(g['code']);
    if (c !== null) return { gate: g['gate'], code: c };
  }
  return { gate: 'worker', code: 'untyped' };
};

const RESTART_KINDS = new Set(['planned', 'deploy', 'unplanned']);
/** A stop line's crash site (crash-site.ts): `<name> at <file>:<line>|no frame in packages/[ during <event>]`. */
const SITE = /^(\S+) at (?:no frame in packages\/|(\S+):(\d{1,9}))(?: during (\S+))?$/;

/** A crash site's parts, each kept only when it fits its pattern (a file that does not fit drops its line too). */
export const parseCrashSite = (site: string): Omit<CrashSite, 'count'> | null => {
  const m = SITE.exec(site);
  if (m === null || !fits(m[1], PATTERNS.ERROR)) return null;
  const file = fits(m[2], PATTERNS.FILE) ? m[2] : null;
  return { error: m[1], file, line: file === null ? null : Number(m[3]), event: fits(m[4], PATTERNS.EVENT) ? m[4] : null };
};

const CANDIDATE_KINDS = new Set(['shortlist', 'reject', 'enter', 'no entry', 'risk approved']);

/** Folds one parsed journal line into its Melbourne day. Unknown or malformed lines change nothing. */
export const foldLine = (s: SummaryState, line: unknown): void => {
  if (!isObj(line) || typeof line['ts'] !== 'string') return;
  const ms = Date.parse(line['ts']);
  if (!Number.isFinite(ms)) return;
  const dayKey = melbourneDate(ms);
  const day = (s.days[dayKey] ??= emptyDay());
  const kind = line['kind'];
  const reasons = Array.isArray(line['reasons']) ? line['reasons'].filter((r): r is string => typeof r === 'string') : [];
  if (kind === 'start') {
    // The unit's `--reconcile` pre-step writes its own start line (RESTART-CAUSE): only real boots are counted.
    if (line['phase'] !== 'reconcile') {
      day.starts += 1;
      if (typeof line['restart'] === 'string' && RESTART_KINDS.has(line['restart'])) bump((day.restarts ??= {}), line['restart']);
      if ((EXIT_KINDS as readonly unknown[]).includes(line['exit'])) bump((day.exits ??= {}), line['exit'] as string);
      // HEAP-GUARD: a death on a fatal error leaves no stop line; the next boot's start line carries its site.
      const site = typeof line['crash_site'] === 'string' ? parseCrashSite(line['crash_site']) : null;
      if (site !== null) bump((day.crashSites ??= {}), JSON.stringify([site.error, site.file, site.line, site.event]));
      // MEM-SUMMARY: the dead process's memory, numbers only (checked again: a malformed one is dropped, never guessed).
      const dm = line['death_mem'] === undefined ? null : parseDeathMem(line['death_mem']);
      if (dm !== null) day.lastDeath = dm;
    }
    day.recorder = line['recorder'] === true || line['recorder'] === 'on' ? 'on' : line['recorder'] === false || line['recorder'] === 'off' ? 'off' : null;
    day.gitSha = fits(line['git_sha'], PATTERNS.SHA) ? line['git_sha'] : null;
    day.entryRule = fits(line['entry_rule'], PATTERNS.RULE) ? line['entry_rule'] : 'other';
    // A new process starts halted ('starting'); its first halt line is a new halt.
    s.halts = [];
  } else if (kind === 'stop') {
    const site = reasons[0] === 'crash' && reasons[1] !== undefined ? parseCrashSite(reasons[1]) : null;
    if (site !== null) bump((day.crashSites ??= {}), JSON.stringify([site.error, site.file, site.line, site.event]));
  } else if (kind === 'alert') {
    if (line['level'] === 'critical') bump(day.alerts, code(line['code']) ?? 'other');
  } else if (kind === 'halt' || kind === 'resume') {
    const now = kind === 'halt' ? [...new Set(reasons.map(haltCode))] : [];
    for (const c of now) if (!s.halts.includes(c)) bump(day.halts, c);
    s.halts = now;
  } else if (kind === 'decision') {
    const [k, , mint] = reasons;
    if (k === undefined || mint === undefined || !CANDIDATE_KINDS.has(k) || !fits(mint, PATTERNS.MINT)) return;
    const c = (day.cands[mint] ??= { gate: null, code: null, entered: false });
    if (k === 'reject') Object.assign(c, refusal(line));
  } else if (kind === 'entry') {
    const mint = line['mint'];
    if (typeof mint !== 'string' || !fits(mint, PATTERNS.MINT)) return;
    (day.cands[mint] ??= { gate: null, code: null, entered: false }).entered = true;
  }
};

/** Drops all but the newest KEEP_DAYS days. */
export const pruneDays = (s: SummaryState): void => {
  for (const d of Object.keys(s.days).sort().slice(0, -KEEP_DAYS)) delete s.days[d];
};

/**
 * Hands each whole line of `path` after `offset` to `onLine`, one chunk at a time, and never holds more than one chunk
 * (and one torn line) in memory: a long journal read from the start (the first run on a host, or a lost summary.json)
 * stays small. `onChunk` gets the offset after each chunk's last whole line, so the caller's offset advances as it
 * goes. A torn last line is left for the next read. A file now shorter than the offset (replaced) reads from the start.
 */
export const foldNewLines = async (
  path: string, offset: number, onLine: (text: string) => void, onChunk: (offset: number) => void = () => {}, chunk = 1 << 20,
): Promise<{ offset: number; reset: boolean }> => {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return { offset, reset: false };
  }
  const reset = size < offset;
  let pos = reset ? 0 : offset;
  const fh = await open(path, 'r');
  try {
    let carry = Buffer.alloc(0);
    while (pos + carry.length < size) {
      const n = Math.min(chunk, size - pos - carry.length);
      const b = Buffer.alloc(n);
      const { bytesRead } = await fh.read(b, 0, n, pos + carry.length);
      if (bytesRead === 0) break;
      const buf = carry.length === 0 ? b.subarray(0, bytesRead) : Buffer.concat([carry, b.subarray(0, bytesRead)]);
      const last = buf.lastIndexOf(0x0a);
      if (last === -1) {
        carry = buf;
        continue;
      }
      let start = 0;
      while (start <= last) {
        const end = buf.indexOf(0x0a, start);
        onLine(buf.toString('utf8', start, end));
        start = end + 1;
      }
      pos += last + 1;
      carry = Buffer.from(buf.subarray(last + 1));
      onChunk(pos);
    }
  } finally {
    await fh.close();
  }
  return { offset: pos, reset };
};

/** The ts of a journal line from its first bytes (the journal writes seq, then ts), without parsing the line. */
const TS = /^\{"seq":\d+,"ts":"([^"]+)"/;

/**
 * Folds one journal line's text, skipping lines older than `cutoffIso` before any JSON.parse (an old line costs a
 * prefix match only). Unreadable lines are skipped, never fatal.
 */
export const foldText = (s: SummaryState, text: string, cutoffIso: string): void => {
  const ts = TS.exec(text.slice(0, 80))?.[1];
  if (ts !== undefined && ts < cutoffIso) return;
  try {
    foldLine(s, JSON.parse(text));
  } catch {
    // Not a whole JSON line: skipped.
  }
};

/** Lines before this many days ago are not folded (KEEP_DAYS Melbourne days fit inside it). */
const FOLD_DAYS_MS = (KEEP_DAYS + 1) * 86_400_000;

export interface SummaryInputs {
  readonly day: string;
  readonly final: boolean;
  readonly nowMs: number;
  readonly fold: DayFold | undefined;
  /** The running process, used when the day has no start line of its own (the worker ran through midnight). */
  readonly gitSha: string;
  readonly entryRule: string;
  readonly recorder: 'on' | 'off';
  readonly uptimeS: number;
  readonly trades: readonly PaperTrade[];
  readonly openPositions: number;
  readonly solPrice: MicroUsd | null;
  readonly credits: readonly { readonly provider: string; readonly credits_used: number; readonly monthly_credits: number | null; readonly credits_by_class?: readonly number[] }[];
  /** HELIUS-EXHAUSTED: Helius's "max usage reached" answers since boot and the first one's time; null when not wired. */
  readonly heliusExhaustion?: { readonly count: number; readonly firstAtMs: number | null } | null;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const byCount = <T extends { count: number }>(a: T, b: T, ka: string, kb: string): number => b.count - a.count || (ka < kb ? -1 : ka > kb ? 1 : 0);
const counts = (m: Record<string, number>): CodeCount[] =>
  Object.entries(m).map(([c, n]) => ({ code: c, count: n })).sort((a, b) => byCount(a, b, a.code, b.code)).slice(0, 64);

const crashSites = (m: Record<string, number>): CrashSite[] =>
  Object.entries(m)
    .map(([k, n]) => {
      const [error, file, line, event] = JSON.parse(k) as [string, string | null, number | null, string | null];
      return { error, file, line, event, count: n };
    })
    .sort((a, b) => byCount(a, b, JSON.stringify(a), JSON.stringify(b)))
    .slice(0, SUMMARY_MAX_CRASH_SITES);

/** The book's exit reasons, as the app names them (api.ts EXIT_REASON); anything else is 'other'. */
const EXIT = new Set(['stop', 'trailing_stop', 'take_profit', 'max_hold', 'thesis_lost', 'liquidity', 'emergency']);
const exitReason = (t: PaperTrade): string | null => {
  if (t.closedAtMs === null) return null;
  const r = t.exitReasons?.find((x) => EXIT.has(x));
  return r ?? (t.stoppedOut ? 'stop' : 'other');
};

/** The day's summary, in the shape the watchdog accepts. Pure. */
export const buildSummary = (i: SummaryInputs): Summary => {
  const f = i.fold ?? emptyDay();
  const cands = Object.values(f.cands);
  const refusedBy = new Map<string, ReasonCount>();
  let refused = 0;
  for (const c of cands) {
    if (c.entered || c.code === null || c.gate === null) continue;
    refused += 1;
    const k = `${c.gate}/${c.code}`;
    const r = refusedBy.get(k);
    refusedBy.set(k, { gate: c.gate, code: c.code, count: (r?.count ?? 0) + 1 });
  }
  const reasons = [...refusedBy.values()].sort((a, b) => byCount(a, b, `${a.gate}/${a.code}`, `${b.gate}/${b.code}`));
  const top = reasons.slice(0, SUMMARY_TOP_REASONS);
  const inDay = (ms: number | null) => ms !== null && melbourneDate(ms) === i.day;
  const inScope = i.trades.filter((t) => inDay(t.openedAtMs) || inDay(t.closedAtMs) || (!i.final && t.closedAtMs === null));
  // A trade whose mint is not a mint address is counted, never listed (nothing unchecked reaches the text).
  const listed = inScope.filter((t) => fits(t.mint, PATTERNS.MINT));
  const closed = i.trades.filter((t) => inDay(t.closedAtMs));
  const netL = closed.reduce((s, t) => s + (t.netLamports ?? 0n), 0n);
  const netU = closed.reduce((s, t) => s + BigInt(t.netPnl ?? 0n), 0n);
  const trades: SummaryTrade[] = listed.slice(0, SUMMARY_MAX_TRADES).map((t) => ({
    mint: t.mint,
    opened_at: iso(t.openedAtMs),
    closed_at: t.closedAtMs === null ? null : iso(t.closedAtMs),
    size_usd: usdText(BigInt(t.notional)),
    exit_reason: exitReason(t),
    net_lamports: t.netLamports === null ? null : t.netLamports.toString(),
    net_usd: t.netPnl === null ? (t.netLamports === null ? null : usdText(lamportsUsd(t.netLamports, t.closeSolPrice ?? i.solPrice))) : usdText(BigInt(t.netPnl)),
  }));
  const credits: ProviderCredits[] = i.credits
    .filter((q) => fits(q.provider, PATTERNS.CODE))
    .slice(0, 16)
    .map((q) => {
      const base: ProviderCredits = { provider: q.provider, used_since_boot: Math.max(0, Math.round(q.credits_used)), monthly: q.monthly_credits === null ? null : Math.max(0, Math.round(q.monthly_credits)) };
      // HELIUS-EXHAUSTED: by class since boot (which reads spend), and Helius's "max usage reached" answers.
      const cls = q.credits_by_class;
      if (cls === undefined || cls.length !== 4) return base;
      const by = cls.map((c) => Math.max(0, Math.ceil(c))) as unknown as readonly [number, number, number, number];
      const x = q.provider === 'helius' ? i.heliusExhaustion ?? null : null;
      if (x === null) return { ...base, by_class: by };
      return { ...base, by_class: by, exhausted: { count: Math.max(0, Math.floor(x.count)), first_at: x.firstAtMs === null ? null : iso(x.firstAtMs) } };
    });
  const sha = f.gitSha ?? (fits(i.gitSha, PATTERNS.SHA) ? i.gitSha : 'unknown');
  return {
    v: SUMMARY_VERSION,
    day: i.day,
    final: i.final,
    generated_at: iso(i.nowMs),
    mode: 'paper',
    worker: {
      git_sha: sha,
      entry_rule: f.entryRule ?? (fits(i.entryRule, PATTERNS.RULE) ? i.entryRule : 'other'),
      uptime_s: Math.max(0, Math.floor(i.uptimeS)),
      starts: f.starts,
      recorder: f.recorder ?? i.recorder,
      restarts: { planned: f.restarts?.['planned'] ?? 0, deploy: f.restarts?.['deploy'] ?? 0, unplanned: f.restarts?.['unplanned'] ?? 0 },
      exits: counts(f.exits ?? {}),
      crash_sites: crashSites(f.crashSites ?? {}),
      last_death: f.lastDeath === undefined ? null : lastDeathOf(f.lastDeath),
    },
    alerts: counts(f.alerts),
    halts: counts(f.halts),
    candidates: {
      seen: cands.length,
      entered: cands.filter((c) => c.entered).length,
      refused,
      refused_by_reason: top,
      refused_other: reasons.slice(SUMMARY_TOP_REASONS).reduce((s, r) => s + r.count, 0),
    },
    trades,
    trades_dropped: inScope.length - trades.length,
    pnl: { closed_trades: closed.length, net_lamports: netL.toString(), net_usd: usdText(netU) },
    open_positions: i.openPositions,
    provider_credits: credits,
  };
};

/** A death's memory in the summary's form: times as ISO strings. */
const lastDeathOf = (d: DeathMem): LastDeath => ({
  at: iso(d.at), uptime_s: d.uptime_s, heap_used_mb: d.heap_used_mb, heap_limit_mb: d.heap_limit_mb, spaces: d.spaces.map((x) => ({ ...x })),
  sample: d.sample === null ? null : { ...d.sample, at: iso(d.sample.at) },
  ...(d.recent === undefined || d.recent.length === 0 ? {} : { recent: d.recent.map((p) => ({ at: iso(p.at), heap_used_mb: p.heap_used_mb, old_mb: p.old_mb, large_object_mb: p.large_object_mb, saving: p.saving, counts: p.counts.map((c) => ({ code: c.code, count: c.count })) })) }),
});

/** The summary without MEM-PROBE's samples in `last_death`, the shape a watchdog from MEM-SUMMARY to before MEM-PROBE accepts. */
export const withoutProbe = (s: Summary): Summary => {
  const d = (s.worker as { readonly last_death?: LastDeath | null }).last_death;
  if (d === undefined || d === null || !Object.hasOwn(d, 'recent')) return s;
  const { recent: _recent, ...rest } = d;
  return { ...s, worker: { ...s.worker, [MEM_SUMMARY_KEY]: rest } };
};
/** True when the summary carries MEM-PROBE's samples. */
const hasProbe = (s: Summary): boolean => withoutProbe(s) !== s;

/** The summary without MEM-SUMMARY's key of `worker`, the shape a watchdog from RESTART-CAUSE to before it accepts. */
export const withoutLastDeath = (s: Summary): Summary => {
  const w: Record<string, unknown> = { ...s.worker };
  delete w[MEM_SUMMARY_KEY];
  return { ...s, worker: w as unknown as Summary['worker'] };
};

/** The summary without RESTART-CAUSE's keys of `worker` (nor MEM-SUMMARY's), the shape a watchdog from before them accepts. */
export const withoutRestartCause = (s: Summary): Summary => {
  const w: Record<string, unknown> = { ...s.worker };
  for (const k of [...RESTART_CAUSE_KEYS, MEM_SUMMARY_KEY]) delete w[k];
  return { ...s, worker: w as unknown as Summary['worker'] };
};

/** The summary without HELIUS-EXHAUSTED's keys of each provider's credits, the shape a watchdog from before them accepts. */
export const withoutCreditDetail = (s: Summary): Summary => ({
  ...s,
  provider_credits: s.provider_credits.map((c) => {
    const o: Record<string, unknown> = { ...c };
    for (const k of CREDIT_DETAIL_KEYS) delete o[k];
    return o as unknown as ProviderCredits;
  }),
});

/** The body to post, or null with the reason when either guard refuses it (then nothing is sent). */
export const summaryBody = (summary: Summary): { readonly body: string } | { readonly refused: string } => {
  let s = summary;
  let body = JSON.stringify(s);
  // MEM-PROBE: over the size cap, the oldest probe samples go first (the trades stay listed while they can).
  const over = () => new TextEncoder().encode(body).length > SUMMARY_MAX_BYTES;
  while (over() && hasProbe(s)) {
    const d = (s.worker as { readonly last_death?: LastDeath | null }).last_death!;
    const recent = d.recent!.slice(1);
    s = recent.length === 0 ? withoutProbe(s) : { ...s, worker: { ...s.worker, [MEM_SUMMARY_KEY]: { ...d, recent } } };
    body = JSON.stringify(s);
  }
  // Over the size cap: list fewer trades (all are still counted) until it fits.
  let keep = s.trades.length;
  while (new TextEncoder().encode(body).length > SUMMARY_MAX_BYTES && keep > 0) {
    keep = Math.floor(keep / 2);
    body = JSON.stringify({ ...s, trades: s.trades.slice(0, keep), trades_dropped: s.trades_dropped + s.trades.length - keep });
  }
  const c = checkSummary(body);
  return c.ok ? { body } : { refused: c.reason };
};

export const signSummary = (key: string, t: number, body: string): string =>
  createHmac('sha256', key).update(`${t}\nPOST\n/summary\n${body}`).digest('hex');

export type PostResult = { readonly ok: true; readonly written: boolean } | { readonly ok: false; readonly reason: string };

/** One signed post. Never throws; the reason names no URL and no key. */
export const postSummary = async (http: HttpClient, url: string, key: string, body: string, t: number): Promise<PostResult> => {
  try {
    const res = await http({
      method: 'POST', url: `${url}/summary`, timeoutMs: 10_000, body,
      headers: { 'content-type': 'application/json', 'x-zeroed-signature': `t=${t},v1=${signSummary(key, t, body)}` },
    });
    if (res.status < 200 || res.status >= 300) return { ok: false, reason: `HTTP ${res.status}` };
    const reply = JSON.parse(res.text) as { written?: unknown };
    return { ok: true, written: reply.written === true };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.name : 'error' };
  }
};

export interface SummarizerDeps {
  readonly journalPath: string;
  readonly stateDir: string;
  readonly http: HttpClient;
  readonly watchdogUrl: string | null;
  readonly key: string | null;
  readonly now: () => number;
  readonly log: (line: string) => void;
  /** What the running worker knows now: its trades, positions, price and credits. */
  readonly live: () => Omit<SummaryInputs, 'day' | 'final' | 'nowMs' | 'fold'>;
  /** The summary builder (buildSummary unless a test swaps it, to show the guard stops a bad summary before any post). */
  readonly build?: (i: SummaryInputs) => Summary;
}

/**
 * Folds new journal lines and posts today's summary; after Melbourne midnight it first posts the day that ended, marked
 * final. Every failure is logged and swallowed. `tick` resolves when done and never rejects.
 */
export class Summarizer {
  readonly #d: SummarizerDeps;
  readonly #file: StateFile<SummaryState>;
  #state: SummaryState;
  #lastT = 0;
  #busy = false;

  constructor(d: SummarizerDeps) {
    this.#d = d;
    this.#file = summaryFile(d.stateDir);
    try {
      this.#state = this.#file.read(emptySummaryState());
    } catch {
      // An unreadable summary.json never stops the worker: count again from the start of the journal.
      d.log('summary.json unreadable; counting again from the journal.');
      this.#state = emptySummaryState();
    }
  }

  get state(): SummaryState {
    return this.#state;
  }

  /** When the watchdog last took a post, kept across restarts; null before the first. */
  get lastPostedMs(): number | null {
    return this.#state.last_posted_ms ?? null;
  }

  async tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      await this.#tick();
    } catch (e) {
      this.#d.log(`Summary skipped: ${e instanceof Error ? e.name : 'error'}.`);
    } finally {
      this.#busy = false;
    }
  }

  async #tick(): Promise<void> {
    const now = this.#d.now();
    const cutoff = new Date(now - FOLD_DAYS_MS).toISOString();
    const size = await stat(this.#d.journalPath).then((x) => x.size, () => null);
    // A journal shorter than the offset was replaced: count again from its start.
    if (size !== null && size < this.#state.offset) this.#state = { ...emptySummaryState(), lastDay: this.#state.lastDay ?? null, last_posted_ms: this.#state.last_posted_ms ?? null };
    const state = this.#state;
    const r = await foldNewLines(this.#d.journalPath, state.offset, (text) => foldText(state, text, cutoff), (offset) => {
      state.offset = offset;
    });
    state.offset = r.offset;
    pruneDays(state);
    const today = melbourneDate(now);
    const last = this.#state.lastDay ?? null;
    // The day that ended is posted final until the watchdog takes it (kept while its counts are kept).
    const ended = last !== null && last < today && this.#state.days[last] !== undefined ? last : null;
    if (ended === null) this.#state.lastDay = today;
    this.#save();
    if (ended !== null && (await this.#post(ended, true, now))) {
      this.#state.lastDay = today;
      this.#state.last_posted_ms = now;
      this.#save();
    }
    if (await this.#post(today, false, now)) {
      this.#state.last_posted_ms = now;
      this.#save();
    }
  }

  #save(): void {
    try {
      this.#file.write(this.#state);
    } catch {
      this.#d.log('summary.json not written; the counts are kept in memory.');
    }
  }

  /** True when the watchdog took the post (written or not: a write failure is its alert, not a reason to resend). */
  async #post(day: string, final: boolean, now: number): Promise<boolean> {
    const { watchdogUrl: url, key } = this.#d;
    if (url === null || key === null) return false;
    const s = (this.#d.build ?? buildSummary)({ ...this.#d.live(), day, final, nowMs: now, fold: this.#state.days[day] });
    let res = await this.#send(day, s, url, key, now);
    // A watchdog from before MEM-SUMMARY refuses its key, one from before HELIUS-EXHAUSTED the credit detail too, one
    // from before RESTART-CAUSE its keys too (a deploy is not atomic): the day goes again without each in turn.
    let sent = s;
    // A watchdog from before MEM-PROBE refuses its samples: the day goes again without them, then as below.
    if (res !== null && !res.ok && res.reason === 'HTTP 400' && hasProbe(sent)) {
      this.#d.log(`Summary for ${day} refused; sent again without the memory probe samples.`);
      sent = withoutProbe(sent);
      res = await this.#send(day, sent, url, key, now);
    }
    if (res !== null && !res.ok && res.reason === 'HTTP 400' && Object.hasOwn(s.worker, MEM_SUMMARY_KEY)) {
      this.#d.log(`Summary for ${day} refused; sent again without the memory at the last death.`);
      sent = withoutLastDeath(sent);
      res = await this.#send(day, sent, url, key, now);
    }
    const detail = sent.provider_credits.some((c) => CREDIT_DETAIL_KEYS.some((k) => Object.hasOwn(c, k)));
    if (detail && res !== null && !res.ok && res.reason === 'HTTP 400') {
      this.#d.log(`Summary for ${day} refused; sent again without the credit detail.`);
      sent = withoutCreditDetail(sent);
      res = await this.#send(day, sent, url, key, now);
    }
    if (res !== null && !res.ok && res.reason === 'HTTP 400') {
      this.#d.log(`Summary for ${day} refused; sent again without the restart counts.`);
      res = await this.#send(day, withoutRestartCause(withoutCreditDetail(sent)), url, key, now);
    }
    if (res === null) return false;
    if (!res.ok) this.#d.log(`Summary for ${day} not accepted: ${res.reason}.`);
    else if (!res.written) this.#d.log(`Summary for ${day} accepted, not written (the watchdog alerts why).`);
    return res.ok;
  }

  /** One checked, signed post; null when the guards refuse the summary (nothing is sent). */
  async #send(day: string, s: Summary, url: string, key: string, now: number): Promise<PostResult | null> {
    const b = summaryBody(s);
    if ('refused' in b) {
      this.#d.log(`Summary for ${day} not sent: ${b.refused}.`);
      return null;
    }
    // The watchdog takes each signature time once: two posts in one second get consecutive times.
    const t = Math.max(Math.floor(now / 1000), this.#lastT + 1);
    this.#lastT = t;
    return postSummary(this.#d.http, url, key, b.body, t);
  }
}

/** The scheduled posts land this long after each wall-clock slot (:00 and :30 with the default 30 minutes). */
const SLOT_LAG_MS = 60_000;
/** A reconciled start posts once, this long after it. */
export const SUMMARY_AFTER_START_MS = 180_000;
/** ... unless the watchdog took a post less than this long before. */
export const SUMMARY_MIN_GAP_MS = 600_000;

/**
 * Milliseconds to the next scheduled post: the next Melbourne wall-clock slot (every `everyMs` from local midnight, so
 * :00 and :30 with 30 minutes) plus a short lag, or just after the next Melbourne midnight when that comes first. The
 * slots come from the clock alone, never from when the process started, so a worker that restarts often still posts.
 */
export const nextSummaryDelay = (nowMs: number, everyMs: number): number => {
  const day = melbourneDay(nowMs);
  const lag = Math.min(SLOT_LAG_MS, Math.floor(everyMs / 30));
  const slot = day.start + (Math.floor((nowMs - day.start - lag) / everyMs) + 1) * everyMs + lag;
  return Math.max(1000, Math.min(slot, day.end + 5_000) - nowMs);
};

export interface SummaryClockDeps {
  readonly timers: Timers;
  readonly everyMs: number;
  /** One summary post; resolves when done and never rejects (Summarizer.tick). */
  readonly tick: () => Promise<void>;
  /** When the watchdog last took a post (Summarizer.lastPostedMs, from summary.json). */
  readonly lastPostedMs: () => number | null;
}

/**
 * SUMMARY-CLOCK: when the summary posts. On every wall-clock slot and just after Melbourne midnight (nextSummaryDelay),
 * and once SUMMARY_AFTER_START_MS after a reconciled start unless the watchdog took a post less than
 * SUMMARY_MIN_GAP_MS before (so a worker restarting every few seconds does not post on every start).
 */
export class SummaryClock {
  readonly #d: SummaryClockDeps;
  #slot: TimerHandle | null = null;
  #afterStart: TimerHandle | null = null;
  #stopped = false;

  constructor(d: SummaryClockDeps) {
    this.#d = d;
  }

  start(): void {
    const d = this.#d;
    const run = (): void => {
      if (this.#stopped) return;
      void d.tick().finally(() => {
        if (!this.#stopped) this.#slot = d.timers.setTimeout(run, nextSummaryDelay(d.timers.now(), d.everyMs));
      });
    };
    this.#slot = d.timers.setTimeout(run, nextSummaryDelay(d.timers.now(), d.everyMs));
    this.#afterStart = d.timers.setTimeout(() => {
      this.#afterStart = null;
      if (this.#stopped) return;
      const last = d.lastPostedMs();
      const ago = last === null ? null : d.timers.now() - last;
      if (ago !== null && ago >= 0 && ago < SUMMARY_MIN_GAP_MS) return;
      void d.tick();
    }, SUMMARY_AFTER_START_MS);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#slot !== null) this.#d.timers.clearTimeout(this.#slot);
    if (this.#afterStart !== null) this.#d.timers.clearTimeout(this.#afterStart);
  }
}
