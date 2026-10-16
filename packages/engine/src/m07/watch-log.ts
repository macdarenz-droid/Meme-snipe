// The watch history the coverage report counts against (card Z08, Z04 ruling 14: the denominator comes from the
// watchlist or the universe manifest, never from poll_counts). M04's watch and unwatch calls are appended, one JSON line
// each, to `<dataDir>/watch/YYYY-MM-DD.ndjson` (public pool ids only; supervisor's stored-data ruling). At the first
// event of a new UTC day every pool still watched is carried over, so each day file stands alone. A pool whose watch was
// never closed (a crash) counts as watched to the end of the day: the coverage report then counts that time as missing,
// which can only make a day look worse, never better.
import * as nodeFs from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { UnixMs } from '@bot/types';
import { DAY_MS, dayStartOf, type PriorityClass, type WatchInterval } from './coverage.ts';
import { FILE_MODE, mkdirs } from './segments.ts';

/** Poll interval of each class (A-M04-01: 2 Hz positions, 1 Hz candidates; M05 tails 0.1 Hz). */
export const POLL_INTERVAL_MS: Readonly<Record<PriorityClass, number>> = { position: 500, candidate: 1_000, tail: 10_000 };

interface Line { e: 'watch' | 'unwatch' | 'carry'; poolId: string; c?: PriorityClass; at: UnixMs }

export type WatchLogFs = Pick<typeof nodeFs, 'appendFileSync' | 'existsSync' | 'mkdirSync' | 'chmodSync' | 'readFileSync' | 'statSync'>;

export class WatchLog {
  private readonly dir: string;
  private readonly fs: WatchLogFs;
  private readonly watched = new Map<string, PriorityClass>();
  private day: string | null = null;
  private readonly onError: (e: unknown) => void;

  constructor(dataDir: string, onError: (e: unknown) => void, fs: WatchLogFs = nodeFs) {
    this.dir = join(dataDir, 'watch');
    this.fs = fs;
    this.onError = onError;
  }

  /** Opens the day's file: on a new UTC day every pool still watched (but `except`) is carried over first. */
  private ensureDay(day: string, except: string | null): string {
    // Ruling Z10-26: made as segments.ts makes its folders (finding F8: under the unit's UMask=0077 a chmod to 0750
    // cleared the setgid group of /var/lib/zeroed-md), and the day file set to 0640 once, when it is first made.
    if (!this.fs.existsSync(this.dir)) mkdirs(this.fs, dirname(this.dir), basename(this.dir));
    const path = join(this.dir, `${day}.ndjson`);
    if (!this.fs.existsSync(path)) { this.fs.appendFileSync(path, '', { mode: FILE_MODE }); this.fs.chmodSync(path, FILE_MODE); }
    if (this.day !== day) {
      const carry = [...this.watched].filter(([p]) => p !== except).map(([poolId, c]) => JSON.stringify({ e: 'carry', poolId, c, at: dayStartOf(day) }));
      if (carry.length > 0) this.fs.appendFileSync(path, `${carry.join('\n')}\n`, { mode: FILE_MODE });
      this.day = day;
    }
    return path;
  }

  /** True when the line was written (ruling Z08-18: callers change their state only then). */
  private write(line: Line): boolean {
    try {
      const path = this.ensureDay(new Date(line.at).toISOString().slice(0, 10), line.poolId);
      this.fs.appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: FILE_MODE });
      return true;
    } catch (e) {
      this.onError(e);
      return false;
    }
  }

  /** Call at least once a minute: a quiet new UTC day still gets its carried-over watches. */
  tick(nowMs: UnixMs): void {
    try {
      this.ensureDay(new Date(nowMs).toISOString().slice(0, 10), null);
    } catch (e) {
      this.onError(e);
    }
  }

  watch(poolId: string, c: PriorityClass, atMs: UnixMs): void {
    if (this.watched.get(poolId) === c) return;
    if (this.write({ e: 'watch', poolId, c, at: atMs })) this.watched.set(poolId, c);
  }

  unwatch(poolId: string, atMs: UnixMs): void {
    if (!this.watched.has(poolId)) return;
    if (this.write({ e: 'unwatch', poolId, at: atMs })) this.watched.delete(poolId);
  }

  /** The day's watch intervals (an unclosed watch runs to the end of the day). */
  static readDay(dataDir: string, dayUtc: string, fs: Pick<typeof nodeFs, 'existsSync' | 'readFileSync'> = nodeFs): WatchInterval[] {
    const path = join(dataDir, 'watch', `${dayUtc}.ndjson`);
    if (!fs.existsSync(path)) return [];
    const end = (dayStartOf(dayUtc) + DAY_MS) as UnixMs;
    const open = new Map<string, { c: PriorityClass; from: UnixMs }>();
    const out: WatchInterval[] = [];
    const close = (poolId: string, at: UnixMs): void => {
      const o = open.get(poolId);
      if (o === undefined) return;
      open.delete(poolId);
      if (at > o.from) out.push({ poolId, priorityClass: o.c, fromMs: o.from, toMs: at, pollIntervalMs: POLL_INTERVAL_MS[o.c] });
    };
    for (const text of (fs.readFileSync(path, 'utf8') as string).split('\n')) {
      if (text === '') continue;
      let l: Line;
      try {
        l = JSON.parse(text) as Line;
      } catch {
        continue;                                                         // a torn last line after a crash
      }
      if (typeof l.poolId !== 'string' || typeof l.at !== 'number') continue;
      if (l.e === 'unwatch') { close(l.poolId, l.at); continue; }
      if ((l.e === 'watch' || l.e === 'carry') && l.c !== undefined && Object.hasOwn(POLL_INTERVAL_MS, l.c)) {
        close(l.poolId, l.at);                                            // a class change closes the old interval
        open.set(l.poolId, { c: l.c, from: l.at });
      }
    }
    for (const poolId of [...open.keys()]) close(poolId, end);
    return out;
  }
}
