// Data freshness (UI-T05, C29; docs/UI.md "Data freshness model"). Age = now + server offset − as_of on the wall clock,
// so a wrong laptop clock cannot make stale data look fresh; for simulated data (clock "sim") the age is measured
// against the simulation clock instead, while connection health always uses the wall clock. States: live (age up to
// the "delayed after" threshold), delayed (up to the "stale after" threshold), stale (beyond it), disconnected and
// paused. A negative age within CLOCK_SKEW_TOLERANCE_MS counts as 0; beyond it (data ahead of the server clock by more
// than the skew) the data is stale with the reason "clock skew" and the skew is reported (Z05 round 2, red team M1: a
// future as_of must never read as live). Paused and disconnected keep the age state in `ageState`, so stale data stays
// blocked while paused or disconnected (red team M2). A missing as_of is stale with the reason "no timestamp"; a malformed one (a
// contract violation the schema check refuses upstream) is stale with the reason "invalid timestamp", never a throw
// out of render.
import { parseAt } from './money.ts';

/** Epoch ms of an `_at` timestamp, or null when it is malformed. */
function atOrNull(iso: string): number | null {
  try {
    return parseAt(iso);
  } catch {
    return null;
  }
}

/**
 * How far data may look ahead of now before it counts as clock skew. The offset is a median estimate from heartbeats
 * (network jitter makes a just-received as_of look a few to a few hundred ms ahead), and ages show and re-evaluate in
 * whole seconds, so a lead within one second is normal and indistinguishable from 0s.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 1000;

/**
 * A clock-skew episode ends only once the data has been free of skew for this long: a reading without skew at least
 * this long after the last skewed one. A lead that hovers around the tolerance, or skew that only shows for the first
 * moment after each update, stays one episode, so a VM reports at most once a minute. On the slowest VMs (60 s
 * cadence) a steady skew also shows only for the first moment after each update. When the next update comes a full
 * SKEW_EPISODE_END_MS later, a reading without skew has ended the episode first, so the VM reports once a minute (once
 * per update); an update that comes sooner continues the episode.
 */
export const SKEW_EPISODE_END_MS = 60_000;

export type FreshnessState = 'live' | 'delayed' | 'stale' | 'disconnected' | 'paused';

export interface Thresholds { expected_ms: number; delayed_ms: number; stale_ms: number }

/** The DS table's cadence and thresholds for the pushed and polled VMs (PROPOSED values in docs/UI.md). */
export const VM_THRESHOLDS: Readonly<Record<string, Thresholds>> = {
  'VM-01': { expected_ms: 2000, delayed_ms: 4000, stale_ms: 10000 },
  'VM-04': { expected_ms: 30000, delayed_ms: 45000, stale_ms: 90000 },
  'VM-05': { expected_ms: 1000, delayed_ms: 5000, stale_ms: 10000 },
  'VM-08': { expected_ms: 1000, delayed_ms: 5000, stale_ms: 10000 },
  'VM-09': { expected_ms: 60000, delayed_ms: 120000, stale_ms: 180000 },
  'VM-10': { expected_ms: 5000, delayed_ms: 15000, stale_ms: 30000 },
  'VM-11': { expected_ms: 1000, delayed_ms: 5000, stale_ms: 10000 },
  'VM-12': { expected_ms: 1000, delayed_ms: 3000, stale_ms: 5000 },
  'VM-13': { expected_ms: 2000, delayed_ms: 4000, stale_ms: 6000 },
  'VM-14': { expected_ms: 60000, delayed_ms: 120000, stale_ms: 180000 },
  'VM-18': { expected_ms: 30000, delayed_ms: 60000, stale_ms: 90000 },
  'VM-20': { expected_ms: 2000, delayed_ms: 4000, stale_ms: 10000 },
};

export interface FreshnessInput extends Thresholds {
  /** The data's `as_of` (RFC 3339 UTC with milliseconds), or null when the payload has none. */
  as_of: string | null;
  clock: 'wall' | 'sim';
  /** The operator paused updates. */
  paused?: boolean;
  /** The stream is disconnected (from ConnectionStatus). */
  disconnected?: boolean;
}

export interface ClockReading {
  /** Local wall-clock time in epoch ms. */
  nowMs: number;
  /** Server minus local clock (median of recent heartbeats). */
  offsetMs: number;
  /** The simulation clock's time (`sim_clock.sim_time`), for clock "sim". */
  simTime?: string | null;
}

export interface Freshness {
  state: FreshnessState;
  /** The state the data's age alone gives (live, delayed or stale), kept when the shown state is paused or disconnected. */
  ageState: 'live' | 'delayed' | 'stale';
  /** Age in ms (0 or more), null when there is no timestamp or no simulation time. */
  ageMs: number | null;
  /** Why the state is what it is, when not plain age (no timestamp, invalid timestamp, no simulation time, clock skew). */
  reason?: string;
  /** How far the data is ahead of now, when that is more than CLOCK_SKEW_TOLERANCE_MS (clock-skew diagnostic). */
  skewMs?: number;
}

/** The freshness of `input` at `clock`. Disconnected beats paused, which beats the age. */
export function freshness(input: FreshnessInput, clock: ClockReading): Freshness {
  const base = ((): Freshness => {
    if (input.as_of === null) return { state: 'stale', ageState: 'stale', ageMs: null, reason: 'no timestamp' };
    const asOf = atOrNull(input.as_of);
    if (asOf === null) return { state: 'stale', ageState: 'stale', ageMs: null, reason: 'invalid timestamp' };
    const now = input.clock === 'sim' ? (clock.simTime === undefined || clock.simTime === null ? null : atOrNull(clock.simTime)) : clock.nowMs + clock.offsetMs;
    if (now === null) return { state: 'stale', ageState: 'stale', ageMs: null, reason: 'no simulation time' };
    const raw = now - asOf;
    const ageMs = Math.max(0, raw);
    if (-raw > CLOCK_SKEW_TOLERANCE_MS) return { state: 'stale', ageState: 'stale', ageMs, reason: 'clock skew', skewMs: -raw };
    const state = ageMs <= input.delayed_ms ? 'live' : ageMs <= input.stale_ms ? 'delayed' : 'stale';
    return { state, ageState: state, ageMs };
  })();
  if (input.disconnected === true) return { ...base, state: 'disconnected' };
  if (input.paused === true) return { ...base, state: 'paused' };
  return base;
}

/** Thresholds for a VM ID from the DS table; throws for a VM without a freshness rule. */
export function thresholdsFor(vm: string): Thresholds {
  const t = VM_THRESHOLDS[vm];
  if (t === undefined) throw new Error(`freshness: ${vm} has no freshness thresholds`);
  return t;
}

/**
 * Why a risk-increasing action is blocked by the data's freshness (UI-T05 acceptance 3); undefined when it is not.
 * Risk-reducing actions ignore this. Blocks while the stream is down ("Disconnected from bot"), while the data is ahead
 * of the server clock (clock skew), while updates are paused (always: paused data is not known to be current), and
 * while the data's age is stale, whatever state is shown (Z05 round 2, red team M1 and M2).
 */
export function blockedReason(f: Freshness, subject: string): string | undefined {
  if (f.state === 'disconnected') return 'Disconnected from bot';
  if (f.skewMs !== undefined) return `${subject} is ahead of the server clock`;
  if (f.state === 'paused') return `${subject} updates are paused`;
  return f.ageState === 'stale' ? `${subject} is stale` : undefined;
}
