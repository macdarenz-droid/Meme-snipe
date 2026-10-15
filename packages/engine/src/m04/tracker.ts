// M04 pool state tracker (A-M04-01, A-M04-02; ARCH M04). M04 exclusively owns the ring buffers, the freshness state and
// each read's provider slot. All mutation happens on the event loop.
// - watch(): a new pool is read once alone (its account names its vaults and token mint), its canonical creator PDA is
//   derived and its mint read; then it joins its class's polls (pool, base vault, quote vault).
// - Each delivery: decode and normalise through the pool model, then the monotonic rule (ARCH 7.2: a slot older than
//   the stored one is discarded, `snapshot_out_of_order_total`) and the lag rule (a non-exit read more than
//   `max_provider_lag_slots` behind the highest slot seen is discarded and the provider reported to M14). Lag is in
//   slots (A-M04-02); it becomes milliseconds only for display, with M15's measured slot time (bug B1).
// - A pool account that is gone, or a pool or vault that changed hands, publishes `pool.closed` (and the quarantine
//   through M01 for an owner change, or for a negative effective reserve); one missing vault skips the pool this cycle.
// - freshRead: entry grade (finite max lag) re-reads once on the next provider and is `E_STALE` if still behind; exit
//   grade (infinite) never returns `E_STALE`, takes the freshest of up to two attempts (a second one when the first
//   failed or is more than `build_lag_slots` behind) and alerts past `exit_lag_alert_slots`.
//   Reads of one pool coalesce; an exit read in flight serves entry callers too (edge 3), who apply their own limit.
// - A staleness monitor every 500 ms publishes `pool.stale` once per episode past `stale_lag_slots`, and `pool.fresh`.
import { createHash } from 'node:crypto';
import type { Clock, Pubkey, Result, Slot, UnixMs } from '@bot/types';
import { SnapshotRing } from './ring.ts';
import { capOf, checkM04Settings, intervalOf, M04_DEFAULTS, type M04Settings, type UniverseLimits } from './settings.ts';
import { createPollSource, thrownCode, type PoolSource, type SourceRecord } from './source.ts';
import type {
  AccountsReader, ChainStatePort, MintInfo, PoolAddresses, PoolClass, PoolModelPort, PoolSnapshot, PoolStateLike, RawAccount, SchedulerPort,
  TrackerLog, TrackerMetrics, TrackerOutputs,
} from './types.ts';

/**
 * `E_CLOCK` (rulings Z07-9, Z07-13, Z07-31, Z07-32): a read past the slot clock's ceiling, from a clock fault (two
 * providers agree), one unconfirmed provider, or a disagreement. Exit grade: the past-ceiling read comes back UNSTORED
 * in `snapshot`, always with an under-ceiling partner in `underCeiling` (the newest read under the ceiling, else the
 * trusted stored latest); with no partner both are null and the exit waits and retries, never pricing on a lone
 * past-ceiling read. The caller prices on the WORSE proceeds of the two and floors minOut at the partner's quote less
 * the configured emergency slippage (`decideClockExit` in `exit-price.ts`, SPEC-A C-88). Entry grade: both are null;
 * entries are refused.
 */
export type FreshReadError<P extends PoolStateLike = PoolStateLike> =
  | { code: 'E_STALE' | 'E_RPC'; detail: string }
  | { code: 'E_CLOCK'; detail: string; snapshot: PoolSnapshot<P> | null; underCeiling: PoolSnapshot<P> | null };

export interface PoolTracker<P extends PoolStateLike> {
  /** False when the class is at its cap (`pool_tracker.max_*`): the watch is refused and nothing changes. */
  watch(poolId: Pubkey, priority: PoolClass): boolean;
  unwatch(poolId: Pubkey): void;
  /**
   * The newest stored snapshot. Ruling Z07-26: after the slot clock re-bases downward it can sit above the new ceiling
   * (as can `history()` and `snapshotBefore()`); the monotonic rule still holds against it, and `lagNow` treats it as
   * +∞, so it is never fresh until the clock passes it again.
   */
  latest(poolId: Pubkey): PoolSnapshot<P> | null;
  history(poolId: Pubkey, fromMs: UnixMs, toMs: UnixMs): ReadonlyArray<PoolSnapshot<P>>;
  /** M01's orientation guard: the newest snapshot strictly before `slot`. */
  snapshotBefore(poolId: Pubkey, slot: Slot): PoolSnapshot<P> | null;
  lagNow(s: PoolSnapshot<P>): number;
  /** Display only (VM-07 `quote_age_ms`): lag × M15's measured slot time (bug B1). */
  lagMs(s: PoolSnapshot<P>): number;
  freshRead(poolId: Pubkey, maxLagSlots: number): Promise<Result<PoolSnapshot<P>, FreshReadError<P>>>;
  /** True while a clock fault is confirmed (rulings Z07-9, Z07-13; tests and health). */
  clockFault(): boolean;
  /** Pools watched and ready (read once, mint known). */
  ready(): Pubkey[];
  /** In-flight `freshRead` entries (tests: MINOR-2). */
  inflightCount(): number;
  /** Bytes held by every ring (tests: MINOR-1). */
  ringBytes(): number;
  /** Starts the staleness monitor and the supply refresh; stops everything. */
  start(): void;
  stop(): void;
  /** Resolves when every pending first read has finished (tests and shutdown). */
  settled(): Promise<void>;
}

interface Entry<P extends PoolStateLike> {
  cls: PoolClass; addr: PoolAddresses | null; canonical: Pubkey | null; mint: MintInfo | null; ring: SnapshotRing<P> | null;
  staleSinceMs: number | null; boot: Promise<void> | null;
  /** A failed first read is retried from this time on (BOOT_RETRY_MS later). */
  bootRetryAtMs: number;
}

