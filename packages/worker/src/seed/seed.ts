// SEED-1: the deployer index's start-up seed (docs/DECISIONS.md, SEED-1). Sources oldest first: DATA-1's published
// day releases, then an RPC backfill from their last slot to the live creates watch's first slot. The result is
// handed to `DeployerIndex.seed(creates, coverage, asOf)`, and `coverage` is also released into the engine ahead of
// the live events, because H14 reads creates coverage from the engine's history.
//
// Start-up order (WORKER-1): start the live creates watch and buffer its events; once its `coverage:creates:start`
// gives its first slot, call `buildSeed` with `untilSlot` = that slot and `asOf` = now (at or after it); seed the
// index; release `coverage`; then let the engine decide. Seed and live then meet at `untilSlot`, and a slot the seed
// could not reach is a bounded gap, never a silent hole.
//
// Every range the seed cannot vouch for is a bounded `coverage:creates:gap` dated at (or after) its end, so H14 stays
// not-covered while it is inside the look-back. Nothing dated after `asOf` is kept. Rug labels are not seeded (see
// `RUGS_NOT_SEEDED`): no `coverage:rugs:*` fact is produced, so the rug half stays not-covered after a start.
import type { MarketEvent, Moment } from '../../../core/src/engine/index.ts';
import { OFF_CHAIN, compareEvents } from '../../../core/src/engine/index.ts';
import { DAY_MS, SECOND_MS } from '../../../core/src/config/time.ts';
import { TX_CREATE_PREFIX } from '../../../core/src/gates/index.ts';
import { eventIxIndex } from '../providers/canonical.ts';
import { callCost } from '../providers/solana-http.ts';
import { type DayCreate, type DayRead, readDayRelease, type SlotRange } from './days.ts';
import { backfillCreates, type BackfillOptions, type BackfillResult, type SlotGap, SIGNATURE_PAGE } from './rpc.ts';

export const SEED_VIA = 'seed';

/**
 * Measured on mainnet 2026-10-04 (getSignaturesForAddress on the create authority, public RPC): 1,000 signatures in
 * 1,254 s, 72 failed. About 69,000 a day, 7.2% failed, so about 64,000 creates a day.
 */
export const CREATE_AUTHORITY_SIGNATURES_PER_DAY = 69_000;
export const CREATE_AUTHORITY_FAILED_SHARE = 0.072;

export const RUGS_NOT_SEEDED =
  'rug labels are not seeded: day releases keep trades only for the 5% hash sample and an RPC trade backfill for every mint is far beyond the free plan, so no coverage:rugs fact is produced for the seeded range';

/** Credits an RPC backfill of `spanMs` is expected to cost: one page per 1,000 signatures, one fetch per successful create. */
export const estimateBackfillCredits = (spanMs: number, provider: BackfillOptions['provider']): number => {
  const days = Math.max(0, spanMs) / DAY_MS;
  const sigs = days * CREATE_AUTHORITY_SIGNATURES_PER_DAY;
  return Math.ceil(Math.ceil(sigs / SIGNATURE_PAGE) * callCost(provider, 'getSignaturesForAddress') + sigs * (1 - CREATE_AUTHORITY_FAILED_SHARE) * callCost(provider, 'getTransaction'));
};

export interface SeedOptions {
  /** Downloaded day releases (`data-day-DAY` assets in `dir`), any order; each is verified before it is read. */
  readonly days: readonly { readonly dir: string; readonly day: string }[];
  /** The RPC backfill. Without it, slots after the last day up to `untilSlot` are a gap. */
  readonly rpc?: Omit<BackfillOptions, 'afterSlot' | 'untilSlot'>;
  /** With no day release: the first slot to backfill (the look-back start) and its block time (ms). */
  readonly rpcFrom?: { readonly slot: bigint; readonly ms: number };
  /**
   * Downtime fill after a restart whose index, labeller and coverage were saved (supervisor ruling 2026-10-04): RPC
   * only, for slots `fromSlot` (the first slot after the saved state) to `untilSlot`. No start fact is made, because
   * the saved coverage continues; every slot not fetched is a bounded gap. `close` names the saved watch's open gap
   * (its `via` and `fromSlot`), or the watch itself when none was open: a complete fill closes it with a `resume` up to
   * `untilSlot`, otherwise a bounded gap with the same `via` and `fromSlot` closes it as lossy. Fill creates go to
   * the restored index through `DeployerIndex.fill`, and the coverage facts into the engine before the watch's new start.
   */
  readonly fill?: {
    readonly fromSlot: bigint;
    readonly fromMs: number;
    readonly close?: { readonly via: string; readonly fromSlot: bigint | null };
    /** The restarted watch's `coverage:creates:start` moment, as the feed placed it: the close is dated just before it. */
    readonly liveStart?: Moment;
  };
  /** The live creates watch's first slot: the seed covers up to and including it. */
  readonly untilSlot: bigint;
  /** The process start: nothing dated after it is seeded. */
  readonly asOf: Moment;
}

