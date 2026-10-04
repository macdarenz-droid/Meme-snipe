// FILL-2: backfills gaps in a tracked pool's trade stream (`coverage:trades:<pool>`), so a restart or a feed drop
// does not reject a coin for life at H5/H11, and live matches the backtest, which has every pool row.
//
// For each gap: `getSignaturesForAddress` on the pool over the gap's slots, then each confirmed transaction, decoded
// only through FEED-1's `eventsOfFrame` for a `tx` frame (DEC-1 inside), so a filled event has the id, key and value
// the stream gives for the same transaction. Paging, retry, budget and as-of rules are the SEED-1 backfill's.
//
// Two uses:
// - After a restart (`liveStart` given): events with their chain moments, to be released in compareEvents order
//   ahead of the buffered live events, plus the close of the saved open gap, dated just before the restarted watch's
//   start (SEED-1's liveStart rule): a `resume` when complete, a bounded lossy gap otherwise.
// - In a run (no `liveStart`): FEED-1's socket asks through `WatchOptions.fill` when a reconnect gap is ready to
//   close; `ingestingFill` puts the transactions into the live feed (which places what is already released after
//   it and drops duplicates) and answers whether the fill was complete, and the socket closes the gap accordingly.
//
// Fail safe: until a fill completes, the gap stands; a partial or skipped fill is a lossy gap. Open positions are
// filled first, then shortlisted candidates, from one credit cap per restart (config).
import type { TransactionRecord } from '../../../core/src/chain/index.ts';
import type { MarketEvent, Moment } from '../../../core/src/engine/index.ts';
import { OFF_CHAIN, compareEvents, compareMoments } from '../../../core/src/engine/index.ts';
import { SECOND_MS } from '../../../core/src/config/time.ts';
import { eventsOfFrame, type Frame, type FrameBody, type Source } from '../providers/canonical.ts';
import type { IngestOptions } from '../providers/live-feed.ts';
import { P2, P3 } from '../scheduler/scheduler.ts';
import { backfillAddress, type BackfillOptions, type BackfillResult } from './rpc.ts';

/** Signature pages one gap may read by default (10,000 signatures). */
export const DEFAULT_MAX_PAGES = 10;

export interface TradeGap {
  readonly pool: string;
  /** Coverage stream name: the facts are `coverage:<stream>:start|gap|resume` (e.g. `trades:<pool>`). */
  readonly stream: string;
  /** Open positions are filled before candidates in their evaluation window. */
  readonly kind: 'position' | 'candidate';
  /** First missing slot (the open gap's `fromSlot`, inclusive) and its block time (ms). */
  readonly fromSlot: bigint;
  readonly fromMs: number;
  /** The live watch's first slot after the gap: the fill reads up to the slot before it, which live covers. */
  readonly untilSlot: bigint;
  /**
   * The open gap to close, as FEED-1 reported it: `via`, `fromSlot` and, when known, `at` (when it was reported). The
   * fill reads from the older of `fromSlot` and `close.fromSlot`, so the close never restores a slot not read.
   */
  readonly close: { readonly via: string; readonly fromSlot: bigint | null; readonly at?: Moment };
  /** After a restart: the restarted watch's `coverage:<stream>:start` moment. Without it no close fact is made. */
  readonly liveStart?: Moment;
}

export interface FillOptions {
  readonly rpc: BackfillOptions['rpc'];
  readonly timers: BackfillOptions['timers'];
  readonly provider: BackfillOptions['provider'];
  /** Credits for all gaps of this restart together (config). */
  readonly creditCap: number;
  readonly gaps: readonly TradeGap[];
  /** Nothing dated after this moment is released. */
  readonly asOf: Moment;
  readonly retry?: BackfillOptions['retry'];
  /**
   * Signature pages (1,000 each) one gap may read (default 10). A busier gap stops there as partial and stays a gap,
   * so no single fill holds the provider for long.
   */
  readonly maxPagesPerFill?: number;
}