/** POLICY (card Z07): a pool whose first read or mint read failed is read again after 10 s (the monitor retries). */
export const BOOT_RETRY_MS = 10_000;
/** POLICY (ruling Z07-9): another provider's read counts as evidence for this long. */
export const PEER_WINDOW_MS = 5_000;
/** POLICY (ruling Z07-9): at most one verification read of a past-ceiling poll read this often. */
export const VERIFY_SPACING_MS = 2_000;
/**
 * POLICY (ruling Z07-25): verification reads back off. For the first `VERIFY_FAST_MS` of an episode they are at most
 * one every `VERIFY_SPACING_MS`, then at most one every `VERIFY_SLOW_SPACING_MS` (a 10-minute fault costs about 48
 * P2 reads, not 300; Chainstack's owner rate is one read every 2 s, ARCH 11.2). An episode starts at the first request
 * after `VERIFY_SLOW_SPACING_MS` with none. The reads go through M14, whose limiter holds each provider to 50% of its
 * documented limit.
 */
export const VERIFY_FAST_MS = 60_000;
export const VERIFY_SLOW_SPACING_MS = 30_000;
/** Ruling Z07-13.3: a clock fault ends after this many consecutive under-ceiling reads from at least 2 providers. */
export const FAULT_END_READS = 3;
/**
 * Ruling Z07-27(c): a source of unconfirmed past-ceiling evidence is blamed and excluded after this many verification
 * reads on other providers that do not confirm it; entries are refused until then.
 */
export const EXCLUDE_AFTER_STRIKES = 3;
/**
 * Ruling Z07-29: a past-ceiling source is implausible only when it is ahead of max(the ceiling, the last agreed slot
 * moved on at the measured slot time) by more than this (about 60 s of slots). Only an implausible source can be
 * blamed and excluded (Z07-27(c)); a plausible one is never excluded on the word of a peer under the ceiling.
 */
export const PLAUSIBLE_MARGIN_SLOTS = 150n;
/** Ruling Z07-29: a disagreement with a plausible source raises one critical alert after this long. */
export const DISAGREEMENT_ALERT_MS = 10_000;
/** The evidence source for M15's highest slot when M15 does not say which provider set it. */
export const M15_UNKNOWN_SOURCE = 'm15';
/** Ruling Z07-23: the lag logged and published for a slot past the ceiling (whose lag is +∞ inside M04). */
export const LAG_SENTINEL_SLOTS = 2_147_483_647;
const finite = (lag: number): number => (lag === Number.POSITIVE_INFINITY ? LAG_SENTINEL_SLOTS : lag);

export interface TrackerDeps<P extends PoolStateLike> {
  model: PoolModelPort<P>; reader: AccountsReader; scheduler: SchedulerPort; chain: ChainStatePort; clock: Clock;
  outputs: TrackerOutputs<P>; log: TrackerLog; metrics?: TrackerMetrics; settings?: M04Settings;
  /** M05's limits the caps are checked against (ruling Z07-12). */
  universe?: UniverseLimits;
  /** The transport seam (A-M04-03); polling by default. */
  source?: PoolSource;
  /** M14's providers in failover order (A-M04-02's "next provider"). */
  providerOrder(): readonly string[];
}

/** sha256 over the three raw accounts' data, each prefixed by its length (C-06; all three exist when a state built). */
const rawHashOf = (accounts: ReadonlyArray<RawAccount | null>): string => {
  const h = createHash('sha256');
  for (const a of accounts) {
    const data = (a as RawAccount).data;
    const len = Buffer.alloc(4);
    len.writeUInt32LE(data.length);
    h.update(len).update(data);
  }
  return h.digest('hex');
};

