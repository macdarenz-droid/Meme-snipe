// OWNER-REVIEW: the owner's review commands. The owner sends /review, /rearm or /weekly in the paired Telegram chat;
// the watchdog shows the evidence from the worker's last heartbeat (`review`) and, on "<command> confirm <trip>",
// queues the command; the heartbeat reply carries it here. The worker checks the trip against its own open stop, writes
// the review moment into the latches (control.json) only on a match, and acknowledges the result in its next heartbeat
// (`acked`). Each command clears only its own stop; a command applied once is never applied again.
import type { Policy } from '../../../core/src/config/index.ts';
import type { ClosedTrade, DayOverride, Latches, RiskSnapshot } from '../../../core/src/risk/index.ts';
import { lossReviewTrip } from '../../../core/src/risk/index.ts';
import { melbourneDay, melbourneWeek } from '../../../core/src/risk/melbourne.ts';

export type OwnerKind = 'review' | 'rearm' | 'weekly' | 'override';
export const OWNER_KINDS: readonly OwnerKind[] = ['review', 'rearm', 'weekly', 'override'];

/** A command from the watchdog: its id, what it clears, the trip the owner confirmed, and when (watchdog time). */
export interface ReplyCommand {
  readonly id: string;
  readonly kind: string;
  readonly trip: string;
  readonly at: number | null;
}

export type OwnerResult = 'applied' | 'stale' | 'invalid' | 'expired';

/** A confirm counts for 15 minutes (ops ruling): a /rearm never applies days later on evidence the owner saw long before. */
export const COMMAND_TTL_MS = 15 * 60_000;

/** A command handled, kept in control.json so a repeat is a no-op and its result is acknowledged. */
export interface HandledCommand {
  readonly id: string;
  readonly kind: string;
  readonly trip: string;
  readonly result: OwnerResult;
  /** When it was handled; for an applied command, the review moment written into the latches. */
  readonly atMs: number;
}

/** Commands kept (newest last): far more than the watchdog can have pending (one per kind). */
export const KEEP_HANDLED = 32;

/** Evidence values: counts, moments and lamports (a decimal string, the watchdog shows SOL), or null when unknown. */
export type Evidence = Readonly<Record<string, string | number | null>>;

/** A stop the owner can clear, named by its trip id. */
export interface OpenStop {
  readonly trip: string;
  /** The trip's moment: the review written must be strictly later. */
  readonly atMs: number;
  readonly evidence: Evidence;
  /** /override only: the override an applied confirm writes (its `atMs` set when applied). */
  readonly override?: Omit<DayOverride, 'atMs'>;
}

export type OpenStops = Readonly<Record<OwnerKind, OpenStop | null>>;

export const tripId = (kind: OwnerKind, atMs: number): string => `${kind}-${atMs}`;
/** /override's trip: the Melbourne day and how many overrides it already had, so a confirm fits one override only. */
export const overrideTrip = (dayStartMs: number, count: number): string => `override-${dayStartMs}-${count}`;

const ID = /^[A-Za-z0-9:_-]{1,64}$/;
const TRIP = /^((review|rearm|weekly)-\d{1,16}|override-\d{1,16}-\d{1,4})$/;

/** Risk's day-level stops the owner can override (R7, and R8's streak pauses; never the R8 review). */
const DAY_CODES = ['daily_loss', 'loss_cooldown', 'loss_day_pause'] as const;

export interface StopInputs {
  readonly latches: Latches;
  readonly closed: readonly ClosedTrade[];
  readonly loss: Pick<Policy['loss'], 'reviewWindowTrades' | 'reviewLosses'>;
  /** Net lamports of the paper trades closed from `fromMs` to `toMs` (both included), or null when any is unknown. */
  readonly netLamports: (fromMs: number, toMs: number) => bigint | null;
  /** The latest valuation, for the SOL figures; null before the first one. */
  readonly snapshot: RiskSnapshot | null;
  /** Risk's reason codes on that valuation (its exit check), for the day-level stops; empty before the first one. */
  readonly codes: readonly string[];
  /**
   * That valuation was fully marked at a fresh SOL price (marks.ts `latchable`, the RISK-LATCH evidence rule). Otherwise
   * an unknown mark stands in as a total loss, so its day loss is not evidence: /override is neither offered nor applied.
   */
  readonly latchable: boolean;
  /** Micro-dollars as lamports at the current SOL price, or null without one (SOL figures until SOL-BOOKS). */
  readonly toLamports: (usd: bigint) => bigint | null;
  /** R7's line in force on that valuation's day (core dayLossLine: the limit, or beyond an override), micro-dollars. */
  readonly dayLine: bigint;
}

