// Strategy health, observation only (STRATEGY-HEALTH-OBS; docs/research/risk.md §10, docs/DECISIONS.md).
// A pure, deterministic reducer over episode events: one observation per entry decision, z = net lamports / entry
// lamports (the entry size fixed before the first attempt), fed to a one-sided CUSUM S_i = max(0, S_{i−1} − z_i − κ).
// The states it computes (unregistered, active, watch, paused, requalifying) are reported next to decisions and enforced
// nowhere: nothing in entry, exit or risk reads them. Replacing R8 with them would be a loosening, the owner's decision.

/** Where the episodes come from. Each mode keeps its own history: paper never inherits from a backtest. */
export type HealthMode = 'backtest' | 'paper' | 'live';

/**
 * What a strategy is. History belongs to the lineage (lineageId within a mode): a new version, policy, venue or
 * execution model inside the same lineage is recorded but cannot reset its history.
 */
export interface StrategyIdentity {
  readonly lineageId: string;
  readonly strategyVersionHash: string;
  readonly universe: string;
  readonly venue: string;
  readonly policyHash: string;
  readonly executionModelHash: string;
  readonly mode: HealthMode;
}

export type HealthStatus = 'unregistered' | 'active' | 'watch' | 'paused' | 'requalifying';

export interface HealthConfig {
  /** CUSUM reference value: S grows only when an episode returns less than −κ. */
  readonly kappa: number;
  /** Alarm level: S ≥ h is "paused". */
  readonly h: number;
  /** S ≥ watchFraction·h is "watch". */
  readonly watchFraction: number;
  /** After a pause S restarts at 0; this many consecutive episodes below the watch level return it to "active". */
  readonly requalifyEpisodes: number;
  /** Identities registered for trading; an episode of any other identity is reported "unregistered". */
  readonly registered: readonly StrategyIdentity[];
}

/**
 * κ = 0.005 and h = 7.1 from research/risk/loss_review.py: h is the smallest value with at most 5% alarms within 100
 * episodes for every synthetic in-control model, chosen on seed 810 and validated on seed 281011 (risk.md §10).
 * The 5% is per 100 episodes, not a fixed-level test: false pauses accumulate over a longer run (a marginal +1.75%
 * strategy is falsely paused on about 5% of paths by 100 episodes, 22% by 250, 44% by 500, 71% by 1,000), and a rise
 * in variance at the same mean also alarms. "Paused" is evidence read against the episodes observed.
 */
export const HEALTH_DEFAULTS = { kappa: 0.005, h: 7.1, watchFraction: 0.5, requalifyEpisodes: 20 } as const;

/**
 * Episode events in durable-sequence order (`seq` strictly increasing; equal timestamps are ordered by it).
 *  - entry: the entry decision, with the size fixed before the first attempt.
 *  - flow: a signed lamport flow of the episode (spend on a fill, proceeds of an exit, every fee, failed attempts'
 *    fees included). Retries, partial fills and partial exits are flows of the same episode.
 *  - final: the episode is over. 'closed' and 'failed-entry' are observations; 'dropped' (nothing was sent) is not,
 *    and a dropped episode that carried flows is refused rather than hidden.
 */
export type HealthEvent =
  | { readonly type: 'entry'; readonly seq: number; readonly episodeId: string; readonly identity: StrategyIdentity; readonly entryLamports: bigint }
  | { readonly type: 'flow'; readonly seq: number; readonly episodeId: string; readonly lamports: bigint }
  | { readonly type: 'final'; readonly seq: number; readonly episodeId: string; readonly outcome: 'closed' | 'failed-entry' | 'dropped' }
  /**
   * A settlement that landed after the episode was observed (a late sell or fee, PAPER-2). It counts at once, as a
   * correction of that episode: its return becomes (net + lamports)/entry and the lineage is recomputed from the
   * start with it, so S, the state, the clean run and the pauses are exactly what they would be had the return been
   * known at the time. Under the golden rule a late loss is never dropped.
   */
  | { readonly type: 'late'; readonly seq: number; readonly episodeId: string; readonly lamports: bigint };

