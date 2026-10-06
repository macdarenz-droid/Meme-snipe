// journal.jsonl (docs/ARCHITECTURE.md §12.4): one JSON line per event, appended synchronously, so a kill can tear only
// the last line. At open a torn last line is cut and a `journal_repair` line follows the boot's `start`; `seq` runs on
// across restarts. ENOSPC loses evidence, never exits: attempts consume seqs, a bounded loss counter becomes a
// coverage_gap once space returns. No new journal kind or health/API shape is needed.
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readSync, statSync, truncateSync, writeSync } from 'node:fs';
import { redact } from './redact.ts';
import type { JournalKind } from '../../../runner/src/contract.ts';
import { jsonText } from './json.ts';

/**
 * The last two lines of a file and the byte offset where each starts, read from the end in chunks (the file is never
 * read whole). A final newline ends the last line; without one, the last line is what follows the last newline.
 */
export const lastLines = (path: string, chunk = 64 * 1024): { readonly lines: string[]; readonly offsets: number[] } => {
  let pos = statSync(path).size;
  let buf = Buffer.alloc(0);
  const body = () => (buf.length > 0 && buf[buf.length - 1] === 0x0a ? buf.subarray(0, buf.length - 1) : buf);
  const newlines = (b: Buffer) => b.reduce((n, x) => n + (x === 0x0a ? 1 : 0), 0);
  const fd = openSync(path, 'r');
  try {
    // Two newlines inside the body isolate its last two lines whole.
    while (pos > 0 && newlines(body()) < 2) {
      const n = Math.min(chunk, pos);
      pos -= n;
      const b = Buffer.alloc(n);
      readSync(fd, b, 0, n, pos);
      buf = Buffer.concat([b, buf]);
    }
  } finally {
    closeSync(fd);
  }
  if (buf.length === 0) return { lines: [], offsets: [] };
  // Short of the file's start the first piece may be part of a line; the two newlines put it before the last two.
  const lines: string[] = [];
  const offsets: number[] = [];
  let start = 0;
  const all = body();
  for (let i = 0; i <= all.length; i++) {
    if (i < all.length && all[i] !== 0x0a) continue;
    lines.push(all.subarray(start, i).toString('utf8'));
    offsets.push(pos + start);
    start = i + 1;
  }
  return { lines: lines.slice(-2), offsets: offsets.slice(-2) };
};

export interface JournalOptions {
  /** One notification per pending ENOSPC interval. Never writes back to this journal. */
  readonly onNoSpace?: () => void;
  /** Test seam; production appends synchronously. */
  readonly append?: (path: string, text: string) => void;
  /** Told every line as written (its kind and text), after it is on disk (FUNNEL-PERSIST: the app's views follow it). */
  readonly written?: (kind: JournalKind, text: string) => void;
}

// Bounded emergency headroom for journal recovery and durable exit writes. This is not a sustained disk budget:
// entries/recording stop, and ledger/state errors still throw if the remaining space is exhausted.
const RESERVE_BYTES = 64 * 1024;

const noSpace = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOSPC';
const armedReserve = (path: string): boolean => {
  if (statSync(path).size !== RESERVE_BYTES) return false;
  const fd = openSync(path, 'r');
  const b = Buffer.alloc(RESERVE_BYTES);
  try { return readSync(fd, b, 0, b.length, 0) === b.length && b.every((x) => x === 0); } finally { closeSync(fd); }
};

const terminated = (path: string): boolean => {
  const size = statSync(path).size;
  if (size === 0) return true;
  const fd = openSync(path, 'r');
  const b = Buffer.alloc(1);
  try { readSync(fd, b, 0, 1, size - 1); } finally { closeSync(fd); }
  return b[0] === 0x0a;
};

export class Journal {
  readonly #path: string;
  readonly #boot: string;
  readonly #now: () => number;
  readonly #o: JournalOptions;
  #seq = 0;
  // Constant memory regardless of how long disk stays full: no retained lines or fields.
  #lost: { count: number; fromMs: number; fromSeq: number; toSeq: number } | null = null;
  #truncateAt: number | null = null;
  #restartGap = false;
  #startPending = false;
  #started = false;
  readonly #reserve: string;
  #reserveReleased = false;
  #noSpaceNotified = false;
  /** When the last whole line before this process was written (the previous process's last sign of life), or null. */
  readonly previousMs: number | null = null;
  /** True when a torn last line was cut at open. */
  readonly repaired: boolean;
  /**
   * How the previous process ended, from the journal's last whole line (RESTART-ALERT): `stop: <reason>` when it wrote
   * its stop line (`signal` for a clean stop, `crash` for a caught failure), `no clean stop` when it did not (a kill, an
   * OOM, an uncaught exit), null when there was no earlier process.
   */
  readonly previousExit: string | null = null;

