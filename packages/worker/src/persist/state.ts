// PERSIST-1: the deployer index, the rug labeller's tables and the coverage facts, saved and restored across
// restarts, so the RPC backfill runs once per host instead of once per boot (the rehearsal measured 14 boots × a
// 14-day create backfill ≈ 4,150 credits each, projecting 11.9M Helius credits a month). Only public chain data and
// our own labels are stored (supervisor approval under the stored-data ruling, 2026-10-04).
//
// Honesty rules:
// - the file carries its as-of moment, and nothing in it may be dated after it;
// - a restore never claims coverage beyond what was saved: every live watch that was covered at the save gets an
//   open `restart` gap at the saved moment, so the downtime reads as not covered until a fill closes it (a crash
//   leaves no gap of its own);
// - a missing, corrupt, truncated or version-mismatched file is discarded whole: the caller starts unseeded, which
//   is "not covered", never "clean";
// - the fill plan tops up only from the saved moment (or an older open gap) to now, within the daily credit budget.
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import type { RugConfig } from '../../../core/src/config/rugs.ts';
import { DAY_MS } from '../../../core/src/config/time.ts';
import { compareEvents, compareMoments, type MarketEvent, type Moment } from '../../../core/src/engine/index.ts';
import { DeployerIndex, RugLabeller, type DeployerIndexState, type RugLabellerState } from '../../../core/src/gates/index.ts';
import { SEED_VIA } from '../seed/seed.ts';
import { parseGraduatesSeed } from '../../../core/src/facts/raw.ts';
import type { SavedCandidate, SavedGraduates, SavedTail } from '../engine/strategy.ts';

export const STATE_VERSION = 1;

export interface SavedState {
  readonly asOf: Moment;
  readonly index: DeployerIndexState;
  readonly labeller: RugLabellerState;
  /** Every released `coverage:<stream>:start|gap|resume` fact, in release order. */
  readonly coverage: readonly MarketEvent[];
  /**
   * PERSIST-2: the regime's graduates series as of the save (`asOfMs` is the saved moment's receipt time). Optional, so
   * a file written before it still loads (with no series); when present it must hold up or the whole file is discarded.
   */
  readonly graduates?: SavedGraduates;
  /**
   * RESTART-KEEP: the candidates in their window as of the save, with the signatures of the transactions their gate
   * facts came from (null when this process did not see one). Optional, so an older file still loads (with none).
   * Public chain data and the strategy's own state (supervisor approval 2026-10-04 under the stored-data ruling of 2026-10-03).
   */
  readonly candidates?: readonly SavedCandidateState[];
  /** RESTART-KEEP: REC-1's tail watches (mint, pool, until when). Optional, so an older file still loads (with none). */
  readonly tails?: readonly SavedTail[];
}

/** A saved candidate and the transactions to read again at a restart: its create, curve completion and migration. */
export interface SavedCandidateState extends SavedCandidate {
  readonly signatures: { readonly create: string | null; readonly complete: string | null; readonly migration: string | null };
}

/** One open gap the restart must fill and close: pass `via`, `fromSlot` and `at` as the fill's `close`. */
export interface RestartFill {
  readonly stream: string;
  readonly via: string;
  readonly fromSlot: bigint | null;
  /** When the gap was reported (the fill's `close.at`). */
  readonly at: Moment;
  /** True when the restore made this gap (the watch was covered at the save); false for a gap the save already had. */
  readonly synthesized: boolean;
}

export type Restored =
  | {
    readonly ok: true;
    readonly asOf: Moment;
    readonly index: DeployerIndex;
    readonly labeller: RugLabeller;
    /** The saved coverage facts plus the restart gaps, in release order, none after `asOf`: release them first. */
    readonly coverage: readonly MarketEvent[];
    readonly fills: readonly RestartFill[];
    /** The saved graduates series (null when the file has none): release it as `read:graduates-seed` before any decision. */
    readonly graduates: SavedGraduates | null;
    /** The saved candidates (none when the file has none), for the restore fact. */
    readonly candidates: readonly SavedCandidateState[];
    /** The saved tail watches (none when the file has none), for the restore fact. */
    readonly tails: readonly SavedTail[];
  }
  | { readonly ok: false; readonly reason: string };

// bigint survives JSON as { "$bigint": "123" }; nothing else in the state has that shape.
const replacer = (_k: string, v: unknown): unknown => (typeof v === 'bigint' ? { $bigint: v.toString() } : v);
const reviver = (_k: string, v: unknown): unknown => {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (keys.length === 1 && keys[0] === '$bigint') {
      if (typeof o['$bigint'] !== 'string' || !/^-?\d+$/.test(o['$bigint'])) throw new RangeError('bad bigint');
      return BigInt(o['$bigint']);
    }
  }
  return v;
};

