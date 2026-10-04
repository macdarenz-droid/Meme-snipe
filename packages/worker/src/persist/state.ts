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
import { closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, openSync, readFileSync, readSync, renameSync, rmSync } from 'node:fs';
import { Writable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createZstdCompress, createZstdDecompress } from 'node:zlib';
import { fileLines } from '../../../runner/src/lines.ts';
import { atomicWrite, writeAll, type WriteFn } from '../run/state.ts';
import type { RugConfig } from '../../../core/src/config/rugs.ts';
import { DAY_MS } from '../../../core/src/config/time.ts';
import { compareEvents, compareMoments, type MarketEvent, type Moment } from '../../../core/src/engine/index.ts';
import { DeployerIndex, RugLabeller, type DeployerIndexState, type RugLabellerState } from '../../../core/src/gates/index.ts';
import { SEED_VIA } from '../seed/seed.ts';

/** Written as version 2 (streamed lines, see `saveState`); version 1 files (the payload as a string inside one JSON object) are still read. */
export const STATE_VERSION = 2;

/** The saved state's file name, in the state dir and in a boot's recording (its copy). */
export const PERSIST_FILE = 'deployer-state.json';

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
    /** The file's format version (1 or 2). */
    readonly version: number;
    readonly index: DeployerIndex;
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

/** Writes atomically with every write checked (`atomicWrite`, #159 review N2): a failure leaves the old file whole. */
const writeAtomic = (path: string, text: string, write?: WriteFn): void => atomicWrite(path, text, write);

/** After `asOf` in the event order, or received later than it: either way not something the save could have known. */
const after = (m: Moment, asOf: Moment): boolean => compareMoments(m, asOf) > 0 || m.receivedAt > asOf.receivedAt;

/** The first line of a version 2 file. */
export const STATE_FORMAT = 'zeroed-deployer-state';

type MintRow = readonly [string, readonly (readonly [string, number])[]];

/**
 * Saves the state, streamed (version 2, WORKER-GROW): a format line; the payload with the index's mint rows left out;
 * one line per creator's mint row (`mintRows`, else the rows of `s.index.mints`); a last line with the sha256 of every
 * line between the first and the last (each with its newline) and their count. Nothing is held whole: at a full
 * look-back the old single payload string was about 65 MB, twice over. Written to a temp file with every write checked,
 * flushed, then renamed (#159 review N2): a failure leaves the old file whole.
 */
export const saveState = (path: string, s: SavedState, o: { readonly mintRows?: Iterable<MintRow>; readonly write?: WriteFn } = {}): void => {
  for (const e of s.coverage) {
    if (after(e.moment, s.asOf)) throw new RangeError(`coverage fact ${e.id} is dated after the snapshot moment`);
  }
  if (compareMoments(s.index.asOf, s.asOf) !== 0) throw new RangeError('the index snapshot was taken at another moment');
  if (o.mintRows !== undefined && s.index.mints.length > 0) throw new RangeError('mint rows given twice');
  const rows: Iterable<MintRow> = o.mintRows ?? s.index.mints;
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w', 0o600);
  const hash = createHash('sha256');
  let lines = 0;
  let out: string[] = [];
  let bytes = 0;
  const flush = (): void => {
    if (out.length > 0) writeAll(fd, out.join(''), o.write);
    out = [];
    bytes = 0;
  };
  const line = (text: string, hashed: boolean): void => {
    const l = `${text}\n`;
    if (hashed) {
      hash.update(l);
      lines++;
    }
    out.push(l);
    bytes += l.length;
    if (bytes >= 1 << 20) flush();
  };
  try {
    line(JSON.stringify({ format: STATE_FORMAT, version: STATE_VERSION }), false);
    line(JSON.stringify({ ...s, index: { ...s.index, mints: [] } }, replacer), true);
    for (const r of rows) line(JSON.stringify(r), true);
    line(JSON.stringify({ sha256: hash.digest('hex'), lines }), false);
    flush();
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(tmp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(tmp, path);
};

/** The sha256 of a file's bytes, read in chunks (the recording copy's binding, WORKER-GROW). */
export const fileSha256 = (path: string): string => {
  const hash = createHash('sha256');
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(1 << 20);
    for (let n = readSync(fd, buf, 0, buf.length, null); n > 0; n = readSync(fd, buf, 0, buf.length, null)) hash.update(buf.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return hash.digest('hex');
};

/** A file's size and sha256. */
export interface FileHash {
  readonly bytes: number;
  readonly sha256: string;
}

/** A pass-through stream that hashes and counts what goes by. */
const hashing = (): { readonly stream: Transform; readonly result: () => FileHash } => {
  const hash = createHash('sha256');
  let bytes = 0;
  const stream = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      bytes += chunk.length;
      done(null, chunk);
    },
  });
  return { stream, result: () => ({ bytes, sha256: hash.digest('hex') }) };
};

