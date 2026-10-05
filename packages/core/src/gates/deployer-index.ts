// GATE-1b: our own deployer index (H14) and the creates-stream coverage it depends on (docs/ARCHITECTURE.md §7.1 H14,
// FEED-1 `WatchOptions.coverage`). The index is built only from events the engine has released, so it is as of now
// by construction; every answer is filtered to now again. Coverage is read from the as-of history of FEED-1's
// `coverage:creates:*` facts: any range the stream may have missed is uncovered, and a deployer whose look-back
// touches an uncovered range is not judged (H16), so a gap can never make us count fewer mints.
import type { AsOfEntry } from '../engine/asof.ts';
import type { MarketEvent } from '../engine/feed.ts';
import { compareEvents, compareMoments, type Moment } from '../engine/moment.ts';
import { SECOND_MS } from '../config/time.ts';
import type { DeployerFact } from './facts.ts';

/** FEED-1 keys: creates read from logs (processed) and from fetched transactions (confirmed). */
export const LOG_CREATE_PREFIX = 'logs:pump:CreateEvent:';
export const TX_CREATE_PREFIX = 'pump:CreateEvent:';
/** A rug label for a mint: `{ mint, creator }`, recorded at the moment it became known. */
export const RUG_PREFIX = 'rug:';
/** A mint the labeller could not judge: `{ mint, creator, reason }`, at its create's moment. H14 is not covered while one is in the look-back. */
export const RUG_UNJUDGED_PREFIX = 'rug-unjudged:';
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

/** A label as the index holds it: when it became known, and the rule that made it (null when the label named none). */
export interface Known {
  readonly at: Moment;
  readonly kind: string | null;
}

/** The deployer index: mints and rug labels per creator, from released events only. */
export class DeployerIndex {
  readonly #mints = new Map<string, Map<string, number>>();
  /** Rug labels and unjudged mints per creator, each at the moment it became known (compared in full with now). */
  readonly #rugs = new Map<string, Map<string, Known>>();
  readonly #unjudged = new Map<string, Map<string, Known>>();
  /** Watches that carry the creates stream (the `via` of every `coverage:creates:start`). */
  readonly #createVias = new Set<string>();
  /** Log reads that may have lost a create, by signature: when seen and on which watch. Cleared by the fetched transaction. */
  readonly #lost = new Map<string, { readonly atMs: number; readonly via: string }>();
  #first: Moment | null = null;
  #last: Moment | null = null;
  #seeded = false;

  /** Feed every released market event here, in release order. Unrelated events are ignored. */
  observe(e: MarketEvent): void {
    this.#first ??= e.moment;
    this.#last = e.moment;
    this.#trackLoss(e);
    if (e.key.startsWith(LOG_CREATE_PREFIX) || e.key.startsWith(TX_CREATE_PREFIX)) {
      const c = createOf(e.value);
      if (c !== null) this.#addMint(this.#mints, c);
      return;
    }
    const into = e.key.startsWith(RUG_PREFIX) ? this.#rugs : e.key.startsWith(RUG_UNJUDGED_PREFIX) ? this.#unjudged : null;
    if (into !== null) {
      const r = payload(e.value);
      if (r === null || typeof r['creator'] !== 'string' || typeof r['mint'] !== 'string') return;
      const m = into.get(r['creator']) ?? new Map<string, Known>();
      // The rule that made a label is its kind (what was observed); a label without one is kept without a kind.
      if (!m.has(r['mint'])) m.set(r['mint'], { at: e.moment, kind: typeof r['rule'] === 'string' ? r['rule'] : null });
      into.set(r['creator'], m);
    }
  }

