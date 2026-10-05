// journal.jsonl (docs/ARCHITECTURE.md §12.4): one JSON line per event, appended synchronously, so a kill can tear only
// the last line. At open a torn last line is cut and a `journal_repair` line follows the boot's `start`; `seq` runs on
// across restarts. DISK-GUARD: a line that cannot be written for lack of space is counted, not thrown (the worker keeps
// exiting positions on a full disk); the next line that fits is preceded by a `journal_gap` line with the count, so the
// evidence says what it is missing, and `seq` stays unbroken.
import { appendFileSync, closeSync, existsSync, openSync, readSync, statSync, truncateSync } from 'node:fs';
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
  /** Told when a line was not written for lack of space (ENOSPC). */
  readonly onNoSpace?: () => void;
  /** Test seam: appends a line (default appendFileSync), so a test can make a write fail with ENOSPC. */
  readonly append?: (path: string, text: string) => void;
}

/** True when the file is missing, empty or ends with a newline (no part of a line left by a short write). */
const endsWithNewline = (path: string): boolean => {
  const size = existsSync(path) ? statSync(path).size : 0;
  if (size === 0) return true;
  const b = Buffer.alloc(1);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, b, 0, 1, size - 1);
  } finally {
    closeSync(fd);
  }
  return b[0] === 0x0a;
};

const noSpace = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOSPC';

export class Journal {
  readonly #path: string;
  readonly #boot: string;
  readonly #now: () => number;
  readonly #o: JournalOptions;
  #seq = 0;
  /** DISK-GUARD: lines not written for lack of space since the last `journal_gap`, and when the first of them was due. */
  #lost: { count: number; fromMs: number } | null = null;
  /** When the last whole line before this process was written (the previous process's last sign of life), or null. */
  readonly previousMs: number | null = null;
  /** True when a torn last line was cut at open. */
  readonly repaired: boolean;

  constructor(path: string, boot: string, now: () => number, o: JournalOptions = {}) {
    this.#path = path;
    this.#boot = boot;
    this.#now = now;
    this.#o = o;
    let repaired = false;
    if (existsSync(path)) {
      // Only the file's tail is read: the last line (cut if torn) and the one before it give the seq and the previous
      // process's last sign of life, so a start after a long run stays fast and small (EXIT-1g review N1).
      const { lines, offsets } = lastLines(path);
      const last = lines[lines.length - 1];
      if (last !== undefined) {
        try {
          JSON.parse(last);
        } catch {
          // Keep everything before the torn line, newline included.
          truncateSync(path, offsets[offsets.length - 1]!);
          lines.pop();
          repaired = true;
        }
      }
      const good = lines[lines.length - 1];
      if (good !== undefined) {
        const l = JSON.parse(good) as { seq: number; ts?: string };
        this.#seq = l.seq;
        const t = typeof l.ts === 'string' ? Date.parse(l.ts) : Number.NaN;
        this.previousMs = Number.isFinite(t) ? t : null;
      }
    }
    this.repaired = repaired;
  }

  get seq(): number {
    return this.#seq;
  }

  /** True while lines were lost for lack of space and their `journal_gap` is not written yet. */
  get failing(): boolean {
    return this.#lost !== null;
  }

  /**
   * Appends one line. A line that does not fit (ENOSPC) is counted instead and its `seq` is not used; any other error
   * is thrown as before.
   */
  write(kind: JournalKind, fields: Readonly<Record<string, unknown>> = {}): void {
    const now = this.#now();
    if (!this.#gap(now)) return this.#count(now);
    if (!this.#line(now, kind, fields)) this.#count(now);
  }

  /** Writes the pending `journal_gap` line if there is room now (the worker tries once a minute); true when none is pending. */
  retry(): boolean {
    return this.#gap(this.#now());
  }

  #gap(now: number): boolean {
    const lost = this.#lost;
    if (lost === null) return true;
    // A newline first when a short write left part of a lost line, so that fragment stands alone (the runner flags it).
    const ok = this.#line(now, 'journal_gap', { lost: lost.count, from_ts: new Date(lost.fromMs).toISOString(), reasons: [`${lost.count} journal line(s) not written: no space left on the device`] }, endsWithNewline(this.#path) ? '' : '\n');
    if (ok) this.#lost = null;
    return ok;
  }

  #count(now: number): void {
    if (this.#lost === null) this.#lost = { count: 0, fromMs: now };
    this.#lost.count += 1;
    this.#o.onNoSpace?.();
  }

  /** One line; false (and `seq` unchanged) when it did not fit. */
  #line(now: number, kind: JournalKind, fields: Readonly<Record<string, unknown>>, before = ''): boolean {
    const seq = this.#seq + 1;
    try {
      (this.#o.append ?? appendFileSync)(this.#path, `${before}${redact(jsonText({ seq, ts: new Date(now).toISOString(), boot: this.#boot, kind, ...fields }))}\n`);
    } catch (e) {
      if (!noSpace(e)) throw e;
      return false;
    }
    this.#seq = seq;
    return true;
  }
}