export interface GapFill {
  readonly gap: TradeGap;
  readonly complete: boolean;
  /**
   * The pool's events in the gap, with chain moments, in compareEvents order: from min(`fromSlot`, `close.fromSlot`)
   * to `untilSlot − 1`, none after `asOf`. Events of other pools in the same transactions come too, as the stream
   * gives them; they arrive without coverage facts of their own, which is harmless under the gap rules (see DECISIONS).
   */
  readonly events: readonly MarketEvent[];
  /** The transactions read, oldest first (for `ingestingFill`). */
  readonly records: readonly TransactionRecord[];
  /** The close of the saved open gap (after a restart only). */
  readonly coverage: readonly MarketEvent[];
  readonly report: {
    readonly creditsUsed: number;
    readonly latencyMs: number;
    readonly stoppedBy: BackfillResult['stoppedBy'] | 'skipped-no-budget' | 'empty';
    readonly calls: BackfillResult['calls'];
    readonly retries: number;
    readonly droppedFuture: number;
    readonly reasons: readonly string[];
  };
}

/**
 * S0-ZERO: the address's history ended inside the gap, and its oldest transaction is the one that created this pool
 * (PumpSwap's CreatePoolEvent for it, first of everything read): nothing can have traded on the pool before it, so the
 * history end is the pool's own start, not missing history. A candidate's catch-up from its migration ends this way.
 */
const opensPool = (events: readonly MarketEvent[], records: readonly TransactionRecord[], pool: string): boolean => {
  const oldest = records[0];
  if (oldest === undefined) return false;
  return events.some((e) => {
    if (!e.id.startsWith(`ev:${oldest.signature}:`)) return false;
    const ev = (e.value as { event?: { name?: unknown; data?: { pool?: unknown } } } | null)?.event;
    return ev?.name === 'CreatePoolEvent' && ev.data?.pool === pool;
  });
};

/** The close of the saved open gap, dated just before the restarted watch's start (SEED-1's liveStart rule). */
const closeFact = (gap: TradeGap, live: Moment, complete: boolean, n: number): MarketEvent => {
  let moment: Moment = { slot: live.slot, txIndex: live.txIndex, ixIndex: live.ixIndex, receivedAt: Math.min(gap.fromMs, live.receivedAt - 1) };
  // A saved gap reported at or after the restarted start was not settled by it: follow the gap instead (SEED-1).
  if (gap.close.at !== undefined && compareMoments(gap.close.at, moment) >= 0) moment = { ...gap.close.at, receivedAt: gap.close.at.receivedAt + 1 };
  const range = { fromSlot: gap.close.fromSlot, toSlot: gap.untilSlot, via: gap.close.via };
  return {
    kind: 'market', id: `fill:${gap.stream}:close:${n}`, moment,
    key: `coverage:${gap.stream}:${complete ? 'resume' : 'gap'}`,
    value: { value: complete ? range : { ...range, reason: 'trade fill incomplete' }, source: 'worker', backfilled: true, seq: n },
  };
};

