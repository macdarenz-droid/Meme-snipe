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
//
// Clock steps (Z02 round 2 ruling 8): a day file is deleted only when it is past the retention by date AND not among the
// `retentionDays` newest days at or before the current day, so a clock that jumps ahead deletes at most one older day
// (never the whole history), and a file dated after the current day is kept and not counted. A day already compressed
// is never overwritten: when the clock goes back across midnight and that day's file is written again, its new lines
// are added to the `.gz` as another gzip member (gunzip reads every member), through a copy that replaces it in one
// rename (ruling 17).
import {
  appendFileSync, copyFileSync, createReadStream, createWriteStream, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync,
  type WriteStream,
} from 'node:fs';
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
  /** Days whose earlier streams are still flushing: never compressed until they have ended (ruling 8). */
  private readonly ending = new Map<string, number>();
  /** Days being compressed now: their `.gz.tmp` is in use, and a second compression of them waits for the next pass. */
  private readonly compressing = new Set<string>();
  private readonly opts: FileLogSinkOptions;

  constructor(opts: FileLogSinkOptions) {
    this.opts = opts;
    if (!Number.isInteger(opts.retentionDays) || opts.retentionDays < 1) throw new RangeError('log: retentionDays must be an integer >= 1');
    this.prefix = opts.prefix ?? 'engine';
    this.fileRe = new RegExp(`^${this.prefix}-(\\d{4}-\\d{2}-\\d{2})\\.ndjson(\\.gz|\\.gz\\.tmp|\\.gz\\.part|\\.compressing)?$`);
    mkdirSync(opts.dir, { recursive: true, mode: 0o700 });
    this.rotate(dayOf(opts.clock.nowMs()));
  }

  write(line: string, level: Level): SinkResult {
    if (this.closed) return 'lost';
    const now = this.opts.clock.nowMs();
    const day = dayOf(now);
    if (day !== this.day) this.rotate(day);
    // A retry time left far ahead by a clock that came back is not waited for (red team C M3 pattern).
    else if (this.broken && (now >= this.retryAt || now < this.retryAt - REOPEN_MS)) this.open();
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
    const oldDay = this.day;
    this.stream = null;
    this.day = day;
    this.open();
    if (old !== null) this.ending.set(oldDay, (this.ending.get(oldDay) ?? 0) + 1);
    const done = old === null ? Promise.resolve() : new Promise<void>((resolve) => old.end(() => {
      const left = (this.ending.get(oldDay) ?? 1) - 1;
      if (left === 0) this.ending.delete(oldDay);
      else this.ending.set(oldDay, left);
      resolve();
    }));
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
    const files = names.flatMap((name) => {
      const m = this.fileRe.exec(name);
      return m === null ? [] : [{ file: join(this.opts.dir, name), fileDay: m[1] as string, suffix: m[2] }];
    });
    // The newest `retentionDays` days at or before today are kept whatever their date says (ruling 8).
    const kept = new Set([...new Set(files.map((f) => f.fileDay).filter((d) => d <= day))].sort().reverse().slice(0, this.opts.retentionDays));
    for (const { file, fileDay, suffix } of files) {
      const old = (today - Date.parse(`${fileDay}T00:00:00Z`)) / DAY_MS >= this.opts.retentionDays && !kept.has(fileDay);
      if (this.compressing.has(fileDay)) continue;
      if (old || suffix === '.gz.tmp' || suffix === '.gz.part') {
        rmSync(file, { force: true, recursive: true });
        continue;
      }
      // Never the file being written: after a clock step back, `day` can be later than the current day (ruling 8).
      if ((suffix === undefined || suffix === '.compressing') && fileDay < day && fileDay !== this.day && !this.ending.has(fileDay)) {
        this.compressing.add(fileDay);
        try {
          await this.compress(file, suffix);
        } finally {
          this.compressing.delete(fileDay);
        }
      }
    }
  }

  /**
   * Compresses one day's plain file. It is first renamed to `.compressing` (synchronously, right after the check that it
   * is not the file being written), so lines written to that day later go to a new plain file and are never deleted
   * with the old one; a crash leaves the `.compressing` file, which the next housekeeping compresses.
   */
  private async compress(file: string, suffix: string | undefined): Promise<void> {
    const plain = suffix === '.compressing' ? file.slice(0, -'.compressing'.length) : file;
    const source = `${plain}.compressing`;
    try {
      if (suffix === undefined) {
        if (existsSync(source)) return;                                  // a compression of this day is still running
        renameSync(plain, source);
      }
      await pipeline(createReadStream(source), createGzip(), createWriteStream(`${plain}.gz.tmp`, { flags: 'wx', mode: 0o600 }));
      if (existsSync(`${plain}.gz`)) {
        // The day was compressed before (the clock went back across midnight): the old file plus the new member go to
        // `.gz.part`, which then replaces `.gz` in one rename, so a crash never leaves a half-appended `.gz` (ruling 17).
        copyFileSync(`${plain}.gz`, `${plain}.gz.part`);
        appendFileSync(`${plain}.gz.part`, readFileSync(`${plain}.gz.tmp`));
        renameSync(`${plain}.gz.part`, `${plain}.gz`);
        rmSync(`${plain}.gz.tmp`);
      } else {
        renameSync(`${plain}.gz.tmp`, `${plain}.gz`);
      }
      rmSync(source);
    } catch (e) {
      this.opts.onError?.({ op: 'compress', message: (e as Error).message });
    }
  }
}