/** Writes atomically: a temporary file, flushed, then renamed over the old one. A crash leaves the old file whole. */
const writeAtomic = (path: string, text: string): void => {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
};

/**
 * The saved graduates must be dated at the saved moment, well formed, unique per mint, and none migrated after it
 * (each entry's survival mark, which the producer checks again, is later still). Throws the first problem.
 */
const graduatesProblem = (g: unknown, asOf: Moment, saving: boolean): void => {
  const r = parseGraduatesSeed(isObj(g) ? { ...g, source: 'persist' } : g);
  if (r === null) throw new RangeError('the graduates series is malformed');
  if (r.asOfMs !== asOf.receivedAt) throw new RangeError(`the graduates series is dated ${r.asOfMs}, not at the ${saving ? 'snapshot' : 'saved'} moment`);
  const seen = new Set<string>();
  for (const i of r.items) {
    if (i.migratedAtMs > r.asOfMs) throw new RangeError(`graduate ${i.mint} migrated after the ${saving ? 'snapshot' : 'saved'} moment`);
    if (seen.has(i.mint)) throw new RangeError(`graduate ${i.mint} appears twice`);
    seen.add(i.mint);
  }
};

const sig = (v: unknown): boolean => v === null || (typeof v === 'string' && v !== '');

/**
 * The saved candidates must be well formed, unique per mint, and none migrated or evaluated after the saved moment.
 * Throws the first problem (the strategy checks them again against its restore moment).
 */
const candidatesProblem = (c: unknown, asOf: Moment, saving: boolean): void => {
  if (!Array.isArray(c)) throw new RangeError('the candidates are not a list');
  const seen = new Set<string>();
  for (const x of c) {
    const ms = (v: unknown, nul: boolean): boolean => (nul && v === null) || (typeof v === 'number' && Number.isSafeInteger(v));
    if (!isObj(x) || typeof x['mint'] !== 'string' || x['mint'] === '' || !sig(x['pool']) || !ms(x['migratedAtMs'], false) || !ms(x['lastEvalMs'], true)
      || !(x['migrationSlot'] === null || (typeof x['migrationSlot'] === 'bigint' && x['migrationSlot'] >= 0n)) || !Number.isSafeInteger(x['tries']) || (x['tries'] as number) < 0
      || !(x['lastReason'] === null || typeof x['lastReason'] === 'string') || !Array.isArray(x['bars'])
      || !x['bars'].every((b) => isObj(b) && ms(b['startMs'], false) && ['high', 'low', 'close'].every((k) => typeof b[k] === 'bigint' && (b[k] as bigint) > 0n)) || !isObj(x['signatures']) || !['create', 'complete', 'migration'].every((k) => sig((x['signatures'] as Obj)[k]))) {
      throw new RangeError('a saved candidate is malformed');
    }
    const at = saving ? 'snapshot' : 'saved';
    if ((x['migratedAtMs'] as number) > asOf.receivedAt || ((x['lastEvalMs'] as number | null) ?? Number.NEGATIVE_INFINITY) > asOf.receivedAt || (x['bars'] as { startMs: number }[]).some((b) => b.startMs > asOf.receivedAt)) throw new RangeError(`candidate ${x['mint']} is dated after the ${at} moment`);
    if (seen.has(x['mint'])) throw new RangeError(`candidate ${x['mint']} appears twice`);
    seen.add(x['mint']);
  }
};

/** The saved tail watches must be well formed and unique per mint. Throws the first problem. */
const tailsProblem = (t: unknown): void => {
  if (!Array.isArray(t)) throw new RangeError('the tails are not a list');
  const seen = new Set<string>();
  for (const x of t) {
    if (!isObj(x) || typeof x['mint'] !== 'string' || x['mint'] === '' || typeof x['pool'] !== 'string' || x['pool'] === '' || !Number.isSafeInteger(x['untilMs'])) throw new RangeError('a saved tail is malformed');
    if (seen.has(x['mint'])) throw new RangeError(`tail ${x['mint']} appears twice`);
    seen.add(x['mint']);
  }
};

/** After `asOf` in the event order, or received later than it: either way not something the save could have known. */
const after = (m: Moment, asOf: Moment): boolean => compareMoments(m, asOf) > 0 || m.receivedAt > asOf.receivedAt;

