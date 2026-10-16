// A-M05-02 watchlist allocation, pinning, eviction and the eviction tail (card Z09; ARCH M05, CA-25). Keeps the
// polled set inside M04's budget: `max_watched` candidate slots (POLICY 30, never above floor(max_accounts_per_call / 3)),
// pools with open positions always watched at `position` priority and never evicted, free slots filled from eligible
// candidates by effective depth (then first seen), stale pools evicted first and then the shallowest. An evicted pool
// keeps being polled at 0.1 Hz (`tail`) for the longest holding period of any enabled strategy plus 1 h, so replays
// are not survivorship-biased; at most `tail_max_pools`, the oldest ending first (`tail_capacity`, in the manifest).
// In `degraded_reads` only pinned pools stay watched and tail polling stops (ARCH 11.2).
//
// Z09-33 (red team RT-8): a pool never leaves a slot without a tail. One that the universe moved out of every
// slot-holding state (a failed re-check to `rejected`, a blacklist, a failed cooldown re-screen to `evicted`) is
// unwatched, put on the eviction tail and recorded (`onEviction`, reason `prefilter_recheck`, `rescreen_failed`,
// `blacklisted` or `cooldown_rescreen_failed`), so a rug's aftermath is recorded (CA-25).
//
// Z09-41 (red team RT-12): eviction tails survive a restart. At start the watchlist restores each tail still running
// from the persisted eviction records (`restoreTails`) and polling resumes; a tail it cannot restore (M04 refuses it,
// the cap is full, or reads are degraded) is recorded as cut (`tail_restart_cut`), so the manifest ends that pool's
// eligible span there.
//
// Z09-53 (red team RT-15): pools in an enabled strategy's entry window come first. A watched or stale pool past every
// set's latest entry age (`universe.pastEntryAge`) that is not pinned is evicted with its tail (reason
// `past_entry_age`) whenever an in-window eligible pool waits for a slot; it keeps its slot only while none waits, so
// recording goes on when slots are free. Free slots go to in-window pools first.
import type { Pubkey, UnixMs } from '@bot/types';
import type { CandidateRecord } from './universe.ts';

export interface WatchlistConfig {
  /** `universe.max_watched` (30; 1 to the derived maximum). */
  maxWatched: number;
  /** M04 `pool_tracker.max_accounts_per_call` (90): the derived maximum is floor(it / 3). */
  maxAccountsPerCall: number;
  /** `universe.tail_max_pools` (30; 0-60). */
  tailMaxPools: number;
  /** `universe.tail_extra_ms` (3,600,000; at least 3,600,000). */
  tailExtraMs: number;
}
export const WATCHLIST_DEFAULTS: WatchlistConfig = { maxWatched: 30, maxAccountsPerCall: 90, tailMaxPools: 30, tailExtraMs: 3_600_000 };

export function checkWatchlistConfig(c: WatchlistConfig): string | null {
  const derived = Math.floor(c.maxAccountsPerCall / 3);
  if (!Number.isInteger(c.maxWatched) || c.maxWatched < 1 || c.maxWatched > derived) return `universe.max_watched must be 1-${derived} (floor(max_accounts_per_call / 3))`;
  if (!Number.isInteger(c.tailMaxPools) || c.tailMaxPools < 0 || c.tailMaxPools > 60) return 'universe.tail_max_pools must be 0-60';
  if (!Number.isInteger(c.tailExtraMs) || c.tailExtraMs < 3_600_000) return 'universe.tail_extra_ms must be at least 3,600,000';
  return null;
}

