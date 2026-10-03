// GATE-1b: our own deployer index (H14) and the creates-stream coverage it depends on (docs/ARCHITECTURE.md §7.1 H14,
// FEED-1 `WatchOptions.coverage`). The index is built only from events the engine has released, so it is as of now
// by construction; every answer is filtered to now again. Coverage is read from the as-of history of FEED-1's
// `coverage:creates:*` facts: any range the stream may have missed is uncovered, and a deployer whose look-back
// touches an uncovered range is not judged (H16), so a gap can never make us count fewer mints.
import type { AsOfEntry } from '../engine/asof.ts';
import type { MarketEvent } from '../engine/feed.ts';
import type { Moment } from '../engine/moment.ts';
import { SECOND_MS } from '../config/time.ts';
import type { DeployerFact } from './facts.ts';

/** FEED-1 keys: creates read from logs (processed) and from fetched transactions (confirmed). */
export const LOG_CREATE_PREFIX = 'logs:pump:CreateEvent:';
export const TX_CREATE_PREFIX = 'pump:CreateEvent:';
/** A rug label for a mint: `{ mint, creator }`, recorded at the moment it became known. */
export const RUG_PREFIX = 'rug:';
export const coverageKeys = (stream: string) =>
  ({ start: `coverage:${stream}:start`, gap: `coverage:${stream}:gap`, resume: `coverage:${stream}:resume` }) as const;

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
/** FEED-1 wraps an event's payload with its frame metadata: `{ value, source, backfilled, seq }` for off-chain facts. */
const payload = (v: unknown): Obj | null => (isObj(v) && isObj(v['value']) ? v['value'] : isObj(v) ? v : null);

/** A create event as FEED-1 emits it (`value.event` is DEC-1's decoded event). */
export const createOf = (v: unknown): { readonly mint: string; readonly creator: string; readonly createdAtMs: number } | null => {
  if (!isObj(v) || !isObj(v['event'])) return null;
  const e = v['event'];
  if (e['name'] !== 'CreateEvent' || !isObj(e['data'])) return null;
  const d = e['data'];
  const ts = d['timestamp'];
  if (typeof d['mint'] !== 'string' || typeof d['creator'] !== 'string' || typeof ts !== 'bigint' || ts < 0n) return null;
  const createdAtMs = Number(ts) * SECOND_MS;
  return Number.isSafeInteger(createdAtMs) ? { mint: d['mint'], creator: d['creator'], createdAtMs } : null;
};

/** The deployer index: mints and rug labels per creator, from released events only. */
export class DeployerIndex {
  readonly #mints = new Map<string, Map<string, number>>();
  readonly #rugs = new Map<string, Map<string, number>>();
  /** Watches that carry the creates stream (the `via` of every `coverage:creates:start`). */
  readonly #createVias = new Set<string>();
  /** Log reads that may have lost a create, by signature: when seen and on which watch. Cleared by the fetched transaction. */
  readonly #lost = new Map<string, { readonly atMs: number; readonly via: string }>();
  #first: Moment | null = null;
  #last: Moment | null = null;

  /** Feed every released market event here, in release order. Unrelated events are ignored. */
  observe(e: MarketEvent): void {
    this.#first ??= e.moment;
    this.#last = e.moment;
    this.#trackLoss(e);
    if (e.key.startsWith(LOG_CREATE_PREFIX) || e.key.startsWith(TX_CREATE_PREFIX)) {
      const c = createOf(e.value);
      if (c === null) return;
      const m = this.#mints.get(c.creator) ?? new Map<string, number>();
      // The same create from logs and from a fetched transaction counts once, at its earliest time.
      const prev = m.get(c.mint);
      m.set(c.mint, prev === undefined || c.createdAtMs < prev ? c.createdAtMs : prev);
      this.#mints.set(c.creator, m);
      return;
    }
    if (e.key.startsWith(RUG_PREFIX)) {
      const r = payload(e.value);
      if (r === null || typeof r['creator'] !== 'string' || typeof r['mint'] !== 'string') return;
      const m = this.#rugs.get(r['creator']) ?? new Map<string, number>();
      if (!m.has(r['mint'])) m.set(r['mint'], e.moment.receivedAt);
      this.#rugs.set(r['creator'], m);
    }
  }

