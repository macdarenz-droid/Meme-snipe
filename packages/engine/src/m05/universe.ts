// A-M05-01 candidate state machine, prefilters, blacklist and cooldown (card Z09; ARCH 7.5, M05; C-15, C-44).
// Every transition is one edge of `ALLOWED` (ARCH 7.5), persisted with its reason through `CandidateStore` (M24: the
// candidate row by compare-and-set on its version, the `candidate_event` row and the outbox event in one transaction).
// A transition the store refuses (`E_STATE_CHANGED`, a write failure) is not applied in memory either.
//
// Phase 0: `screening_required = false` sends a candidate that passes the prefilter straight to `eligible` with reason
// `phase0_unscreened`; that setting is valid only while no strategy is enabled in any mode (C-44), so it never feeds
// a trade. Screening verdicts, signals and positions (Phase 1+) arrive through the handlers below (test doubles now).
//
// Builder readings (DECISIONS Z09-U1..U3, U7; ARCH 7.5 is silent on these):
// - `stale` → `evicted`: A-M05-02 evicts stale pools first, so a stale pool can be evicted;
// - a timed blacklist that expires re-runs the prefilter (to `prefiltered_out`, `screening` or `eligible`);
// - a screening backlog drop (logic 13) goes to `rejected` (reason `backlog`), retried after 6 h like a soft reject;
// - U7 (SPEC-A C-96): an `eligible` pool waiting for a slot whose current facts fail the prefilter goes to `prefiltered_out`.
//
// Round 2 (red team, rulings Z09-14..17, Z09-20, Z09-23):
// - A retry that fails stays in its state (no edge in ARCH 7.5 leads elsewhere, e.g. rejected → prefiltered_out) with a
//   new retry time PERSISTED (`CandidateStore.patch`, no transition) and one `m05.retry_failed` log per retry.
// - The blacklist lives in its store (M24 `blacklist`); an entry only lengthens (a permanent one is never shortened).
// - `evicted` returns to `eligible` only through the prefilter (a retry timer); only `eligible` pools are watched.
// - Each tick re-checks watched, stale and eligible pools on their CURRENT facts (M04's latest snapshot): a watched or
//   stale pool that fails goes to `rejected` (the ARCH re-screen edge, retried after 6 h), an eligible one (U7) to
//   `prefiltered_out`; no facts means no check.
// - Memory holds active candidates only (discovered, screening, eligible, watched, stale, signalled, in_position,
//   cooldown); the store is the source of truth for the rest, and timers come from `store.due` (O(active + due)).
//
// Round 3 (red team, rulings Z09-33, Z09-34, Z09-38):
// - Facts carry `observedAtMs`; facts older than `factsMaxAgeMs` never pass the prefilter (`facts_stale`). An eligible
//   pool with no fresh facts goes to `prefiltered_out` with a retry; watched and stale pools are re-checked only on
//   fresh facts, and their staleness is measured from the facts' `observedAtMs` (so a restart does not reset it).
// - A due retry whose facts are stale asks for a fresh read (`requestFacts`, M04 at P4 through M14, at most
//   `factsRefreshMax` pools per tick and `factsRefreshPerHour` in any 60 minutes) and looks again after
//   `FACTS_WAIT_MS`; no read by then is a failed retry. With the hour's reads used, the due scan runs at most once a
//   minute and asks for nothing (Z09-39). The window is kept per minute in the store, so restarts never reset it
//   (Z09-45), and asks are flushed at most once a minute: at most 60 `requestFacts` calls an hour (Z09-46).
// - Retired from retries, with zero reads (Z09-39): a pool that can never pass again (no migration time, or older than
//   the latest entry age of every limit set, or evicted and past its tail) and a pool after `retireAfterFailedRetries`
//   failed retries. Its retry timer is cleared; only a new discovery event brings it back.
// - A pool that fails only on age (too young, its migration time known) is retried when the youngest-passing set's
//   minimum age is reached, not after the 6 h prefilter retry (Z09-43), so a fresh PM-01 pool is judged at migration
//   + 20 min, inside its entry window. Such a wait is not a failed retry.
// - While M14 cannot serve P4 from the unmetered primary (`readsAvailable` false), fresh reads pause: nothing is asked,
//   a retry waiting for a read is not judged on stale facts, and none counts as failed (Z09-44).
// - A watched or stale pool that fails its re-check leaves with reasons starting `prefilter_recheck`, so the watchlist
//   gives it an eviction tail (Z09-33).
// - A blacklist write that fails is logged (`m05.blacklist_not_saved`) and never throws out of a handler (Z09-38).
import { createHash } from 'node:crypto';
import { canonicalJson, type CandidateState, type Lamports, type Pubkey, type Result, type UnixMs } from '@bot/types';

export const STATES: readonly CandidateState[] = ['discovered', 'prefiltered_out', 'screening', 'rejected', 'eligible', 'watched', 'signalled',
  'in_position', 'cooldown', 'blacklisted', 'stale', 'evicted'];

