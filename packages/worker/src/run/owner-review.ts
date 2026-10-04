// OWNER-REVIEW: the owner's review commands. The owner sends /review, /rearm or /weekly in the paired Telegram chat;
// the watchdog shows the evidence from the worker's last heartbeat (`review`) and, on "<command> confirm <trip>",
// queues the command; the heartbeat reply carries it here. The worker checks the trip against its own open stop, writes
// the review moment into the latches (control.json) only on a match, and acknowledges the result in its next heartbeat
// (`acked`). Each command clears only its own stop; a command applied once is never applied again.
import type { Policy } from '../../../core/src/config/index.ts';
import type { ClosedTrade, Latches, RiskSnapshot } from '../../../core/src/risk/index.ts';
import { lossReviewTrip } from '../../../core/src/risk/index.ts';
import { melbourneWeek } from '../../../core/src/risk/melbourne.ts';

export type OwnerKind = 'review' | 'rearm' | 'weekly';
export const OWNER_KINDS: readonly OwnerKind[] = ['review', 'rearm', 'weekly'];

/** A command from the watchdog: its id, what it clears, and the trip the owner confirmed. */
export interface OwnerCommand {
  readonly id: string;
  readonly kind: OwnerKind;
  readonly trip: string;
}

export type OwnerResult = 'applied' | 'stale' | 'invalid';

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
}

export type OpenStops = Readonly<Record<OwnerKind, OpenStop | null>>;

export const tripId = (kind: OwnerKind, atMs: number): string => `${kind}-${atMs}`;

const ID = /^[A-Za-z0-9:_-]{1,64}$/;
const TRIP = /^(review|rearm|weekly)-\d{1,16}$/;

export interface StopInputs {
  readonly latches: Latches;
  readonly closed: readonly ClosedTrade[];
  readonly loss: Pick<Policy['loss'], 'reviewWindowTrades' | 'reviewLosses'>;
  /** Net lamports of the paper trades closed from `fromMs` to `toMs` (both included), or null when any is unknown. */
  readonly netLamports: (fromMs: number, toMs: number) => bigint | null;
  /** The latest valuation, for the SOL figures; null before the first one. */
  readonly snapshot: RiskSnapshot | null;
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
      evidence: { losses: r8.losses, window: i.loss.reviewWindowTrades, from_ms: r8.fromMs, to_ms: r8.atMs, net_lamports: lamports(i.netLamports(r8.fromMs, r8.atMs)) },
    },
    rearm: !killOpen(l) ? null : {
      trip: tripId('rearm', l.killTrippedAtMs), atMs: l.killTrippedAtMs,
      evidence: { tripped_ms: l.killTrippedAtMs, equity_lamports: lamports(s?.equitySol ?? null), nav_lamports: lamports(s?.navSol ?? null), nav_peak_lamports: lamports(s?.navHighWaterMarkSol ?? null) },
    },
    weekly: !weeklyOpen(l) ? null : {
      trip: tripId('weekly', l.weeklyTrippedAtMs), atMs: l.weeklyTrippedAtMs,
      evidence: { tripped_ms: l.weeklyTrippedAtMs, week_ends_ms: melbourneWeek(l.weeklyTrippedAtMs).end, equity_lamports: lamports(s?.equitySol ?? null) },
    },
  };
};

/** The heartbeat's `review` block: the open stops by kind, null when none is open. */
export const reviewBlock = (stops: OpenStops): Record<OwnerKind, { readonly trip: string; readonly evidence: Evidence } | null> => ({
  review: stops.review === null ? null : { trip: stops.review.trip, evidence: stops.review.evidence },
  rearm: stops.rearm === null ? null : { trip: stops.rearm.trip, evidence: stops.rearm.evidence },
  weekly: stops.weekly === null ? null : { trip: stops.weekly.trip, evidence: stops.weekly.evidence },
});

/**
 * The commands in a heartbeat reply. Signed by nobody (it is the watchdog's answer), so every field is checked: an
 * entry that is not an object with a well-formed id, kind and trip is dropped here; one with a good id but a bad kind or
 * trip is kept so it is answered `invalid`.
 */
export const commandsOf = (raw: unknown): { readonly id: string; readonly kind: string; readonly trip: string }[] => {
  if (!Array.isArray(raw)) return [];
  const out: { id: string; kind: string; trip: string }[] = [];
  for (const c of raw.slice(0, 8)) {
    if (typeof c !== 'object' || c === null) continue;
    const { id, kind, trip } = c as Record<string, unknown>;
    if (typeof id !== 'string' || !ID.test(id) || typeof kind !== 'string' || typeof trip !== 'string') continue;
    out.push({ id, kind: kind.slice(0, 16), trip: trip.slice(0, 40) });
  }
  return out;
};

const isKind = (k: string): k is OwnerKind => (OWNER_KINDS as readonly string[]).includes(k);

/** The latches with `kind`'s review moment written: only its own field. */
const reviewed = (l: Latches, kind: OwnerKind, atMs: number): Latches =>
  kind === 'review' ? { ...l, lossReviewedAtMs: atMs } : kind === 'rearm' ? { ...l, killRearmedAtMs: atMs } : { ...l, weeklyReviewedAtMs: atMs };

/**
 * One command against the open stops. Applied only when its kind's stop is open, its trip is that stop's trip, and the
 * review moment is strictly after the trip; otherwise stale (or invalid for a bad kind or trip) and nothing changes.
 * A command already handled returns null: it is never applied twice.
 */
export const handleCommand = (
  c: { readonly id: string; readonly kind: string; readonly trip: string }, stops: OpenStops, latches: Latches, handled: readonly HandledCommand[], nowMs: number,
): { readonly latches: Latches; readonly entry: HandledCommand } | null => {
  if (handled.some((h) => h.id === c.id)) return null;
  const done = (result: OwnerResult, l: Latches = latches) => ({ latches: l, entry: { id: c.id, kind: c.kind, trip: c.trip, result, atMs: nowMs } });
  if (!isKind(c.kind) || !TRIP.test(c.trip) || !c.trip.startsWith(`${c.kind}-`)) return done('invalid');
  const stop = stops[c.kind];
  if (stop === null || stop.trip !== c.trip || nowMs <= stop.atMs) return done('stale');
  return done('applied', reviewed(latches, c.kind, nowMs));
};

/** The handled list with `entry` added, newest last, capped. */
export const keepHandled = (handled: readonly HandledCommand[], entry: HandledCommand): HandledCommand[] => [...handled, entry].slice(-KEEP_HANDLED);

/** The heartbeat's `acked`: every kept command's id and result (the watchdog drops a pending command once acked). */
export const ackedOf = (handled: readonly HandledCommand[]): { readonly id: string; readonly result: OwnerResult }[] => handled.map((h) => ({ id: h.id, result: h.result }));