export interface WatchlistDeps {
  config: WatchlistConfig;
  nowMs(): UnixMs;
  /** The longest holding period of any enabled strategy (0 with none enabled). */
  maxHoldMs(): number;
  /** M14 `mode()`. */
  mode(): 'normal' | 'degraded_reads';
  /** M04. */
  /** M04: `watch` re-classes a pool already watched in place (no unwatch); false when its class cap refuses it. */
  tracker: { watch(poolId: Pubkey, cls: 'position' | 'candidate' | 'tail'): boolean | void; unwatch(poolId: Pubkey): void };
  /** M05 state machine: a slot offered (true when the pool became watched) or an eviction with its tail end. */
  universe: {
    onWatched(poolId: Pubkey): boolean; onEvicted(poolId: Pubkey, reason: string, tailUntilMs?: UnixMs | null): void;
    /** Any candidate, in any state (the store's for inactive ones): why a pool left its slot (Z09-33). */
    candidate(poolId: Pubkey): CandidateRecord | null;
    /** No enabled strategy can enter it any more (Z09-53). */
    pastEntryAge(poolId: Pubkey): boolean;
  };
  /** M04's latest effective depth of a pool (null: no snapshot); ranking uses it over the candidate's stored depth (Z09-17). */
  depthOf?(poolId: Pubkey): bigint | null;
  /** Recorded in the manifest (A-M05-03): evictions and tail endings. */
  onEviction(e: { poolId: Pubkey; atMs: UnixMs; reason: string; tailUntilMs: UnixMs | null }): void;
  /**
   * At start: the persisted eviction records (evictions with their `tail_until`, and tail cuts with none), as
   * `onEviction` wrote them. Each pool's latest record decides: a tail still running is restored with its original
   * start; one that ended, or that a later record cut (`tail_capacity`, `tail_degraded`, `tail_restart_cut`), is not
   * (Z09-41, Z09-50). `seq` is the record's persisted order: records of the same ms are ordered by it (Z09-56).
   */
  restoreTails(): ReadonlyArray<{ poolId: Pubkey; atMs: UnixMs; seq: bigint; reason: string; tailUntilMs: UnixMs | null }>;
  log: { event(level: 'info' | 'warn', code: string, fields: Readonly<Record<string, unknown>>): void };
}

export interface Watchlist {
  pinForPosition(poolId: Pubkey): void;
  unpin(poolId: Pubkey): void;
  watchlist(): ReadonlyArray<{ poolId: Pubkey; priority: number }>;
  postEvictionTail(): ReadonlyArray<{ poolId: Pubkey; untilMs: UnixMs; reason: string }>;
  /** Recomputed on every candidate transition and every 10 s (single writer). */
  recompute(candidates: readonly CandidateRecord[]): void;
}

/** Candidate states that hold a slot (polled at candidate priority). */
const HOLDS_SLOT = new Set(['watched', 'stale', 'signalled', 'in_position', 'cooldown']);
const EVICTABLE = new Set(['watched', 'stale']);
/** Only eligible pools are offered a slot; an evicted pool returns to eligible through the prefilter (Z09-16). */
const QUEUED = new Set(['eligible']);