/** ARCH 7.5 edges (plus the readings in the header). `null` is "no candidate yet". */
export const ALLOWED: ReadonlyMap<CandidateState | null, ReadonlySet<CandidateState>> = new Map<CandidateState | null, ReadonlySet<CandidateState>>([
  [null, new Set<CandidateState>(['discovered'])],
  ['discovered', new Set<CandidateState>(['prefiltered_out', 'screening', 'eligible', 'blacklisted'])],
  ['prefiltered_out', new Set<CandidateState>(['screening', 'eligible', 'blacklisted'])],
  ['screening', new Set<CandidateState>(['rejected', 'eligible', 'blacklisted'])],
  ['rejected', new Set<CandidateState>(['screening', 'eligible', 'blacklisted'])],
  ['eligible', new Set<CandidateState>(['watched', 'prefiltered_out', 'blacklisted'])],
  ['watched', new Set<CandidateState>(['signalled', 'stale', 'rejected', 'evicted', 'blacklisted'])],
  ['signalled', new Set<CandidateState>(['watched', 'in_position', 'blacklisted'])],
  ['in_position', new Set<CandidateState>(['cooldown', 'blacklisted'])],
  ['cooldown', new Set<CandidateState>(['watched', 'evicted', 'blacklisted'])],
  ['stale', new Set<CandidateState>(['watched', 'evicted', 'blacklisted'])],
  ['evicted', new Set<CandidateState>(['eligible', 'blacklisted'])],
  ['blacklisted', new Set<CandidateState>(['prefiltered_out', 'screening', 'eligible'])],
]);
export const isAllowed = (from: CandidateState | null, to: CandidateState): boolean => ALLOWED.get(from)?.has(to) === true;

export interface CandidateRecord {
  candidateId: string; mint: Pubkey; poolId: Pubkey; venue: string; state: CandidateState;
  firstSeenAtMs: UnixMs; cooldownUntilMs: UnixMs | null; reasons: string[]; version: number;
  /** NEW (Z09-39): failed retries since the last transition (absent: 0). */
  failedRetries?: number;
  /** NEW (C-15): when the pool's migration landed (A-M03-02); the only age proof while D30 is parked. */
  migratedAtMs: UnixMs | null;
  /** NEW: the effective quote depth of the last prefilter (A-M05-02 orders by it). */
  depthLamports: Lamports;
  /** NEW: when the current state started and when a retry (prefilter, soft reject, blacklist expiry) is due. */
  sinceMs: UnixMs; retryAtMs: UnixMs | null;
}
export interface Transition { candidateId: string; poolId: Pubkey; mint: Pubkey; from: CandidateState | null; to: CandidateState; reason: string; atMs: UnixMs }

export interface CandidateStore {
  /** Active candidates (see ACTIVE), read once at start. */
  active(): CandidateRecord[];
  get(poolId: Pubkey): CandidateRecord | null;
  /** Candidates of a mint in any state (blacklist propagation). */
  byMint(mint: Pubkey): CandidateRecord[];
  /** Inactive candidates whose retry time is due, oldest first, at most `limit`. */
  due(nowMs: UnixMs, limit: number): CandidateRecord[];
  /** Persists `next` (insert when `prev` is null, else compare-and-set on `prev.version`) and the transition. */
  apply(prev: CandidateRecord | null, next: CandidateRecord, t: Transition): Result<void, { code: 'E_STATE_CHANGED' | 'E_WRITE' }>;
  /** Persists a change that is not a transition (retry time, reasons, migration time), by compare-and-set. */
  patch(prev: CandidateRecord, next: CandidateRecord): Result<void, { code: 'E_STATE_CHANGED' | 'E_WRITE' }>;
  /** `put` refuses with E_WRITE on a write failure and never throws (Z09-38). */
  blacklist: { get(mint: Pubkey): BlacklistEntry | null; put(e: BlacklistEntry): Result<void, { code: 'E_WRITE' }> };
  /** The fresh-read window (Z09-45): pools asked per minute start over the last hour, kept across restarts. */
  factsWindow: { load(): Array<[number, number]>; save(w: Array<[number, number]>): Result<void, { code: 'E_WRITE' }> };
}
/** `untilMs` null: permanent. */
export interface BlacklistEntry { mint: Pubkey; untilMs: UnixMs | null; reason: string }
/** States held in memory; the rest live in the store only. */
export const ACTIVE: ReadonlySet<CandidateState> = new Set<CandidateState>(['discovered', 'screening', 'eligible', 'watched', 'stale', 'signalled', 'in_position', 'cooldown']);
export const DUE_BATCH = 1_000;

/** What the prefilter reads: the venue, quote mint, per-side fee and effective depth of one snapshot, and when it was observed. */
export interface PrefilterFacts { venue: string; quoteMint: Pubkey; feeTotalBps: number; effectiveQuoteLamports: bigint; observedAtMs: UnixMs }
/** One strategy's universe limits (`strategy.<id>.universe.*`). */
export interface UniverseLimits { strategyId: string; feeCeilingBps: number; minDepthLamports: bigint; minAgeMs: number }
/** MR 30 bps / 300 SOL / 24 h; PM 125 bps / 85 SOL / 20 min after migration (A-M05-01 config). */
export const MR_LIMITS: UniverseLimits = { strategyId: 'mr-01', feeCeilingBps: 30, minDepthLamports: 300_000_000_000n, minAgeMs: 86_400_000 };
export const PM_LIMITS: UniverseLimits = { strategyId: 'pm-01', feeCeilingBps: 125, minDepthLamports: 85_000_000_000n, minAgeMs: 1_200_000 };
/**
 * The named limit sets the Phase 0 recording may use (ruling Z09-2): `universe.phase0_limit_set`, default `pm01`, never
 * implicit. MR-01's set stays here, unused while MR-01 is parked (C-76).
 */