export interface OpenEpisode {
  readonly identity: StrategyIdentity;
  readonly entryLamports: bigint;
  /** Sum of the flows so far: an unfinished loser stays visible here until it is final. */
  readonly netLamports: bigint;
  readonly flows: number;
  readonly entrySeq: number;
}

export interface LineageHealth {
  /** The latest identity seen in the lineage. */
  readonly identity: StrategyIdentity;
  readonly s: number;
  /** The CUSUM state machine, before registration is applied. */
  readonly machine: Exclude<HealthStatus, 'unregistered'>;
  /** What is reported: `machine`, or 'unregistered' when the latest identity is not registered. */
  readonly status: HealthStatus;
  readonly observations: number;
  /** Consecutive episodes below the watch level while requalifying. */
  readonly cleanRun: number;
  readonly pauses: number;
  /**
   * Every observed episode of the lineage in the order it became final, with its return and identity: a late
   * settlement corrects one return and the lineage is recomputed from the start (STATS review B1 of #200), because the
   * CUSUM's zero floor and the pauses between make an incremental correction wrong in both directions.
   */
  readonly history: readonly { readonly episodeId: string; readonly z: number; readonly identity: StrategyIdentity }[];
}

/** An episode already final: what a late settlement corrects. A dropped episode has no lineage and takes none. */
export interface FinishedEpisode {
  readonly lineage: string | null;
  readonly entryLamports: bigint;
  readonly netLamports: bigint;
}

export interface HealthState {
  readonly lastSeq: number;
  readonly open: Readonly<Record<string, OpenEpisode>>;
  readonly finished: Readonly<Record<string, FinishedEpisode>>;
  /** Fingerprint of every applied event by sequence: a re-delivered event is ignored, a conflicting one refused. */
  readonly seen: Readonly<Record<number, string>>;
  readonly lineages: Readonly<Record<string, LineageHealth>>;
}

export interface HealthObservation {
  /** 'episode' when an episode became final; 'correction' when a late settlement corrected one already observed. */
  readonly kind: 'episode' | 'correction';
  readonly seq: number;
  readonly episodeId: string;
  readonly lineage: string;
  readonly z: number;
  readonly s: number;
  readonly from: HealthStatus | null;
  readonly to: HealthStatus;
  /** Corrections only: the lineage before it was recomputed with the corrected return. */
  readonly previous?: { readonly s: number; readonly status: HealthStatus; readonly pauses: number; readonly z: number };
}

export interface HealthStep {
  readonly state: HealthState;
  /** Set when the event finished an episode that counts. */
  readonly observation: HealthObservation | null;
  /** True when the event was a re-delivery of one already applied (nothing changed). */
  readonly duplicate: boolean;
}

export const initialHealthState = (): HealthState => ({ lastSeq: -1, open: {}, finished: {}, seen: {}, lineages: {} });

export const lineageKey = (id: StrategyIdentity): string => `${id.mode}|${id.lineageId}`;

const identityKey = (id: StrategyIdentity): string =>
  JSON.stringify([id.lineageId, id.strategyVersionHash, id.universe, id.venue, id.policyHash, id.executionModelHash, id.mode]);

const fingerprint = (e: HealthEvent): string => {
  switch (e.type) {
    case 'entry': return JSON.stringify(['entry', e.episodeId, identityKey(e.identity), e.entryLamports.toString()]);
    case 'flow': return JSON.stringify(['flow', e.episodeId, e.lamports.toString()]);
    case 'final': return JSON.stringify(['final', e.episodeId, e.outcome]);
    case 'late': return JSON.stringify(['late', e.episodeId, e.lamports.toString()]);
  }
};

const checkConfig = (c: HealthConfig): void => {
  if (!(Number.isFinite(c.kappa) && Number.isFinite(c.h) && c.h > 0)) throw new RangeError('health config: κ must be finite and h > 0');
  if (!(c.watchFraction > 0 && c.watchFraction < 1)) throw new RangeError('health config: watchFraction must be in (0, 1)');
  if (!(Number.isInteger(c.requalifyEpisodes) && c.requalifyEpisodes >= 1)) throw new RangeError('health config: requalifyEpisodes must be a positive integer');
};

