// The market recorder (docs/ARCHITECTURE.md §12.4, §20 WORKER-1): every raw live input, from process start, in DATA-1's
// dataset layout (schema 2), so TEST-1 can replay what live fed and DATA-1's QA (research/historical/qa/check.mjs)
// reads it. One dataset folder per boot, `recorder/<boot>/`:
//   manifest.json                          schema 2, source "live-recorder", coverage, gaps, one entry per day and file
//   gaps-NNN.jsonl(.zst)                   every stream gap of the boot, one per line, in order (RC-H3), in chunks of
//                                          GAPS_CHUNK_BYTES; each chunk is packed and listed as an attachment when full,
//                                          at a clean stop, or at the next start after a kill
//   days/<UTC day>/frames-NNN.jsonl.zst    every frame as received (seq, receipt time, source, place, duplicate, body)
//   days/<UTC day>/raw-NNN.jsonl.zst       every fetched transaction as a schema-2 raw record (DEC-1's shape)
//   days/<UTC day>/releases-NNN.jsonl.zst  every event handed to the engine, in order (FEED-1 `Release`)
// Frames and releases use lossless JSON (bigints `{"$n":…}`, bytes `{"$b":…}`). Lines are appended to plain `.jsonl`
// files as they come and flushed before the engine acts on them; a file is compressed and listed in the manifest when
// it is rotated, at a clean stop, or at the next start after a crash, so a kill loses no flushed line. Each sealed
// file is hashed once, from the bytes written when it is sealed; the manifest lists that hash and never re-reads it.
import { createHash } from 'node:crypto';
import { redactCounted } from './redact.ts';
import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { toBase64 } from '../../../core/src/chain/index.ts';
import type { Frame, Release } from '../providers/index.ts';
import { typedText } from './json.ts';

export const RECORDER_SCHEMA = 2;
/** STATE-DEDUPE: the recorder folder holding each distinct saved state once, packed, named by the sha256 of its plain bytes. */
export const SAVED_STATES = 'saved-state';
// `pre` held SEED-1's seed before it became a recorded frame; kept so an older boot's leftover files still seal.
const TABLES = ['frames', 'raw', 'releases', 'pre', 'delays'] as const;
/** RC-H3: every stream gap (`gap()`) is appended here; the manifest lists only the first MANIFEST_STREAM_GAPS of them. */
export const MANIFEST_STREAM_GAPS = 500;
/**
 * RC-H3 (S1 on #271): the gaps go in chunks of at most this many plain bytes (one flush's lines may pass it), so packing
 * one (at a seal, a stop, or the next start after a kill) never holds more than a chunk in memory.
 */
export const GAPS_CHUNK_BYTES = 4 * 1024 * 1024;
/** A gaps chunk's file name, plain while open; `.zst` once packed. */
export const gapsChunk = (n: number): string => `gaps-${String(n).padStart(3, '0')}.jsonl`;
const GAPS_PLAIN = /^gaps-(\d{3,6})\.jsonl$/;
const GAPS_PACKED = /^gaps-(\d{3,6})\.jsonl\.zst$/;
/** How the manifest names the chunks (`coverage_gaps_file.path`). */
export const GAPS_FILES = 'gaps-NNN.jsonl.zst';
type Table = (typeof TABLES)[number];

export interface RecorderOptions {
  /** `<state>/recorder`. */
  readonly root: string;
  readonly boot: string;
  readonly gitSha: string;
  /** A file is rotated once it holds this many bytes (and at every UTC day change). */
  readonly rotateBytes: number;
  /** The commitment each feed actually uses, by feed and subscription (listed in the manifest for BT-1c). */
  readonly commitments?: Readonly<Record<string, string>>;
}

interface Open {
  readonly day: string;
  readonly n: number;
  readonly path: string;
  bytes: number;
  rows: number;
  /** Values redacted from this file: each is data a replay cannot see, so it is listed as a coverage gap at sealing. */
  redactions: number;
}

interface Coverage {
  first_slot: number | null;
  last_slot: number | null;
  first_block_time: number | null;
  last_block_time: number | null;
}

const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const pad = (n: number): string => String(n).padStart(3, '0');

