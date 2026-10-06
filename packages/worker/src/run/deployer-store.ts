// The deployer index's saved state (supervisor ruling 2026-10-04, SEED-1): every released event the index learns from
// (creates, rug labels, unjudged mints) and every creates and rugs coverage fact, appended as it is released, so a
// restart re-seeds the index and puts the coverage history back into the engine instead of blanking H14 for a whole
// look-back. Public chain data only. Kept for the look-back plus a day; older lines are dropped at each start and once a
// day while running (DISK-GUARD: the file stays bounded however long the worker runs). A line that does not fit (ENOSPC)
// is not a crash: durable write-ahead uncertainty holds entries across restarts; the next line that fits is preceded by a bounded `coverage:<creates|rugs>:gap` over the lost range,
// so a restart seeded from this file reads H14 as not covered across it, never as complete.
import { appendFileSync, closeSync, constants, existsSync, fstatSync, fsyncSync, ftruncateSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { fileLines } from '../../../runner/src/lines.ts';
import { join } from 'node:path';
import { compareEvents, type MarketEvent } from '../../../core/src/engine/index.ts';
import { LOG_CREATE_PREFIX, RUG_PREFIX, RUG_UNJUDGED_PREFIX, TX_CREATE_PREFIX, pruneCoverage } from '../../../core/src/gates/index.ts';
import { parseTyped, typedText } from './json.ts';
import { commitTemp, writeAll, type WriteFn } from './state.ts';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const isCreate = (key: string): boolean => key.startsWith(LOG_CREATE_PREFIX) || key.startsWith(TX_CREATE_PREFIX);
export const isRugFact = (key: string): boolean => key.startsWith(RUG_PREFIX) || key.startsWith(RUG_UNJUDGED_PREFIX);
export const isCoverage = (key: string): boolean => /^coverage:(creates|rugs):(start|gap|resume)$/.test(key);

/** A create event cut to what the index reads (mint, creator, chain time, supply), so a look-back of creates stays small. */
const compactCreate = (e: MarketEvent): MarketEvent => {
  const v = e.value;
  const ev = isObj(v) && isObj(v['event']) ? v['event'] : null;
  const d = ev !== null && isObj(ev['data']) ? ev['data'] : null;
  if (ev === null || d === null) return e;
  const data: Record<string, unknown> = { mint: d['mint'], creator: d['creator'], timestamp: d['timestamp'] };
  if (d['tokenTotalSupply'] !== undefined) data['tokenTotalSupply'] = d['tokenTotalSupply'];
  return { kind: 'market', id: e.id, moment: e.moment, key: e.key, value: { event: { name: ev['name'], program: ev['program'], data } } };
};

export interface SavedDeployers {
  readonly creates: readonly MarketEvent[];
  readonly rugs: readonly MarketEvent[];
  readonly coverage: readonly MarketEvent[];
  /** The newest moment saved (slot and receipt time): where a downtime fill starts. */
  readonly last: { readonly slot: bigint; readonly ms: number } | null;
  /** Why the saved seed was refused whole (over the cap), if it was. */
  readonly refused?: string;
}

/** The `via` of the gaps the store writes for lines it lost (no live watch has this name). */
export const STORE_GAP_VIA = 'deployer-store';

export interface DeployerStoreOptions {
  /** Told when a line was not written for lack of space. */
  readonly onNoSpace?: () => void;
  /** Test seam: appends a line (default appendFileSync), so a test can make a write fail with ENOSPC. */
  readonly append?: (path: string, text: string) => void;
  /** Fault seams for the durable write-ahead marker; default checked writes and fsync. */
  readonly markerWrite?: WriteFn;
  readonly sync?: (fd: number) => void;
}

const noSpace = (e: unknown): boolean => typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'ENOSPC';

export class DeployerStore {
  readonly #path: string;
  readonly #marker: string;
  readonly #stateDir: string;
  #uncertain = false;

  readonly #write: WriteFn | undefined;
  readonly #o: DeployerStoreOptions;
  /** DISK-GUARD: the first lost line's moment and how many were lost, until their bounded gaps are written; durable uncertainty stays independent. */
  #lost: { from: MarketEvent['moment']; count: number } | null = null;

  /** `write` is for tests (a short write); the default checks every write's count. */
  constructor(stateDir: string, write?: WriteFn, o: DeployerStoreOptions = {}) {
    this.#path = join(stateDir, 'deployers.jsonl');
    this.#marker = join(stateDir, 'deployers.jsonl.reserve');
    this.#stateDir = stateDir;
    this.#write = write;
    this.#o = o;
    if (existsSync(this.#marker)) {
      const fd = openSync(this.#marker, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || st.size !== 65536) this.#uncertain = true;
        else {
          const bytes = readFileSync(fd);
          this.#uncertain = bytes[0] !== 0 || bytes.subarray(1).some((b) => b !== 0);
        }
      } finally { closeSync(fd); }
    } else {
      // Migration cannot certify an older saved store. A missing marker beside saved data is unknown.
      this.#uncertain = existsSync(this.#path) || existsSync(join(stateDir, 'deployer-state.json'));
      let fd: number | null = null;
      try {
        fd = openSync(this.#marker, 'wx', 0o600);
        writeAll(fd, (this.#uncertain ? '\x01' : '\0') + '\0'.repeat(65535), o.markerWrite);
        if (fstatSync(fd).size !== 65536) throw new Error('deployer uncertainty marker short write');
        (o.sync ?? fsyncSync)(fd);
        this.#syncDir();
      } catch (err) {
        this.#uncertain = true;
        if (!noSpace(err)) throw err;
        o.onNoSpace?.();
      } finally { if (fd !== null) closeSync(fd); }
    }
  }

  #syncDir(): void {
    const fd = openSync(this.#stateDir, constants.O_RDONLY | constants.O_DIRECTORY);
    try { (this.#o.sync ?? fsyncSync)(fd); } finally { closeSync(fd); }
  }

  #mark(pending: boolean): void {
    const fd = openSync(this.#marker, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size !== 65536) throw new Error('deployer-store uncertainty marker is invalid');
      writeAll(fd, pending ? '\x01' : '\0', this.#o.markerWrite);
      const byte = Buffer.alloc(1);
      if (readSync(fd, byte, 0, 1, 0) !== 1 || byte[0] !== (pending ? 1 : 0)) throw new Error('deployer write-ahead marker short write');
      (this.#o.sync ?? fsyncSync)(fd);
    } catch (err) {
      // A failed write-ahead operation never dispatches the append. Releasing already allocated bytes gives
      // zero-progress/torn marker failures a persistent unknown state too; never rearm it after a failure.
      this.#uncertain = true;
      try { ftruncateSync(fd, 0); (this.#o.sync ?? fsyncSync)(fd); } catch { /* The original failure stays strict. */ }
      throw err;
    } finally { closeSync(fd); }
  }

  /** Independent open gaps cannot be settled by an ordinary watch restart, retry or creates-only refill. */
  uncertaintyCoverage(): readonly MarketEvent[] {
    if (!this.#uncertain) return [];
    return ['creates', 'rugs'].map((stream) => ({
      kind: 'market', id: `${STORE_GAP_VIA}:uncertain:${stream}`, key: `coverage:${stream}:gap`,
      moment: { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: 0 },
      value: { value: { fromSlot: 0n, toSlot: null, via: `${STORE_GAP_VIA}-uncertain`, reason: 'saved deployer data uncertain; verified repair required' }, source: 'worker', backfilled: false, seq: 0 },
    }));
  }

  /** True while a write failed or a durable marker says saved deployer history is uncertain. */
  get failing(): boolean {
    return this.#uncertain || this.#lost !== null;
  }

  /** Keeps a released event when the index or H14's coverage reads it. */
  keep(e: MarketEvent): void {
    if (!isCreate(e.key) && !isRugFact(e.key) && !isCoverage(e.key)) return;
    const lost = this.#lost;
    let text = `${typedText(isCreate(e.key) ? compactCreate(e) : e)}\n`;
    if (lost !== null) {
      // The gaps go in the same append as the line after them, after a newline that ends any part of a lost line a short
      // write left (load skips that fragment and the empty line): all land, or the range grows and they are tried again.
      const gap = (stream: string): string => typedText({
        kind: 'market', id: `${STORE_GAP_VIA}:${stream}:${String(lost.from.slot)}:${lost.from.receivedAt}`, moment: e.moment, key: `coverage:${stream}:gap`,
        value: { value: { fromSlot: lost.from.slot, toSlot: e.moment.slot, reason: `${lost.count} saved line(s) lost: no space left on the device`, via: STORE_GAP_VIA }, source: 'worker', backfilled: false, seq: 0 },
      });
      text = `\n${gap('creates')}\n${gap('rugs')}\n${text}`;
    }
    try {
      const alreadyUncertain = this.#uncertain;
      if (!alreadyUncertain) this.#mark(true);
      const existed = existsSync(this.#path);
      (this.#o.append ?? appendFileSync)(this.#path, text);
      const fd = openSync(this.#path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { (this.#o.sync ?? fsyncSync)(fd); } finally { closeSync(fd); }
      if (!existed) this.#syncDir();
      if (!alreadyUncertain) this.#mark(false);
    } catch (err) {
      this.#uncertain = true;
      if (!noSpace(err)) throw err;
      if (this.#lost === null) this.#lost = { from: e.moment, count: 0 };
      this.#lost.count += 1;
      this.#o.onNoSpace?.();
      return;
    }
    this.#lost = null;
  }

  /**
   * The saved events received at or after `fromMs`, in release order, with the file rewritten to just those (a torn
   * last line from a kill is dropped). Older coverage facts are cut by `pruneCoverage` (WORKER-1d), not dropped: a
   * start older than the window is what says the stream has run since before it, and an open gap stays open.
   */
  load(fromMs: number, o: { readonly keepCreates?: boolean; readonly maxCreates?: number; readonly onCreate?: (e: MarketEvent) => void } = {}): SavedDeployers {
    if (!existsSync(this.#path)) return { creates: [], rugs: [], coverage: this.uncertaintyCoverage(), last: null };
    // WORKER-GROW: with a restored index the creates are already in it, so they stay in the file only (`keepCreates`
    // false). Without one they seed the index, at most `maxCreates` of them: past that the seed is refused whole (no
    // creates, rugs or coverage), so H14 reads not covered until the look-back passes, which is fail safe; seeding the
    // coverage without all of its creates would not be.
    const keepCreates = o.keepCreates ?? true;
    const maxCreates = o.maxCreates ?? Number.POSITIVE_INFINITY;
    let creates = 0;
    // WORKER-1d: which coverage facts to keep is decided over all of them first (`pruneCoverage`: the latest start per
    // stream and watch, a watch's history while it has an open gap, unreadable ones). Only coverage lines are held, and
    // after the first pruned load they are few.
    const coverageFacts: MarketEvent[] = [];
    for (const line of fileLines(this.#path)) {
      if (!line.includes('"coverage:')) continue;
      try {
        const e = parseTyped(line) as MarketEvent;
        if (isCoverage(e.key)) coverageFacts.push(e);
      } catch {
        // a torn line: skipped below too
      }
    }
    const keepSet = new Set(pruneCoverage(coverageFacts, fromMs));
    const keepCoverage = coverageFacts.map((e) => keepSet.has(e));
    let coverageAt = 0;
    let last: { slot: bigint; ms: number } | null = null;
    const kept: MarketEvent[] = [];
    // Streamed in chunks and rewritten in 1 MiB batches (GROWTH-SWEEP): 15 days of creates is about a million lines, too big
    // to hold as one string and its split beside the parsed events under the worker's MemoryMax.
    const tmp = `${this.#path}.tmp`;
    const fd = openSync(tmp, 'w', 0o600);
    let out: string[] = [];
    let outBytes = 0;
    let written = 0;
    const flush = (): void => {
      if (out.length > 0) written += writeAll(fd, out.join(''), this.#write);
      out = [];
      outBytes = 0;
    };
    try {
      for (const line of fileLines(this.#path)) {
        if (line === '') continue;
        let e: MarketEvent;
        try {
          e = parseTyped(line) as MarketEvent;
        } catch {
          continue;
        }
        if (!isCoverage(e.key) && e.moment.receivedAt < fromMs) continue;
        if (last === null || e.moment.slot > last.slot) last = { slot: e.moment.slot, ms: e.moment.receivedAt };
        // A coverage fact the prune drops is neither kept nor written back (it is older than `fromMs`).
        if (isCoverage(e.key) && keepCoverage[coverageAt++] !== true) continue;
        if (isCreate(e.key)) {
          creates++;
          // CREATE-AFTER-RESTART: every create in the window is shown to `onCreate` (its mint and signature), kept or not.
          o.onCreate?.(e);
          if (keepCreates && creates <= maxCreates) kept.push(e);
        } else kept.push(e);
        const text = `${typedText(e)}\n`;
        out.push(text);
        outBytes += text.length;
        if (outBytes >= 1 << 20) flush();
      }
      flush();
    } catch (e) {
      // A short write (a nearly full disk) or a read error: the old file stays whole and the start stops with the error.
      closeSync(fd);
      rmSync(tmp, { force: true });
      throw e;
    }
    commitTemp(fd, tmp, this.#path, written);
    if (keepCreates && creates > maxCreates) return { creates: [], rugs: [], coverage: this.uncertaintyCoverage(), last: null, refused: `${creates} saved creates, over the seed cap of ${maxCreates}` };
    return { creates: kept.filter((e) => isCreate(e.key)), rugs: kept.filter((e) => isRugFact(e.key)), coverage: [...kept.filter((e) => isCoverage(e.key)), ...this.uncertaintyCoverage()].sort(compareEvents), last };
  }
}

/**
 * The saved live creates watch, for the downtime fill's `close`: its open gap (via and first slot), or, when none was
 * open (a crash leaves none), the watch itself with no first slot. Null when no live watch ever started.
 */
export const liveWatchToClose = (coverage: readonly MarketEvent[]): { readonly via: string; readonly fromSlot: bigint | null } | null => {
  const val = (e: MarketEvent): Record<string, unknown> | null => (isObj(e.value) && isObj(e.value['value']) ? e.value['value'] : isObj(e.value) ? e.value : null);
  let via: string | null = null;
  const open = new Map<string, bigint | null>();
  for (const e of coverage) {
    if (!e.key.startsWith('coverage:creates:')) continue;
    const v = val(e);
    if (v === null || typeof v['via'] !== 'string' || v['via'] === 'seed') continue;
    const w = v['via'];
    if (e.key.endsWith(':start')) {
      via = w;
      open.delete(w);
    } else if (e.key.endsWith(':gap') && v['toSlot'] === null) open.set(w, typeof v['fromSlot'] === 'bigint' ? v['fromSlot'] : null);
    else if (e.key.endsWith(':gap') || e.key.endsWith(':resume')) open.delete(w);
  }
  if (via === null) return null;
  return open.has(via) ? { via, fromSlot: open.get(via) ?? null } : { via, fromSlot: null };
};