/** The CUSUM step and the state machine for one observation z. */
const advance = (prev: LineageHealth | undefined, episodeId: string, identity: StrategyIdentity, z: number, c: HealthConfig): LineageHealth => {
  const watch = c.watchFraction * c.h;
  const machine0 = prev?.machine ?? 'active';
  // After a pause the CUSUM restarts at 0 and the lineage requalifies.
  const restart = machine0 === 'paused';
  const s = Math.max(0, (restart ? 0 : prev?.s ?? 0) - z - c.kappa);
  let machine: LineageHealth['machine'];
  let cleanRun = 0;
  let pauses = prev?.pauses ?? 0;
  if (s >= c.h) {
    machine = 'paused';
    pauses++;
  } else if (restart || machine0 === 'requalifying') {
    cleanRun = s < watch ? (restart ? 0 : prev!.cleanRun) + 1 : 0;
    machine = cleanRun >= c.requalifyEpisodes ? 'active' : 'requalifying';
  } else {
    machine = s >= watch ? 'watch' : 'active';
  }
  const registered = c.registered.some((r) => identityKey(r) === identityKey(identity));
  return {
    identity, s, machine, status: registered ? machine : 'unregistered', observations: (prev?.observations ?? 0) + 1, cleanRun, pauses,
    history: [...(prev?.history ?? []), { episodeId, z, identity }],
  };
};

/** The lineage computed from its history alone: the exact CUSUM and state machine over these returns, in order. */
const recompute = (history: LineageHealth['history'], c: HealthConfig): LineageHealth => {
  let l: LineageHealth | undefined;
  for (const h of history) l = advance(l, h.episodeId, h.identity, h.z, c);
  return l!;
};

/**
 * Applies one event. Pure and deterministic: the same events give the same states, observations and transitions,
 * whether in the worker or the backtest, and across a restart from any saved state (`healthStateToJson`).
 */