/** A fetched transaction as DATA-1's raw record (scanner/raw.go). Meta fields DEC-1 does not read are not fetched live. */
export const rawRecord = (f: Frame): Record<string, unknown> | null => {
  if (f.body.type !== 'tx') return null;
  const r = f.body.record;
  return {
    slot: Number(r.slot), blockTime: r.blockTime, txIndex: r.txIndex, signature: r.signature, transaction: toBase64(r.transaction),
    err: r.err === null || r.err === undefined ? null : { json: r.err }, mints: [],
    meta: {
      fee: null, computeUnitsConsumed: null, preBalances: null, postBalances: null,
      loadedAddresses: { writable: [...r.loadedAddresses.writable], readonly: [...r.loadedAddresses.readonly] },
      innerInstructions: r.innerInstructions === null ? null : r.innerInstructions.map((g) => ({
        index: g.index,
        instructions: g.instructions.map((ix) => ({ programIdIndex: ix.programIdIndex, accounts: [...ix.accounts], data: toBase64(ix.data), stackHeight: ix.stackHeight })),
      })),
      logMessages: r.logMessages === null ? null : [...r.logMessages], preTokenBalances: null, postTokenBalances: null,
    },
    receivedAt: f.receivedAt,
  };
};

export class Recorder {
  readonly #o: RecorderOptions;
  readonly #dir: string;
  readonly #open = new Map<Table, Open>();
  readonly #buffer = new Map<Table, string[]>();
  readonly #coverage: Coverage = { first_slot: null, last_slot: null, first_block_time: null, last_block_time: null };
  /** The manifest's `coverage_gaps`: seal gaps (redactions) and the first MANIFEST_STREAM_GAPS stream gaps. */
  readonly #gaps: unknown[] = [];
  /** Stream gaps seen this boot (all of them are in GAPS_FILE once flushed), and those not yet appended there. */
  #streamGaps = 0;
  /** The open gaps chunk: its number, its bytes and lines written whole. */
  #gapsChunk = 0;
  #gapsBytes = 0;
  #gapsRows = 0;
  readonly #gapLines: string[] = [];
  readonly #attachments: Attachment[] = [];
  /** Sealed files' sizes and hashes, by path relative to the folder, as sealed (G4c: never re-read). */
  readonly #hashes: FileHashes = new Map();
  /** RECORD-BUDGET: the highest file number used per table and day, so a deleted newest file's number is never reused. */
  readonly #high = new Map<string, number>();
  /** RECORD-BUDGET: this boot's sealed files deleted by the budget, listed in the manifest's `pruned`. */
  readonly #pruned: PrunedFile[] = [];
  #frames = 0;
  #raw = 0;
  #releases = 0;
  /** Rows in sealed files: what the manifest lists. */
  readonly #sealed = { frames: 0, raw: 0, releases: 0, pre: 0, delays: 0 };