export const LIMIT_SETS: Readonly<Record<'pm01' | 'mr01', readonly UniverseLimits[]>> = { pm01: [PM_LIMITS], mr01: [MR_LIMITS] };
export type LimitSetId = keyof typeof LIMIT_SETS;
/**
 * The latest pool age at which each strategy may enter (Z09-39; not part of the limit set's hash): PM-01's `pool_age`
 * ends at migration + 120 min (research/pm01/PREREG.md, ARCH 8.4); MR-01 has none. An unknown strategy has none.
 */
export const MAX_ENTRY_AGE_MS: Readonly<Record<string, number | null>> = { 'pm-01': 7_200_000, 'mr-01': null };
/** SHA-256 of the set's canonical JSON (bigints as decimal strings): the manifest names the set and this hash. */
export function limitSetHash(limits: readonly UniverseLimits[]): string {
  return createHash('sha256').update(canonicalJson(limits.map((l) => ({ ...l, minDepthLamports: l.minDepthLamports.toString() }))), 'utf8').digest('hex');
}

export interface UniverseConfig {
  screeningRequired: boolean;
  cooldownMs: number; prefilterRetryMs: number; staleToStateMs: number; screenBacklogMax: number;
  /** The named set (`universe.phase0_limit_set`) and its limits; `limits` must be that set's (checked). */
  limitSetId: string;
  limits: readonly UniverseLimits[];
  /** Strategies enabled in any mode (C-44: `screening_required = false` needs none). */
  enabledStrategies: number;
  /** `universe.facts_max_age_ms` (300,000; 30,000-3,600,000): older facts never pass the prefilter (Z09-34). */
  factsMaxAgeMs: number;
  /** `universe.facts_refresh_max` (30; 0-90): pools per tick whose facts a due retry may ask to be read again (Z09-34). */
  factsRefreshMax: number;
  /** `universe.facts_refresh_per_hour` (300; 0-3,600): pools read again in any 60 minutes, on M14's P4 budget (Z09-39). */
  factsRefreshPerHour: number;
  /** `universe.retire_after_failed_retries` (3; 1-20): failed retries after which a pool is retired (Z09-39). */
  retireAfterFailedRetries: number;
  /** Venues the prefilter allows and that are specified (PumpSwap; Raydium after A-M01-06). */
  venues: readonly string[];
}
export const UNIVERSE_DEFAULTS: UniverseConfig = {
  screeningRequired: true, cooldownMs: 1_800_000, prefilterRetryMs: 21_600_000, staleToStateMs: 30_000, screenBacklogMax: 100,
  limitSetId: 'pm01', limits: LIMIT_SETS.pm01, enabledStrategies: 0, venues: ['pumpswap'], factsMaxAgeMs: 300_000, factsRefreshMax: 30,
  factsRefreshPerHour: 300, retireAfterFailedRetries: 3,
};
const HOUR_MS = 3_600_000;
/** How long a due retry waits for the fresh read it asked for before it counts as failed (Z09-34). */
export const FACTS_WAIT_MS = 60_000;
/** The first reason of a retry waiting for its fresh read. */
const FACTS_REQUESTED = 'facts_requested';
export const SOFT_RETRY_MS = 21_600_000;
export const HONEYPOT_BLACKLIST_MS = 86_400_000;

export function checkUniverseConfig(c: UniverseConfig): string | null {
  if (!c.screeningRequired && c.enabledStrategies > 0) return 'universe.screening_required = false is allowed only while no strategy is enabled (C-44)';
  const range = (v: number, lo: number, hi: number): boolean => Number.isInteger(v) && v >= lo && v <= hi;
  if (!range(c.cooldownMs, 0, 86_400_000)) return 'universe.cooldown_ms must be 0-86,400,000';
  if (!range(c.prefilterRetryMs, 600_000, 86_400_000)) return 'universe.prefilter_retry_ms must be 600,000-86,400,000';
  if (!range(c.staleToStateMs, 5_000, 600_000)) return 'universe.stale_to_state_ms must be 5,000-600,000';
  if (!range(c.screenBacklogMax, 10, 1_000)) return 'universe.screen_backlog_max must be 10-1,000';
  if (!range(c.factsMaxAgeMs, 30_000, 3_600_000)) return 'universe.facts_max_age_ms must be 30,000-3,600,000';
  if (!range(c.factsRefreshMax, 0, 90)) return 'universe.facts_refresh_max must be 0-90';
  if (!range(c.factsRefreshPerHour, 0, 3_600)) return 'universe.facts_refresh_per_hour must be 0-3,600';
  if (!range(c.retireAfterFailedRetries, 1, 20)) return 'universe.retire_after_failed_retries must be 1-20';
  if (c.limits.length === 0) return 'at least one strategy universe limit set is needed';
  const named = (LIMIT_SETS as Readonly<Record<string, readonly UniverseLimits[]>>)[c.limitSetId];
  if (named === undefined || limitSetHash(named) !== limitSetHash(c.limits)) return `universe.phase0_limit_set "${c.limitSetId}" must name the limits in use (Z09-2)`;
  for (const l of c.limits) if (!range(l.feeCeilingBps, 0, 10_000) || l.minDepthLamports < 0n || !range(l.minAgeMs, 0, 30 * 86_400_000)) return `bad universe limits for ${l.strategyId}`;
  return null;
}

