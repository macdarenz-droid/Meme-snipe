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
import { farAhead } from '../run/budget-day.ts';
import type { RugConfig } from '../../../core/src/config/rugs.ts';
import { DAY_MS } from '../../../core/src/config/time.ts';
import { compareEvents, compareMoments, type MarketEvent, type Moment } from '../../../core/src/engine/index.ts';
import { DeployerIndex, RepeatedRowError, RugLabeller, type DeployerIndexState, type RugLabellerState } from '../../../core/src/gates/index.ts';
import { SEED_VIA } from '../seed/seed.ts';
import { parseGraduatesSeed } from '../../../core/src/facts/raw.ts';
import type { SavedCandidate, SavedGraduates, SavedTail } from '../engine/strategy.ts';

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
    /** The file's format version (1 or 2). */
    readonly version: number;
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
/** SAVE-SPIKE: how deep the payload is written piece by piece: the payload, its tables, and their rows. */
const PAYLOAD_DEPTH = 3;

/**
 * SAVE-SPIKE: `JSON.stringify(v, replacer)` emitted in pieces, arrays element by element and objects key by key down to
 * `depth` levels, each deeper value as one `JSON.stringify`. The text is the same byte for byte: `toJSON`, then the
 * replacer, on every value; a key whose value is then undefined, a function or a symbol is left out of an object, and
 * such an element is `null` in an array.
 */
export const streamJson = (v: unknown, emit: (text: string) => void, depth: number): void => {
  const prepared = (key: string, raw: unknown): unknown =>
    replacer(key, typeof raw === 'object' && raw !== null && typeof (raw as { toJSON?: unknown }).toJSON === 'function' ? (raw as { toJSON: (k: string) => unknown }).toJSON(key) : raw);
  const omitted = (x: unknown): boolean => x === undefined || typeof x === 'function' || typeof x === 'symbol';
  // `x` has had toJSON and the replacer applied; returns the text still to emit, '' when it was emitted, null if omitted.
  const step = (x: unknown, d: number): string | null => {
    if (omitted(x)) return null;
    if (d <= 0 || typeof x !== 'object' || x === null) return JSON.stringify(x, replacer);
    if (Array.isArray(x)) {
      emit('[');
      for (let i = 0; i < x.length; i++) {
        if (i > 0) emit(',');
        const t = step(prepared(String(i), x[i]), d - 1);
        if (t !== '') emit(t ?? 'null');
      }
      emit(']');
      return '';
    }
    emit('{');
    let first = true;
    for (const k of Object.keys(x)) {
      // Left out exactly as JSON.stringify leaves it out, decided before the key is written.
      const x2 = prepared(k, (x as Record<string, unknown>)[k]);
      if (omitted(x2)) continue;
      emit(`${first ? '' : ','}${JSON.stringify(k)}:`);
      first = false;
      const t = step(x2, d - 1);
      if (t !== '') emit(t!);
    }
    emit('}');
    return '';
  };
  const t = step(prepared('', v), depth);
  if (t !== '' && t !== null) emit(t);
};

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
    if ((x['migratedAtMs'] as number) > asOf.receivedAt || ((x['lastEvalMs'] as number | null) ?? Number.NEGATIVE_INFINITY) > asOf.receivedAt || (x['bars'] as { startMs: number }[]).some((b) => b.startMs > asOf.receivedAt)
      // FEES-KEEP: the saved fee terms are refused like a bar when dated after the moment; malformed ones restore as none.
      || (isObj(x['fees']) && typeof x['fees']['atMs'] === 'number' && x['fees']['atMs'] > asOf.receivedAt)) throw new RangeError(`candidate ${x['mint']} is dated after the ${at} moment`);
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
  if (s.graduates !== undefined) graduatesProblem(s.graduates, s.asOf, true);
  if (s.candidates !== undefined) candidatesProblem(s.candidates, s.asOf, true);
  if (s.tails !== undefined) tailsProblem(s.tails);
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
  // SAVE-SPIKE: a line goes out in pieces, hashed as it goes (the same digest as the whole line), written in batches of
  // about 1 MiB: no piece and no batch is the whole payload.
  let hashed = false;
  const piece = (text: string): void => {
    if (hashed) hash.update(text);
    out.push(text);
    bytes += text.length;
    if (bytes >= 1 << 20) flush();
  };
  const line = (write: (emit: (text: string) => void) => void, isHashed: boolean): void => {
    hashed = isHashed;
    write(piece);
    piece('\n');
    if (isHashed) lines++;
  };
  try {
    line((emit) => emit(JSON.stringify({ format: STATE_FORMAT, version: STATE_VERSION })), false);
    // SAVE-SPIKE: the payload, element by element (`streamJson`): byte for byte the one-string JSON.stringify, never
    // held whole. At live sizes (41k coverage facts) the one string was about 23 MB, made twice per save.
    line((emit) => streamJson({ ...s, index: { ...s.index, mints: [] } }, emit, PAYLOAD_DEPTH), true);
    for (const r of rows) line((emit) => emit(JSON.stringify(r)), true);
    line((emit) => emit(JSON.stringify({ sha256: hash.digest('hex'), lines })), false);
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
    if (s.graduates !== undefined) graduatesProblem(s.graduates, asOf, false);
    if (s.candidates !== undefined) candidatesProblem(s.candidates, asOf, false);
    if (s.tails !== undefined) tailsProblem(s.tails);
    const checkTrailer = (st: NonNullable<typeof streamed>): void => {
      const t = st.trailer === null ? null : JSON.parse(st.trailer) as unknown;
      if (!isObj(t) || t['sha256'] !== st.hash.digest('hex') || t['lines'] !== st.count) throw new RangeError('saved state checksum does not match, or the file is cut');
    };
    let index: DeployerIndex;
    if (streamed === null) index = DeployerIndex.restore(s.index);
    else {
      const it = rows(streamed);
      // No `return` on what the restore iterates: its `for…of` would close the generator on a throw, and the drain
      // below would then hash nothing (persist review).
      const once: Iterable<unknown> = { [Symbol.iterator]: () => ({ next: () => it.next() }) };
      try {
        index = DeployerIndex.restore(s.index, once);
      } catch (e) {
        // DEPLOYER-COMPACT: a repeated creator row or mint is what a cut or doubled file looks like mid-stream: the rest
        // is read for the checksum, whose failure is the reason, as before; an intact file that repeats one is refused
        // for that.
        if (!(e instanceof RepeatedRowError)) throw e;
        for (let r = it.next(); r.done !== true; r = it.next()) { /* hashed by `rows` */ }
        checkTrailer(streamed);
        throw e;
      }
      checkTrailer(streamed);
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
    return { ok: true, asOf, version: streamed === null ? 1 : STATE_VERSION, index, labeller, coverage: [...coverage, ...restart].sort(compareEvents), fills, graduates: s.graduates ?? null, candidates: s.candidates ?? [], tails: s.tails ?? [] };
  } catch (e) {
    return { ok: false, reason: `saved state rejected: ${e instanceof Error ? e.message : String(e)}` };
  }
};

