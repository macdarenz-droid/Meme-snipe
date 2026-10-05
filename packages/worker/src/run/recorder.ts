// The market recorder (docs/ARCHITECTURE.md §12.4, §20 WORKER-1): every raw live input, from process start, in DATA-1's
// dataset layout (schema 2), so TEST-1 can replay what live fed and DATA-1's QA (research/historical/qa/check.mjs)
// reads it. One dataset folder per boot, `recorder/<boot>/`:
//   manifest.json                          schema 2, source "live-recorder", coverage, gaps, one entry per day and file
//   days/<UTC day>/frames-NNN.jsonl.zst    every frame as received (seq, receipt time, source, place, duplicate, body)
//   days/<UTC day>/raw-NNN.jsonl.zst       every fetched transaction as a schema-2 raw record (DEC-1's shape)
//   days/<UTC day>/releases-NNN.jsonl.zst  every event handed to the engine, in order (FEED-1 `Release`)
// Frames and releases use lossless JSON (bigints `{"$n":…}`, bytes `{"$b":…}`). Lines are appended to plain `.jsonl`
// files as they come and flushed before the engine acts on them; a file is compressed and listed in the manifest when
// it is rotated, at a clean stop, or at the next start after a crash, so a kill loses no flushed line.
import { createHash } from 'node:crypto';
import { redactCounted } from './redact.ts';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { toBase64 } from '../../../core/src/chain/index.ts';
import type { Frame, Release } from '../providers/index.ts';
import { typedText } from './json.ts';

