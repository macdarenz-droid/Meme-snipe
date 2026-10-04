// The deployer index's saved state (supervisor ruling 2026-10-04, SEED-1): every released event the index learns from
// (creates, rug labels, unjudged mints) and every creates and rugs coverage fact, appended as it is released, so a
// restart re-seeds the index and puts the coverage history back into the engine instead of blanking H14 for a whole
// look-back. Public chain data only. Kept for the look-back plus a day; older lines are dropped at each start.
import { appendFileSync, closeSync, existsSync, openSync, rmSync } from 'node:fs';
import { fileLines } from '../../../runner/src/lines.ts';
import { join } from 'node:path';
import type { MarketEvent } from '../../../core/src/engine/index.ts';
import { LOG_CREATE_PREFIX, RUG_PREFIX, RUG_UNJUDGED_PREFIX, TX_CREATE_PREFIX } from '../../../core/src/gates/index.ts';
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
}

export class DeployerStore {
  readonly #path: string;

  readonly #write: WriteFn | undefined;

  /** `write` is for tests (a short write); the default checks every write's count. */
  constructor(stateDir: string, write?: WriteFn) {
    this.#path = join(stateDir, 'deployers.jsonl');
    this.#write = write;
  }

  /** Keeps a released event when the index or H14's coverage reads it. */
  keep(e: MarketEvent): void {
    if (!isCreate(e.key) && !isRugFact(e.key) && !isCoverage(e.key)) return;
    appendFileSync(this.#path, `${typedText(isCreate(e.key) ? compactCreate(e) : e)}\n`);
  }

  /**
   * The saved events received at or after `fromMs`, in release order, with the file rewritten to just those (a torn
   * last line from a kill is dropped). Coverage facts are all kept: a start older than the window is what says the
   * stream has run since before it.
   */
  load(fromMs: number): SavedDeployers {
    if (!existsSync(this.#path)) return { creates: [], rugs: [], coverage: [], last: null };
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
        kept.push(e);
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
    let last: { slot: bigint; ms: number } | null = null;
    for (const e of kept) if (last === null || e.moment.slot > last.slot) last = { slot: e.moment.slot, ms: e.moment.receivedAt };
    return { creates: kept.filter((e) => isCreate(e.key)), rugs: kept.filter((e) => isRugFact(e.key)), coverage: kept.filter((e) => isCoverage(e.key)), last };
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