const lamports = (v: bigint | null): string | null => (v === null ? null : v.toString());

/** The R10 kill latch still waits for a re-arm (evaluate.ts R10: a re-arm counts only strictly after the trip). */
const killOpen = (l: Latches): l is Latches & { readonly killTrippedAtMs: number } =>
  l.killTrippedAtMs !== null && (l.killRearmedAtMs === null || l.killRearmedAtMs <= l.killTrippedAtMs);
/** The R9 weekly latch still waits for the owner's review (evaluate.ts R9; it then holds until the week ends). */
const weeklyOpen = (l: Latches): l is Latches & { readonly weeklyTrippedAtMs: number } =>
  l.weeklyTrippedAtMs !== null && (l.weeklyReviewedAtMs === null || l.weeklyReviewedAtMs <= l.weeklyTrippedAtMs);

/** The stops the owner can clear now, each with its trip id and evidence in SOL. */
export const openStops = (i: StopInputs): OpenStops => {
  const s = i.snapshot;
  const r8 = lossReviewTrip(i.closed, i.latches.lossReviewedAtMs, i.loss);
  const l = i.latches;
  return {
    review: r8 === null ? null : {
      trip: tripId('review', r8.atMs), atMs: r8.atMs,
      evidence: { losses: r8.losses, trades: r8.trades, from_ms: r8.fromMs, to_ms: r8.toMs, net_lamports: lamports(i.netLamports(r8.fromMs, r8.toMs)) },
    },
    rearm: !killOpen(l) ? null : {
      trip: tripId('rearm', l.killTrippedAtMs), atMs: l.killTrippedAtMs,
      evidence: { tripped_ms: l.killTrippedAtMs, equity_lamports: lamports(s?.equitySol ?? null), nav_lamports: lamports(s?.navSol ?? null), nav_peak_lamports: lamports(s?.navHighWaterMarkSol ?? null) },
    },
    weekly: !weeklyOpen(l) ? null : {
      trip: tripId('weekly', l.weeklyTrippedAtMs), atMs: l.weeklyTrippedAtMs,
      evidence: { tripped_ms: l.weeklyTrippedAtMs, week_ends_ms: melbourneWeek(l.weeklyTrippedAtMs).end, equity_lamports: lamports(s?.equitySol ?? null) },
    },
    override: overrideStop(i),
  };
};

/** /override: open while risk's last valuation shows a day-level stop on today's Melbourne day. */
const overrideStop = (i: StopInputs): OpenStop | null => {
  const s = i.snapshot;
  const daily = i.codes.includes('daily_loss');
  const streak = i.codes.includes('loss_cooldown') || i.codes.includes('loss_day_pause');
  if (s === null || !i.latchable || !DAY_CODES.some((c) => i.codes.includes(c))) return null;
  const prev = i.latches.dayOverride ?? null;
  const count = prev !== null && prev.dayStartMs === s.dayStartMs ? prev.count : 0;
  return {
    trip: overrideTrip(s.dayStartMs, count), atMs: s.dayStartMs,
    evidence: {
      daily: daily ? 1 : 0, streak: streak ? s.lossStreak : 0, day_loss_lamports: lamports(i.toLamports(s.dayLoss)),
      day_line_lamports: lamports(i.toLamports(i.dayLine)), overrides: count, day_ends_ms: s.dayStartMs + melbourneDayLength(s.dayStartMs),
    },
    override: { dayStartMs: s.dayStartMs, dayLossAt: daily ? s.dayLoss : null, streak, count: count + 1, ...(count > 0 && prev !== null ? { firstAtMs: prev.firstAtMs ?? prev.atMs } : {}) },
  };
};

/** The length of the Melbourne day starting at `dayStartMs` (23, 24 or 25 hours across daylight saving). */
const melbourneDayLength = (dayStartMs: number): number => melbourneDay(dayStartMs).end - dayStartMs;

/** The heartbeat's `review` block: the open stops by kind, null when none is open. */
export const reviewBlock = (stops: OpenStops): Record<OwnerKind, { readonly trip: string; readonly evidence: Evidence } | null> => {
  const out = (s: OpenStop | null) => (s === null ? null : { trip: s.trip, evidence: s.evidence });
  return { review: out(stops.review), rearm: out(stops.rearm), weekly: out(stops.weekly), override: out(stops.override) };
};