export interface SeedGap {
  readonly fromSlot: bigint;
  readonly toSlot: bigint;
  readonly atMs: number;
  readonly reason: string;
}

export interface SeedReport {
  readonly mode: 'seed' | 'fill';
  readonly asOf: Moment;
  readonly untilSlot: bigint;
  /** The seeded range's start, or null when nothing could be seeded (H14 then waits for a full live look-back). */
  readonly start: { readonly slot: bigint; readonly ms: number } | null;
  /** Every requested day: what it gave, or why it was dropped (its range is then a gap, or RPC's if it was the last). */
  readonly days: readonly ({ readonly day: string; readonly creates: number; readonly units: number; readonly gapUnits: number; readonly verified: number } | { readonly day: string; readonly error: string })[];
  readonly rpc: {
    readonly fromSlot: bigint;
    readonly estimatedCredits: number | null;
    readonly creditCap: number;
    readonly fitsCap: boolean | null;
    readonly result: Omit<BackfillResult, 'creates' | 'gaps'> & { readonly creates: number };
  } | null;
  readonly creates: number;
  readonly gaps: readonly SeedGap[];
  readonly droppedFuture: number;
  readonly rugs: string;
}

export interface Seed {
  /** Create events in FEED-1's shape, in release order, none after `asOf`. */
  readonly creates: readonly MarketEvent[];
  /** `coverage:creates:start|gap` facts on via `seed`, in release order, none after `asOf`. */
  readonly coverage: readonly MarketEvent[];
  readonly report: SeedReport;
}

const dayCreateEvent = (c: DayCreate, seq: number): MarketEvent => {
  const pad = (n: number) => String(n).padStart(5, '0');
  return {
    kind: 'market', id: `ev:${c.signature}:${pad(c.outerIx)}:${pad(c.innerIx)}`,
    moment: { slot: c.slot, txIndex: c.txIdx, ixIndex: eventIxIndex(c.outerIx, c.innerIx), receivedAt: c.blockTimeMs },
    key: `${TX_CREATE_PREFIX}${c.mint}`,
    value: {
      event: {
        name: 'CreateEvent', program: 'pump', outerIx: c.outerIx, innerIx: c.innerIx,
        data: { mint: c.mint, creator: c.creator, user: c.user, timestamp: c.timestamp, ...(c.tokenTotalSupply === null ? {} : { tokenTotalSupply: c.tokenTotalSupply }) },
      },
      txSlot: c.slot, blockTime: Math.floor(c.blockTimeMs / SECOND_MS), source: 'seed', backfilled: true, seq,
    },
  };
};

/** Overlapping or touching gaps become one, dated at the later end. */
const mergeGaps = (gaps: readonly SeedGap[]): SeedGap[] => {
  const out: SeedGap[] = [];
  for (const g of [...gaps].sort((a, b) => (a.fromSlot < b.fromSlot ? -1 : a.fromSlot > b.fromSlot ? 1 : 0))) {
    const last = out[out.length - 1];
    if (last !== undefined && g.fromSlot <= last.toSlot + 1n) {
      out[out.length - 1] = { fromSlot: last.fromSlot, toSlot: g.toSlot > last.toSlot ? g.toSlot : last.toSlot, atMs: Math.max(last.atMs, g.atMs), reason: `${last.reason}; ${g.reason}` };
    } else out.push(g);
  }
  return out;
};