  constructor(path: string, boot: string, now: () => number, o: JournalOptions = {}) {
    this.#path = path;
    this.#boot = boot;
    this.#now = now;
    this.#o = o;
    this.#reserve = `${path}.reserve`;
    let repaired = false;
    if (existsSync(path)) {
      // Only the file's tail is read: the last line (cut if torn) and the one before it give the seq and the previous
      // process's last sign of life, so a start after a long run stays fast and small (EXIT-1g review N1).
      const { lines, offsets } = lastLines(path);
      const last = lines[lines.length - 1];
      if (last !== undefined) {
        const complete = terminated(path); // I/O errors are strict, never confused with malformed JSON.
        try {
          if (!complete) throw new SyntaxError('unterminated append');
          JSON.parse(last);
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
          // Keep everything before the torn line, newline included.
          this.#truncateAt = offsets[offsets.length - 1]!;
          this.#repairTail();
          lines.pop();
          repaired = true;
        }
      }
      const good = lines[lines.length - 1];
      if (good !== undefined) {
        const l = JSON.parse(good) as { seq: number; ts?: string; kind?: string; reasons?: unknown };
        this.#seq = l.seq;
        const reasons = Array.isArray(l.reasons) ? l.reasons.filter((r): r is string => typeof r === 'string') : [];
        // A crash's stop line carries where it happened second (crash-site.ts: never the error's message).
        const where = reasons[1] === undefined ? '' : ` (${reasons[1].slice(0, 200)})`;
        this.previousExit = l.kind === 'stop' ? `stop: ${reasons[0] ?? 'no reason'}${where}` : 'no clean stop';
        const t = typeof l.ts === 'string' ? Date.parse(l.ts) : Number.NaN;
        this.previousMs = Number.isFinite(t) ? t : null;
      }
    }
    this.repaired = repaired;
    // A full-size reserve survives clean stops AND kill drills. Only observed ENOSPC truncates it to a persistent
    // marker; a normal no-stop restart does not assert evidence loss.
    this.#restartGap = existsSync(this.#reserve) ? !armedReserve(this.#reserve) : existsSync(path) && statSync(path).size > 0;
    this.#reserveReleased = existsSync(this.#reserve) && statSync(this.#reserve).size === 0;
    if (!existsSync(this.#reserve) && !this.#restartGap) this.#armReserve();
  }

  get seq(): number {
    return this.#seq;
  }

  get failing(): boolean {
    return this.#lost !== null || this.#restartGap;
  }

  write(kind: JournalKind, fields: Readonly<Record<string, unknown>> = {}): void {
    const now = this.#now();
    if (!this.retry()) {
      this.#seq++;
      if (kind === 'start') this.#startPending = true;
      this.#count(now);
      return;
    }
    this.#seq++;
    if (!this.#line(this.#seq, now, kind, fields)) {
      if (kind === 'start') this.#startPending = true;
      this.#count(now);
      return;
    }
    if (kind === 'start') {
      this.#started = true;
      this.retry();
    }
  }

  /** Try to record the missing interval; failed retries never inflate the lost event count or reuse event seqs. */
  retry(): boolean {
    if (this.#startPending) {
      if (!this.#line(this.#seq + 1, this.#now(), 'start', { reasons: ['original start evidence lost: no space left on device'] })) return false;
      this.#seq++;
      this.#startPending = false;
      this.#started = true;
    }
    const lost = this.#lost;
    // A pre-start recorder fault can lose its alert; start remains the first whole line of the new boot.
    if (!this.#started) return this.#repairTail();
    if (lost === null && !(this.#restartGap && this.#started)) return this.#repairTail();
    const now = this.#now();
    const seq = this.#seq + 1;
    if (!this.#line(seq, now, 'coverage_gap', {
      stream: 'journal', gap_id: `${this.#boot}:${lost?.fromSeq ?? 'disk-restart'}`,
      lost: this.#restartGap ? null : lost!.count,
      ...(lost === null ? {} : { from_seq: lost.fromSeq, to_seq: lost.toSeq, known_lost: lost.count }),
      from_ts: new Date(this.#restartGap ? Math.min(this.previousMs ?? now, now) : lost!.fromMs).toISOString(),
      to_ts: new Date(now).toISOString(),
      reason: this.#restartGap ? 'journal reserve missing or released; tail evidence count is unknown' : 'journal events not written: no space left on device',
    })) return false;
    this.#seq = seq;
    this.#lost = null;
    this.#restartGap = false;
    // Refill only after the recovery gap was fsynced. An ENOSPC refill leaves the zero-size marker and entries off.
    this.#armReserve();
    if (!this.#restartGap) this.#noSpaceNotified = false;
    return true;
  }

  /** Before a new entry is sent, its existing decision evidence must reach durable storage. */
  ensureDurable(): boolean {
    if (this.failing) return false;
    const fd = openSync(this.#path, 'r');
    try { fsyncSync(fd); } catch (e) {
      if (!noSpace(e)) throw e;
      this.#releaseReserve();
      this.#restartGap = true;
      this.#notifyNoSpace();
      return false;
    } finally { closeSync(fd); }
    return true;
  }

  #notifyNoSpace(): void {
    if (this.#noSpaceNotified) return;
    this.#noSpaceNotified = true;
    this.#o.onNoSpace?.();
  }

  #count(now: number): void {
    if (this.#lost === null) {
      this.#lost = { count: 1, fromMs: now, fromSeq: this.#seq, toSeq: this.#seq };
      this.#notifyNoSpace();
    } else { this.#lost.count++; this.#lost.toSeq = this.#seq; }
  }

  #armReserve(): void {
    let fd: number;
    try { fd = openSync(this.#reserve, 'w', 0o600); } catch (e) {
      if (!noSpace(e)) throw e;
      this.#restartGap = true;
      this.#notifyNoSpace();
      return;
    }
    try {
      const zeros = Buffer.alloc(64 * 1024);
      for (let off = 0; off < RESERVE_BYTES;) {
        const n = writeSync(fd, zeros, 0, Math.min(zeros.length, RESERVE_BYTES - off));
        if (n <= 0) throw new Error('journal reserve short write');
        off += n;
      }
      fsyncSync(fd);
      this.#reserveReleased = false;
    } catch (e) {
      if (!noSpace(e)) throw e;
      this.#reserveReleased = false;
      this.#releaseReserve();
      this.#restartGap = true;
      this.#notifyNoSpace();
    } finally { closeSync(fd); }
  }

  #releaseReserve(): void {
    if (this.#reserveReleased) return;
    // Truncation frees blocks without allocating a new marker. Keep the empty inode until the recovery gap is
    // durable; no ledger, saved state, journal history or recording is ever removed.
    let fd: number;
    try { fd = openSync(this.#reserve, 'r+'); } catch (e) {
      if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOENT') return;
      if (!noSpace(e)) throw e;
      return;
    }
    try {
      truncateSync(this.#reserve, 0);
      fsyncSync(fd);
      this.#reserveReleased = true;
    } catch (e) {
      if (!noSpace(e)) throw e;
      // The device can even refuse reserve release; retain the process latch and retry on its next failed write.
    } finally { closeSync(fd); }
  }

  #repairTail(): boolean {
    if (this.#truncateAt === null) return true;
    try {
      truncateSync(this.#path, this.#truncateAt);
    } catch (e) {
      if (!noSpace(e)) throw e;
      this.#releaseReserve();
      this.#notifyNoSpace();
      return false;
    }
    this.#truncateAt = null;
    return true;
  }

  #line(seq: number, now: number, kind: JournalKind, fields: Readonly<Record<string, unknown>>): boolean {
    if (!this.#repairTail()) return false;
    const before = existsSync(this.#path) ? statSync(this.#path).size : 0;
    const text = redact(jsonText({ seq, ts: new Date(now).toISOString(), boot: this.#boot, kind, ...fields }));
    try {
      (this.#o.append ?? appendFileSync)(this.#path, `${text}\n`);
      if (kind === 'coverage_gap' && fields['stream'] === 'journal') {
        const fd = openSync(this.#path, 'r');
        try { fsyncSync(fd); } finally { closeSync(fd); }
      }
    } catch (e) {
      if (!noSpace(e)) throw e;
      this.#releaseReserve();
      this.#notifyNoSpace();
      // appendFileSync may have written a prefix, including valid JSON without its newline. Remove ONLY this failed
      // append before any next line; otherwise recovery could join two events or create a duplicate seq.
      if (existsSync(this.#path) && statSync(this.#path).size !== before) this.#truncateAt = before;
      this.#repairTail();
      return false;
    }
    // Only a line that reached the file is told (a line lost to ENOSPC is not), outside the append's ENOSPC handling.
    this.#o.written?.(kind, text);
    return true;
  }
}