export const saveState = (path: string, s: SavedState): void => {
  for (const e of s.coverage) {
    if (after(e.moment, s.asOf)) throw new RangeError(`coverage fact ${e.id} is dated after the snapshot moment`);
  }
  if (compareMoments(s.index.asOf, s.asOf) !== 0) throw new RangeError('the index snapshot was taken at another moment');
  if (s.graduates !== undefined) graduatesProblem(s.graduates, s.asOf, true);
  if (s.candidates !== undefined) candidatesProblem(s.candidates, s.asOf, true);
  if (s.tails !== undefined) tailsProblem(s.tails);
  const payload = JSON.stringify(s, replacer);
  writeAtomic(path, JSON.stringify({ version: STATE_VERSION, sha256: createHash('sha256').update(payload).digest('hex'), payload }));
};

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const COVERAGE_KEY = /^coverage:(.+):(start|gap|resume)$/;
const payloadOf = (v: unknown): Obj | null => (isObj(v) && isObj(v['value']) ? v['value'] : null);

const isMoment = (m: unknown): m is Moment =>
  isObj(m) && typeof m['slot'] === 'bigint' && Number.isSafeInteger(m['txIndex']) && Number.isSafeInteger(m['ixIndex']) && Number.isSafeInteger(m['receivedAt']);

/**
 * The open gaps per stream and `via` at the end of the saved coverage, and the vias that were covered (started, no
 * gap open), with the same reading as `createsCoverage`: a start settles that via's open gaps; a bounded gap or a
 * resume with the same `via` and `fromSlot` closes one.
 */
const openAtEnd = (coverage: readonly MarketEvent[]) => {
  const open = new Map<string, { stream: string; via: string; fromSlot: bigint | null; at: Moment }>();
  const started = new Map<string, { stream: string; via: string }>();
  for (const e of coverage) {
    const [, stream, kind] = COVERAGE_KEY.exec(e.key)!;
    const v = payloadOf(e.value)!;
    const via = v['via'] as string;
    const from = (v['fromSlot'] ?? null) as bigint | null;
    const sv = `${stream}|${via}`;
    if (kind === 'start') {
      started.set(sv, { stream: stream!, via });
      for (const k of [...open.keys()]) if (k.startsWith(`${sv}|`)) open.delete(k);
    } else if (kind === 'gap' && v['toSlot'] === null) open.set(`${sv}|${String(from)}`, { stream: stream!, via, fromSlot: from, at: e.moment });
    else open.delete(`${sv}|${String(from)}`);
  }
  return { open, started };
};

/**
 * Reads a saved state. Any defect discards the whole file (`ok: false` with the reason), so the caller starts as a
 * fresh process would. Every started via but the seed's backfill that was covered at the save gets an open `restart`
 * gap at the saved moment. `continuing(stream, via)` names the watches a live stream carries on after the restart (by
 * default all; the seed's backfill via never has an open or restart gap, so it never gets one); only those get a fill in
 * the plan. A stream nothing restarts stays not covered.
 */