export type TerminalKind = 'closed' | 'open_failed' | 'written_off';
export interface UniverseDeps {
  config: UniverseConfig;
  store: CandidateStore;
  nowMs(): UnixMs;
  newId(): string;
  wsolMint: Pubkey;
  /** The latest prefilter facts for a pool (M04's latest snapshot, or the verification read), or null. */
  facts(poolId: Pubkey): PrefilterFacts | null;
  /**
   * Asks for one fresh read of these slotless pools (M04 at P4 through M14, one batch); the facts arrive later through
   * `facts`. Absent: a retry on stale facts simply fails (Z09-34).
   */
  requestFacts?(poolIds: readonly Pubkey[]): void;
  /** False while M14 serves P4 from a metered backup only (Z10 wires it to the primary's health): reads pause (Z09-44). */
  readsAvailable?(): boolean;
  /** M22 lists (read): mints that never become candidates for new entries. */
  lists: { isWrittenOff(mint: Pubkey): boolean; isUnsolicited(mint: Pubkey): boolean };
  publish(t: Transition): void;
  log: { event(level: 'debug' | 'info' | 'warn', code: string, fields: Readonly<Record<string, unknown>>): void };
}

export interface Universe {
  onDiscovery(e: { poolId: Pubkey; baseMint: Pubkey; quoteMint: Pubkey; venue: string; verifiedOnChain: boolean; migratedAtMs: UnixMs | null }, facts?: PrefilterFacts | null): void;
  blacklist(mint: Pubkey, reason: string, untilMs: UnixMs | null): void;
  candidate(poolId: Pubkey): CandidateRecord | null;
  /** Active candidates (memory). */
  candidates(): CandidateRecord[];
  /** Phase 1+: M06 verdicts (soft reject, hard fail kinds, eligible). */
  onScreen(poolId: Pubkey, v: { verdict: 'eligible' } | { verdict: 'rejected' } | { verdict: 'hard_fail'; kind: 'authority' | 'extension' | 'honeypot' | 'lp' }): void;
  /** A-M05-02 offers a slot: true when an eligible pool passing the prefilter on its current facts became watched. */
  onWatched(poolId: Pubkey): boolean;
  /** A-M05-02 evicted the pool; `tailUntilMs` (its eviction tail end) is kept in the transition's reason. */
  onEvicted(poolId: Pubkey, reason: string, tailUntilMs?: UnixMs | null): void;
  onSignal(poolId: Pubkey): void;
  onRiskDecision(poolId: Pubkey, accepted: boolean): void;
  onPositionTerminal(poolId: Pubkey, kind: TerminalKind): void;
  /** M04 `pool.stale` / `pool.fresh`. */
  onStale(poolId: Pubkey, sinceMs: UnixMs): void;
  onFresh(poolId: Pubkey): void;
  /** M06 `token.authority_changed`, A-M02-05 `decoder.unknown_layout`, A-M01-04 `venue.pool_quarantined`. */
  onAuthorityChanged(mint: Pubkey): void;
  onUnknownLayout(poolId: Pubkey): void;
  onQuarantine(poolId: Pubkey): void;
  /** Timers (stale, cooldown, current-facts re-check) over active pools, then the store's due retries. */
  tick(): void;
}

const SOL = 1_000_000_000n;
/** The eviction reason carries the tail end (manifest, ruling Z09-18/22): `budget;tail_until=<ms>`. */
export const tailReason = (reason: string, tailUntilMs: number | null | undefined): string => (tailUntilMs == null ? reason : `${reason};tail_until=${tailUntilMs}`);