  /** The same create from logs and from a fetched transaction counts once, at its earliest time. */
  #addMint(into: Map<string, Map<string, number>>, c: { readonly mint: string; readonly creator: string; readonly createdAtMs: number }): void {
    const m = into.get(c.creator) ?? new Map<string, number>();
    const prev = m.get(c.mint);
    m.set(c.mint, prev === undefined || c.createdAtMs < prev ? c.createdAtMs : prev);
    into.set(c.creator, m);
  }

  /**
   * SEED-1: fills the index from history before its first live event (docs/DECISIONS.md, SEED-1), so a fresh or
   * restarted worker does not reject H14 for a whole look-back. `creates` are create events in FEED-1's shape, in
   * release order; `coverage` are the `coverage:creates:*` facts of the seeded range, which the worker must also
   * release into the engine, because H14 reads coverage from the engine's history and never from here.
   * As of `asOf` (the process start): an event or fact dated after it, or a create whose chain time is after it, is
   * refused and nothing is seeded. The index's own start becomes the seeded range's first `coverage:creates:start`;
   * without one the start is unchanged (the first live event), so a seed with no coverage never widens what the
   * index claims to have watched. Gaps inside the range stay gaps: they are coverage facts, judged by H14.
   */
  seed(creates: readonly MarketEvent[], coverage: readonly MarketEvent[], asOf: Moment): { readonly creates: number; readonly fromMs: number | null } {
    if (this.#first !== null || this.#seeded) throw new Error('the deployer index can only be seeded once, before it observes an event');
    let start: Moment | null = null;
    for (const f of coverage) {
      if (compareMoments(f.moment, asOf) > 0) throw new RangeError(`seed coverage ${f.id} is dated after the process start`);
      if (!f.key.startsWith('coverage:creates:')) throw new RangeError(`seed coverage ${f.id} is not a creates coverage fact (${f.key})`);
      if (f.key === 'coverage:creates:start' && (start === null || compareMoments(f.moment, start) < 0)) start = f.moment;
    }
    const { mints, last } = this.#checked(creates, asOf, 'seed');
    // Checked in full before anything changes: a refused seed leaves the index as it was.
    this.#seeded = true;
    this.#merge(mints);
    if (start !== null) {
      this.#first = start;
      this.#last = last !== null && compareMoments(last, start) > 0 ? last : start;
    }
    return { creates: creates.length, fromMs: start === null ? null : start.receivedAt };
  }

  /**
   * SEED-1 downtime fill: after a restart from saved state, the creates backfilled for the downtime, which are older
   * than the live events already observed. Same as-of checks as `seed`, all or nothing; the index's own start is not
   * touched (the saved state carries it). Whether the downtime is covered is decided by the fill's coverage facts in
   * the engine's history, never here.
   */
  fill(creates: readonly MarketEvent[], asOf: Moment): { readonly creates: number } {
    const { mints } = this.#checked(creates, asOf, 'fill');
    this.#merge(mints);
    return { creates: creates.length };
  }

  #checked(creates: readonly MarketEvent[], asOf: Moment, what: string): { readonly mints: Map<string, Map<string, number>>; readonly last: Moment | null } {
    const mints = new Map<string, Map<string, number>>();
    let prev: MarketEvent | null = null;
    for (const e of creates) {
      if (compareMoments(e.moment, asOf) > 0) throw new RangeError(`${what} create ${e.id} is dated after the process start`);
      if (prev !== null && compareEvents(prev, e) >= 0) throw new RangeError(`${what} create ${e.id} is not after ${prev.id}`);
      prev = e;
      const c = e.key.startsWith(LOG_CREATE_PREFIX) || e.key.startsWith(TX_CREATE_PREFIX) ? createOf(e.value) : null;
      if (c === null) throw new RangeError(`${what} event ${e.id} is not a create event`);
      if (c.createdAtMs > asOf.receivedAt) throw new RangeError(`${what} create ${e.id} has a chain time after the process start`);
      this.#addMint(mints, c);
    }
    return { mints, last: prev?.moment ?? null };
  }

  #merge(mints: Map<string, Map<string, number>>): void {
    for (const [creator, m] of mints) for (const [mint, createdAtMs] of m) this.#addMint(this.#mints, { mint, creator, createdAtMs });
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
    const sorted = <V>(m: Map<string, V> | undefined) => [...(m ?? new Map<string, V>())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const known = (m: Map<string, Known> | undefined) =>
      sorted(m).filter(([, k]) => compareMoments(k.at, now) <= 0).map(([mint, k]) => ({ mint, knownAtMs: k.at.receivedAt, ...(k.kind === null ? {} : { kind: k.kind }) }));
    return {
      obs: { provider: 'deployer-index', slot: now.slot, receivedAt: now.receivedAt, quality: [], commitment: 'confirmed' },
      coverageFromMs,
      mints: sorted(this.#mints.get(creator)).filter(([, t]) => t <= now.receivedAt).map(([mint, createdAtMs]) => ({ mint, createdAtMs })),
      rugs: known(this.#rugs.get(creator)),
      unjudged: known(this.#unjudged.get(creator)),
    };
  }

  /** The moment of the last event observed (for checks that the index was fed). */
  get last(): Moment | null {
    return this.#last;
  }

  /**
   * PERSIST-1: the index as of `asOf` (at or after the last event observed), for a restart without a re-fetch.
   * Entries older than `retainFromMs` are left out, and the index's own start moves up to it, so the restored index
   * never claims to have watched what it no longer holds.
   */
  snapshot(asOf: Moment, retainFromMs = Number.MIN_SAFE_INTEGER, o: { readonly mints?: boolean } = {}): DeployerIndexState {
    if (this.#last !== null && compareMoments(this.#last, asOf) > 0) throw new RangeError('the index has observed events after the snapshot moment');
    const keep = <V>(m: Map<string, Map<string, V>>, ms: (v: V) => number) =>
      [...m].map(([creator, inner]) => [creator, [...inner].filter(([, v]) => ms(v) >= retainFromMs)] as const)
        .filter(([, inner]) => inner.length > 0)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const first = this.#first === null ? null : this.#first.receivedAt >= retainFromMs ? this.#first : { ...this.#first, receivedAt: retainFromMs };
    return {
      asOf, first, last: this.#last, seeded: this.#seeded,
      // Without `mints` (WORKER-GROW), the rows are left to `mintRows`, for a save that streams them.
      mints: o.mints === false ? [] : keep(this.#mints, (t) => t), rugs: keep(this.#rugs, (k) => k.at.receivedAt), unjudged: keep(this.#unjudged, (k) => k.at.receivedAt),
      createVias: [...this.#createVias].sort(),
      lost: [...this.#lost].filter(([, l]) => l.atMs >= retainFromMs).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    };
  }

  /**
   * WORKER-GROW: the snapshot's mint rows one creator at a time (`snapshot(asOf, retainFromMs).mints` without building
   * them all), in the same order, for a save that streams them.
   */
  *mintRows(retainFromMs = Number.MIN_SAFE_INTEGER): Generator<readonly [string, readonly (readonly [string, number])[]]> {
    for (const creator of [...this.#mints.keys()].sort()) {
      const inner = [...this.#mints.get(creator)!].filter(([, t]) => t >= retainFromMs);
      if (inner.length > 0) yield [creator, inner] as const;
    }
  }

  /**
   * PERSIST-1: an index restored from `snapshot`. A malformed state throws; the caller then discards the file.
   * `mintRows` (WORKER-GROW), when given, holds the mint rows in place of `s.mints`, read one at a time from a streamed file.
   */
  static restore(s: DeployerIndexState, mintRows?: Iterable<unknown>): DeployerIndex {
    const idx = new DeployerIndex();
    const moment = (m: unknown): Moment | null => {
      if (m === null) return null;
      if (typeof m !== 'object' || m === null) throw new RangeError('bad moment');
      const o = m as Record<string, unknown>;
      if (typeof o['slot'] !== 'bigint' || !Number.isSafeInteger(o['txIndex']) || !Number.isSafeInteger(o['ixIndex']) || !Number.isSafeInteger(o['receivedAt'])) throw new RangeError('bad moment');
      return { slot: o['slot'], txIndex: o['txIndex'] as number, ixIndex: o['ixIndex'] as number, receivedAt: o['receivedAt'] as number };
    };
    const asOf = moment(s.asOf);
    if (asOf === null) throw new RangeError('a snapshot needs its as-of moment');
    const pairs = <V>(rows: unknown, into: Map<string, Map<string, V>>, value: (v: unknown) => V, ms: (v: V) => number) => {
      if (!Array.isArray(rows) && !(typeof rows === 'object' && rows !== null && Symbol.iterator in rows)) throw new RangeError('bad table');
      for (const row of rows as Iterable<unknown>) {
        if (!Array.isArray(row) || typeof row[0] !== 'string' || !Array.isArray(row[1])) throw new RangeError('bad row');
        const m = new Map<string, V>();
        for (const e of row[1] as unknown[]) {
          if (!Array.isArray(e) || typeof e[0] !== 'string') throw new RangeError('bad entry');
          const v = value(e[1]);
          if (ms(v) > asOf.receivedAt) throw new RangeError('an entry is dated after the snapshot moment');
          m.set(e[0], v);
        }
        into.set(row[0], m);
      }
    };
    const ms = (v: unknown): number => {
      if (!Number.isSafeInteger(v)) throw new RangeError('bad time');
      return v as number;
    };
    if (mintRows !== undefined && Array.isArray(s.mints) && s.mints.length > 0) throw new RangeError('mint rows given twice');
    pairs(mintRows ?? s.mints, idx.#mints, ms, (t) => t);
    // A label keeps its kind exactly: a string, or null for a label that named no rule (RUG-1c).
    const known = (v: unknown): Known => {
      if (typeof v !== 'object' || v === null) throw new RangeError('bad label');
      const o = v as Record<string, unknown>;
      const at = moment(o['at']);
      if (at === null || (o['kind'] !== null && typeof o['kind'] !== 'string')) throw new RangeError('bad label');
      return { at, kind: o['kind'] as string | null };
    };
    pairs(s.rugs, idx.#rugs, known, (k) => k.at.receivedAt);
    pairs(s.unjudged, idx.#unjudged, known, (k) => k.at.receivedAt);
    if (!Array.isArray(s.createVias) || !s.createVias.every((v) => typeof v === 'string')) throw new RangeError('bad vias');
    for (const v of s.createVias) idx.#createVias.add(v);
    if (!Array.isArray(s.lost)) throw new RangeError('bad lost table');
    for (const row of s.lost as unknown[]) {
      if (!Array.isArray(row) || typeof row[0] !== 'string' || typeof row[1] !== 'object' || row[1] === null) throw new RangeError('bad lost row');
      const l = row[1] as Record<string, unknown>;
      if (typeof l['via'] !== 'string') throw new RangeError('bad lost row');
      idx.#lost.set(row[0], { atMs: ms(l['atMs']), via: l['via'] });
    }
    idx.#first = moment(s.first);
    idx.#last = moment(s.last);
    // After the as-of moment by event order or by receipt time: either way not something the snapshot could know.
    for (const m of [idx.#first, idx.#last]) {
      if (m !== null && (compareMoments(m, asOf) > 0 || m.receivedAt > asOf.receivedAt)) throw new RangeError('the snapshot claims a moment after its as-of moment');
    }
    if (typeof s.seeded !== 'boolean') throw new RangeError('bad seeded flag');
    idx.#seeded = s.seeded;
    return idx;
  }
}

/** A deployer index saved by `snapshot` (PERSIST-1). Only public chain data and our own labels. */
export interface DeployerIndexState {
  readonly asOf: Moment;
  readonly first: Moment | null;
  readonly last: Moment | null;
  readonly seeded: boolean;
  readonly mints: readonly (readonly [string, readonly (readonly [string, number])[]])[];
  readonly rugs: readonly (readonly [string, readonly (readonly [string, Known])[]])[];
  readonly unjudged: readonly (readonly [string, readonly (readonly [string, Known])[]])[];
  readonly createVias: readonly string[];
  readonly lost: readonly (readonly [string, { readonly atMs: number; readonly via: string }])[];
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

/**
 * WORKER-1d: coverage facts (in release order) cut to what still matters for every window that starts at or after
 * `retainFromMs`, so a saved coverage history stops growing with time and restarts. Facts received at or after that
 * point are all kept. Of the older ones, per stream and `via`: the latest `start` (what says the stream ran from before
 * the window), and, when that watch still has an open gap at the retain point, every fact on it since that start (so
 * the gap and the watch's state read exactly as before). Unreadable facts are kept (they hold coverage open). For any
 * window start at or after `retainFromMs`, `createsCoverage` gives the same verdict on the result; only a `fromMs`
 * earlier than the retain point can move (still at or before it), and the index never claims coverage from before its
 * own retained start.
 */
export const pruneCoverage = <E extends Pick<MarketEvent, 'key' | 'moment' | 'value'>>(facts: readonly E[], retainFromMs: number): E[] => {
  const keep = new Set<number>();
  /** `${stream}|${via}` → the index of the latest start, and the indexes of every fact since it. */
  const watches = new Map<string, { start: number | null; since: number[]; open: Set<string> }>();
  facts.forEach((e, i) => {
    if (e.moment.receivedAt >= retainFromMs) {
      keep.add(i);
      return;
    }
    const m = /^coverage:(.+):(start|gap|resume)$/.exec(e.key);
    const v = payload(e.value);
    const via = v !== null && typeof v['via'] === 'string' ? v['via'] : null;
    const from = v === null ? undefined : v['fromSlot'];
    const to = v === null ? undefined : v['toSlot'];
    if (m === null || v === null || via === null || !(from === null || typeof from === 'bigint') || (m[2] === 'gap' && !(to === null || typeof to === 'bigint'))) {
      keep.add(i);
      return;
    }
    const key = `${m[1]}|${via}`;
    const w = watches.get(key) ?? { start: null, since: [], open: new Set<string>() };
    watches.set(key, w);
    const id = String(from);
    if (m[2] === 'start') {
      w.start = i;
      w.since = [];
      w.open.clear();
      return;
    }
    w.since.push(i);
    if (m[2] === 'gap' && to === null) w.open.add(id);
    else w.open.delete(id);
  });
  for (const w of watches.values()) {
    if (w.start !== null) keep.add(w.start);
    if (w.open.size > 0) for (const i of w.since) keep.add(i);
  }
  return facts.filter((_, i) => keep.has(i));
};