export const loadState = (path: string, rugs: RugConfig, continuing: (stream: string, via: string) => boolean = () => true): Restored => {
  if (!existsSync(path)) return { ok: false, reason: 'no saved state' };
  let s: SavedState;
  try {
    const outer = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (!isObj(outer) || outer['version'] !== STATE_VERSION) return { ok: false, reason: `saved state version ${isObj(outer) ? String(outer['version']) : '?'} is not ${STATE_VERSION}` };
    const payload = outer['payload'];
    if (typeof payload !== 'string' || createHash('sha256').update(payload).digest('hex') !== outer['sha256']) return { ok: false, reason: 'saved state checksum does not match' };
    s = JSON.parse(payload, reviver) as SavedState;
  } catch (e) {
    return { ok: false, reason: `saved state unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  try {
    if (!isMoment(s.asOf)) throw new RangeError('no as-of moment');
    const asOf = s.asOf;
    if (!Array.isArray(s.coverage)) throw new RangeError('no coverage table');
    for (const e of s.coverage) {
      if (!isObj(e) || typeof e.id !== 'string' || typeof e.key !== 'string' || !COVERAGE_KEY.test(e.key) || !isMoment(e.moment)) throw new RangeError('bad coverage fact');
      const v = payloadOf(e.value);
      if (v === null || typeof v['via'] !== 'string') throw new RangeError(`coverage fact ${e.id} has no via`);
      if (after(e.moment, asOf)) throw new RangeError(`coverage fact ${e.id} is dated after the saved moment`);
    }
    if (!isObj(s.index) || !isMoment(s.index.asOf) || compareMoments(s.index.asOf, asOf) !== 0) throw new RangeError('the index was saved at another moment');
    if (s.graduates !== undefined) graduatesProblem(s.graduates, asOf, false);
    if (s.candidates !== undefined) candidatesProblem(s.candidates, asOf, false);
    if (s.tails !== undefined) tailsProblem(s.tails);
    const index = DeployerIndex.restore(s.index);
    const labeller = RugLabeller.restore(rugs, s.labeller, asOf);
    const coverage = [...s.coverage].sort(compareEvents);
    const { open, started } = openAtEnd(coverage);
    const fills: RestartFill[] = [...open.values()].filter((g) => continuing(g.stream, g.via)).map((g) => ({ ...g, synthesized: false }));
    const restart: MarketEvent[] = [];
    for (const [sv, w] of started) {
      // Every started via but the seed's backfill gets the gap, continued or not: a stream nothing restarts must stay
      // not covered, never read as covered across the downtime (#71 review). `continuing` only filters the fill plan.
      if (w.via === SEED_VIA || [...open.keys()].some((k) => k.startsWith(`${sv}|`))) continue;
      // Dated at the saved moment: after every saved fact, and before anything the new process sees.
      const id = `persist:restart:${w.stream}:${w.via}`;
      restart.push({ kind: 'market', id, moment: asOf, key: `coverage:${w.stream}:gap`, value: { value: { fromSlot: asOf.slot, toSlot: null, reason: 'restart', via: w.via }, source: 'worker', backfilled: true, seq: 0 } });
      if (continuing(w.stream, w.via)) fills.push({ stream: w.stream, via: w.via, fromSlot: asOf.slot, at: asOf, synthesized: true });
    }
    fills.sort((a, b) => (a.stream < b.stream ? -1 : a.stream > b.stream ? 1 : a.via < b.via ? -1 : a.via > b.via ? 1 : 0));
    return { ok: true, asOf, index, labeller, coverage: [...coverage, ...restart].sort(compareEvents), fills, graduates: s.graduates ?? null, candidates: s.candidates ?? [], tails: s.tails ?? [] };
  } catch (e) {
    return { ok: false, reason: `saved state rejected: ${e instanceof Error ? e.message : String(e)}` };
  }
};

/**
 * The fill's daily credit budget, kept in its own small file so it survives a discarded state. A day is a UTC day.
 * A missing file is a first boot (the full budget); an unreadable one counts today as spent (fail safe on spend: a
 * corrupt budget must not let a reboot loop spend again).
 */
export class DailyBudget {
  readonly #path: string;
  readonly #daily: number;
  #day: string;
  #spent: number;

  private constructor(path: string, daily: number, day: string, spent: number) {
    this.#path = path;
    this.#daily = daily;
    this.#day = day;
    this.#spent = spent;
  }

  static load(path: string, daily: number, nowMs: number): DailyBudget {
    const day = dayOf(nowMs);
    if (!existsSync(path)) return new DailyBudget(path, daily, day, 0);
    try {
      const o = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (!isObj(o) || o['version'] !== 1 || typeof o['day'] !== 'string' || !Number.isSafeInteger(o['spent']) || (o['spent'] as number) < 0) throw new Error('bad budget file');
      // A file dated today or later (the clock stepped back since it was written) keeps its spend (WORKER-1c).
      return o['day'] >= day ? new DailyBudget(path, daily, o['day'] as string, o['spent'] as number) : new DailyBudget(path, daily, day, 0);
    } catch {
      return new DailyBudget(path, daily, day, daily);
    }
  }

  remaining(nowMs: number): number {
    this.#roll(nowMs);
    return Math.max(0, this.#daily - this.#spent);
  }

  /** Records credits spent and saves at once, so a crash right after a fill cannot forget it. */
  spend(credits: number, nowMs: number): void {
    if (!Number.isSafeInteger(credits) || credits < 0) throw new RangeError('credits must be a non-negative integer');
    this.#roll(nowMs);
    this.#spent += credits;
    writeAtomic(this.#path, JSON.stringify({ version: 1, day: this.#day, spent: this.#spent }));
  }

  /** Gives back credits reserved by `spend` and not used (never below zero). */
  refund(credits: number, nowMs: number): void {
    if (!Number.isSafeInteger(credits) || credits < 0) throw new RangeError('credits must be a non-negative integer');
    this.#roll(nowMs);
    this.#spent = Math.max(0, this.#spent - credits);
    writeAtomic(this.#path, JSON.stringify({ version: 1, day: this.#day, spent: this.#spent }));
  }

  #roll(nowMs: number): void {
    const day = dayOf(nowMs);
    // Only forward: a clock stepped back (NTP, a VM restore) keeps today's spend (WORKER-1c review).
    if (day > this.#day) {
      this.#day = day;
      this.#spent = 0;
    }
  }
}

const dayOf = (ms: number): string => new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
