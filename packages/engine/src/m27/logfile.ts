// JSON-lines log files with daily rotation, gzip compression and 14-day retention (B-M27-01 logic 4-5; ARCH 13.2).
//
// One file per UTC day, `<prefix>-YYYY-MM-DD.ndjson`, mode 0600 in a 0700 directory. At the first write of a new
// day the old file is closed and compressed in the background (`.gz.tmp`, then renamed to `.gz`, then the plain file
// is removed, so a crash never leaves a half-written `.gz`), and files older than the retention are deleted.
//
// "Sink full → drop debug, keep warn and above" (ARCH M27; B-M27-01 logic 5). Lines are `shed` (`log_dropped_total`):
// - write queue (bytes not yet on disk): debug from half of `queueBytes`, info from `queueBytes`;
// - daily size: debug and info from `maxBytesPerDay`. The daily size never drops warn and above.
// Lines are `lost` (`log_lost_total`, owner-visible spec deviation): any level while the file cannot be opened or
// written, and warn and above once the write queue reaches its hard memory bound of twice `queueBytes` (2 GB host,
// owner rule: the queue must not grow without limit). A line accepted but then not written (the disk filled before it
// reached the file, or its stream broke) is reported to `onLost` once its write fails, so it is counted as lost too.
// A file that cannot be opened or written is reported (`onError`) and reopened every `REOPEN_MS` (30 s) until it
// works again, so a short disk-full or I/O error loses at most the lines of that outage, not the rest of the day
// (B-M27-01 logic 5).
// The logger copies error and above to the alert store whatever the sink returns.
import { createReadStream, createWriteStream, fstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { Clock } from '@bot/types';
import { LEVELS, type Level, type LogSink, type SinkResult } from './log.ts';

export interface FileLogSinkOptions {
  dir: string;
  clock: Clock;
  /** `m27.log_retention_days`: days kept, today included. */
  retentionDays: number;
  /** `m27.log_max_bytes_per_day`. */
  maxBytesPerDay: number;
  /** `m27.log_queue_bytes`: bytes buffered for the disk before lines are dropped. */
  queueBytes: number;
  prefix?: string;
  onError?: (e: { op: 'open' | 'write' | 'compress' | 'prune'; message: string }) => void;
  /**
   * Called for each line `write` accepted ('written') whose write then failed, for example on a still-full disk
   * (`log_lost_total{level}`, wired like the logger's `onLost`; red team n4).
   */
  onLost?: (level: Level) => void;
}

const DAY_MS = 86_400_000;
/** While the day's file cannot be opened or written, it is reopened at most this often. */
export const REOPEN_MS = 30_000;
const WARN = LEVELS.indexOf('warn');
const INFO = LEVELS.indexOf('info');

function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export class FileLogSink implements LogSink {
  private readonly prefix: string;
  private readonly fileRe: RegExp;
  private day = '';
  private stream: WriteStream | null = null;
  private broken = false;
  private closed = false;
  private retryAt = 0;
  private dayBytes = 0;
  private readonly pending = new Set<Promise<void>>();
  private readonly opts: FileLogSinkOptions;

  constructor(opts: FileLogSinkOptions) {
    this.opts = opts;
    if (!Number.isInteger(opts.retentionDays) || opts.retentionDays < 1) throw new RangeError('log: retentionDays must be an integer >= 1');
    this.prefix = opts.prefix ?? 'engine';
    this.fileRe = new RegExp(`^${this.prefix}-(\\d{4}-\\d{2}-\\d{2})\\.ndjson(\\.gz|\\.gz\\.tmp)?$`);
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    this.rotate(dayOf(opts.clock.nowMs()));
  }

  write(line: string, level: Level): SinkResult {
    if (this.closed) return 'lost';
    const now = this.opts.clock.nowMs();
    const day = dayOf(now);
    if (day !== this.day) this.rotate(day);
    else if (this.broken && now >= this.retryAt) this.open();
    const rank = LEVELS.indexOf(level);
    const queued = this.stream === null ? 0 : this.stream.writableLength;
    if (rank < INFO && queued >= this.opts.queueBytes / 2) return 'shed';
    if (rank < WARN && (queued >= this.opts.queueBytes || this.dayBytes >= this.opts.maxBytesPerDay)) return 'shed';
    if (this.broken || queued >= 2 * this.opts.queueBytes) return 'lost';
    const text = `${line}\n`;
    this.dayBytes += Buffer.byteLength(text);
    (this.stream as WriteStream).write(text, (e) => {
      if (e) this.opts.onLost?.(level);
    });
    return 'written';
  }

  /** The current day's file. */
  path(day = this.day): string {
    return join(this.opts.dir, `${this.prefix}-${day}.ndjson`);
  }

  /** Closes the current file and waits for every background compression. */
  async close(): Promise<void> {
    this.closed = true;
    const stream = this.stream;
    this.stream = null;
    if (stream !== null) await new Promise<void>((resolve) => stream.end(() => resolve()));
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  private rotate(day: string): void {
    const old = this.stream;
    this.stream = null;
    this.day = day;
    this.open();
    const done = old === null ? Promise.resolve() : new Promise<void>((resolve) => old.end(() => resolve()));
    this.track(done.then(() => this.housekeep(day)));
  }

  /**
   * Opens the day's file in append mode (synchronously, so an open error is known at once). A failed open or a later
   * write error marks the sink broken until the next attempt, `REOPEN_MS` later. An error of a stream that has
   * already been replaced (the previous day's, or a broken one) is reported but leaves the current file alone.
   */
  private open(): void {
    if (this.stream !== null) this.stream.destroy();   // a broken stream: its queued lines are already lost
    this.stream = null;
    let fd: number;
    try {
      fd = openSync(this.path(), 'a', 0o600);
    } catch (e) {
      this.fail('open', (e as Error).message);
      return;
    }
    this.broken = false;
    this.dayBytes = fstatSync(fd).size;
    const stream = createWriteStream(this.path(), { fd });
    stream.on('error', (e) => {
      if (this.stream === stream) this.fail('write', e.message);
      else this.opts.onError?.({ op: 'write', message: e.message });
    });
    this.stream = stream;
  }

  private fail(op: 'open' | 'write', message: string): void {
    this.broken = true;
    this.retryAt = this.opts.clock.nowMs() + REOPEN_MS;
    this.opts.onError?.({ op, message });
  }

  private track(p: Promise<void>): void {
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
  }

  /** Compresses every plain file of a day before `day` and deletes files past the retention, as seen from `day`. */
  private async housekeep(day: string): Promise<void> {
    const today = Date.parse(`${day}T00:00:00Z`);
    let names: string[] = [];
    try {
      names = readdirSync(this.opts.dir);
    } catch (e) {
      this.opts.onError?.({ op: 'prune', message: (e as Error).message });
    }
    for (const name of names) {
      const m = this.fileRe.exec(name);
      if (m === null) continue;
      const file = join(this.opts.dir, name);
      const fileDay = m[1] as string;
      const suffix = m[2];
      if ((today - Date.parse(`${fileDay}T00:00:00Z`)) / DAY_MS >= this.opts.retentionDays || suffix === '.gz.tmp') {
        rmSync(file, { force: true, recursive: true });
        continue;
      }
      if (suffix === undefined && fileDay < day) await this.compress(file);
    }
  }

  private async compress(file: string): Promise<void> {
    try {
      await pipeline(createReadStream(file), createGzip(), createWriteStream(`${file}.gz.tmp`, { flags: 'wx', mode: 0o600 }));
      renameSync(`${file}.gz.tmp`, `${file}.gz`);
      rmSync(file);
    } catch (e) {
      this.opts.onError?.({ op: 'compress', message: (e as Error).message });
    }
  }
}