export const buildSeed = async (o: SeedOptions): Promise<Seed> => {
  if (o.untilSlot > o.asOf.slot) throw new RangeError(`untilSlot ${o.untilSlot} is after the process start slot ${o.asOf.slot}`);
  if (o.fill !== undefined && (o.days.length > 0 || o.rpcFrom !== undefined)) throw new RangeError('a downtime fill takes neither day releases nor rpcFrom');
  if (o.fill?.close !== undefined && o.fill.liveStart === undefined) throw new RangeError('a fill that closes the saved gap needs liveStart, the restarted watch\'s start moment');

  const nowMs = o.asOf.receivedAt;
  const clampMs = (ms: number | null): number => (ms === null || !Number.isFinite(ms) || ms > nowMs ? nowMs : ms);
  // A missing, altered or failed day is dropped and reported; it never stops the seed.
  const dayReports: SeedReport['days'][number][] = [];
  const reads: DayRead[] = [];
  for (const d of [...o.days].sort((a, b) => (a.day < b.day ? -1 : 1))) {
    try {
      const r = readDayRelease(d.dir, d.day);
      reads.push(r);
      dayReports.push({ day: r.day, creates: r.creates.length, units: r.units.length, gapUnits: r.units.filter((u) => !u.covered).length, verified: r.verified });
    } catch (e) {
      dayReports.push({ day: d.day, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Units, deduplicated across days (a unit crossing midnight is in both); a unit any copy calls a gap is a gap.
  const units = new Map<string, SlotRange>();
  for (const r of reads) {
    for (const u of r.units) {
      const k = `${u.fromSlot}-${u.toSlot}`;
      const prev = units.get(k);
      if (prev === undefined || (prev.covered && !u.covered)) units.set(k, u);
    }
  }
  const ranges = [...units.values()].sort((a, b) => (a.fromSlot < b.fromSlot ? -1 : a.fromSlot > b.fromSlot ? 1 : 0));
  const gaps: SeedGap[] = [];
  for (let i = 0; i < ranges.length; i++) {
    const u = ranges[i]!;
    const next = ranges[i + 1];
    // A gap is dated at its end, or at the next known block time after it.
    if (!u.covered) gaps.push({ fromSlot: u.fromSlot, toSlot: u.toSlot, atMs: clampMs(Number.isFinite(u.toMs) ? u.toMs : next?.fromMs ?? null), reason: u.reason ?? 'unit not covered' });
    if (next !== undefined && next.fromSlot > u.toSlot + 1n) gaps.push({ fromSlot: u.toSlot + 1n, toSlot: next.fromSlot - 1n, atMs: clampMs(next.fromMs), reason: `no unit for slots ${u.toSlot + 1n}..${next.fromSlot - 1n}` });
  }
  const firstDay = ranges.find((u) => Number.isFinite(u.fromMs));
  const lastDay = ranges[ranges.length - 1];
  // The start's time is the first known block time, never earlier than the true start (the safe side).
  let start: { slot: bigint; ms: number } | null = ranges[0] === undefined ? null : { slot: ranges[0].fromSlot, ms: firstDay?.fromMs ?? nowMs };

  // The RPC range: after the days' last slot, or from `rpcFrom` when there is no day.
  const from = o.fill ?? (o.rpcFrom === undefined ? undefined : { fromSlot: o.rpcFrom.slot, fromMs: o.rpcFrom.ms });
  const afterSlot = lastDay !== undefined ? lastDay.toSlot : from !== undefined ? from.fromSlot - 1n : null;
  let rpcReport: SeedReport['rpc'] = null;
  let rpcCreates: readonly MarketEvent[] = [];
  // A fill starting after untilSlot (a failover, or a node behind the one that saved the state) skips this: it is
  // empty and complete, because the saved coverage already reaches past the new start.
  if (afterSlot !== null && afterSlot < o.untilSlot) {
    if (o.rpc === undefined) {
      gaps.push({ fromSlot: afterSlot + 1n, toSlot: o.untilSlot, atMs: nowMs, reason: 'no RPC backfill configured' });
    } else {
      const fromMs = lastDay !== undefined && Number.isFinite(lastDay.toMs) ? lastDay.toMs : from?.fromMs ?? null;
      const estimatedCredits = fromMs === null ? null : estimateBackfillCredits(nowMs - fromMs, o.rpc.provider);
      const r = await backfillCreates({ ...o.rpc, afterSlot, untilSlot: o.untilSlot });
      for (const g of r.gaps as readonly SlotGap[]) gaps.push({ fromSlot: g.fromSlot, toSlot: g.toSlot, atMs: clampMs(g.atMs), reason: g.reason });
      rpcCreates = r.creates;
      if (start === null && o.fill === undefined) start = { slot: afterSlot + 1n, ms: clampMs(r.firstMs ?? from?.fromMs ?? null) };
      const { creates: _c, gaps: _g, ...rest } = r;
      rpcReport = { fromSlot: afterSlot + 1n, estimatedCredits, creditCap: o.rpc.creditCap, fitsCap: estimatedCredits === null ? null : estimatedCredits <= o.rpc.creditCap, result: { ...rest, creates: r.creates.length } };
    }
  } else if (afterSlot === null && o.rpc !== undefined && o.days.length === 0) {
    throw new RangeError('an RPC-only seed needs rpcFrom (the look-back start slot and time)');
  }

  // Creates: days then RPC, deduplicated by event id, nothing after the process start (the leak guard).
  let droppedFuture = rpcReport?.result.droppedFuture ?? 0;
  const seen = new Set<string>();
  const creates: MarketEvent[] = [];
  let seq = 0;
  const keep = (e: MarketEvent) => {
    if (e.moment.slot > o.untilSlot || e.moment.receivedAt > nowMs) {
      droppedFuture++;
      return;
    }
    if (seen.has(e.id)) return;
    seen.add(e.id);
    creates.push(e);
  };
  for (const r of reads) for (const c of r.creates) keep(dayCreateEvent(c, seq++));
  for (const e of rpcCreates) keep(e);
  creates.sort(compareEvents);

  // Coverage facts: one start at the range start, then every bounded gap, dated at its end and never after asOf.
  const merged = mergeGaps(gaps);
  const fact = (kind: 'start' | 'gap' | 'resume', slot: bigint, ms: number, value: Record<string, unknown>, n: number, via = SEED_VIA): MarketEvent => ({
    kind: 'market', id: `${SEED_VIA}:coverage:${kind}:${n}`,
    moment: { slot: slot > o.asOf.slot ? o.asOf.slot : slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: Math.min(ms, nowMs) },
    key: `coverage:creates:${kind}`, value: { value: { ...value, via }, source: 'worker', backfilled: true, seq: n },
  });
  const coverage: MarketEvent[] = [];
  const floorMs = start?.ms ?? o.fill?.fromMs ?? null;
  if (floorMs !== null) {
    if (start !== null) coverage.push(fact('start', start.slot, start.ms, { fromSlot: start.slot }, 0));
    merged.forEach((g, i) => coverage.push(fact('gap', g.toSlot, Math.max(g.atMs, floorMs), { fromSlot: g.fromSlot, toSlot: g.toSlot, reason: g.reason }, i + 1)));
  }
  const close = o.fill?.close;
  const live = o.fill?.liveStart;
  if (close !== undefined && o.fill !== undefined && live !== undefined) {
    // Dated from the restarted watch's actual start fact: same slot and in-slot position, 1 ms earlier (and never
    // later than the downtime's first block time), so createsCoverage's order puts the close first and the start
    // cannot settle the saved open gap as lossy before it. The feed may place that start below untilSlot (a skipped
    // slot, a socket ahead of the feed tip, no tip yet), so no slot derived from untilSlot is safe (#45 re-review).
    const n = merged.length + 1;
    const closeMoment: Moment = { slot: live.slot, txIndex: live.txIndex, ixIndex: live.ixIndex, receivedAt: Math.min(o.fill.fromMs, live.receivedAt - 1) };
    const value = merged.length === 0
      ? { fromSlot: close.fromSlot, toSlot: o.untilSlot }
      : { fromSlot: close.fromSlot, toSlot: o.untilSlot, reason: `downtime fill incomplete (${merged.length} gaps)` };
    coverage.push({
      kind: 'market', id: `${SEED_VIA}:coverage:close:${n}`, moment: closeMoment, key: `coverage:creates:${merged.length === 0 ? 'resume' : 'gap'}`,
      value: { value: { ...value, via: close.via }, source: 'worker', backfilled: true, seq: n },
    });
  }
  coverage.sort(compareEvents);
  return {
    creates, coverage,
    report: {
      mode: o.fill === undefined ? 'seed' : 'fill', asOf: o.asOf, untilSlot: o.untilSlot, start,
      days: dayReports,
      rpc: rpcReport, creates: creates.length, gaps: merged, droppedFuture, rugs: RUGS_NOT_SEEDED,
    },
  };
};
