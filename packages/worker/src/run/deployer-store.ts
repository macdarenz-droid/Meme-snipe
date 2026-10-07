// The deployer index's saved state (supervisor ruling 2026-10-04, SEED-1): every released event the index learns from
// (creates, rug labels, unjudged mints) and every creates and rugs coverage fact, appended as it is released, so a
// restart re-seeds the index and puts the coverage history back into the engine instead of blanking H14 for a whole
// look-back. Public chain data only. Kept for the look-back plus a day; older lines are dropped at each start.
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { fileLines } from '../../../runner/src/lines.ts';
import { join } from 'node:path';
import type { MarketEvent } from '../../../core/src/engine/index.ts';
import { LOG_CREATE_PREFIX, RUG_PREFIX, RUG_UNJUDGED_PREFIX, TX_CREATE_PREFIX, pruneCoverage } from '../../../core/src/gates/index.ts';
import { parseTyped, typedText } from './json.ts';
import { writeAll, type WriteFn } from './state.ts';

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

/** The `via` of the coverage gaps a failed append leaves (RC-FIXES-2b). */
export const STORE_GAP_VIA = 'worker:deployer-store';
/**
 * RC-FIXES-2c: space kept free beside the store (`deployers.jsonl.reserve`), so the first failed append of a full disk
 * can still write its open gaps. A few gap lines need under 2 KB.
 */
export const STORE_RESERVE_BYTES = 16 * 1024;

const storeGap = (stream: string, from: bigint, to: bigint | null, moment: MarketEvent['moment']): MarketEvent => ({
  kind: 'market', id: `${STORE_GAP_VIA}:${stream}:${from}-${to ?? 'open'}`, moment, key: `coverage:${stream}:gap`,
  value: { value: { fromSlot: from, toSlot: to, reason: 'deployer store append failed', via: STORE_GAP_VIA }, source: 'worker', backfilled: false, seq: 0 },
});
const gapVal = (e: MarketEvent): Record<string, unknown> | null => (isObj(e.value) && isObj(e.value['value']) ? e.value['value'] : null);
const isStoreGap = (e: MarketEvent): boolean => /^coverage:(creates|rugs):gap$/.test(e.key) && gapVal(e)?.['via'] === STORE_GAP_VIA;

export interface DeployerStoreOptions {
  /** For tests (a short write); the default checks every write's count. */
  readonly write?: WriteFn;
  /** A failed append is logged at most once a minute (RC-FIXES-2b). */
  readonly log?: (line: string) => void;
  readonly now?: () => number;
}

export class DeployerStore {
  readonly #path: string;

  readonly #write: WriteFn | undefined;
  readonly #log: ((line: string) => void) | undefined;
  readonly #now: () => number;
  /** The file's size after the last whole append (null: not known yet, read from the file on the next append). */
  #size: number | null = null;
  /** The slots of the events a failed append lost, not yet covered by a gap in the file. */
  #lost: { from: bigint; to: bigint } | null = null;
  /** The first lost slot whose open gaps reached the file (written from the reserve), until a closing gap follows. */
  #openFrom: bigint | null = null;
  #lastLog = Number.NEGATIVE_INFINITY;

  constructor(stateDir: string, o: WriteFn | DeployerStoreOptions = {}) {
    this.#path = join(stateDir, 'deployers.jsonl');
    const opts: DeployerStoreOptions = typeof o === 'function' ? { write: o } : o;
    this.#write = opts.write;
    this.#log = opts.log;
    this.#now = opts.now ?? Date.now;
    this.#reserve();
  }