/**
 * The commands in a heartbeat reply. Signed by nobody (it is the watchdog's answer), so every field is checked: an
 * entry that is not an object with a well-formed id, kind and trip is dropped here; one with a good id but a bad kind or
 * trip is kept so it is answered `invalid`.
 */
export const commandsOf = (raw: unknown): ReplyCommand[] => {
  if (!Array.isArray(raw)) return [];
  const out: ReplyCommand[] = [];
  for (const c of raw.slice(0, 8)) {
    if (typeof c !== 'object' || c === null) continue;
    const { id, kind, trip, at } = c as Record<string, unknown>;
    if (typeof id !== 'string' || !ID.test(id) || typeof kind !== 'string' || typeof trip !== 'string') continue;
    out.push({ id, kind: kind.slice(0, 16), trip: trip.slice(0, 40), at: typeof at === 'number' && Number.isSafeInteger(at) ? at : null });
  }
  return out;
};

const isKind = (k: string): k is OwnerKind => (OWNER_KINDS as readonly string[]).includes(k);

/** The latches with `kind`'s review moment written: only its own field (for /override, the day override). */
const reviewed = (l: Latches, kind: OwnerKind, atMs: number, stop: OpenStop): Latches =>
  kind === 'review' ? { ...l, lossReviewedAtMs: atMs }
    : kind === 'rearm' ? { ...l, killRearmedAtMs: atMs }
      : kind === 'weekly' ? { ...l, weeklyReviewedAtMs: atMs }
        : stop.override === undefined ? l : { ...l, dayOverride: { firstAtMs: atMs, ...stop.override, atMs } };

/**
 * One command against the open stops. Applied only when it was confirmed within COMMAND_TTL_MS, its kind's stop is open,
 * its trip is that stop's trip, and the review moment is strictly after the trip; otherwise expired, stale (or invalid
 * for a bad kind, trip or time) and nothing changes.
 * A command already handled returns null: it is never applied twice.
 */
export const handleCommand = (
  c: ReplyCommand, stops: OpenStops, latches: Latches, handled: readonly HandledCommand[], nowMs: number,
): { readonly latches: Latches; readonly entry: HandledCommand } | null => {
  if (handled.some((h) => h.id === c.id)) return null;
  const done = (result: OwnerResult, l: Latches = latches) => ({ latches: l, entry: { id: c.id, kind: c.kind, trip: c.trip, result, atMs: nowMs } });
  if (!isKind(c.kind) || !TRIP.test(c.trip) || !c.trip.startsWith(`${c.kind}-`) || c.at === null) return done('invalid');
  // Confirmed more than 15 minutes ago, or stamped that far ahead of this clock: the owner confirms it again.
  if (Math.abs(nowMs - c.at) > COMMAND_TTL_MS) return done('expired');
  const stop = stops[c.kind];
  if (stop === null || stop.trip !== c.trip || nowMs <= stop.atMs) return done('stale');
  if (c.kind === 'override' && stop.override === undefined) return done('stale');
  return done('applied', reviewed(latches, c.kind, nowMs, stop));
};

/**
 * A journal line's fields: an `entry` decided while an owner day override held says so. Judged at the entry intent's
 * decision moment, not at the fill: an entry decided before the override and filled after it is not tagged. The day's
 * first override counts (a later one on the same day replaces it in the latches). Unknown decision moment: not tagged.
 */
export const withOverrideTag = (kind: string, fields: Readonly<Record<string, unknown>>, latches: Latches, decidedAtMs: number | null): Readonly<Record<string, unknown>> => {
  const o = latches.dayOverride ?? null;
  if (kind !== 'entry' || decidedAtMs === null || o === null || melbourneDay(decidedAtMs).start !== o.dayStartMs) return fields;
  return decidedAtMs >= (o.firstAtMs ?? o.atMs) ? { ...fields, override: true } : fields;
};

/** The handled list with `entry` added, newest last, capped. */
export const keepHandled = (handled: readonly HandledCommand[], entry: HandledCommand): HandledCommand[] => [...handled, entry].slice(-KEEP_HANDLED);

/** The heartbeat's `acked`: every kept command's id and result (the watchdog drops a pending command once acked). */
export const ackedOf = (handled: readonly HandledCommand[]): { readonly id: string; readonly result: OwnerResult }[] => handled.map((h) => ({ id: h.id, result: h.result }));