const discard = (): Writable => new Writable({ write: (_c, _e, done) => done() });

/** The size and sha256 of a zstd file's content, streamed (never held whole). */
export const zstdContentHash = async (zst: string): Promise<FileHash> => {
  const h = hashing();
  await pipeline(createReadStream(zst), createZstdDecompress(), h.stream, discard());
  return h.result();
};

/**
 * G4c: a recording's saved-state copy, packed to `<path>.zst` by streaming (memory stays flat), flushed, and checked to
 * decompress to exactly the plain bytes (`content`) before the plain copy is removed. On any failure the plain copy
 * stays and the partial `.zst` is removed. Returns the packed file's own size and hash, and its content's.
 */
export const packFile = async (path: string, content: FileHash): Promise<{ readonly packed: FileHash; readonly content: FileHash }> => {
  const zst = `${path}.zst`;
  const tmp = `${zst}.tmp`;
  try {
    const h = hashing();
    await pipeline(createReadStream(path), createZstdCompress(), h.stream, createWriteStream(tmp, { mode: 0o600 }));
    const fd = openSync(tmp, 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const back = await zstdContentHash(tmp);
    if (back.sha256 !== content.sha256 || back.bytes !== content.bytes) throw new Error(`packed copy decompresses to sha256 ${back.sha256} (${back.bytes} bytes), not ${content.sha256} (${content.bytes} bytes)`);
    renameSync(tmp, zst);
    rmSync(path);
    return { packed: h.result(), content };
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
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
  // Version 2: the mint rows are read one line at a time while the index restores (see `rows`); version 1: in the payload.
  let streamed: { readonly lines: Iterator<string>; readonly hash: ReturnType<typeof createHash>; count: number; trailer: string | null } | null = null;
  try {
    const first = fileLines(path)[Symbol.iterator]();
    const head = first.next();
    const outer = JSON.parse(head.done === true ? '' : head.value) as unknown;
    if (isObj(outer) && outer['format'] === STATE_FORMAT) {
      if (outer['version'] !== STATE_VERSION) return { ok: false, reason: `saved state version ${String(outer['version'])} is not ${STATE_VERSION} or 1` };
      const hash = createHash('sha256');
      const payload = first.next();
      if (payload.done === true) return { ok: false, reason: 'saved state payload is missing' };
      hash.update(`${payload.value}\n`);
      s = JSON.parse(payload.value, reviver) as SavedState;
      streamed = { lines: first, hash, count: 1, trailer: null };
    } else {
      first.return?.(undefined);
      const text = readFileSync(path, 'utf8');
      const v1 = JSON.parse(text) as unknown;
      if (!isObj(v1) || v1['version'] !== 1) return { ok: false, reason: `saved state version ${isObj(v1) ? String(v1['version']) : '?'} is not ${STATE_VERSION} or 1` };
      const payload = v1['payload'];
      if (typeof payload !== 'string' || createHash('sha256').update(payload).digest('hex') !== v1['sha256']) return { ok: false, reason: 'saved state checksum does not match' };
      s = JSON.parse(payload, reviver) as SavedState;
    }
  } catch (e) {
    return { ok: false, reason: `saved state unreadable: ${e instanceof Error ? e.message : String(e)}` };
  }
  /** Version 2's mint rows, parsed as the restore takes them; the last line is held back as the trailer. */
  function* rows(st: NonNullable<typeof streamed>): Generator<unknown> {
    let prev: string | null = null;
    for (let r = st.lines.next(); r.done !== true; r = st.lines.next()) {
      if (prev !== null) {
        st.hash.update(`${prev}\n`);
        st.count++;
        yield JSON.parse(prev) as unknown;
      }
      prev = r.value;
    }
    st.trailer = prev;
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
    const index = streamed === null ? DeployerIndex.restore(s.index) : DeployerIndex.restore(s.index, rows(streamed));
    if (streamed !== null) {
      const t = streamed.trailer === null ? null : JSON.parse(streamed.trailer) as unknown;
      if (!isObj(t) || t['sha256'] !== streamed.hash.digest('hex') || t['lines'] !== streamed.count) throw new RangeError('saved state checksum does not match, or the file is cut');
    }
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
    return { ok: true, asOf, version: streamed === null ? 1 : STATE_VERSION, index, labeller, coverage: [...coverage, ...restart].sort(compareEvents), fills };
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