export function createWatchlist(deps: WatchlistDeps): Watchlist {
  const problem = checkWatchlistConfig(deps.config);
  if (problem !== null) throw { code: 'E_CONFIG', message: problem };
  const cfg = deps.config;
  const pinned = new Set<Pubkey>();
  const watched = new Map<Pubkey, 'position' | 'candidate'>();
  const tail = new Map<Pubkey, { untilMs: UnixMs; reason: string; startedMs: number }>();
  let degraded = false;
  const depth = (c: CandidateRecord): bigint => deps.depthOf?.(c.poolId) ?? c.depthLamports;
  const byDepthThenAge = (a: CandidateRecord, b: CandidateRecord): number => {
    const [x, y] = [depth(a), depth(b)];
    return (x > y ? -1 : x < y ? 1 : 0) || a.firstSeenAtMs - b.firstSeenAtMs || (a.poolId < b.poolId ? -1 : 1);
  };

  function setClass(poolId: Pubkey, cls: 'position' | 'candidate'): boolean {
    if (watched.get(poolId) === cls) return true;
    if (deps.tracker.watch(poolId, cls) === false) {
      deps.log.event('warn', 'm05.watch_refused', { pool: poolId, class: cls });
      return false;
    }
    tail.delete(poolId);                                                             // re-classed in place by M04
    watched.set(poolId, cls);
    return true;
  }
  function drop(poolId: Pubkey): void {
    if (watched.delete(poolId)) deps.tracker.unwatch(poolId);
  }
  function startTail(poolId: Pubkey, reason: string): UnixMs | null {
    if (cfg.tailMaxPools === 0 || degraded) return null;
    const now = deps.nowMs();
    const untilMs = (now + deps.maxHoldMs() + cfg.tailExtraMs) as UnixMs;
    if (deps.tracker.watch(poolId, 'tail') === false) return null;
    tail.set(poolId, { untilMs, reason, startedMs: now });
    // Oldest tail entries end first when the cap is hit.
    const order = [...tail].sort((a, b) => a[1].startedMs - b[1].startedMs);
    while (tail.size > cfg.tailMaxPools) {
      const [id] = order.shift() as [Pubkey, unknown];
      tail.delete(id);
      deps.tracker.unwatch(id);
      deps.onEviction({ poolId: id, atMs: now, reason: 'tail_capacity', tailUntilMs: null });
    }
    return tail.has(poolId) ? untilMs : null;
  }
  /** Unwatched, on the tail and recorded; `tell` tells the universe (false when it already moved the pool on). */
  function evict(poolId: Pubkey, reason: string, tell = true): void {
    drop(poolId);
    const until = startTail(poolId, reason);
    if (tell) deps.universe.onEvicted(poolId, reason, until);
    deps.onEviction({ poolId, atMs: deps.nowMs(), reason, tailUntilMs: until });
    deps.log.event('info', 'm05.evicted', { pool: poolId, reason });
  }
  /** Why a pool the universe moved out of its slot left (Z09-33). */
  function leftReason(poolId: Pubkey): string {
    const r = deps.universe.candidate(poolId);
    if (r === null) return 'left_slot';
    if (r.state === 'blacklisted') return 'blacklisted';
    if (r.state === 'rejected') return r.reasons[0] === 'prefilter_recheck' ? 'prefilter_recheck' : 'rescreen_failed';
    if (r.state === 'evicted') return r.reasons[0] ?? 'evicted';
    return 'left_slot';
  }

  // Z09-41/50: each pool's latest record decides; the running tails are restored with their original start, the
  // newest started first while the cap allows (the cap ends the oldest first, as startTail does); the rest are cut.
  {
    const now = deps.nowMs();
    const latest = new Map<Pubkey, { atMs: number; seq: bigint; reason: string; tailUntilMs: number | null }>();
    const later = (a: { atMs: number; seq: bigint }, b: { atMs: number; seq: bigint }): boolean => a.atMs > b.atMs || (a.atMs === b.atMs && a.seq > b.seq);
    for (const e of deps.restoreTails()) {
      const cur = latest.get(e.poolId);
      if (cur === undefined || later(e, cur)) latest.set(e.poolId, e);
    }
    const due = [...latest].filter(([, e]) => e.tailUntilMs !== null && e.tailUntilMs > now)
      .sort((a, b) => (later(a[1], b[1]) ? -1 : later(b[1], a[1]) ? 1 : 0));
    const cut = (poolId: Pubkey): void => deps.onEviction({ poolId, atMs: now, reason: 'tail_restart_cut', tailUntilMs: null });
    for (const [poolId, e] of due) {
      if (tail.size >= cfg.tailMaxPools || deps.mode() === 'degraded_reads' || deps.tracker.watch(poolId, 'tail') === false) { cut(poolId); continue; }
      tail.set(poolId, { untilMs: e.tailUntilMs as UnixMs, reason: e.reason, startedMs: e.atMs });
    }
  }

  return {
    pinForPosition(poolId) {
      pinned.add(poolId);
      setClass(poolId, 'position');
    },
    unpin(poolId) {
      if (!pinned.delete(poolId)) { deps.log.event('info', 'm05.unpin_unknown', { pool: poolId }); return; }
      setClass(poolId, 'candidate');                                                // demoted; may be evicted normally
    },
    watchlist: () => [...watched].map(([poolId, cls]) => ({ poolId, priority: cls === 'position' ? 0 : 1 })).sort((a, b) => a.priority - b.priority || (a.poolId < b.poolId ? -1 : 1)),
    postEvictionTail: () => [...tail].map(([poolId, t]) => ({ poolId, untilMs: t.untilMs, reason: t.reason })).sort((a, b) => a.untilMs - b.untilMs),
    recompute(candidates) {
      const now = deps.nowMs();
      for (const [id, t] of [...tail]) if (t.untilMs <= now) { tail.delete(id); deps.tracker.unwatch(id); }
      for (const p of pinned) setClass(p, 'position');
      const nowDegraded = deps.mode() === 'degraded_reads';
      if (nowDegraded) {
        if (!degraded) deps.log.event('warn', 'm05.watchlist_shrunk_degraded', { pinned: pinned.size, tail: tail.size });
        degraded = true;
        for (const c of candidates) if (!pinned.has(c.poolId) && watched.has(c.poolId)) evict(c.poolId, 'degraded');
        // P4 is suspended; the gap is recorded by M07, and each tail cut short is an eviction record (Z09-27).
        for (const id of [...tail.keys()]) {
          tail.delete(id);
          deps.tracker.unwatch(id);
          deps.onEviction({ poolId: id, atMs: now, reason: 'tail_degraded', tailUntilMs: null });
        }
        return;
      }
      degraded = false;
      const free = (c: CandidateRecord): boolean => !pinned.has(c.poolId);
      const holding = candidates.filter((c) => free(c) && HOLDS_SLOT.has(c.state));
      // Over budget: stale first, then the shallowest; never pinned.
      const evictable = holding.filter((c) => EVICTABLE.has(c.state))
        .sort((a, b) => (a.state === 'stale' ? 0 : 1) - (b.state === 'stale' ? 0 : 1) || -byDepthThenAge(a, b));
      let over = holding.length - cfg.maxWatched;
      const gone = new Set<Pubkey>();
      for (const c of evictable) {
        if (over <= 0) break;
        evict(c.poolId, c.state === 'stale' ? 'stale' : 'budget');
        gone.add(c.poolId);
        over -= 1;
      }
      // Z09-53: past-window holders make way for in-window pools waiting for a slot (stale first, then the shallowest).
      const past = (c: CandidateRecord): boolean => deps.universe.pastEntryAge(c.poolId);
      const waiting = candidates.filter((x) => free(x) && QUEUED.has(x.state));
      const inWindowWaiting = waiting.filter((x) => !past(x)).length;
      let freeSlots = cfg.maxWatched - (holding.length - gone.size);
      for (const c of evictable) {
        if (inWindowWaiting - freeSlots <= 0) break;
        if (gone.has(c.poolId) || !past(c)) continue;
        evict(c.poolId, 'past_entry_age');
        gone.add(c.poolId);
        freeSlots += 1;
      }
      for (const c of holding) if (!gone.has(c.poolId)) setClass(c.poolId, 'candidate');
      let used = [...watched.values()].filter((v) => v === 'candidate').length;
      const inWindowFirst = (a: CandidateRecord, b: CandidateRecord): number => Number(past(a)) - Number(past(b)) || byDepthThenAge(a, b);
      for (const c of [...waiting].sort(inWindowFirst)) {
        if (used >= cfg.maxWatched) break;
        if (!setClass(c.poolId, 'candidate')) continue;
        // Refused (its current facts fail): it never held the slot, so no tail.
        if (!deps.universe.onWatched(c.poolId)) { drop(c.poolId); continue; }
        used += 1;
      }
      // Pools that left every slot-holding state (rejected, blacklisted, evicted by the universe) go to the tail (Z09-33).
      const keep = new Set([...pinned, ...candidates.filter((c) => HOLDS_SLOT.has(c.state) || QUEUED.has(c.state)).map((c) => c.poolId)]);
      for (const id of [...watched.keys()]) if (!keep.has(id)) evict(id, leftReason(id), false);
    },
  };
}