  constructor(o: RecorderOptions) {
    this.#o = o;
    this.#dir = join(o.root, o.boot);
    mkdirSync(this.#dir, { recursive: true });
    this.#writeManifest();
  }

  get dir(): string {
    return this.#dir;
  }

  get counts(): { readonly frames: number; readonly raw: number; readonly releases: number } {
    return { frames: this.#frames, raw: this.#raw, releases: this.#releases };
  }

  /** FEED-1 `onFrame`: every frame, duplicates included. */
  frame(f: Frame): void {
    this.#frames++;
    this.#push('frames', f.receivedAt, typedText(f));
    const raw = rawRecord(f);
    if (raw !== null) {
      this.#raw++;
      this.#push('raw', f.receivedAt, JSON.stringify(raw));
    }
    const slot = f.body.type === 'slot' ? Number(f.body.slot) : null;
    if (slot !== null) {
      const c = this.#coverage;
      if (c.first_slot === null) {
        c.first_slot = slot;
        c.first_block_time = Math.floor(f.receivedAt / 1000);
      }
      if (c.last_slot === null || slot > c.last_slot) {
        c.last_slot = slot;
        c.last_block_time = Math.floor(f.receivedAt / 1000);
      }
    }
  }

  /** FEED-1 `onRelease`: the event handed to the engine, in release order. */
  release(r: Release, receivedAt: number): void {
    this.#releases++;
    this.#push('releases', receivedAt, JSON.stringify(r));
  }

  /**
   * One delay sample (BT-1c's measured scenario): the same signature and slot seen at processed and read at confirmed,
   * with each arrival time on this host and the commitment of each path.
   */
  delay(row: Readonly<Record<string, unknown>>, atMs: number): void {
    this.#push('delays', atMs, JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
  }

  /**
   * A stream gap (`coverage:*:gap`). Every one is appended to the open gaps chunk at the next flush; the manifest lists the first
   * MANIFEST_STREAM_GAPS and names the file and the total (RC-H3: a long boot's gaps once made a 77 MB manifest rewritten
   * at every seal). `recordedGaps` reads them all back.
   */
  gap(g: Readonly<Record<string, unknown>>): void {
    this.#streamGaps++;
    this.#gapLines.push(JSON.stringify(g, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
    if (this.#streamGaps <= MANIFEST_STREAM_GAPS) this.#gaps.push(g);
  }

  #flushGaps(): void {
    const lines = this.#gapLines;
    while (lines.length > 0) {
      // The lines that fit the open chunk (at least one); a full chunk is packed first, so no chunk passes
      // GAPS_CHUNK_BYTES unless one line does.
      let bytes = 0;
      let n = 0;
      while (n < lines.length) {
        const b = Buffer.byteLength(lines[n]!) + 1;
        if (n > 0 && this.#gapsBytes + bytes + b > GAPS_CHUNK_BYTES) break;
        if (n === 0 && this.#gapsBytes > 0 && this.#gapsBytes + b > GAPS_CHUNK_BYTES) break;
        bytes += b;
        n++;
      }
      if (n === 0) {
        this.#sealGaps();
        continue;
      }
      const path = join(this.#dir, gapsChunk(this.#gapsChunk));
      const text = `${redactCounted(lines.slice(0, n).join('\n')).text}\n`;
      try {
        appendFileSync(path, text);
      } catch (e) {
        // A part written before the failure (a full disk) is cut back off: the lines stay buffered for the next flush,
        // so a chunk never holds a repeated or torn gap line. A cut that fails too leaves at most a torn tail.
        try {
          truncateSync(path, this.#gapsBytes);
        } catch {}
        throw e;
      }
      this.#gapsBytes += Buffer.byteLength(text);
      this.#gapsRows += n;
      lines.splice(0, n);
    }
  }

  /**
   * Packs the open gaps chunk, crash-safe (S1 on #271): the `.zst` is written whole, then the manifest that lists it,
   * and only then is the plain chunk removed. A kill at any step leaves the plain chunk, which the next start packs.
   */
  #sealGaps(): void {
    const plain = join(this.#dir, gapsChunk(this.#gapsChunk));
    if (!existsSync(plain)) return;
    const a = packChunk(plain, this.#gapsRows);
    const i = this.#attachments.findIndex((x) => x.file === a.file);
    if (i !== -1) this.#attachments.splice(i, 1);
    this.#attachments.push(a);
    this.#writeManifestNow();
    rmSync(plain);
    this.#gapsChunk++;
    this.#gapsBytes = 0;
    this.#gapsRows = 0;
  }

  #push(t: Table, atMs: number, line: string): void {
    const day = dayOf(atMs);
    const cur = this.#open.get(t);
    if (cur !== undefined && (cur.day !== day || cur.bytes >= this.#o.rotateBytes)) {
      this.#flushTable(t);
      this.#seal(t);
    }
    if (!this.#open.has(t)) {
      const n = this.#nextNumber(t, day);
      const dir = join(this.#dir, 'days', day);
      const made = !existsSync(dir);
      mkdirSync(dir, { recursive: true });
      // RC-STATE review: a new file's (and a new day folder's) name reaches disk at the next durable(), with the folder.
      this.#newDirs.add(dir);
      if (made) this.#newDirs.add(join(this.#dir, 'days'));
      this.#open.set(t, { day, n, path: join(dir, `${t}-${pad(n)}.jsonl`), bytes: 0, rows: 0, redactions: 0 });
    }
    const o = this.#open.get(t)!;
    o.bytes += Buffer.byteLength(line) + 1;
    o.rows++;
    const buf = this.#buffer.get(t) ?? [];
    buf.push(line);
    this.#buffer.set(t, buf);
  }

  #nextNumber(t: Table, day: string): number {
    const dir = join(this.#dir, 'days', day);
    const used = existsSync(dir) ? readdirSync(dir).map((f) => new RegExp(`^${t}-(\\d{3})\\.jsonl`).exec(f)).filter((m) => m !== null).map((m) => Number(m![1])) : [];
    const high = this.#high.get(`${t}/${day}`);
    if (high !== undefined) used.push(high);
    const n = used.length === 0 ? 0 : Math.max(...used) + 1;
    this.#high.set(`${t}/${day}`, n);
    return n;
  }

  #flushTable(t: Table): void {
    const buf = this.#buffer.get(t);
    const o = this.#open.get(t);
    if (buf === undefined || buf.length === 0 || o === undefined) return;
    const r = redactCounted(buf.join('\n'));
    o.redactions += r.count;
    appendFileSync(o.path, `${r.text}\n`);
    buf.length = 0;
  }

  /** Writes every buffered line. Called before the engine acts on what was ingested. */
  flush(): void {
    for (const t of TABLES) this.#flushTable(t);
    this.#flushGaps();
  }

  /** Folders that gained a file (or a day folder) since the last durable(): their entries are fsynced there. */
  readonly #newDirs = new Set<string>();

  /**
   * RC-FIXES: every buffered line written and on disk (fsync of each open file and the gaps file), and every folder that
   * gained a file since the last call (a new file at rotation, a new day) fsynced too, before an entry reaches the
   * outside world, so the recording always replays to the journaled entry (TEST-1), whatever kills the process after.
   */
  durable(sync: (fd: number) => void = fsyncSync): void {
    this.flush();
    // The open gaps chunk, and the boot's folder (where a new gaps chunk or a sealed one appears).
    const paths = [...[...this.#open.values()].map((o) => o.path), join(this.#dir, gapsChunk(this.#gapsChunk)), this.#dir, ...this.#newDirs];
    for (const p of paths) {
      if (!existsSync(p)) continue;
      const fd = openSync(p, 'r');
      try {
        sync(fd);
      } finally {
        closeSync(fd);
      }
    }
    this.#newDirs.clear();
  }

  #seal(t: Table): void {
    const o = this.#open.get(t);
    this.#open.delete(t);
    if (o === undefined || !existsSync(o.path)) return;
    this.#hashes.set(relative(this.#dir, `${o.path}.zst`), sealFile(o.path));
    this.#sealed[t] += o.rows;
    if (o.redactions > 0) this.#gaps.push({ reason: 'values redacted as credentials; a replay of this file differs there', file: relative(this.#dir, `${o.path}.zst`), redactions: o.redactions });
    this.#writeManifest();
  }

  /** Clean stop: flush, compress every open file and write the manifest. */
  close(): void {
    this.flush();
    for (const t of TABLES) this.#seal(t);
    // RC-H3: a plain .jsonl keeps an ended boot "open" for the uploader and the budget; the last gaps chunk goes packed.
    this.#sealGaps();
    this.#writeManifest();
  }

  /**
   * RECORD-BUDGET: one of this boot's sealed files was deleted by the byte budget. It leaves `days[].files` (the
   * manifest lists what is on disk) and is listed under `pruned` with the size and hash it had when sealed.
   */
  pruned(path: string, bytes: number, reason: 'cap' | 'floor'): void {
    const h = this.#hashes.get(path);
    this.#hashes.delete(path);
    this.#pruned.push({ path, bytes: h?.bytes ?? bytes, sha256: h?.sha256 ?? null, reason });
    this.#writeManifest();
  }

  /** A file written into this boot's folder beside the recording (the restored saved state), listed in the manifest. */
  attach(file: string, sha256: string, bytes: number, content?: Attachment['content']): void {
    const i = this.#attachments.findIndex((x) => x.file === file);
    if (i !== -1) this.#attachments.splice(i, 1);
    this.#attachments.push({ file, sha256, bytes, ...(content === undefined ? {} : { content }) });
    this.#writeManifest();
  }

  /** G4c: an attachment replaced by its packed form (`<file>.zst`), listed with its own hash and its content's. */
  packed(file: string, packed: { readonly sha256: string; readonly bytes: number }, content: { readonly sha256: string; readonly bytes: number }): void {
    const i = this.#attachments.findIndex((x) => x.file === file);
    if (i !== -1) this.#attachments.splice(i, 1);
    this.attach(`${file}.zst`, packed.sha256, packed.bytes, { encoding: 'zstd', sha256: content.sha256, bytes: content.bytes });
  }

  #writeManifest(): void {
    // The chunks always hold at least what the manifest counts.
    this.#flushGaps();
    this.#writeManifestNow();
  }

  #writeManifestNow(): void {
    const gapsFile = this.#streamGaps === 0 ? null : { path: GAPS_FILES, total: this.#streamGaps, listed: Math.min(this.#streamGaps, MANIFEST_STREAM_GAPS) };
    writeManifest(this.#dir, { boot: this.#o.boot, git_sha: this.#o.gitSha, coverage: this.#coverage, coverage_gaps: this.#gaps, coverage_gaps_file: gapsFile, counts: this.#sealed, commitments: this.#o.commitments ?? null, attachments: this.#attachments, pruned: this.#pruned }, this.#hashes);
  }
}

/** A sealed file's size and sha256, by its path relative to the recorder folder. */
type FileHashes = Map<string, { readonly bytes: number; readonly sha256: string }>;

const hashOf = (b: Buffer): { readonly bytes: number; readonly sha256: string } => ({ bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') });

/** Compresses a plain `.jsonl` into `.jsonl.zst` (written beside it, then the plain one removed). Returns its size and hash. */
const sealFile = (path: string): { readonly bytes: number; readonly sha256: string } => {
  const zst = `${path}.zst`;
  const packed = zstdCompressSync(readFileSync(path));
  writeFileSync(`${zst}.tmp`, packed);
  renameSync(`${zst}.tmp`, zst);
  rmSync(path);
  return hashOf(packed);
};

interface ManifestState {
  readonly boot: string;
  readonly git_sha: string | null;
  readonly coverage: Coverage;
  readonly coverage_gaps: readonly unknown[];
  /** RC-H3: where every stream gap is, how many there are, and how many of the first ones `coverage_gaps` also lists. */
  readonly coverage_gaps_file?: GapsFile | null;
  readonly counts: { readonly frames: number; readonly raw: number; readonly releases: number; readonly pre?: number; readonly delays?: number };
  readonly commitments?: Readonly<Record<string, string>> | null;
  /** Files kept beside the recording (WORKER-GROW: the saved state the boot restored from), each with its sha256 and size. */
  readonly attachments?: readonly Attachment[];
  /** RECORD-BUDGET: sealed files the byte budget deleted. */
  readonly pruned?: readonly PrunedFile[];
}

export interface GapsFile {
  readonly path: string;
  readonly total: number;
  readonly listed: number;
}

/** A sealed file the byte budget deleted: its path in the folder, its size and sha256 as sealed (null if unknown). */
export interface PrunedFile {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string | null;
  readonly reason: 'cap' | 'floor';
}

export interface Attachment {
  readonly file: string;
  /** A gaps chunk's lines (RC-H3). */
  readonly rows?: number;
  readonly sha256: string;
  readonly bytes: number;
  /** A packed file's content: what it decompresses to. */
  readonly content?: { readonly encoding: 'zstd'; readonly sha256: string; readonly bytes: number };
}

/**
 * The manifest of one recorder folder, from the sealed files on disk. A file in `hashes` is listed as sealed; any other
 * (an earlier process's) is hashed once and added.
 */
const writeManifest = (dir: string, s: ManifestState, hashes: FileHashes = new Map()): void => {
  const daysDir = join(dir, 'days');
  const days = existsSync(daysDir) ? readdirSync(daysDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
  const dayEntries = days.map((day) => {
    const files = readdirSync(join(daysDir, day)).filter((f) => f.endsWith('.jsonl.zst')).sort().map((f) => {
      const path = relative(dir, join(daysDir, day, f));
      let h = hashes.get(path);
      if (h === undefined) {
        h = hashOf(readFileSync(join(daysDir, day, f)));
        hashes.set(path, h);
      }
      return { path, bytes: h.bytes, sha256: h.sha256 };
    });
    const rows: Record<string, number> = {};
    return { day, blocks_expected: 0, blocks_scanned: 0, complete: false, warm_up: false, rows, files };
  });
  const next = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const manifest = {
    schema: RECORDER_SCHEMA,
    source: 'live-recorder',
    boot: s.boot,
    git_sha: s.git_sha,
    window: { from: days[0] ?? null, to_exclusive: days.length === 0 ? null : next(days[days.length - 1]!) },
    coverage: s.coverage,
    coverage_gaps: s.coverage_gaps,
    ...(s.coverage_gaps_file === null || s.coverage_gaps_file === undefined ? {} : { coverage_gaps_file: s.coverage_gaps_file }),
    commitments: s.commitments ?? null,
    attachments: s.attachments ?? [],
    pruned: s.pruned ?? [],
    chain_breaks: [],
    decode_failures: 0,
    units: [{ boot: s.boot, schema: RECORDER_SCHEMA, ...s.counts, unknown_events: {}, newer_layouts: {} }],
    days: dayEntries,
  };
  // Plain JSON for DATA-1's tools: a bigint (a slot in a gap) is written as its decimal string.
  writeFileSync(join(dir, 'manifest.json.tmp'), `${JSON.stringify(manifest, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
  renameSync(join(dir, 'manifest.json.tmp'), join(dir, 'manifest.json'));
};

/** The well-formed `days[].files` entries of a manifest (anything else is skipped and hashed afresh). */
const listedFiles = (days: unknown): { readonly path: string; readonly bytes: number; readonly sha256: string }[] => {
  if (!Array.isArray(days)) return [];
  const out: { path: string; bytes: number; sha256: string }[] = [];
  for (const d of days) {
    const files = typeof d === 'object' && d !== null ? (d as { files?: unknown }).files : undefined;
    if (!Array.isArray(files)) continue;
    for (const f of files) {
      if (typeof f !== 'object' || f === null) continue;
      const { path, bytes, sha256 } = f as { path?: unknown; bytes?: unknown; sha256?: unknown };
      if (typeof path === 'string' && Number.isSafeInteger(bytes) && typeof sha256 === 'string' && /^[0-9a-f]{64}$/.test(sha256)) out.push({ path, bytes: bytes as number, sha256 });
    }
  }
  return out;
};

/**
 * RECORD-BUDGET: an ended boot's sealed files were deleted by the byte budget. Its manifest is rewritten in place: the
 * days and files from what is on disk, and each deleted file appended to `pruned` with the size and sha256 its manifest
 * listed (null when it was not listed). Every other field is kept. Throws when the manifest cannot be read.
 */
export const notePruned = (dir: string, entries: readonly { readonly path: string; readonly bytes: number }[], reason: 'cap' | 'floor'): void => {
  const prev = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as PrevManifest;
  const listed = new Map(listedFiles(prev.days).map((f) => [f.path, f] as const));
  const hashes: FileHashes = new Map([...listed].map(([path, f]) => [path, { bytes: f.bytes, sha256: f.sha256 }] as const));
  const pruned: PrunedFile[] = [...(Array.isArray(prev.pruned) ? prev.pruned : [])];
  for (const e of entries) {
    const l = listed.get(e.path);
    pruned.push({ path: e.path, bytes: l?.bytes ?? e.bytes, sha256: l?.sha256 ?? null, reason });
  }
  const u = prev.units?.[0] ?? {};
  writeManifest(dir, {
    boot: prev.boot ?? basename(dir), git_sha: prev.git_sha ?? null,
    coverage: prev.coverage ?? { first_slot: null, last_slot: null, first_block_time: null, last_block_time: null },
    coverage_gaps: prev.coverage_gaps ?? [], coverage_gaps_file: prev.coverage_gaps_file ?? null, commitments: prev.commitments ?? null, attachments: prev.attachments ?? [], pruned,
    counts: {
      frames: u.frames ?? 0, raw: u.raw ?? 0, releases: u.releases ?? 0,
      ...(typeof u.pre === 'number' ? { pre: u.pre } : {}), ...(typeof u.delays === 'number' ? { delays: u.delays } : {}),
    },
  }, hashes);
};

/** The fields of a manifest on disk that a rewrite keeps. */
interface PrevManifest {
  boot?: string;
  git_sha?: string | null;
  coverage?: Coverage;
  coverage_gaps?: unknown[];
  coverage_gaps_file?: GapsFile | null;
  commitments?: Record<string, string> | null;
  attachments?: Attachment[];
  pruned?: PrunedFile[];
  units?: { frames?: number; raw?: number; releases?: number; pre?: number; delays?: number }[];
  days?: unknown;
}

/** Packs one plain gaps chunk to `<chunk>.zst` (written whole, then renamed), and returns its attachment entry. */
const packChunk = (plain: string, rows: number): Attachment => {
  const text = readFileSync(plain);
  const z = `${plain}.zst`;
  const packed = zstdCompressSync(text);
  writeFileSync(`${z}.tmp`, packed);
  renameSync(`${z}.tmp`, z);
  const h = hashOf(packed);
  const c = hashOf(text);
  return { file: basename(z), sha256: h.sha256, bytes: h.bytes, rows, content: { encoding: 'zstd', sha256: c.sha256, bytes: c.bytes } };
};

/** A chunk's whole lines: a torn last line (a kill mid-append) is cut off the file. Returns how many lines it holds. */
const wholeLines = (plain: string): number => {
  const text = readFileSync(plain);
  const end = text.lastIndexOf(0x0a) + 1;
  if (end !== text.length) truncateSync(plain, end);
  let n = 0;
  for (let k = 0; k < end; k++) if (text[k] === 0x0a) n++;
  return n;
};

const chunkNumbers = (dir: string, re: RegExp): number[] =>
  readdirSync(dir).map((f) => re.exec(f)).filter((m): m is RegExpExecArray => m !== null).map((m) => Number(m[1])).sort((a, b) => a - b);

/**
 * A crashed boot's gaps (RC-H3, S1 on #271), crash-safe at every step of a seal: a `.zst.tmp` is dropped; a plain chunk
 * whose `.zst` the manifest already lists only waits for its removal; any other plain chunk (torn line cut) is packed
 * again; a `.zst` the manifest does not list, with no plain chunk beside it, is listed. Returns the attachments to write
 * and the plain chunks to remove once a manifest listing them is on disk; null when there is nothing to do.
 */
const leftoverGaps = (dir: string, prev: readonly Attachment[]): { readonly attachments: Attachment[]; readonly remove: string[] } | null => {
  let changed = false;
  for (const f of readdirSync(dir)) {
    if (/^gaps-\d{3,6}\.jsonl\.zst\.tmp$/.test(f)) {
      rmSync(join(dir, f));
      changed = true;
    }
  }
  const attachments = [...prev];
  const listed = new Set(prev.map((a) => a.file));
  const remove: string[] = [];
  for (const n of chunkNumbers(dir, GAPS_PLAIN)) {
    const plain = join(dir, gapsChunk(n));
    changed = true;
    remove.push(plain);
    if (listed.has(`${gapsChunk(n)}.zst`) && existsSync(`${plain}.zst`)) continue;
    const a = packChunk(plain, wholeLines(plain));
    const k = attachments.findIndex((x) => x.file === a.file);
    if (k !== -1) attachments.splice(k, 1);
    attachments.push(a);
    listed.add(a.file);
  }
  for (const n of chunkNumbers(dir, GAPS_PACKED)) {
    const file = `${gapsChunk(n)}.zst`;
    if (listed.has(file)) continue;
    const packed = readFileSync(join(dir, file));
    const text = zstdDecompressSync(packed);
    let rows = 0;
    for (const b of text) if (b === 0x0a) rows++;
    const h = hashOf(packed);
    const c = hashOf(text);
    attachments.push({ file, sha256: h.sha256, bytes: h.bytes, rows, content: { encoding: 'zstd', sha256: c.sha256, bytes: c.bytes } });
    changed = true;
  }
  return changed ? { attachments, remove } : null;
};

/**
 * Every coverage gap of one recorder folder: the manifest's `coverage_gaps`, then the stream gaps it does not list, from
 * the gaps chunks in order (plain while the boot runs or until the next start packs it, `.zst` once packed). A torn
 * last line (a kill mid-append) is not a gap and is skipped.
 */
export const recordedGaps = (dir: string): unknown[] => {
  const m = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as PrevManifest;
  const listed = m.coverage_gaps ?? [];
  const numbers = [...new Set([...chunkNumbers(dir, GAPS_PLAIN), ...chunkNumbers(dir, GAPS_PACKED)])].sort((a, b) => a - b);
  const lines: string[] = [];
  for (const n of numbers) {
    const plain = join(dir, gapsChunk(n));
    const text = existsSync(plain) ? readFileSync(plain, 'utf8') : zstdDecompressSync(readFileSync(`${plain}.zst`)).toString('utf8');
    lines.push(...text.split('\n').filter((l) => l !== ''));
  }
  const rest: unknown[] = [];
  for (let i = m.coverage_gaps_file?.listed ?? 0; i < lines.length; i++) {
    try {
      rest.push(JSON.parse(lines[i]!));
    } catch (e) {
      if (i === lines.length - 1) continue;
      throw e;
    }
  }
  return [...listed, ...rest];
};

/**
 * At start, before this boot records anything: earlier boots' folders that a crash left with plain `.jsonl` files get
 * them compressed and their manifest rewritten (counts and coverage as the files show them). Returns the folders fixed.
 */
export const sealLeftovers = (root: string, current: string): string[] => {
  if (!existsSync(root)) return [];
  const fixed: string[] = [];
  for (const boot of readdirSync(root)) {
    if (boot === current) continue;
    try {
      if (sealBoot(root, boot)) fixed.push(boot);
    } catch (e) {
      // RECORD-BUDGET: a folder removed while it is read (the budget, an upload) is no fault; anything else is.
      if (isObj(e) && e['code'] === 'ENOENT') continue;
      throw e;
    }
  }
  return fixed;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** One earlier boot's folder: its plain files sealed and its manifest rewritten. False when it had none. */
const sealBoot = (root: string, boot: string): boolean => {
  const dir = join(root, boot);
  const daysDir = join(dir, 'days');
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return false;
  let open = 0;
  const counts = { frames: 0, raw: 0, releases: 0, pre: 0, delays: 0 };
  const hashes: FileHashes = new Map();
  for (const day of existsSync(daysDir) ? readdirSync(daysDir) : []) {
    for (const f of readdirSync(join(daysDir, day))) {
      const m = /^(frames|raw|releases|pre|delays)-\d{3}\.jsonl$/.exec(f);
      if (m === null) continue;
      // A torn last line (the kill) is cut; every whole line is kept.
      const p = join(daysDir, day, f);
      const text = readFileSync(p, 'utf8');
      const whole = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
      writeFileSync(p, whole);
      counts[m[1] as Table] += whole === '' ? 0 : whole.split('\n').length - 1;
      hashes.set(relative(dir, `${p}.zst`), sealFile(p));
      open++;
    }
  }
  let prev: PrevManifest = {};
  try {
    prev = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as typeof prev;
  } catch {}
  // RC-H3: the crashed boot's gaps chunks, packed and listed like a clean stop's (a kill at any step of a seal included).
  const gaps = leftoverGaps(dir, prev.attachments ?? []);
  if (open === 0 && gaps === null) return false;
  // Files the crashed boot had sealed keep the size and hash its manifest listed at their seal (G4c review N1), so a
  // change made to one between the crash and this start shows as a mismatch, not a fresh hash.
  for (const f of listedFiles(prev.days)) if (!hashes.has(f.path)) hashes.set(f.path, { bytes: f.bytes, sha256: f.sha256 });
  const attachments = gaps?.attachments ?? prev.attachments ?? [];
  const gapRows = attachments.reduce((n, a) => n + (GAPS_PACKED.test(a.file) ? (a.rows ?? 0) : 0), 0);
  writeManifest(dir, {
    boot, git_sha: prev.git_sha ?? null,
    coverage: prev.coverage ?? { first_slot: null, last_slot: null, first_block_time: null, last_block_time: null },
    coverage_gaps: [...(prev.coverage_gaps ?? []), { reason: 'worker stopped without a clean stop; files sealed at the next start' }],
    coverage_gaps_file: gapRows === 0 ? prev.coverage_gaps_file ?? null : { path: GAPS_FILES, total: Math.max(gapRows, prev.coverage_gaps_file?.total ?? 0), listed: prev.coverage_gaps_file?.listed ?? 0 },
    commitments: prev.commitments ?? null,
    attachments,
    ...(prev.pruned === undefined ? {} : { pruned: prev.pruned }),
    counts: {
      frames: (prev.units?.[0]?.frames ?? 0) + counts.frames, raw: (prev.units?.[0]?.raw ?? 0) + counts.raw,
      releases: (prev.units?.[0]?.releases ?? 0) + counts.releases,
    },
  }, hashes);
  // Only now that a manifest lists every packed chunk: the plain chunks go.
  for (const plain of gaps?.remove ?? []) rmSync(plain, { force: true });
  return true;
};
