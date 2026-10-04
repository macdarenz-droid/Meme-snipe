// journal.jsonl (docs/ARCHITECTURE.md §12.4): one JSON line per event, appended synchronously, so a kill can tear only
// the last line. At open a torn last line is cut and a `journal_repair` line follows the boot's `start`; `seq` runs on
// across restarts.
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

export class Journal {
  readonly #path: string;
  readonly #boot: string;
  readonly #now: () => number;
  #seq = 0;
  /** When the last whole line before this process was written (the previous process's last sign of life), or null. */
  readonly previousMs: number | null = null;
  /** True when a torn last line was cut at open. */
  readonly repaired: boolean;

  constructor(path: string, boot: string, now: () => number) {
    this.#path = path;
    this.#boot = boot;
    this.#now = now;
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

  write(kind: JournalKind, fields: Readonly<Record<string, unknown>> = {}): void {
    this.#seq += 1;
    appendFileSync(this.#path, `${redact(jsonText({ seq: this.#seq, ts: new Date(this.#now()).toISOString(), boot: this.#boot, kind, ...fields }))}\n`);
  }
}