export const fillTradeGaps = async (o: FillOptions): Promise<{ readonly fills: readonly GapFill[]; readonly creditsUsed: number }> => {
  // As-of: the close is dated from these moments, so neither may be after the process start (SEED-1). Checked for
  // every gap before any call, so a refused fill spends nothing.
  for (const g of o.gaps) {
    for (const [what, m] of [['liveStart', g.liveStart], ['close.at', g.close.at]] as const) {
      if (m !== undefined && compareMoments(m, o.asOf) > 0) throw new RangeError(`fill of ${g.pool}: ${what} is dated after the process start`);
    }
  }
  // Positions first, then candidates; oldest gap first within each.
  const order = [...o.gaps].sort((a, b) => (a.kind === b.kind ? (a.fromSlot < b.fromSlot ? -1 : a.fromSlot > b.fromSlot ? 1 : 0) : a.kind === 'position' ? -1 : 1));
  let spent = 0;
  const fills: GapFill[] = [];
  for (const [i, gap] of order.entries()) {
    const started = o.timers.now();
    const last = gap.untilSlot - 1n;
    const first = gap.close.fromSlot !== null && gap.close.fromSlot < gap.fromSlot ? gap.close.fromSlot : gap.fromSlot;
    let r: BackfillResult | null = null;
    let stoppedBy: GapFill['report']['stoppedBy'];
    if (first > last) stoppedBy = 'empty'; // nothing between the saved state and the live start
    else if (spent >= o.creditCap) stoppedBy = 'skipped-no-budget';
    else {
      r = await backfillAddress({
        rpc: o.rpc, timers: o.timers, provider: o.provider, creditCap: o.creditCap - spent, ...(o.retry ? { retry: o.retry } : {}),
        afterSlot: first - 1n, untilSlot: last, address: gap.pool,
        // Open positions at P2, below live open-position monitoring at P1 (exits never wait: #70 review); candidates P3.
        priority: gap.kind === 'position' ? P2 : P3, maxPages: o.maxPagesPerFill ?? DEFAULT_MAX_PAGES,
        accept: (rec, rank, seq) => {
          const frame: Frame = {
            seq, receivedAt: (rec.blockTime ?? 0) * SECOND_MS, source: o.provider as Source, backfilled: true,
            place: { at: 'chain', slot: rec.slot }, duplicate: false, body: { type: 'tx', record: rec },
          };
          return eventsOfFrame(frame, new Map([[rec.signature, rank]])).filter((e): e is MarketEvent => e.kind === 'market');
        },
      });
      spent += r.creditsUsed;
      stoppedBy = r.stoppedBy;
    }
    // Ranks were given newest first and are renumbered oldest first by the backfill. Bounded by asOf, and by the
    // slot before the live watch's first: the restarted start fact may sit below untilSlot (SEED-1's lesson), but live
    // delivers only from untilSlot, so the fill keeps everything before it.
    const read = r === null ? [] : [...r.creates].sort(compareEvents);
    const events = read.filter((e) => compareMoments(e.moment, o.asOf) <= 0 && e.moment.receivedAt <= o.asOf.receivedAt);
    const complete = stoppedBy === 'empty' || (r !== null && events.length === read.length && (
      (r.stoppedBy === 'done' && r.gaps.length === 0) || (r.stoppedBy === 'history-end' && r.gaps.length === 1 && opensPool(read, r.records, gap.pool))));
    fills.push({
      gap, complete, events, records: r?.records ?? [],
      // A close that would land after asOf (close.at exactly at it) is not made: the gap stays open (fail safe).
      coverage: gap.liveStart === undefined ? [] : [closeFact(gap, gap.liveStart, complete, i + 1)].filter((e) => compareMoments(e.moment, o.asOf) <= 0),
      report: {
        creditsUsed: r?.creditsUsed ?? 0, latencyMs: o.timers.now() - started, stoppedBy, calls: r?.calls ?? { getSignaturesForAddress: 0, getTransaction: 0 },
        retries: r?.retries ?? 0, droppedFuture: r?.droppedFuture ?? 0, reasons: r?.gaps.map((g) => g.reason) ?? [],
      },
    });
  }
  return { fills, creditsUsed: spent };
};

/**
 * The in-run fill for FEED-1's `WatchOptions.fill`: fills the reconnect gap fromSlot..toSlot (inclusive: the live
 * feed drops duplicates by signature) and ingests every transaction read into the live feed as a backfilled `tx`
 * frame, placed after everything ingested so far, oldest first. Answers true only for a complete fill; an unknown gap start,
 * a partial fill or no budget answers false, and the socket then closes the gap as lossy.
 */
export const ingestingFill = (o: {
  readonly feed: { ingest(source: Source, body: FrameBody, opts: IngestOptions): unknown };
  readonly rpc: FillOptions['rpc'];
  readonly timers: FillOptions['timers'];
  readonly provider: FillOptions['provider'];
  /** Credits this fill may use (the caller tracks its per-restart and per-day caps). */
  readonly creditCap: () => number;
  readonly streamOf: (address: string) => string;
  readonly kindOf: (address: string) => TradeGap['kind'];
  readonly onReport?: (fill: GapFill) => void;
}) => async (gap: { readonly address: string; readonly fromSlot: bigint | null; readonly toSlot: bigint }): Promise<boolean> => {
  if (gap.fromSlot === null) return false;
  const now = o.timers.now();
  const { fills } = await fillTradeGaps({
    rpc: o.rpc, timers: o.timers, provider: o.provider, creditCap: o.creditCap(),
    asOf: { slot: gap.toSlot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: now },
    gaps: [{ pool: gap.address, stream: o.streamOf(gap.address), kind: o.kindOf(gap.address), fromSlot: gap.fromSlot, fromMs: now, untilSlot: gap.toSlot + 1n, close: { via: `logs:${gap.address}`, fromSlot: gap.fromSlot } }],
  });
  const f = fills[0]!;
  // After everything ingested so far, oldest first (S0-ZERO): a recent transaction is not placed at its own slot ahead of
  // older ones that land after the released point, so the pool's trades reach the feed in order.
  for (const record of f.records) o.feed.ingest(o.provider, { type: 'tx', record }, { receivedAt: o.timers.now(), backfilled: true, lookup: true, after: true });
  o.onReport?.(f);
  return f.complete;
};