  /**
   * FEED-1 marks a cut log (`truncated`) and emits `logs:truncated:<via>` or `logs:undecodable:<via>`: a create in it
   * may be lost. Each stays a hole in the creates stream until the fetched transaction (`ev:<signature>:…`) is released.
   */
  #trackLoss(e: MarketEvent): void {
    const v = payload(e.value);
    if (e.key === 'coverage:creates:start' && v !== null && typeof v['via'] === 'string') this.#createVias.add(v['via']);
    if (e.id.startsWith('ev:')) {
      const sig = e.id.slice(3).split(':')[0];
      if (sig !== undefined) this.#lost.delete(sig);
      return;
    }
    const o = isObj(e.value) ? e.value : null;
    if (o === null || typeof o['signature'] !== 'string') return;
    const cut = e.key.startsWith('logs:truncated:') || e.key.startsWith('logs:undecodable:') || (e.key.startsWith('logs:') && o['truncated'] === true);
    if (!cut) return;
    const via = typeof o['via'] === 'string' ? o['via'] : e.key.startsWith('logs:truncated:') ? e.key.slice('logs:truncated:'.length) : e.key.slice('logs:undecodable:'.length);
    if (!this.#lost.has(o['signature'])) this.#lost.set(o['signature'], { atMs: e.moment.receivedAt, via });
  }