  /** Puts the reserve back (best effort: a full disk leaves it out until a later append works). */
  #reserve(): void {
    const r = `${this.#path}.reserve`;
    try {
      if (!existsSync(r)) writeFileSync(r, Buffer.alloc(STORE_RESERVE_BYTES));
    } catch {
      rmSync(r, { force: true });
    }
  }

  /**
   * Keeps a released event when the index or H14's coverage reads it. Never throws (RC-FIXES-2b, DISK-GUARD): an append
   * that fails (a full disk) is cut back to the last whole line, logged at most once a minute, and its event's slot is
   * remembered. The next append that works first writes a closed creates gap and a closed rugs gap over every lost
   * slot, so a restart that reads this file never takes the lost span as covered (H14 reads not covered, fail closed);
   * the running process is unaffected (its index has the events).
   */
  keep(e: MarketEvent): void {
    if (!isCreate(e.key) && !isRugFact(e.key) && !isCoverage(e.key)) return;
    const lines: string[] = [];
    if (this.#lost !== null) {
      // The closing gaps: from the first lost slot (the open gaps' own, so they close them) to the last.
      const from = this.#openFrom !== null && this.#openFrom < this.#lost.from ? this.#openFrom : this.#lost.from;
      for (const stream of ['creates', 'rugs']) lines.push(typedText(storeGap(stream, from, this.#lost.to, e.moment)));
    }
    lines.push(typedText(isCreate(e.key) ? compactCreate(e) : e));
    const text = `${lines.join('\n')}\n`;
    try {
      this.#size ??= existsSync(this.#path) ? statSync(this.#path).size : 0;
      appendFileSync(this.#path, text);
      this.#size += Buffer.byteLength(text);
      if (this.#lost !== null) this.#reserve();
      this.#lost = null;
      this.#openFrom = null;
    } catch (err) {
      try {
        if (this.#size !== null && existsSync(this.#path)) truncateSync(this.#path, this.#size);
      } catch {}
      const slot = e.moment.slot;
      const first = this.#lost === null;
      this.#lost = this.#lost === null ? { from: slot, to: slot } : { from: slot < this.#lost.from ? slot : this.#lost.from, to: slot > this.#lost.to ? slot : this.#lost.to };
      // RC-FIXES-2c: the episode's first loss writes open gaps at once, from the reserve's space, so a death before any
      // write works again still leaves the loss on disk (the next start closes them: `load`). A loss in the same slot as
      // the last saved event would otherwise sit before the restart's downtime gap, which starts after that slot.
      if (first && this.#size !== null) {
        const open = `${['creates', 'rugs'].map((stream) => typedText(storeGap(stream, slot, null, e.moment))).join('\n')}\n`;
        try {
          rmSync(`${this.#path}.reserve`, { force: true });
          appendFileSync(this.#path, open);
          this.#size += Buffer.byteLength(open);
          this.#openFrom = slot;
        } catch {
          try {
            if (existsSync(this.#path)) truncateSync(this.#path, this.#size);
          } catch {}
        }
      }
      const now = this.#now();
      if (now - this.#lastLog >= 60_000) {
        this.#lastLog = now;
        this.#log?.(`Deployer store: an append failed (${err instanceof Error ? (err as NodeJS.ErrnoException).code ?? err.name : 'error'}); slots ${this.#lost.from}..${this.#lost.to} will be saved as a coverage gap once a write works again.`);
      }
    }
  }

  /**
   * The saved events received at or after `fromMs`, in release order, with the file rewritten to just those (a torn
   * last line from a kill is dropped). Older coverage facts are cut by `pruneCoverage` (WORKER-1d), not dropped: a
   * start older than the window is what says the stream has run since before it, and an open gap stays open.
   */
  load(fromMs: number, o: { readonly keepCreates?: boolean; readonly maxCreates?: number; readonly onCreate?: (e: MarketEvent) => void } = {}): SavedDeployers {
    if (!existsSync(this.#path)) return { creates: [], rugs: [], coverage: [], last: null };
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
    // RC-FIXES-2c: a store gap left open (a death before any write worked again) is closed here, up to the newest saved
    // slot: the restart's downtime gap starts after that slot, so together they cover every lost slot.
    const closedStore = new Set(coverageFacts.filter((e) => isStoreGap(e) && gapVal(e)?.['toSlot'] !== null).map((e) => `${e.key}|${String(gapVal(e)?.['fromSlot'])}`));
    const openStore: MarketEvent[] = [];
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
    const flush = (): void => {
      if (out.length > 0) writeAll(fd, out.join(''), this.#write);
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
        if (isStoreGap(e) && gapVal(e)?.['toSlot'] === null && !closedStore.has(`${e.key}|${String(gapVal(e)?.['fromSlot'])}`)) {
          openStore.push(e);
          continue;
        }
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
      for (const g of openStore) {
        const from = gapVal(g)?.['fromSlot'] as bigint;
        const closed = storeGap(g.key.split(':')[1]!, from, last !== null && last.slot > from ? last.slot : from, g.moment);
        kept.push(closed);
        out.push(`${typedText(closed)}\n`);
      }
      flush();
      fsyncSync(fd);
    } catch (e) {
      // A short write (a nearly full disk) or a read error: the old file stays whole and the start stops with the error.
      closeSync(fd);
      rmSync(tmp, { force: true });
      throw e;
    }
    closeSync(fd);
    renameSync(tmp, this.#path);
    this.#size = null;
    if (keepCreates && creates > maxCreates) return { creates: [], rugs: [], coverage: [], last: null, refused: `${creates} saved creates, over the seed cap of ${maxCreates}` };
    return { creates: kept.filter((e) => isCreate(e.key)), rugs: kept.filter((e) => isRugFact(e.key)), coverage: kept.filter((e) => isCoverage(e.key)), last };
  }
}

/**
 * The saved live creates watch, for the downtime fill's `close`: its open gap (via and first slot), or, when none was
 * open (a crash leaves none), the watch itself with no first slot. Null when no live watch ever started.
 */
export const liveWatchToClose = (coverage: readonly MarketEvent[], stream: 'creates' | 'rugs' = 'creates'): { readonly via: string; readonly fromSlot: bigint | null } | null => {
  const val = (e: MarketEvent): Record<string, unknown> | null => (isObj(e.value) && isObj(e.value['value']) ? e.value['value'] : isObj(e.value) ? e.value : null);
  let via: string | null = null;
  const open = new Map<string, bigint | null>();
  for (const e of coverage) {
    if (!e.key.startsWith(`coverage:${stream}:`)) continue;
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