export function createUniverse(deps: UniverseDeps): Universe {
  const problem = checkUniverseConfig(deps.config);
  if (problem !== null) throw { code: 'E_CONFIG', message: problem };
  const cfg = deps.config;
  const active = new Map<Pubkey, CandidateRecord>();
  /** M04 `pool.stale` times (cleared by `pool.fresh`); with the facts' own age, the earlier decides (Z09-34). */
  const staleSince = new Map<Pubkey, number>();
  const fresh = (f: PrefilterFacts | null, now: number): f is PrefilterFacts => f !== null && now - f.observedAtMs <= cfg.factsMaxAgeMs;
  for (const r of deps.store.active()) if (ACTIVE.has(r.state)) active.set(r.poolId, r);

  const get = (poolId: Pubkey): CandidateRecord | null => active.get(poolId) ?? deps.store.get(poolId);
  const remember = (r: CandidateRecord): void => {
    if (ACTIVE.has(r.state)) active.set(r.poolId, r);
    else { active.delete(r.poolId); staleSince.delete(r.poolId); }
  };

  /** Applies one transition; false (and nothing changes) when the edge is undefined or the store refuses it. */
  function move(r: CandidateRecord | null, base: Omit<CandidateRecord, 'state' | 'version' | 'sinceMs' | 'retryAtMs' | 'reasons'> & Partial<CandidateRecord>, to: CandidateState, reason: string, o: { retryAtMs?: UnixMs | null; reasons?: string[] } = {}): boolean {
    const from = r?.state ?? null;
    if (!isAllowed(from, to)) {
      deps.log.event('warn', 'm05.transition_refused', { from: from ?? 'none', to, reason });
      return false;
    }
    const now = deps.nowMs();
    const next: CandidateRecord = {
      ...(r ?? {}), ...base, state: to, reasons: o.reasons ?? [reason], version: r === null ? 1 : r.version + 1, sinceMs: now,
      retryAtMs: o.retryAtMs ?? null, cooldownUntilMs: to === 'cooldown' ? ((now + cfg.cooldownMs) as UnixMs) : null, failedRetries: 0,
    } as CandidateRecord;
    // The event's reason carries the detail (the limits a pass met), so a manifest rebuilt from M24 shows it too.
    const t: Transition = { candidateId: next.candidateId, poolId: next.poolId, mint: next.mint, from, to, reason: o.reasons === undefined ? reason : o.reasons.join(';'), atMs: now };
    const w = deps.store.apply(r, next, t);
    if (!w.ok) {
      deps.log.event('warn', 'm05.transition_not_applied', { from: from ?? 'none', to, error_code: w.error.code });
      return false;
    }
    remember(next);
    deps.publish(t);
    deps.log.event(to === 'blacklisted' ? 'info' : 'debug', to === 'blacklisted' ? 'm05.blacklisted' : 'm05.transition', { pool: next.poolId, from: from ?? 'none', to, reason });
    return true;
  }
  const to = (r: CandidateRecord, state: CandidateState, reason: string, o: { retryAtMs?: UnixMs | null; reasons?: string[] } = {}): boolean => move(r, r, state, reason, o);

  /** A change that is not a transition, persisted (retry time, reasons, migration time). */
  function patch(r: CandidateRecord, change: Partial<CandidateRecord>): CandidateRecord {
    const next = { ...r, ...change, version: r.version + 1 };
    const w = deps.store.patch(r, next);
    if (!w.ok) { deps.log.event('warn', 'm05.patch_not_applied', { pool: r.poolId, error_code: w.error.code }); return r; }
    if (ACTIVE.has(next.state)) active.set(next.poolId, next);
    return next;
  }

  function isBlacklisted(mint: Pubkey): BlacklistEntry | null {
    const b = deps.store.blacklist.get(mint);
    if (b === null) return null;
    if (b.untilMs !== null && b.untilMs <= deps.nowMs()) return null;
    return b;
  }

  /** Logic 2: the cheap prefilter on one snapshot; the reasons of a pass describe which limits it met (manifest). */
  function prefilter(r: CandidateRecord, f: PrefilterFacts | null): { pass: boolean; reasons: string[]; depth: Lamports; ageDueAtMs?: UnixMs } {
    if (f === null) return { pass: false, reasons: ['no_snapshot'], depth: r.depthLamports };
    if (!fresh(f, deps.nowMs())) return { pass: false, reasons: ['facts_stale'], depth: r.depthLamports };
    const depth = (f.effectiveQuoteLamports > 0n ? f.effectiveQuoteLamports : 0n) as Lamports;
    const fail: string[] = [];
    if (!cfg.venues.includes(f.venue)) fail.push(`venue=${f.venue}`);
    if (f.quoteMint !== deps.wsolMint) fail.push('quote_not_wsol');
    if (isBlacklisted(r.mint) !== null) fail.push('blacklisted');
    const ageMs = r.migratedAtMs === null ? null : deps.nowMs() - r.migratedAtMs;
    const sets = cfg.limits.map((l) => {
      const why: string[] = [];
      if (f.feeTotalBps > l.feeCeilingBps) why.push(`fee=${f.feeTotalBps}bps>${l.feeCeilingBps}`);
      if (depth < l.minDepthLamports) why.push(`depth=${depth / SOL}SOL<${l.minDepthLamports / SOL}`);
      if (ageMs === null) why.push('age=unknown');
      else if (ageMs < l.minAgeMs) why.push(`age<${l.minAgeMs}ms`);
      return { l, why };
    });
    const ok = sets.find((x) => x.why.length === 0);
    if (fail.length === 0 && ok !== undefined) {
      return { pass: true, depth, reasons: [`set=${ok.l.strategyId};fee=${f.feeTotalBps}bps;depth=${depth / SOL}SOL;age>=${ok.l.minAgeMs}ms`] };
    }
    const reasons = [...fail, ...sets.flatMap((x) => x.why.map((w) => `${x.l.strategyId}:${w}`))];
    // Z09-43: only too young for some set: retry when the first of those sets' minimum age is reached.
    const ageOnly = fail.length === 0 && r.migratedAtMs !== null ? sets.filter((x) => x.why.length === 1 && (x.why[0] as string).startsWith('age<')) : [];
    if (ageOnly.length > 0) return { pass: false, depth, reasons, ageDueAtMs: Math.min(...ageOnly.map((x) => (r.migratedAtMs as number) + x.l.minAgeMs)) as UnixMs };
    return { pass: false, depth, reasons };
  }

  /** A retry that failed: it stays where it is with its next retry persisted, logged once (Z09-14, Z09-20). */
  function retryLater(r: CandidateRecord, reasons: string[], ageDueAtMs?: UnixMs): void {
    // An age wait (Z09-43) is not a failed retry.
    const next = patch(r, ageDueAtMs !== undefined ? { retryAtMs: ageDueAtMs, reasons }
      : { retryAtMs: (deps.nowMs() + cfg.prefilterRetryMs) as UnixMs, reasons, failedRetries: (r.failedRetries ?? 0) + 1 });
    if (next !== r) deps.log.event('info', 'm05.retry_failed', { pool: r.poolId, state: r.state, reason: reasons.join(';').slice(0, 200) });
  }

  /** Older than the latest entry age of every limit set: no strategy can ever enter it (Z09-39). */
  function pastEntryAge(r: CandidateRecord, now: number): boolean {
    const maxAges = cfg.limits.map((l) => MAX_ENTRY_AGE_MS[l.strategyId] ?? null);
    return r.migratedAtMs !== null && maxAges.every((m) => m !== null) && now - r.migratedAtMs >= Math.max(...(maxAges as number[]));
  }
  /** Why a due retry can never pass again or has failed too often, or null (Z09-39). */
  function retireReason(r: CandidateRecord, now: number): string | null {
    if ((r.failedRetries ?? 0) >= cfg.retireAfterFailedRetries) return 'failed_retries';
    if (r.migratedAtMs === null) return 'age_unknown';
    if (pastEntryAge(r, now)) return 'past_entry_age';
    if (r.state === 'evicted') {
      const tail = r.reasons.map((x) => /;tail_until=(\d+)/.exec(x)?.[1]).find((x) => x !== undefined);
      if (tail === undefined || now > Number(tail)) return 'past_tail';
    }
    return null;
  }
  const RETRYABLE = new Set<CandidateState>(['prefiltered_out', 'rejected', 'evicted']);
  /** A retired pool: no retry timer, so `store.due` never returns it again (zero reads). */
  function retire(r: CandidateRecord, why: string): void {
    const next = patch(r, { retryAtMs: null, reasons: [`retired=${why}`, ...r.reasons.filter((x) => x !== FACTS_REQUESTED)] });
    if (next !== r) deps.log.event('info', 'm05.retired', { pool: r.poolId, reason: why });
  }
  /**
   * Pools asked to be read again, per minute start, over the last hour (Z09-45): loaded from the store, so a restart or
   * a crash loop never resets it. At most one flush a minute (Z09-46), so at most 60 `requestFacts` calls an hour.
   */
  const MINUTE_MS = 60_000;
  const window = new Map<number, number>();
  for (const [m, n] of deps.store.factsWindow.load()) if (Number.isSafeInteger(m) && Number.isSafeInteger(n) && n > 0) window.set(m, n);
  let lastFullScanMs = -Infinity;

  /** From `discovered`, a due retry (`prefiltered_out`, `rejected`, `evicted`) or an expired blacklist: prefilter, then screen or Phase 0. */
  function evaluate(r: CandidateRecord, f: PrefilterFacts | null = deps.facts(r.poolId)): void {
    const p = prefilter(r, f);
    const now = deps.nowMs();
    if (!p.pass) {
      // Only `discovered` and an expired blacklist have a prefilter-failure edge; every other state waits for its next retry.
      if (r.state === 'discovered' || r.state === 'blacklisted') move(r, { ...r, depthLamports: p.depth }, 'prefiltered_out', 'prefilter', { reasons: p.reasons, retryAtMs: p.ageDueAtMs ?? ((now + cfg.prefilterRetryMs) as UnixMs) });
      else retryLater(r, p.reasons, p.ageDueAtMs);
      return;
    }
    if (r.state === 'evicted') { move(r, { ...r, depthLamports: p.depth }, 'eligible', 'requeued', { reasons: [...p.reasons, 'requeued'] }); return; }
    if (cfg.screeningRequired) {
      move(r, { ...r, depthLamports: p.depth }, 'screening', 'prefilter_pass', { reasons: p.reasons });
      const backlog = [...active.values()].filter((c) => c.state === 'screening').sort((a, b) => a.sinceMs - b.sinceMs || a.firstSeenAtMs - b.firstSeenAtMs);
      for (const c of backlog.slice(0, Math.max(0, backlog.length - cfg.screenBacklogMax))) to(c, 'rejected', 'backlog', { retryAtMs: (now + SOFT_RETRY_MS) as UnixMs });
      return;
    }
    move(r, { ...r, depthLamports: p.depth }, 'eligible', 'phase0_unscreened', { reasons: [...p.reasons, 'phase0_unscreened'] });
  }

  /** Blacklists one candidate; when it already is, a longer or permanent entry is persisted on it too (Z09-15). */
  function blacklistOne(r: CandidateRecord, b: BlacklistEntry): void {
    if (r.state !== 'blacklisted') { to(r, 'blacklisted', b.reason, { retryAtMs: b.untilMs }); return; }
    if (r.retryAtMs !== null && (b.untilMs === null || b.untilMs > r.retryAtMs)) patch(r, { retryAtMs: b.untilMs, reasons: [b.reason] });
  }

  /** Timers of one active pool: the current-facts re-check, staleness, the cooldown end. */
  function checkActive(cur: CandidateRecord, now: number): void {
      if (cur.state === 'watched' || cur.state === 'stale' || cur.state === 'eligible') {
        // Z09-17: the current facts decide; a pool below its set's limits leaves through the prefilter rules. Z09-34:
        // an eligible pool needs fresh facts to stay; a watched or stale one is re-checked only on fresh facts.
        // Z09-43: an eligible pool no strategy can enter any more leaves the queue, retired (no retry, no read).
        if (cur.state === 'eligible' && pastEntryAge(cur, now)) {
          move(cur, cur, 'prefiltered_out', 'past_entry_age', { reasons: ['retired=past_entry_age'], retryAtMs: null });
          return;
        }
        const f = deps.facts(cur.poolId);
        if (cur.state === 'eligible' || fresh(f, now)) {
          const p = prefilter(cur, f);
          if (!p.pass) {
            if (cur.state === 'eligible') move(cur, { ...cur, depthLamports: p.depth }, 'prefiltered_out', 'prefilter_recheck', { reasons: p.reasons, retryAtMs: (now + cfg.prefilterRetryMs) as UnixMs });
            else to(cur, 'rejected', 'prefilter_recheck', { reasons: ['prefilter_recheck', ...p.reasons], retryAtMs: (now + SOFT_RETRY_MS) as UnixMs });
            return;
          }
          if (p.depth !== cur.depthLamports) active.set(cur.poolId, { ...cur, depthLamports: p.depth });   // ranking only, not persisted
        }
        // Staleness from the data's own time (Z09-34, so a restart does not reset it) or M04's stale event, the earlier.
        const s = Math.min(f?.observedAtMs ?? Infinity, staleSince.get(cur.poolId) ?? Infinity);
        const isStale = now - s > cfg.staleToStateMs;
        if (cur.state === 'watched' && isStale) to(active.get(cur.poolId) as CandidateRecord, 'stale', 'stale_data');
        else if (cur.state === 'stale' && f !== null && !isStale) to(cur, 'watched', 'fresh');   // fresh data, no stale event
      } else if (cur.state === 'cooldown' && cur.cooldownUntilMs !== null && cur.cooldownUntilMs <= now) {
        const b = isBlacklisted(cur.mint);
        if (b !== null) { blacklistOne(cur, b); return; }
        const p = prefilter(cur, deps.facts(cur.poolId));
        to(cur, p.pass ? 'watched' : 'evicted', p.pass ? 'cooldown_done' : 'cooldown_rescreen_failed', { retryAtMs: p.pass ? null : ((now + cfg.prefilterRetryMs) as UnixMs) });
      }
  }

  const api: Universe = {
    onDiscovery(e, facts) {
      if (!e.verifiedOnChain) return;                                                // logic 1: unverified discoveries are ignored
      const existing = get(e.poolId);
      if (existing !== null) {
        if (existing.mint !== e.baseMint) return;
        // Z09-13: a later chain sighting supplies the migration time (the only age proof, C-15).
        let r = existing;
        if (e.migratedAtMs !== null && r.migratedAtMs !== e.migratedAtMs) r = patch(r, { migratedAtMs: e.migratedAtMs });
        // Z09-39: a retired pool comes back only here, with its failed retries cleared.
        const retired = RETRYABLE.has(r.state) && r.retryAtMs === null;
        if (retired) r = patch(r, { failedRetries: 0, reasons: r.reasons.filter((x) => !x.startsWith('retired=')) });
        if (r.state === 'prefiltered_out' || retired) evaluate(r, facts ?? deps.facts(e.poolId));   // re-evaluated on the next discovery
        return;
      }
      if (deps.lists.isWrittenOff(e.baseMint) || deps.lists.isUnsolicited(e.baseMint)) {
        const off = deps.lists.isWrittenOff(e.baseMint);
        deps.log.event('info', 'm05.not_a_candidate', { pool: e.poolId, reason: off ? 'written_off' : 'unsolicited' });
        if (off) api.blacklist(e.baseMint, 'written_off', null);
        return;
      }
      const now = deps.nowMs();
      const base = { candidateId: deps.newId(), mint: e.baseMint, poolId: e.poolId, venue: e.venue, firstSeenAtMs: now, cooldownUntilMs: null,
        migratedAtMs: e.migratedAtMs, depthLamports: 0n as Lamports };
      if (!move(null, base, 'discovered', 'discovery')) return;
      const r = get(e.poolId) as CandidateRecord;
      const b = isBlacklisted(e.baseMint);
      if (b !== null) { blacklistOne(r, b); return; }
      evaluate(r, facts ?? deps.facts(e.poolId));
    },
    blacklist(mint, reason, untilMs) {
      const cur = deps.store.blacklist.get(mint);
      // An entry only lengthens: permanent stays permanent, and a shorter expiry never replaces a longer one.
      const longer = cur === null || cur.untilMs !== null && (untilMs === null || untilMs > cur.untilMs) || (cur.untilMs !== null && cur.untilMs <= deps.nowMs());
      const entry: BlacklistEntry = longer ? { mint, untilMs, reason } : cur;
      if (longer) {
        // Z09-38: a failed write is logged and the candidates are still blacklisted (their rows carry the expiry).
        let w: Result<void, { code: 'E_WRITE' }>;
        try { w = deps.store.blacklist.put(entry); } catch { w = { ok: false, error: { code: 'E_WRITE' } }; }
        if (!w.ok) deps.log.event('warn', 'm05.blacklist_not_saved', { mint, error_code: w.error.code });
      }
      for (const r of deps.store.byMint(mint)) blacklistOne(active.get(r.poolId) ?? r, entry);
    },
    candidate: get,
    candidates: () => [...active.values()],
    onScreen(poolId, v) {
      const r = get(poolId);
      if (r === null || (r.state !== 'screening' && r.state !== 'watched')) return;
      const now = deps.nowMs();
      if (v.verdict === 'eligible') { if (r.state === 'screening') to(r, 'eligible', 'screen=eligible'); return; }
      if (v.verdict === 'rejected') { to(r, 'rejected', 'screen_soft', { retryAtMs: (now + SOFT_RETRY_MS) as UnixMs }); return; }
      api.blacklist(r.mint, `screen_${v.kind}`, v.kind === 'honeypot' ? ((now + HONEYPOT_BLACKLIST_MS) as UnixMs) : null);
    },
    onWatched(poolId) {
      const r = active.get(poolId);
      if (r === undefined || r.state !== 'eligible') return false;
      // Z09-34: no fresh facts, no slot (the pool waits for its retry in prefiltered_out).
      const p = prefilter(r, deps.facts(poolId));
      if (!p.pass) { move(r, { ...r, depthLamports: p.depth }, 'prefiltered_out', 'prefilter_recheck', { reasons: p.reasons, retryAtMs: (deps.nowMs() + cfg.prefilterRetryMs) as UnixMs }); return false; }
      return to(r, 'watched', 'slot');
    },
    onEvicted(poolId, reason, tailUntilMs) {
      const r = active.get(poolId);
      if (r !== undefined && (r.state === 'watched' || r.state === 'stale')) to(r, 'evicted', tailReason(reason, tailUntilMs), { retryAtMs: (deps.nowMs() + cfg.prefilterRetryMs) as UnixMs });
    },
    onSignal(poolId) {
      const r = active.get(poolId);
      if (r?.state === 'watched') to(r, 'signalled', 'proposal');
    },
    onRiskDecision(poolId, accepted) {
      const r = active.get(poolId);
      if (r?.state === 'signalled') to(r, accepted ? 'in_position' : 'watched', accepted ? 'risk_accept' : 'risk_reject');
    },
    onPositionTerminal(poolId, kind) {
      const r = get(poolId);
      if (r === null) { deps.log.event('warn', 'm05.unknown_candidate', { pool: poolId, event: kind }); return; }   // edge case 2
      if (r.state !== 'in_position') return;
      if (!to(r, 'cooldown', `position_${kind}`)) return;
      if (kind === 'written_off') api.blacklist(r.mint, 'written_off', null);       // CA-15
    },
    onStale(poolId, sinceMs) {
      const r = active.get(poolId);
      if (r === undefined) return;
      if (!staleSince.has(poolId)) staleSince.set(poolId, sinceMs);
      checkActive(r, deps.nowMs());                                                  // this pool only (Z09-39: no due scan)
    },
    onFresh(poolId) {
      staleSince.delete(poolId);
      const r = active.get(poolId);
      if (r?.state === 'stale') to(r, 'watched', 'fresh');
    },
    onAuthorityChanged(mint) { api.blacklist(mint, 'authority_changed', null); },
    onUnknownLayout(poolId) {
      const r = get(poolId);
      if (r !== null) blacklistOne(r, { mint: r.mint, untilMs: null, reason: 'unknown_layout' });
    },
    onQuarantine(poolId) {
      const r = get(poolId);
      if (r !== null) blacklistOne(r, { mint: r.mint, untilMs: null, reason: 'pool_quarantined' });
    },
    tick() {
      const now = deps.nowMs();
      for (const r of [...active.values()]) {
        const cur = active.get(r.poolId);
        if (cur !== undefined) checkActive(cur, now);
      }
      // Z09-39/45/46: the reads left in this hour (a minute's asks count until that whole minute is an hour old), and one
      // flush a minute at most; with no room the scan runs at most once a minute and asks for nothing.
      const minute = Math.floor(now / MINUTE_MS) * MINUTE_MS;
      let used = 0;
      for (const [m, n] of [...window]) {
        if (m + MINUTE_MS <= now - HOUR_MS) window.delete(m);
        else used += n;
      }
      const paused = deps.readsAvailable !== undefined && !deps.readsAvailable();
      const room = deps.requestFacts === undefined || paused || window.has(minute) ? 0 : Math.min(cfg.factsRefreshMax, cfg.factsRefreshPerHour - used);
      if (deps.requestFacts !== undefined && room <= 0) {
        if (now - lastFullScanMs < FACTS_WAIT_MS) return;
        lastFullScanMs = now;
      }
      const ask: CandidateRecord[] = [];
      for (const r of deps.store.due(now, DUE_BATCH)) {
        if (r.retryAtMs === null || r.retryAtMs > now) continue;
        if (r.state === 'blacklisted') {
          const b = isBlacklisted(r.mint);
          if (b !== null) { patch(r, { retryAtMs: b.untilMs }); continue; }        // a longer entry since: wait for it
        } else if (!RETRYABLE.has(r.state)) continue;
        else {
          const why = retireReason(r, now);
          if (why !== null) { retire(r, why); continue; }
        }
        const f = deps.facts(r.poolId);
        // Z09-34: a slotless pool's facts are old; ask for one fresh read (capped per tick and per hour), then look again.
        if (!fresh(f, now) && deps.requestFacts !== undefined && r.reasons[0] === FACTS_REQUESTED && paused) {
          patch(r, { reasons: r.reasons.slice(1) });                                // its read could not be served: ask again later (Z09-44)
          continue;
        }
        if (!fresh(f, now) && deps.requestFacts !== undefined && r.reasons[0] !== FACTS_REQUESTED) {
          if (ask.length >= room) { if (room > 0) break; continue; }                 // still due: a later minute asks
          ask.push(r);
          continue;
        }
        const back = r.reasons[0] === FACTS_REQUESTED ? { ...r, reasons: r.reasons.slice(1) } : r;
        evaluate(back, f);
      }
      if (ask.length === 0) return;
      // The window is saved before anything is asked: a failed save asks nothing (fail closed on the budget).
      window.set(minute, ask.length);
      const saved = deps.store.factsWindow.save([...window]);
      if (!saved.ok) {
        deps.log.event('warn', 'm05.facts_window_not_saved', { error_code: saved.error.code, pools: ask.length });
        return;
      }
      const ids: Pubkey[] = [];
      for (const r of ask) {
        const next = patch(r, { retryAtMs: (now + FACTS_WAIT_MS) as UnixMs, reasons: [FACTS_REQUESTED, ...r.reasons] });
        if (next !== r) ids.push(r.poolId);
      }
      if (ids.length > 0) deps.requestFacts?.(ids);
    },
  };
  return api;
}