export function createPoolTracker<P extends PoolStateLike>(deps: TrackerDeps<P>): PoolTracker<P> {
  const settings = deps.settings ?? M04_DEFAULTS;
  const checked = checkM04Settings(settings, deps.universe);
  if (!checked.ok) throw checked.error;
  const poll = (): PoolSource => createPollSource({ reader: deps.reader, scheduler: deps.scheduler, settings, log: deps.log, ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }) });
  let source = deps.source ?? poll();
  const pools = new Map<Pubkey, Entry<P>>();
  const providers: string[] = [];
  const inflight = new Map<Pubkey, { exit?: Promise<Result<PoolSnapshot<P>, FreshReadError<P>>>; entry?: Promise<Result<PoolSnapshot<P>, FreshReadError<P>>> }>();
  /** The cancel of each periodic timer's pending fire (one slot per timer, so nothing grows). */
  const timers: Array<{ cancel: () => void }> = [];
  let mintsBusy = false;

  const capacity = (cls: PoolClass): number => Math.ceil(settings.historyMs / intervalOf(settings, cls));
  /** The highest slot a provider may claim now: the slot clock's estimate plus `max_provider_lag_slots`. */
  const ceiling = (): Slot => (deps.chain.expectedSlot(deps.clock.nowMs()) + BigInt(settings.maxProviderLagSlots)) as Slot;

  function restartSource(): void {
    const set = [...pools.values()].filter((e) => e.ring !== null).map((e) => {
      const a = e.addr as PoolAddresses;
      return { poolId: a.poolId, accounts: [a.poolId, a.baseVault, a.quoteVault], cls: e.cls };
    });
    try {
      source.start(set);
    } catch (e) {
      // A source that refuses to start (the subscription stub while disabled or unverified, A-M04-03) never leaves the
      // pools unread: polling takes over.
      deps.log.event('critical', 'm04.source_refused', { kind: source.kind, error_code: (e as { code?: string }).code ?? 'E_SOURCE' });
      source.stop();
      source = poll();
      source.onAccounts(onRecord);
      deps.metrics?.gauge('pool_source_kind', { kind: source.kind }, 1);
      source.start(set);
    }
  }

  function drop(poolId: Pubkey): void {
    if (!pools.delete(poolId)) return;
    inflight.delete(poolId);
    deps.outputs.unwatched(poolId);
    restartSource();
  }

  function close(poolId: Pubkey, code: string): void {
    if (code === 'E_CLOSED') {
      deps.log.event('warn', 'm04.pool_closed', { pool: poolId, reason: 'closed' });
      deps.outputs.closed({ poolId, reason: 'closed' });
    } else {
      deps.log.event('critical', 'm04.pool_closed', { pool: poolId, reason: 'owner_changed' });
      deps.outputs.quarantine(poolId, 'owner_changed');
      deps.outputs.closed({ poolId, reason: 'owner_changed' });
    }
    drop(poolId);
  }

  /** A first read that throws is logged and retried after BOOT_RETRY_MS, never an unhandled rejection (Z07-34). */
  const boot = (poolId: Pubkey): Promise<void> => bootstrap(poolId).catch((e: unknown) => {
    caught('first_read')(e);
    const now = pools.get(poolId);
    if (now !== undefined) Object.assign(now, { boot: null, bootRetryAtMs: deps.clock.nowMs() + BOOT_RETRY_MS });
  });

  async function bootstrap(poolId: Pubkey): Promise<void> {
    const first = await deps.reader.read([poolId], { priority: 2 });
    const e = pools.get(poolId);
    if (e === undefined) return;
    if (!first.ok) {
      Object.assign(e, { boot: null, bootRetryAtMs: deps.clock.nowMs() + BOOT_RETRY_MS });
      deps.log.event('warn', 'm04.first_read_failed', { pool: poolId, error_code: first.error.code });
      return;
    }
    const addr = deps.model.addresses(poolId, first.value.accounts[0] ?? null);
    if (!addr.ok) {
      if (addr.error.code === 'E_CLOSED' || addr.error.code === 'E_OWNER_CHANGED') return close(poolId, addr.error.code);
      deps.log.event('warn', 'm04.pool_unreadable', { pool: poolId, error_code: addr.error.code });
      return drop(poolId);
    }
    const canonical = await deps.model.canonicalCreator(addr.value.tokenMint);
    const m = await deps.reader.read([addr.value.tokenMint], { priority: 2 });
    const mint = m.ok ? deps.model.mint(m.value.accounts[0] ?? null) : null;
    const now = pools.get(poolId);
    if (now === undefined) return;
    now.boot = null;
    if (mint === null) {
      now.bootRetryAtMs = deps.clock.nowMs() + BOOT_RETRY_MS;
      deps.log.event('warn', 'm04.first_read_failed', { pool: poolId, error_code: m.ok ? 'E_MINT' : m.error.code });
      return;
    }
    Object.assign(now, { addr: addr.value, canonical, mint, ring: new SnapshotRing(addr.value, deps.model, capacity(now.cls), providers) });
    restartSource();
  }

  /** Builds a snapshot from one pool's accounts, or handles why not; null when nothing is recorded. */
  function snapshotOf(e: Entry<P>, accounts: ReadonlyArray<RawAccount | null>, contextSlot: Slot, providerLabel: string, latencyMs: number): PoolSnapshot<P> | null {
    const addr = e.addr as PoolAddresses;
    const [poolAccount, baseVault, quoteVault] = accounts as [RawAccount | null, RawAccount | null, RawAccount | null];
    const built = deps.model.build(addr, { pool: poolAccount, baseVault, quoteVault }, e.mint as MintInfo,
      { asOfSlot: contextSlot, observedAtMs: deps.clock.nowMs(), canonicalCreator: e.canonical });
    if (!built.ok) {
      const code = built.error.code;
      if (code === 'E_CLOSED' || code === 'E_OWNER_CHANGED') close(addr.poolId, code);
      else if (code === 'E_PARTIAL') deps.metrics?.counter('partial_read_total', {});
      else if (code === 'E_NEGATIVE_EFFECTIVE') deps.outputs.quarantine(addr.poolId, 'negative_effective');
      else deps.log.event('warn', 'm04.pool_unreadable', { pool: addr.poolId, error_code: code });
      return null;
    }
    const pool = built.value;
    return {
      pool, effectiveQuoteLamports: deps.model.effectiveQuote(pool), spotSolPerToken: deps.model.spot(pool), feeTotalBps: deps.model.feeTotalBps(pool) ?? 10_000,
      providerLabel, providerSlot: contextSlot, readLatencyMs: latencyMs, observationLagSlots: finite(lagOf(contextSlot)), rawHash: rawHashOf(accounts),
    };
  }

  // ---- Ruling Z07-13 (replaces Z07-9's store branch). Nothing past the ceiling is ever stored. Each provider's newest
  // read is kept for PEER_WINDOW_MS. A read past the ceiling that another provider agrees with (within
  // max_provider_lag_slots) is a clock fault: one critical `m04.clock_fault` (E_CLOCK) per episode, no provider blamed;
  // for the whole episode entries are refused with E_CLOCK and exits get the agreed read unstored with E_CLOCK. A lone
  // provider past the clock and the other providers is refused and blamed. The episode ends after 3 consecutive
  // under-ceiling reads from at least 2 different providers (MINOR-R6). ----
  const recentByProvider = new Map<string, { slot: Slot; atMs: number; under: boolean }>();
  let fault: { sinceMs: number } | null = null;
  let alerted = false;
  /** The under-ceiling reads since the last past-ceiling one, during a fault. */
  let underStreak: string[] = [];
  let verifying = false;
  let lastVerifyMs = -Infinity;
  let verifySinceMs = -Infinity;
  let lastVerifyAskMs = -Infinity;

  /**
   * MINOR-R6 and MAJOR-R6b (Z07-22): lag against max(the clock's estimate, M15's highest slot seen when it is within
   * the ceiling, the newest under-ceiling slot any provider gave within PEER_WINDOW_MS). M15's highest past the ceiling
   * is evidence, not a reference (`suspect()`): capped at the ceiling it would make every honest read look
   * max_provider_lag_slots behind after one bogus slot, and refuse every entry for good (MAJOR-1). A slot past the
   * ceiling has infinite lag (defence in depth: it is never fresh).
   */
  const lagOf = (slot: Slot): number => {
    const now = deps.clock.nowMs();
    const c = ceiling();
    if (slot > c) return Number.POSITIVE_INFINITY;
    const seen = deps.chain.highestSeenSlot();
    let ref = deps.chain.expectedSlot(now) as bigint;
    if (seen <= c && seen > ref) ref = seen;
    for (const r of recentByProvider.values()) if (r.under && now - r.atMs <= PEER_WINDOW_MS && r.slot > ref) ref = r.slot;
    const d = ref - slot;
    return d > 0n ? Number(d) : 0;
  };

  // ---- Ruling Z07-27 (MAJOR-R6c). Witnesses must be independent: a past-ceiling read is confirmed only by another
  // provider's recent slot past the ceiling, or by M15's highest when another provider set it, within
  // max_provider_lag_slots; confirmed means a clock fault. Unconfirmed past-ceiling evidence (a read, or M15's highest)
  // is held by source: while any is unresolved no entry passes (E_CLOCK) and exits behave as before. A source is
  // blamed and excluded after EXCLUDE_AFTER_STRIKES verification reads on other providers that do not confirm it; its
  // later past-ceiling reads are refused and blamed, and entries resume. A provider that agrees past the ceiling with
  // another independent one is never excluded. Honest reads are never refused beyond that bounded window. ----
  const evidence = new Map<string, { slot: Slot; strikes: number }>();
  /** The newest slot two providers agreed on under the ceiling (within max_provider_lag_slots), and when (Z07-29). */
  let agreed: { slot: Slot; atMs: number } | null = null;
  /** When the current suspect episode began, and whether its disagreement alert was raised (Z07-29). */
  let suspectSinceMs: number | null = null;
  let disagreementAlerted = false;

  /**
   * Z07-29(1): ahead of max(ceiling, the last agreed slot moved on by wall time) by more than PLAUSIBLE_MARGIN_SLOTS.
   * Z07-34: with no usable slot time (0, NaN, ±∞) nothing is implausible, so no source is excluded and entries stay
   * refused (fail closed); logged once until the estimate is usable again.
   */
  let slotTimeBad = false;
  const implausible = (slot: Slot): boolean => {
    let limit = ceiling() as bigint;
    if (agreed !== null) {
      const ms = deps.chain.slotDurationMsEstimate();
      if (!(Number.isFinite(ms) && ms > 0)) {
        if (!slotTimeBad) deps.log.event('warn', 'm04.slot_time_invalid', { estimate: String(ms) });
        slotTimeBad = true;
        return false;
      }
      slotTimeBad = false;
      const moved = agreed.slot + BigInt(Math.ceil((deps.clock.nowMs() - agreed.atMs) / ms));
      if (moved > limit) limit = moved;
    }
    return slot > limit + PLAUSIBLE_MARGIN_SLOTS;
  };

  /** No promise of M04 rejects unhandled (Z07-34): a background failure is logged and the work retries on schedule. */
  const caught = (where: string) => (e: unknown): void => {
    deps.log.event('error', 'm04.internal_error', { where, error_code: thrownCode(e) });
  };
  const excluded = new Set<string>();
  let m15Source: string | null = null;

  /** M15's highest is independent of `provider` only when another, known provider set it. */
  const m15Witness = (provider: string, slot: Slot, c: Slot): boolean => {
    const seen = deps.chain.highestSeenSlot();
    const by = deps.chain.highestSeenBy();
    const lag = BigInt(settings.maxProviderLagSlots);
    return by !== null && by !== provider && !excluded.has(by) && seen > c && (seen > slot ? seen - slot : slot - seen) <= lag;
  };

  function blame(source: string, slot: Slot, poolId: Pubkey): void {
    deps.metrics?.counter('snapshot_future_slot_total', { provider: source });
    deps.log.event('error', 'm04.read_ahead_of_clock', { pool: poolId, provider: source, slots_ahead: slot - ceiling() });
  }

  type SlotVerdict = 'ok' | 'lone' | 'unverified' | 'clock';
  function judgeSlot(provider: string, slot: Slot, poolId: Pubkey): SlotVerdict {
    const now = deps.clock.nowMs();
    const c = ceiling();
    const lag = BigInt(settings.maxProviderLagSlots);
    const peers = [...recentByProvider].filter(([p, r]) => p !== provider && now - r.atMs <= PEER_WINDOW_MS);
    recentByProvider.set(provider, { slot, atMs: now, under: slot <= c });
    // Z07-29: two providers within max lag of each other, both under the ceiling, anchor the plausibility margin (an
    // agreement past the ceiling, even a confirmed one, could be two bogus answers: MAJOR-R5).
    for (const [, r] of peers) {
      if (slot > c || r.slot > c || (r.slot > slot ? r.slot - slot : slot - r.slot) > lag) continue;
      const top = (r.slot > slot ? r.slot : slot) as Slot;
      if (agreed === null || top > agreed.slot) agreed = { slot: top, atMs: now };
    }
    if (slot <= c) {
      evidence.delete(provider);                                  // its own reads are back under the ceiling
      // An unconfirmed exit alert (no fault) ends with the first read back under the ceiling.
      if (fault === null) alerted = false;
      else {
        underStreak.push(provider);
        if (underStreak.length >= FAULT_END_READS && new Set(underStreak).size >= 2) {
          fault = null;
          alerted = false;
          underStreak = [];
          deps.log.event('info', 'm04.clock_recovered', { provider });
        }
      }
      return 'ok';
    }
    underStreak = [];
    const witness = peers.find(([, r]) => r.slot > c && (r.slot > slot ? r.slot - slot : slot - r.slot) <= lag);
    if (witness !== undefined || m15Witness(provider, slot, c)) {
      fault ??= { sinceMs: now };
      evidence.clear();
      excluded.delete(provider);
      if (witness !== undefined) excluded.delete(witness[0]);
      clockAlert(provider, slot, c);
      return 'clock';
    }
    if (fault !== null) return 'clock';
    if (excluded.has(provider)) {
      blame(provider, slot, poolId);
      return 'lone';
    }
    const known = evidence.get(provider);
    evidence.set(provider, { slot, strikes: known?.strikes ?? 0 });
    if (known === undefined) deps.log.event('warn', 'm04.clock_suspect', { source: provider, slot, ceiling: c });
    return 'unverified';
  }

  /**
   * M15's highest slot past the ceiling is evidence too (Z07-22, Z07-27), held under the provider that set it (or
   * `M15_UNKNOWN_SOURCE`), unless that source is excluded. While any evidence is unresolved (the suspect state) it
   * returns the oldest source, else null.
   */
  function suspect(): string | null {
    if (fault !== null) return null;
    const seen = deps.chain.highestSeenSlot();
    const c = ceiling();
    const src = deps.chain.highestSeenBy() ?? M15_UNKNOWN_SOURCE;
    if (m15Source !== null && (seen <= c || m15Source !== src)) {
      evidence.delete(m15Source);
      m15Source = null;
    }
    if (seen > c && !excluded.has(src)) {
      const ev = evidence.get(src);
      if (ev === undefined) deps.log.event('warn', 'm04.clock_suspect', { source: src, slot: seen, ceiling: c });
      evidence.set(src, { slot: seen, strikes: ev?.strikes ?? 0 });
      m15Source = src;
    }
    // Z07-29: evidence the clock has caught up with is resolved (the sources converge under the ceiling).
    for (const [k, ev] of evidence) if (ev.slot <= c) evidence.delete(k);
    const [oldest] = evidence.keys();
    if (oldest === undefined) {
      suspectSinceMs = null;
      disagreementAlerted = false;
      return null;
    }
    // Z07-29(2): a plausible source that no one confirms or refutes keeps entries refused; after the window, one
    // critical alert so the owner can act (for example by rotating a provider).
    const now = deps.clock.nowMs();
    suspectSinceMs ??= now;
    if (!disagreementAlerted && now - suspectSinceMs >= DISAGREEMENT_ALERT_MS) {
      disagreementAlerted = true;
      const ev = evidence.get(oldest) as { slot: Slot };
      deps.log.event('critical', 'm04.clock_disagreement', { error_code: 'E_CLOCK', source: oldest, slot: ev.slot, ceiling: c });
    }
    return oldest;
  }

  /** A verification read that another provider answered without confirming `source`: one strike. */
  function strike(source: string, answeredBy: string | undefined, poolId: Pubkey): void {
    const ev = evidence.get(source);
    // Z07-29(2): only an implausible source is struck; a plausible one is never excluded on a lower peer's word.
    if (ev === undefined || answeredBy === undefined || answeredBy === source || fault !== null || !implausible(ev.slot)) return;
    ev.strikes++;
    if (ev.strikes < EXCLUDE_AFTER_STRIKES) return;
    evidence.delete(source);
    if (m15Source === source) m15Source = null;
    excluded.add(source);
    blame(source, ev.slot, poolId);
  }

  function clockAlert(provider: string, slot: Slot, c: Slot): void {
    if (alerted) return;                                          // one alert per episode
    alerted = true;
    deps.log.event('critical', 'm04.clock_fault', { error_code: 'E_CLOCK', provider, slot, ceiling: c });
  }

  /** The stored latest, unless it sits above the current ceiling (defence in depth; nothing above is ever stored). */
  const trustedLatest = (ring: SnapshotRing<P>): PoolSnapshot<P> | null => {
    const last = ring.latest();
    return last !== null && last.providerSlot <= ceiling() ? last : null;
  };

  /**
   * The slot rules (Z07-13), the monotonic rule, then the ring and the outputs. Nothing past the ceiling is stored, so
   * one bogus slot, or one bogus agreement, can never freeze `latest()` (MAJOR-1, MAJOR-R5). `exit` reads are not
   * discarded for lag.
   */
  function store(e: Entry<P>, s: PoolSnapshot<P>, exit: boolean): 'stored' | 'refused' | 'older' | 'ahead' | 'unverified' | 'clock' {
    const ring = e.ring as SnapshotRing<P>;
    const verdict = judgeSlot(s.providerLabel, s.providerSlot, s.pool.poolId);
    if (verdict === 'lone') return 'ahead';
    if (verdict !== 'ok') return verdict;
    // Z07-23: the monotonic rule holds against the stored latest whatever the ceiling does now; nothing past the
    // ceiling is stored, so it cannot freeze `latest()`.
    const last = ring.latest();
    if (last !== null && s.providerSlot < last.providerSlot) {
      deps.metrics?.counter('snapshot_out_of_order_total', {});
      return 'older';
    }
    if (!exit && s.observationLagSlots > settings.maxProviderLagSlots) {
      deps.outputs.providerLagging(s.providerLabel, s.observationLagSlots);
      return 'refused';
    }
    ring.push(s);
    deps.metrics?.observe('observation_lag_slots', { pool: s.pool.poolId, provider: s.providerLabel }, s.observationLagSlots);
    deps.outputs.snapshot(s, e.cls);
    return 'stored';
  }

  function onRecord(r: SourceRecord): void {
    for (const { poolId, accounts } of r.entries) {
      const e = pools.get(poolId);
      if (e === undefined || e.ring === null) continue;
      const s = snapshotOf(e, accounts, r.contextSlot, r.providerLabel, r.latencyMs);
      if (s === null) continue;
      const outcome = store(e, s, false);
      // A past-ceiling read is checked on the next provider; during a fault, under-ceiling reads are confirmed there
      // too, so the episode can end on two providers (Z07-13.3); unresolved evidence is verified (Z07-27).
      if (outcome === 'unverified') verify(poolId, r.providerLabel, r.providerLabel);
      else if (fault !== null && outcome !== 'clock') verify(poolId, r.providerLabel, null);
      else {
        const src = suspect();
        if (src !== null) verify(poolId, src, src);
      }
    }
  }
  source.onAccounts(onRecord);

  /**
   * One read of the pool on the provider after `provider`, spaced by the Z07-25 back-off and never overlapping. When it
   * verifies `source`'s evidence, an answer from another provider that does not confirm it is a strike (Z07-27).
   */
  function verify(poolId: Pubkey, provider: string, source: string | null): void {
    const now = deps.clock.nowMs();
    if (now - lastVerifyAskMs > VERIFY_SLOW_SPACING_MS) verifySinceMs = now;     // a new episode
    lastVerifyAskMs = now;
    const spacing = now - verifySinceMs < VERIFY_FAST_MS ? VERIFY_SPACING_MS : VERIFY_SLOW_SPACING_MS;
    if (verifying || now - lastVerifyMs < spacing) return;
    verifying = true;
    lastVerifyMs = now;
    void readPool(poolId, 2, nextProvider(provider), false)
      .then((r) => { if (source !== null) strike(source, r.by, poolId); })
      .catch(caught('verify'))
      .finally(() => { verifying = false; });
  }

  /**
   * A read. `snap`: what a caller may use (stored, or the stored latest when the read was older; a read refused for lag
   * comes back for the caller's own limit). `held`: a past-ceiling read, unverified or in a clock fault, never stored
   * (exit grade only). `provider`: who answered a refused read, to re-read elsewhere. `by`: who answered.
   */
  type Read = { snap: PoolSnapshot<P> | null; held: PoolSnapshot<P> | null; provider?: string; by?: string };
  async function readPool(poolId: Pubkey, priority: 0 | 1 | 2, provider: string | undefined, exit: boolean): Promise<Read> {
    const none: Read = { snap: null, held: null };
    const e = pools.get(poolId);
    if (e === undefined || e.addr === null) return none;
    const a = e.addr;
    const r = await deps.reader.read([a.poolId, a.baseVault, a.quoteVault], { priority, ...(provider === undefined ? {} : { provider }) });
    const now = pools.get(poolId);
    if (!r.ok || now === undefined || now.ring === null) return none;
    const s = snapshotOf(now, r.value.accounts, r.value.contextSlot, r.value.providerLabel, r.value.latencyMs);
    if (s === null) return none;
    const outcome = store(now, s, exit);
    const by = s.providerLabel;
    if (outcome === 'older') return { snap: trustedLatest(now.ring as SnapshotRing<P>), held: null, by };
    if (outcome === 'ahead') return { ...none, provider: by, by };
    if (outcome === 'unverified' || outcome === 'clock') return { snap: null, held: s, by };
    return { snap: s, held: null, by };
  }

  const nextProvider = (after: string): string | undefined => {
    const order = deps.providerOrder();
    const i = order.indexOf(after);
    return order.find((p, k) => p !== after && k > i) ?? order.find((p) => p !== after);
  };

  /** The provider to re-read on: the one after whoever answered the first read. */
  const after = (r: Read): string | undefined => {
    const label = (r.snap ?? r.held)?.providerLabel ?? r.provider;
    return label === undefined ? undefined : nextProvider(label);
  };

  const clockError = (snapshot: PoolSnapshot<P> | null, detail: string, underCeiling: PoolSnapshot<P> | null = null): { ok: false; error: FreshReadError<P> } =>
    ({ ok: false, error: { code: 'E_CLOCK', detail, snapshot, underCeiling } });

  async function entryRead(poolId: Pubkey, maxLag: number): Promise<Result<PoolSnapshot<P>, FreshReadError<P>>> {
    const r1 = await readPool(poolId, 1, undefined, false);
    const first = r1.snap;
    if (first !== null && suspect() === null && lagOf(first.providerSlot) <= maxLag) return { ok: true, value: first };
    // Z07-24: one provider past the ceiling and no other to confirm it: the clock alert, and E_CLOCK.
    if (r1.held !== null && after(r1) === undefined) {
      clockAlert(r1.held.providerLabel, r1.held.providerSlot, ceiling());
      return clockError(null, 'one provider past the slot clock; no other provider can confirm');
    }
    // Entry reads never use a past-ceiling read; the re-read on the next provider may show a clock fault.
    const again = await readPool(poolId, 1, after(r1), false);
    if (fault !== null) return clockError(null, 'clock fault: entries are refused');
    if (suspect() !== null) return clockError(null, 'unresolved evidence past the slot clock: entries wait (Z07-27)');
    if (again.snap !== null && lagOf(again.snap.providerSlot) <= maxLag) return { ok: true, value: again.snap };
    if (first === null && again.snap === null) return { ok: false, error: { code: 'E_RPC', detail: 'every read failed' } };
    deps.metrics?.counter('fresh_read_stale_total', {});
    return { ok: false, error: { code: 'E_STALE', detail: 're-read on the next provider is still behind' } };
  }

  /** Z07-32: a past-ceiling read goes out only with an under-ceiling partner (`under`, else the trusted stored latest). */
  function withPartner(poolId: Pubkey, past: PoolSnapshot<P>, under: PoolSnapshot<P> | null, detail: string): { ok: false; error: FreshReadError<P> } {
    // Called right after a read of this pool built a snapshot, so the pool is watched and its ring exists.
    const partner = under ?? trustedLatest((pools.get(poolId) as Entry<P>).ring as SnapshotRing<P>);
    return partner === null ? clockError(null, `${detail}; no read under the ceiling: the exit waits and retries`) : clockError(past, detail, partner);
  }

  async function exitRead(poolId: Pubkey): Promise<Result<PoolSnapshot<P>, FreshReadError<P>>> {
    const r1 = await readPool(poolId, 0, undefined, true);
    const disagreeing = suspect();
    if (disagreeing !== null) {
      // Rulings Z07-30, Z07-31: during a disagreement the exit gets BOTH the highest-slot plausible read and the newest
      // under-ceiling one, unstored and flagged E_CLOCK; the caller prices on the worse proceeds of the two. The source
      // ahead is read too when it is a provider we use.
      const r2 = await readPool(poolId, 0, deps.providerOrder().includes(disagreeing) ? disagreeing : after(r1), true);
      const reads = [r1.snap, r1.held, r2.snap, r2.held].filter((x): x is PoolSnapshot<P> => x !== null && !implausible(x.providerSlot));
      const top = reads.reduce<PoolSnapshot<P> | null>((m, x) => (m === null || x.providerSlot > m.providerSlot ? x : m), null);
      if (top !== null && top.providerSlot > ceiling()) {
        if (deps.providerOrder().length < 2) clockAlert(top.providerLabel, top.providerSlot, ceiling());   // Z07-24
        // `top` is one read's past-ceiling (held) copy, so at most the other read is under the ceiling. Z07-32: never a
        // past-ceiling read without an under-ceiling partner; failing both, the stored latest (trusted, at or under the
        // ceiling); failing that, no read at all, and the exit waits and retries.
        return withPartner(poolId, top, r1.snap ?? r2.snap, 'clock disagreement: price on the worse of the two reads, both unstored');
      }
    }
    const first = r1.snap;
    const r2 = first !== null && lagOf(first.providerSlot) <= settings.buildLagSlots ? { snap: null, held: null } as Read
      : await readPool(poolId, 0, after(r1), true);
    const second = r2.snap;
    // readPool never returns an older read than latest() (MINOR-3), so the second is the freshest when it exists.
    const best = second !== null && (first === null || second.providerSlot >= first.providerSlot) ? second : first;
    if (best === null) {
      // No usable read: a past-ceiling one (a clock fault's agreed read, or one unconfirmed provider) is handed back
      // UNSTORED with E_CLOCK, so the exit path decides and an exit is never blocked by a clock fault alone.
      const held = r2.held ?? r1.held;
      if (held !== null) {
        clockAlert(held.providerLabel, held.providerSlot, ceiling());
        return withPartner(poolId, held, null, fault !== null ? 'clock fault' : 'one provider past the slot clock, unconfirmed');
      }
      return { ok: false, error: { code: 'E_RPC', detail: 'every read failed' } };
    }
    const lag = lagOf(best.providerSlot);
    deps.metrics?.observe('exit_read_lag_slots', {}, lag);
    if (lag > settings.exitLagAlertSlots) deps.log.event('warn', 'm04.exit_read_lagging', { pool: poolId, lag_slots: lag });
    return { ok: true, value: best };
  }

  function monitor(): void {
    const now = deps.clock.nowMs();
    for (const [poolId, e] of pools) {
      if (e.ring === null && e.boot === null && now >= e.bootRetryAtMs) e.boot = boot(poolId);
      const last = e.ring?.latest() ?? null;
      if (last === null) continue;
      deps.metrics?.gauge('pool_snapshot_age_ms', { pool: poolId }, now - last.pool.observedAtMs);
      const lag = finite(lagOf(last.providerSlot));
      const ageMs = now - last.pool.observedAtMs;
      if (lag > settings.staleLagSlots || ageMs > settings.staleAgeMs + intervalOf(settings, e.cls)) {
        if (e.staleSinceMs !== null) continue;
        e.staleSinceMs = now;
        deps.log.event('warn', 'm04.pool_stale', { pool: poolId, lag_slots: lag, age_ms: ageMs });
        deps.outputs.stale({ poolId, lagSlots: lag, sinceMs: now });
      } else if (e.staleSinceMs !== null) {
        e.staleSinceMs = null;
        deps.outputs.fresh({ poolId });
      }
    }
  }

  async function refreshMints(): Promise<void> {
    if (mintsBusy) return;
    mintsBusy = true;
    try {
      const ready = [...pools.values()].filter((e) => e.addr !== null && e.ring !== null);
      for (let i = 0; i < ready.length; i += settings.maxAccountsPerCall) {
        const batch = ready.slice(i, i + settings.maxAccountsPerCall);
        const r = await deps.reader.read(batch.map((e) => (e.addr as PoolAddresses).tokenMint), { priority: 2 });
        if (!r.ok) continue;
        batch.forEach((e, k) => {
          const m = deps.model.mint(r.value.accounts[k] ?? null);
          if (m !== null) e.mint = m;
        });
      }
    } finally {
      mintsBusy = false;
    }
  }

  const every = (ms: number, fn: () => void): void => {
    const t = { cancel: () => {} };
    timers.push(t);
    const loop = (): void => { t.cancel = deps.scheduler.set(() => { fn(); loop(); }, ms); };
    loop();
  };

  return {
    watch(poolId, priority) {
      const e = pools.get(poolId);
      if (e?.cls === priority) return true;
      // MINOR-1: rings are preallocated, so each class has a hard cap; a watch past it is refused.
      if ([...pools.values()].filter((x) => x.cls === priority).length >= capOf(settings, priority)) {
        deps.metrics?.counter('watch_refused_total', { class: priority });
        deps.log.event(priority === 'position' ? 'critical' : 'warn', 'm04.watch_refused', { pool: poolId, class: priority });
        return false;
      }
      if (e !== undefined) {
        e.cls = priority;
        e.ring?.resize(capacity(priority));
        restartSource();
        return true;
      }
      const entry: Entry<P> = { cls: priority, addr: null, canonical: null, mint: null, ring: null, staleSinceMs: null, boot: null, bootRetryAtMs: 0 };
      pools.set(poolId, entry);
      entry.boot = boot(poolId);
      return true;
    },
    unwatch: drop,
    latest: (poolId) => pools.get(poolId)?.ring?.latest() ?? null,
    history: (poolId, fromMs, toMs) => pools.get(poolId)?.ring?.history(fromMs, toMs) ?? [],
    snapshotBefore: (poolId, slot) => pools.get(poolId)?.ring?.before(slot) ?? null,
    lagNow: (s) => lagOf(s.providerSlot),
    lagMs: (s) => lagOf(s.providerSlot) * deps.chain.slotDurationMsEstimate(),
    async freshRead(poolId, maxLagSlots) {
      // MINOR-2: an unknown or not yet ready pool is refused before any in-flight state exists.
      if (pools.get(poolId)?.addr == null) return { ok: false, error: { code: 'E_RPC', detail: 'pool not watched or not read yet' } };
      const started = deps.scheduler.nowMs();
      const exit = maxLagSlots === Number.POSITIVE_INFINITY;
      const slot = inflight.get(poolId) ?? {};
      inflight.set(poolId, slot);
      let result: Result<PoolSnapshot<P>, FreshReadError<P>>;
      let pending: string | null;
      if (exit) {
        slot.exit ??= exitRead(poolId).finally(() => { delete slot.exit; });
        result = await slot.exit;
      } else if (fault !== null) {
        // Z07-13.2: for the whole clock-fault episode entries are refused.
        result = clockError(null, 'clock fault: entries are refused');
      } else if ((pending = suspect()) !== null) {
        // Z07-27(b): while past-ceiling evidence is unresolved no entry passes; the evidence is verified meanwhile.
        // Z07-24: with no other provider nothing can confirm it, so the clock alert is raised.
        if (deps.providerOrder().length < 2) clockAlert(pending, (evidence.get(pending) as { slot: Slot }).slot, ceiling());
        verify(poolId, pending, pending);
        result = clockError(null, 'unresolved evidence past the slot clock: entries wait');
      } else if (slot.exit !== undefined) {
        // Edge 3: an exit read in flight serves the entry caller, who applies its own limit and never gets a held read.
        const r = await slot.exit;
        result = !r.ok && r.error.code === 'E_CLOCK' ? clockError(null, 'the exit read is past the slot clock')
          : r.ok && lagOf(r.value.providerSlot) > maxLagSlots ? { ok: false, error: { code: 'E_STALE', detail: 'the exit read is behind the entry limit' } } : r;
      } else {
        slot.entry ??= entryRead(poolId, maxLagSlots).finally(() => { delete slot.entry; });
        const r = await slot.entry;
        result = r.ok && lagOf(r.value.providerSlot) > maxLagSlots ? { ok: false, error: { code: 'E_STALE', detail: 'the shared read is behind this limit' } } : r;
      }
      // MINOR-2: the in-flight entry goes once nothing is pending on it.
      if (slot.exit === undefined && slot.entry === undefined && inflight.get(poolId) === slot) inflight.delete(poolId);
      deps.metrics?.observe('fresh_read_latency_ms', { grade: exit ? 'exit' : 'entry' }, deps.scheduler.nowMs() - started);
      return result;
    },
    ready: () => [...pools.values()].filter((e) => e.ring !== null).map((e) => (e.addr as PoolAddresses).poolId),
    inflightCount: () => inflight.size,
    clockFault: () => fault !== null,
    ringBytes: () => [...pools.values()].reduce((n, e) => n + (e.ring?.bytes ?? 0), 0),
    start() {
      every(settings.staleCheckMs, monitor);
      every(settings.supplyRefreshMs, () => { void refreshMints().catch(caught('supply')); });
      deps.metrics?.gauge('pool_source_kind', { kind: source.kind }, 1);
    },
    stop() {
      for (const t of timers.splice(0)) t.cancel();
      source.stop();
    },
    async settled() {
      for (;;) {
        const pending = [...pools.values()].map((e) => e.boot).filter((b): b is Promise<void> => b !== null);
        if (pending.length === 0) return;
        await Promise.all(pending);
      }
    },
  };
}