/** RT-A9: the UTC day a budget's `spend` booked its credits on; a refund names it, so it cannot go to another day. */
export type BudgetDay = string & { readonly __budgetDay: unique symbol };
/** The fills' daily budget as its readers use it (`DailyBudget`, or a test's stand-in). */
export interface FillBudget {
  remaining(nowMs: number): number;
  spend(credits: number, nowMs: number): BudgetDay;
  refund(credits: number, day: BudgetDay): void;
}
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);

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
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o['day'] as string) || !Number.isSafeInteger(dayNumber(o['day'] as string))) throw new Error('bad budget day');
      // RC-M3: dated more than a day ahead (a wrong clock wrote it): today counts as spent, written back.
      if (farAhead(dayNumber(o['day'] as string), dayNumber(day))) return new DailyBudget(path, daily, day, daily).#saved();
      // A file dated today or tomorrow (the clock stepped back since it was written) keeps its spend (WORKER-1c).
      return o['day'] >= day ? new DailyBudget(path, daily, o['day'] as string, o['spent'] as number) : new DailyBudget(path, daily, day, 0);
    } catch {
      return new DailyBudget(path, daily, day, daily);
    }
  }

  remaining(nowMs: number): number {
    this.#roll(nowMs);
    return Math.max(0, this.#daily - this.#spent);
  }

  /**
   * Records credits spent and saves at once, so a crash right after a fill cannot forget it. Answers the UTC day they
   * were booked on, the only thing `refund` takes back to.
   */
  spend(credits: number, nowMs: number): BudgetDay {
    if (!Number.isSafeInteger(credits) || credits < 0) throw new RangeError('credits must be a non-negative integer');
    this.#roll(nowMs);
    this.#spent += credits;
    writeAtomic(this.#path, JSON.stringify({ version: 1, day: this.#day, spent: this.#spent }));
    return this.#day as BudgetDay;
  }

  /**
   * Gives back credits reserved by `spend` and not used (never below zero), to the day that `spend` answered only, so
   * a reserve taken before midnight and refunded after it never lowers the new day's count (RT-A9; FACTS-REREAD's
   * `rereadRefund` rule). A day that has passed takes nothing back.
   */
  refund(credits: number, day: BudgetDay): void {
    if (!Number.isSafeInteger(credits) || credits < 0) throw new RangeError('credits must be a non-negative integer');
    if (day !== this.#day) return;
    this.#spent = Math.max(0, this.#spent - credits);
    writeAtomic(this.#path, JSON.stringify({ version: 1, day: this.#day, spent: this.#spent }));
  }

  /** Writes the budget; a write that fails leaves the file as it was (the next load applies the same rule). */
  #saved(): DailyBudget {
    try {
      writeAtomic(this.#path, JSON.stringify({ version: 1, day: this.#day, spent: this.#spent }));
    } catch {}
    return this;
  }

  #roll(nowMs: number): void {
    const day = dayOf(nowMs);
    // Only forward: a clock stepped back (NTP, a VM restore) keeps today's spend (WORKER-1c review).
    if (day > this.#day) {
      this.#day = day;
      this.#spent = 0;
    } else if (farAhead(dayNumber(this.#day), dayNumber(day))) {
      // RC-M3: this process's clock ran far ahead and came back: today counts as spent, not every day until that date.
      this.#day = day;
      this.#spent = Math.max(this.#spent, this.#daily);
      this.#saved();
    }
  }
}

const dayOf = (ms: number): string => new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