  /** The first cut or undecodable creates log since `fromMs` whose transaction has not been fetched, or null. */
  lostCreate(fromMs: number, now: Moment): { readonly signature: string; readonly atMs: number; readonly via: string } | null {
    let found: { signature: string; atMs: number; via: string } | null = null;
    for (const [signature, l] of this.#lost) {
      if (!this.#createVias.has(l.via) || l.atMs < fromMs || l.atMs > now.receivedAt) continue;
      if (found === null || l.atMs < found.atMs || (l.atMs === found.atMs && signature < found.signature)) found = { signature, ...l };
    }
    return found;
  }

  /**
   * The deployer fact as of `now`: entries dated after now are left out. `coverageFromMs` is the later of the stream's
   * coverage and this index's own first event: an index started mid-run (a restart) has not seen what came before.
   */
  factFor(creator: string, now: Moment, coverageFromMs: number): DeployerFact {
    const own = this.#first === null || this.#first.receivedAt > now.receivedAt ? Number.MAX_SAFE_INTEGER : this.#first.receivedAt;
    coverageFromMs = Math.max(coverageFromMs, own);
    const sorted = (m: Map<string, number> | undefined) => [...(m ?? new Map<string, number>())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return {
      obs: { provider: 'deployer-index', slot: now.slot, receivedAt: now.receivedAt, quality: [], commitment: 'confirmed' },
      coverageFromMs,
      mints: sorted(this.#mints.get(creator)).filter(([, t]) => t <= now.receivedAt).map(([mint, createdAtMs]) => ({ mint, createdAtMs })),
      rugs: sorted(this.#rugs.get(creator)).filter(([, t]) => t <= now.receivedAt).map(([mint, knownAtMs]) => ({ mint, knownAtMs })),
    };
  }

  /** The moment of the last event observed (for checks that the index was fed). */
  get last(): Moment | null {
    return this.#last;
  }
}

export type History = (key: string, from: Moment, to?: Moment) => readonly AsOfEntry[] | { readonly ok: false; readonly reason: 'future' };

const ORIGIN: Moment = { slot: 0n, txIndex: 0, ixIndex: 0, receivedAt: Number.MIN_SAFE_INTEGER };

export type Coverage =
  | { readonly covered: true; readonly fromMs: number }
  | { readonly covered: false; readonly detail: string };

/**
 * Whether the `stream` was complete from `windowStartMs` to now, from the as-of history of its coverage facts:
 * - coverage begins at a `start`; with none reported by `windowStartMs`, the window is not covered;
 * - an open gap (`toSlot` null) stays uncovered until a bounded gap or a `resume` with the same `via` and `fromSlot`,
 *   or a later `start` on the same `via` (coverage resumes there, the range before it stays a gap);
 * - a bounded gap is a lossy range: uncovered when it was reported at or after the window start (it cannot have
 *   ended later than its report);
 * - a `resume` restores the range in full;
 * - a fact that cannot be read is treated as an open gap.
 * Gaps from every watch count, even when another watch was up: the union is uncovered (the safe side).
 */
export const createsCoverage = (history: History, now: Moment, windowStartMs: number, stream = 'creates'): Coverage => {
  const keys = coverageKeys(stream);
  const read = (key: string): readonly AsOfEntry[] | null => {
    const h = history(key, ORIGIN, now);
    return Array.isArray(h) ? (h as readonly AsOfEntry[]) : null;
  };
  const parts = [['start', read(keys.start)], ['gap', read(keys.gap)], ['resume', read(keys.resume)]] as const;
  for (const [kind, h] of parts) if (h === null) return { covered: false, detail: `coverage ${kind} history refused` };
  const entries = parts.flatMap(([kind, h]) => (h ?? []).map((e) => ({ kind, e })))
    .sort((a, b) => (a.e.moment.slot < b.e.moment.slot ? -1 : a.e.moment.slot > b.e.moment.slot ? 1 : 0)
      || a.e.moment.txIndex - b.e.moment.txIndex || a.e.moment.ixIndex - b.e.moment.ixIndex || a.e.moment.receivedAt - b.e.moment.receivedAt
      || (a.e.source < b.e.source ? -1 : a.e.source > b.e.source ? 1 : 0));
  const open = new Map<string, number>(); // `${via}|${fromSlot}` -> reported at
  let firstStart: number | null = null;
  let lastLossy: { at: number; detail: string } | null = null;
  const lossy = (at: number, detail: string) => {
    if (lastLossy === null || at >= lastLossy.at) lastLossy = { at, detail };
  };
  for (const { kind, e } of entries) {
    const at = e.moment.receivedAt;
    const v = payload(e.value);
    const via = v !== null && typeof v['via'] === 'string' ? v['via'] : null;
    const from = v === null ? undefined : v['fromSlot'];
    const fromOk = from === null || typeof from === 'bigint';
    if (v === null || via === null || !fromOk) {
      open.set(`unreadable|${e.source}`, at);
      continue;
    }
    const id = `${via}|${String(from)}`;
    if (kind === 'start') {
      if (firstStart === null) firstStart = at;
      // A new start on a watch settles its open gaps: the range before the start was missed.
      for (const k of [...open.keys()]) {
        if (k.startsWith(`${via}|`)) {
          open.delete(k);
          lossy(at, `${k} was open until ${via} started again`);
        }
      }
    } else if (kind === 'gap') {
      const to = v['toSlot'];
      if (to === null) open.set(id, at);
      else if (typeof to === 'bigint') {
        open.delete(id);
        lossy(at, `gap ${String(from)}..${to} on ${via}`);
      } else open.set(`unreadable|${e.source}`, at);
    } else {
      open.delete(id); // restored in full
    }
  }
  if (open.size > 0) {
    const [k] = [...open.keys()].sort();
    return { covered: false, detail: `open gap on the ${stream} stream (${k})` };
  }
  if (firstStart === null || firstStart > windowStartMs) {
    return { covered: false, detail: firstStart === null ? `no ${stream} coverage start` : `${stream} coverage starts at ${firstStart}, after ${windowStartMs}` };
  }
  const l = lastLossy as { at: number; detail: string } | null;
  if (l !== null && l.at >= windowStartMs) return { covered: false, detail: `${l.detail}, reported at ${l.at}, inside the window from ${windowStartMs}` };
  return { covered: true, fromMs: l === null ? firstStart : l.at };
};