export const RECORDER_SCHEMA = 2;
// `pre` held SEED-1's seed before it became a recorded frame; kept so an older boot's leftover files still seal.
const TABLES = ['frames', 'raw', 'releases', 'pre', 'delays'] as const;
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
  /** The time a pause forced by a failed write starts at (the worker's clock; default Date.now). */
  readonly now?: () => number;
  /** Told when a write failed for lack of space and the recorder paused itself (DISK-GUARD). */
  readonly onNoSpace?: () => void;
  /** Test seam: appends to a plain file (default appendFileSync), so a test can make a write fail with ENOSPC. */
  readonly append?: (path: string, text: string) => void;
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
  readonly #gaps: unknown[] = [];
  /** DISK-GUARD: while set, nothing is written; the open gap in `#gaps` counts what was dropped. */
  #paused: { gap: { reason: string; from_ms: number; to_ms: number | null; dropped: { frames: number; releases: number; delays: number }; unwritten_rows?: number } } | null = null;
  readonly #attachments: Attachment[] = [];
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

  get paused(): boolean {
    return this.#paused !== null;
  }

  /**
   * DISK-GUARD: stops writing (free space is low, or a write failed for lack of it). What is buffered is written and
   * every open file sealed first, as far as space allows; the stop is a `coverage_gaps` entry with its start, its end
   * (null while it lasts, so a crash leaves it open) and how many rows were not written. A replay of this boot does not
   * cover the gap.
   */
  pause(atMs: number, reason: string): void {
    if (this.#paused !== null) return;
    try {
      this.flush();
      for (const t of TABLES) this.#seal(t);
    } catch {
      // no room even for that: the plain files stay, and the next start seals them (sealLeftovers)
    }
    const gap = { reason: `recorder paused: ${reason}`, from_ms: atMs, to_ms: null as number | null, dropped: { frames: 0, releases: 0, delays: 0 } };
    this.#paused = { gap };
    this.#gaps.push(gap);
    this.#tryManifest();
  }

  /** Writes again from `atMs`; the gap gets its end. */
  resume(atMs: number): void {
    if (this.#paused === null) return;
    this.#paused.gap.to_ms = atMs;
    this.#paused = null;
    this.#tryManifest();
  }

  #tryManifest(): void {
    try {
      this.#writeManifest();
    } catch {
      // written again at the next seal, resume or clean stop
    }
  }

  /** FEED-1 `onFrame`: every frame, duplicates included. */
  frame(f: Frame): void {
    if (this.#paused !== null) {
      this.#paused.gap.dropped.frames++;
      return;
    }
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
    if (this.#paused !== null) {
      this.#paused.gap.dropped.releases++;
      return;
    }
    this.#releases++;
    this.#push('releases', receivedAt, JSON.stringify(r));
  }

  /**
   * One delay sample (BT-1c's measured scenario): the same signature and slot seen at processed and read at confirmed,
   * with each arrival time on this host and the commitment of each path.
   */
  delay(row: Readonly<Record<string, unknown>>, atMs: number): void {
    if (this.#paused !== null) {
      this.#paused.gap.dropped.delays++;
      return;
    }
    this.#push('delays', atMs, JSON.stringify(row, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)));
  }

  /** A stream gap (`coverage:*:gap`), listed in the manifest's `coverage_gaps`. */
  gap(g: Readonly<Record<string, unknown>>): void {
    this.#gaps.push(g);
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
      mkdirSync(dir, { recursive: true });
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
    if (!existsSync(dir)) return 0;
    const used = readdirSync(dir).map((f) => new RegExp(`^${t}-(\\d{3})\\.jsonl`).exec(f)).filter((m) => m !== null).map((m) => Number(m![1]));
    return used.length === 0 ? 0 : Math.max(...used) + 1;
  }

  #flushTable(t: Table): void {
    const buf = this.#buffer.get(t);
    const o = this.#open.get(t);
    if (buf === undefined || buf.length === 0 || o === undefined) return;
    const r = redactCounted(buf.join('\n'));
    o.redactions += r.count;
    (this.#o.append ?? appendFileSync)(o.path, `${r.text}\n`);
    buf.length = 0;
  }

  /**
   * Writes every buffered line. Called before the engine acts on what was ingested. A write that fails for lack of
   * space pauses the recorder (DISK-GUARD) instead of stopping the worker: its state, ledger and journal come first.
   */
  flush(): void {
    try {
      for (const t of TABLES) this.#flushTable(t);
    } catch (e) {
      if ((e as { code?: unknown }).code !== 'ENOSPC') throw e;
      let lost = 0;
      for (const t of TABLES) lost += this.#buffer.get(t)?.splice(0).length ?? 0;
      if (this.#paused === null) {
        const gap = { reason: 'recorder paused: a write failed (no space left on the device)', from_ms: (this.#o.now ?? Date.now)(), to_ms: null as number | null, dropped: { frames: 0, releases: 0, delays: 0 }, unwritten_rows: lost };
        this.#paused = { gap };
        this.#gaps.push(gap);
        this.#tryManifest();
      }
      this.#o.onNoSpace?.();
    }
  }

  #seal(t: Table): void {
    const o = this.#open.get(t);
    this.#open.delete(t);
    if (o === undefined || !existsSync(o.path)) return;
    sealFile(o.path);
    this.#sealed[t] += o.rows;
    if (o.redactions > 0) this.#gaps.push({ reason: 'values redacted as credentials; a replay of this file differs there', file: relative(this.#dir, `${o.path}.zst`), redactions: o.redactions });
    this.#writeManifest();
  }

  /** Clean stop: flush, compress every open file and write the manifest. */
  close(): void {
    this.flush();
    for (const t of TABLES) this.#seal(t);
    this.#writeManifest();
  }

  /** A file written into this boot's folder beside the recording (the restored saved state), listed in the manifest. */
  attach(file: string, sha256: string, bytes: number): void {
    this.#attachments.push({ file, sha256, bytes });
    this.#writeManifest();
  }

  #writeManifest(): void {
    writeManifest(this.#dir, { boot: this.#o.boot, git_sha: this.#o.gitSha, coverage: this.#coverage, coverage_gaps: this.#gaps, counts: this.#sealed, commitments: this.#o.commitments ?? null, attachments: this.#attachments });
  }
}

/** Compresses a plain `.jsonl` into `.jsonl.zst` (written beside it, then the plain one removed). */
const sealFile = (path: string): void => {
  const zst = `${path}.zst`;
  writeFileSync(`${zst}.tmp`, zstdCompressSync(readFileSync(path)));
  renameSync(`${zst}.tmp`, zst);
  rmSync(path);
};

interface ManifestState {
  readonly boot: string;
  readonly git_sha: string | null;
  readonly coverage: Coverage;
  readonly coverage_gaps: readonly unknown[];
  readonly counts: { readonly frames: number; readonly raw: number; readonly releases: number; readonly pre?: number; readonly delays?: number };
  readonly commitments?: Readonly<Record<string, string>> | null;
  /** Files kept beside the recording (WORKER-GROW: the saved state the boot restored from), each with its sha256 and size. */
  readonly attachments?: readonly Attachment[];
}

export interface Attachment {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
}

/** The manifest of one recorder folder, from the sealed files on disk. */
const writeManifest = (dir: string, s: ManifestState): void => {
  const daysDir = join(dir, 'days');
  const days = existsSync(daysDir) ? readdirSync(daysDir).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort() : [];
  const dayEntries = days.map((day) => {
    const files = readdirSync(join(daysDir, day)).filter((f) => f.endsWith('.jsonl.zst')).sort().map((f) => {
      const p = join(daysDir, day, f);
      const bytes = readFileSync(p);
      return { path: relative(dir, p), bytes: statSync(p).size, sha256: createHash('sha256').update(bytes).digest('hex') };
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
    commitments: s.commitments ?? null,
    attachments: s.attachments ?? [],
    chain_breaks: [],
    decode_failures: 0,
    units: [{ boot: s.boot, schema: RECORDER_SCHEMA, ...s.counts, unknown_events: {}, newer_layouts: {} }],
    days: dayEntries,
  };
  // Plain JSON for DATA-1's tools: a bigint (a slot in a gap) is written as its decimal string.
  writeFileSync(join(dir, 'manifest.json.tmp'), `${JSON.stringify(manifest, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`);
  renameSync(join(dir, 'manifest.json.tmp'), join(dir, 'manifest.json'));
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
    const dir = join(root, boot);
    const daysDir = join(dir, 'days');
    if (!existsSync(daysDir)) continue;
    let open = 0;
    const counts = { frames: 0, raw: 0, releases: 0, pre: 0, delays: 0 };
    for (const day of readdirSync(daysDir)) {
      for (const f of readdirSync(join(daysDir, day))) {
        const m = /^(frames|raw|releases|pre|delays)-\d{3}\.jsonl$/.exec(f);
        if (m === null) continue;
        // A torn last line (the kill) is cut; every whole line is kept.
        const p = join(daysDir, day, f);
        const text = readFileSync(p, 'utf8');
        const whole = text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
        writeFileSync(p, whole);
        counts[m[1] as Table] += whole === '' ? 0 : whole.split('\n').length - 1;
        sealFile(p);
        open++;
      }
    }
    if (open === 0) continue;
    let prev: { git_sha?: string | null; coverage?: Coverage; coverage_gaps?: unknown[]; commitments?: Record<string, string> | null; attachments?: Attachment[]; units?: { frames?: number; raw?: number; releases?: number }[] } = {};
    try {
      prev = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as typeof prev;
    } catch {}
    writeManifest(dir, {
      boot, git_sha: prev.git_sha ?? null,
      coverage: prev.coverage ?? { first_slot: null, last_slot: null, first_block_time: null, last_block_time: null },
      coverage_gaps: [...(prev.coverage_gaps ?? []), { reason: 'worker stopped without a clean stop; files sealed at the next start' }],
      commitments: prev.commitments ?? null,
      attachments: prev.attachments ?? [],
      counts: {
        frames: (prev.units?.[0]?.frames ?? 0) + counts.frames, raw: (prev.units?.[0]?.raw ?? 0) + counts.raw,
        releases: (prev.units?.[0]?.releases ?? 0) + counts.releases,
      },
    });
    fixed.push(boot);
  }
  return fixed;
};
