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
import { existsSync, readFileSync } from 'node:fs';
import { atomicWrite, type WriteFn } from '../run/state.ts';
import type { RugConfig } from '../../../core/src/config/rugs.ts';
import { DAY_MS } from '../../../core/src/config/time.ts';
import { compareEvents, compareMoments, type MarketEvent, type Moment } from '../../../core/src/engine/index.ts';
import { DeployerIndex, RugLabeller, type DeployerIndexState, type RugLabellerState } from '../../../core/src/gates/index.ts';
import { SEED_VIA } from '../seed/seed.ts';

/** Written as version 2 (header line, then the payload); version 1 files (the payload inside the header) are still read. */
export const STATE_VERSION = 2;

export interface SavedState {
  readonly asOf: Moment;
  readonly index: DeployerIndexState;
  readonly labeller: RugLabellerState;
  /** Every released `coverage:<stream>:start|gap|resume` fact, in release order. */
  readonly coverage: readonly MarketEvent[];
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
    /** The index as saved, checked by restoring it (`index`): the seed carries this, so no second copy is made. */
    readonly indexState: DeployerIndexState;
    readonly labeller: RugLabeller;
    /** The saved coverage facts plus the restart gaps, in release order, none after `asOf`: release them first. */
    readonly coverage: readonly MarketEvent[];
    readonly fills: readonly RestartFill[];
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

/**
 * Writes atomically: a temporary file, every byte checked and flushed, then renamed over the old one. A crash or a short
 * write (a nearly full disk) leaves the old file whole (`atomicWrite`, #159 review N2).
 */
const writeAtomic = (path: string, text: string, write?: WriteFn): void => atomicWrite(path, text, write);

/** After `asOf` in the event order, or received later than it: either way not something the save could have known. */
const after = (m: Moment, asOf: Moment): boolean => compareMoments(m, asOf) > 0 || m.receivedAt > asOf.receivedAt;

export const saveState = (path: string, s: SavedState): void => {
  for (const e of s.coverage) {
    if (after(e.moment, s.asOf)) throw new RangeError(`coverage fact ${e.id} is dated after the snapshot moment`);
  }
  if (compareMoments(s.index.asOf, s.asOf) !== 0) throw new RangeError('the index snapshot was taken at another moment');
  const payload = JSON.stringify(s, replacer);
  // Version 2 (WORKER-GROW): a header line, then the payload as it is. Version 1 carried the payload as a JSON string
  // inside the header, so a save and a load each made a second, escaped copy of it (about 65 MB at a full look-back).
  writeAtomic(path, `${JSON.stringify({ version: STATE_VERSION, sha256: createHash('sha256').update(payload).digest('hex'), bytes: payload.length })}\n${payload}`);
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
    const text = readFileSync(path, 'utf8');
    const nl = text.indexOf('\n');
    const outer = JSON.parse(nl === -1 ? text : text.slice(0, nl)) as unknown;
    if (!isObj(outer) || (outer['version'] !== STATE_VERSION && outer['version'] !== 1)) return { ok: false, reason: `saved state version ${isObj(outer) ? String(outer['version']) : '?'} is not ${STATE_VERSION} or 1` };
    // Version 2: the payload follows the header line, exactly `bytes` long. Version 1: it is a string inside the header.
    const payload = outer['version'] === 1 ? outer['payload'] : nl === -1 ? null : text.slice(nl + 1);
    if (outer['version'] !== 1 && (typeof payload !== 'string' || payload.length !== outer['bytes'])) return { ok: false, reason: 'saved state payload is cut or longer than its header says' };
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
    return { ok: true, asOf, index, indexState: s.index, labeller, coverage: [...coverage, ...restart].sort(compareEvents), fills };
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
