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
  PATTERNS, SUMMARY_MAX_BYTES, fits, SUMMARY_MAX_TRADES, SUMMARY_TOP_REASONS, SUMMARY_VERSION, checkSummary,
  type CodeCount, type ProviderCredits, type ReasonCount, type Summary, type SummaryTrade,
} from '../../../ops/src/watchdog/summary.ts';
import type { MicroUsd } from '../../../core/src/units/index.ts';
import type { HttpClient } from '../providers/index.ts';
import type { PaperTrade } from './account.ts';
import { lamportsUsd, melbourneDate, usdText } from './api.ts';
import { SEEDING } from '../engine/strategy.ts';
import { StateFile } from './state.ts';

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
    if (line['phase'] !== 'reconcile') day.starts += 1;
    day.recorder = line['recorder'] === true || line['recorder'] === 'on' ? 'on' : line['recorder'] === false || line['recorder'] === 'off' ? 'off' : null;
    day.gitSha = fits(line['git_sha'], PATTERNS.SHA) ? line['git_sha'] : null;
    day.entryRule = fits(line['entry_rule'], PATTERNS.RULE) ? line['entry_rule'] : 'other';
    // A new process starts halted ('starting'); its first halt line is a new halt.
    s.halts = [];
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
  readonly credits: readonly { readonly provider: string; readonly credits_used: number; readonly monthly_credits: number | null }[];
}

const iso = (ms: number): string => new Date(ms).toISOString();
const byCount = <T extends { count: number }>(a: T, b: T, ka: string, kb: string): number => b.count - a.count || (ka < kb ? -1 : ka > kb ? 1 : 0);
const counts = (m: Record<string, number>): CodeCount[] =>
  Object.entries(m).map(([c, n]) => ({ code: c, count: n })).sort((a, b) => byCount(a, b, a.code, b.code)).slice(0, 64);

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
    .map((q) => ({ provider: q.provider, used_since_boot: Math.max(0, Math.round(q.credits_used)), monthly: q.monthly_credits === null ? null : Math.max(0, Math.round(q.monthly_credits)) }));
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

/** The body to post, or null with the reason when either guard refuses it (then nothing is sent). */
export const summaryBody = (s: Summary): { readonly body: string } | { readonly refused: string } => {
  let body = JSON.stringify(s);
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
    if (size !== null && size < this.#state.offset) this.#state = { ...emptySummaryState(), lastDay: this.#state.lastDay ?? null };
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
      this.#save();
    }
    await this.#post(today, false, now);
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
    const b = summaryBody(s);
    if ('refused' in b) {
      this.#d.log(`Summary for ${day} not sent: ${b.refused}.`);
      return false;
    }
    // The watchdog takes each signature time once: two posts in one second get consecutive times.
    const t = Math.max(Math.floor(now / 1000), this.#lastT + 1);
    this.#lastT = t;
    const res = await postSummary(this.#d.http, url, key, b.body, t);
    if (!res.ok) this.#d.log(`Summary for ${day} not accepted: ${res.reason}.`);
    else if (!res.written) this.#d.log(`Summary for ${day} accepted, not written (the watchdog alerts why).`);
    return res.ok;
  }
}

/** Milliseconds to the next post: every `everyMs`, and just after the next Melbourne midnight. */
export const nextSummaryDelay = (nowMs: number, everyMs: number): number => {
  const today = melbourneDate(nowMs);
  // The first minute boundary at which the Melbourne date changes, found by stepping (DST-safe, at most a day).
  let lo = nowMs;
  let hi = nowMs + everyMs;
  if (melbourneDate(hi) === today) return everyMs;
  while (hi - lo > 1000) {
    const mid = Math.floor((lo + hi) / 2);
    if (melbourneDate(mid) === today) lo = mid;
    else hi = mid;
  }
  return Math.max(1000, hi - nowMs + 5_000);
};