export const reduceHealth = (state: HealthState, e: HealthEvent, config: HealthConfig): HealthStep => {
  checkConfig(config);
  if (!Number.isSafeInteger(e.seq) || e.seq < 0) throw new RangeError(`health event: seq ${e.seq} must be a non-negative integer`);
  const fp = fingerprint(e);
  if (e.seq <= state.lastSeq) {
    const before = state.seen[e.seq];
    if (before === fp) return { state, observation: null, duplicate: true };
    throw new RangeError(before === undefined
      ? `health event seq ${e.seq} arrives after seq ${state.lastSeq}: events must come in durable-sequence order`
      : `health event seq ${e.seq} conflicts with the event already applied at that sequence`);
  }
  const base = { ...state, lastSeq: e.seq, seen: { ...state.seen, [e.seq]: fp } };
  if (e.type === 'late') {
    const done = state.finished[e.episodeId];
    if (!done) throw new RangeError(`late settlement for episode ${e.episodeId}, which is ${state.open[e.episodeId] ? 'still open: book it as a flow' : 'unknown'}`);
    if (done.lineage === null) throw new RangeError(`late settlement for episode ${e.episodeId}, which was dropped (nothing was sent): a cost is never hidden`);
    const prev = state.lineages[done.lineage]!;
    const netLamports = done.netLamports + e.lamports;
    const z = Number(netLamports) / Number(done.entryLamports);
    const j = prev.history.findIndex((h) => h.episodeId === e.episodeId);
    if (j < 0) throw new RangeError(`episode ${e.episodeId} is not in lineage ${done.lineage}'s history`);
    // The corrected return replaces the observed one and the lineage is recomputed from the start: exact, not ±Δz.
    const next = recompute(prev.history.map((h, k) => (k === j ? { ...h, z } : h)), config);
    return {
      state: { ...base, finished: { ...state.finished, [e.episodeId]: { ...done, netLamports } }, lineages: { ...state.lineages, [done.lineage]: next } },
      observation: {
        kind: 'correction', seq: e.seq, episodeId: e.episodeId, lineage: done.lineage, z, s: next.s, from: prev.status, to: next.status,
        previous: { s: prev.s, status: prev.status, pauses: prev.pauses, z: prev.history[j]!.z },
      },
      duplicate: false,
    };
  }
  const open = state.open[e.episodeId];
  if (e.type === 'entry') {
    if (open || state.finished[e.episodeId]) throw new RangeError(`episode ${e.episodeId} already has an entry`);
    if (e.entryLamports <= 0n) throw new RangeError(`episode ${e.episodeId}: entry size must be positive`);
    const ep: OpenEpisode = { identity: e.identity, entryLamports: e.entryLamports, netLamports: 0n, flows: 0, entrySeq: e.seq };
    return { state: { ...base, open: { ...state.open, [e.episodeId]: ep } }, observation: null, duplicate: false };
  }
  if (!open) throw new RangeError(`episode ${e.episodeId} is not open (${state.finished[e.episodeId] ? 'already final' : 'no entry'})`);
  if (e.type === 'flow') {
    const ep: OpenEpisode = { ...open, netLamports: open.netLamports + e.lamports, flows: open.flows + 1 };
    return { state: { ...base, open: { ...state.open, [e.episodeId]: ep } }, observation: null, duplicate: false };
  }
  const { [e.episodeId]: _done, ...rest } = state.open;
  if (e.outcome === 'dropped') {
    if (open.flows > 0) throw new RangeError(`episode ${e.episodeId} is dropped but carried ${open.flows} flows (net ${open.netLamports}): a cost is never hidden`);
    const dropped: FinishedEpisode = { lineage: null, entryLamports: open.entryLamports, netLamports: 0n };
    return { state: { ...base, open: rest, finished: { ...state.finished, [e.episodeId]: dropped } }, observation: null, duplicate: false };
  }
  // Not clipped: a blocked exit that also paid failed-attempt fees is below −100%, and counts as such.
  const z = Number(open.netLamports) / Number(open.entryLamports);
  const key = lineageKey(open.identity);
  const prev = state.lineages[key];
  const next = advance(prev, e.episodeId, open.identity, z, config);
  const done: FinishedEpisode = { lineage: key, entryLamports: open.entryLamports, netLamports: open.netLamports };
  return {
    state: { ...base, open: rest, finished: { ...state.finished, [e.episodeId]: done }, lineages: { ...state.lineages, [key]: next } },
    observation: { kind: 'episode', seq: e.seq, episodeId: e.episodeId, lineage: key, z, s: next.s, from: prev?.status ?? null, to: next.status },
    duplicate: false,
  };
};

/** Folds events in order; returns the final state and every observation. */
export const replayHealth = (events: readonly HealthEvent[], config: HealthConfig, from: HealthState = initialHealthState()): { state: HealthState; observations: HealthObservation[] } => {
  let state = from;
  const observations: HealthObservation[] = [];
  for (const e of events) {
    const step = reduceHealth(state, e, config);
    state = step.state;
    if (step.observation) observations.push(step.observation);
  }
  return { state, observations };
};

/** A durable form of the state (bigints as decimal strings), for saving at a write boundary. */
export const healthStateToJson = (s: HealthState): string =>
  JSON.stringify(s, (_k, v: unknown) => (typeof v === 'bigint' ? { $bigint: v.toString() } : v));

export const healthStateFromJson = (json: string): HealthState =>
  JSON.parse(json, (_k, v: unknown) =>
    v !== null && typeof v === 'object' && '$bigint' in v && typeof (v as { $bigint: unknown }).$bigint === 'string'
      ? BigInt((v as { $bigint: string }).$bigint) : v) as HealthState;

/**
 * Drops the fingerprints that can no longer matter (STRATEGY-HEALTH-OBS review): those older than every open
 * episode's entry. `finished` stays, one key per episode, so a final episode is never observed twice. After compaction
 * a re-delivery older than the kept fingerprints is refused as out of order rather than silently ignored.
 */
export const compactHealthState = (s: HealthState): HealthState => {
  const open = Object.values(s.open).map((e) => e.entrySeq);
  const from = open.length === 0 ? s.lastSeq + 1 : Math.min(...open);
  const seen: Record<number, string> = {};
  for (const [k, v] of Object.entries(s.seen)) if (Number(k) >= from) seen[Number(k)] = v;
  return { ...s, seen };
};

export * from './episodes.ts';
