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
import { createPollSource, type PoolSource, type SourceRecord } from './source.ts';
import type {
  AccountsReader, ChainStatePort, MintInfo, PoolAddresses, PoolClass, PoolModelPort, PoolSnapshot, PoolStateLike, RawAccount, SchedulerPort,
  TrackerLog, TrackerMetrics, TrackerOutputs,
} from './types.ts';

/**
 * `E_CLOCK` (rulings Z07-9, Z07-13): a read past the slot clock's ceiling, from a clock fault (two providers agree) or
 * one unconfirmed provider. Exit grade: the read comes back UNSTORED in `snapshot`, so the exit path decides and an
 * exit is never blocked by a clock fault alone. Entry grade: `snapshot` is null; entries are refused for the episode.
 */
export type FreshReadError<P extends PoolStateLike = PoolStateLike> =
  | { code: 'E_STALE' | 'E_RPC'; detail: string }
  | { code: 'E_CLOCK'; detail: string; snapshot: PoolSnapshot<P> | null };

export interface PoolTracker<P extends PoolStateLike> {
  /** False when the class is at its cap (`pool_tracker.max_*`): the watch is refused and nothing changes. */
  watch(poolId: Pubkey, priority: PoolClass): boolean;
  unwatch(poolId: Pubkey): void;
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
/** Ruling Z07-13.3: a clock fault ends after this many consecutive under-ceiling reads from at least 2 providers. */
export const FAULT_END_READS = 3;
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

  type SlotVerdict = 'ok' | 'lone' | 'unverified' | 'clock';
  function judgeSlot(provider: string, slot: Slot, poolId: Pubkey): SlotVerdict {
    const now = deps.clock.nowMs();
    const c = ceiling();
    const peers = [...recentByProvider].filter(([p, r]) => p !== provider && now - r.atMs <= PEER_WINDOW_MS).map(([, r]) => r.slot);
    recentByProvider.set(provider, { slot, atMs: now, under: slot <= c });
    if (slot <= c) {
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
    const lag = BigInt(settings.maxProviderLagSlots);
    if (peers.some((q) => q > c && (q > slot ? q - slot : slot - q) <= lag)) {
      fault ??= { sinceMs: now };
      clockAlert(provider, slot, c);
      return 'clock';
    }
    if (peers.some((q) => q <= c)) {
      deps.metrics?.counter('snapshot_future_slot_total', { provider });
      deps.log.event('error', 'm04.read_ahead_of_clock', { pool: poolId, provider, slots_ahead: slot - c });
      return 'lone';
    }
    return fault !== null ? 'clock' : 'unverified';
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
      // A past-ceiling read with no peer evidence is checked on the next provider; during a fault, under-ceiling
      // reads are confirmed there too, so the episode can end on two providers (Z07-13.3).
      if (outcome === 'unverified' || (fault !== null && outcome !== 'clock') || suspect()) verify(poolId, r.providerLabel);
    }
  }
  source.onAccounts(onRecord);

  /**
   * Z07-22: M15's highest slot seen past the ceiling is clock-fault evidence (or a bogus provider M15 believed): warn
   * once per episode, and the caller verifies on the next provider. Never an alert or a refusal on its own.
   */
  let suspected = false;
  function suspect(): boolean {
    const seen = deps.chain.highestSeenSlot();
    const c = ceiling();
    if (fault !== null || seen <= c) { suspected = false; return false; }
    if (!suspected) deps.log.event('warn', 'm04.clock_suspect', { highest_seen: seen, ceiling: c });
    suspected = true;
    return true;
  }

  /** One read of the pool on the next provider, at most every VERIFY_SPACING_MS and never overlapping. */
  function verify(poolId: Pubkey, provider: string): void {
    const now = deps.clock.nowMs();
    if (verifying || now - lastVerifyMs < VERIFY_SPACING_MS) return;
    verifying = true;
    lastVerifyMs = now;
    void readPool(poolId, 2, nextProvider(provider), false).finally(() => { verifying = false; });
  }

  /**
   * A read. `snap`: what a caller may use (stored, or the stored latest when the read was older; a read refused for lag
   * comes back for the caller's own limit). `held`: a past-ceiling read, unverified or in a clock fault, never stored
   * (exit grade only). `provider`: who answered, to re-read elsewhere.
   */
  type Read = { snap: PoolSnapshot<P> | null; held: PoolSnapshot<P> | null; provider?: string };
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
    if (outcome === 'older') return { snap: trustedLatest(now.ring as SnapshotRing<P>), held: null };
    if (outcome === 'ahead') return { ...none, provider: s.providerLabel };
    if (outcome === 'unverified' || outcome === 'clock') return { snap: null, held: s };
    return { snap: s, held: null };
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

  const clockError = (snapshot: PoolSnapshot<P> | null, detail: string): { ok: false; error: FreshReadError<P> } => ({ ok: false, error: { code: 'E_CLOCK', detail, snapshot } });

  async function entryRead(poolId: Pubkey, maxLag: number): Promise<Result<PoolSnapshot<P>, FreshReadError<P>>> {
    const r1 = await readPool(poolId, 1, undefined, false);
    const first = r1.snap;
    if (first !== null && lagOf(first.providerSlot) <= maxLag) return { ok: true, value: first };
    // Z07-24: one provider past the ceiling and no other to confirm it: the clock alert, and E_CLOCK.
    if (r1.held !== null && after(r1) === undefined) {
      clockAlert(r1.held.providerLabel, r1.held.providerSlot, ceiling());
      return clockError(null, 'one provider past the slot clock; no other provider can confirm');
    }
    // Entry reads never use a past-ceiling read; the re-read on the next provider may show a clock fault.
    const again = await readPool(poolId, 1, after(r1), false);
    if (fault !== null) return clockError(null, 'clock fault: entries are refused');
    if (again.snap !== null && lagOf(again.snap.providerSlot) <= maxLag) return { ok: true, value: again.snap };
    if (first === null && again.snap === null) return { ok: false, error: { code: 'E_RPC', detail: 'every read failed' } };
    deps.metrics?.counter('fresh_read_stale_total', {});
    return { ok: false, error: { code: 'E_STALE', detail: 're-read on the next provider is still behind' } };
  }

  async function exitRead(poolId: Pubkey): Promise<Result<PoolSnapshot<P>, FreshReadError<P>>> {
    const r1 = await readPool(poolId, 0, undefined, true);
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
        return clockError(held, fault !== null ? 'clock fault' : 'one provider past the slot clock, unconfirmed');
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
      if (e.ring === null && e.boot === null && now >= e.bootRetryAtMs) e.boot = bootstrap(poolId);
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
      entry.boot = bootstrap(poolId);
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
      if (exit) {
        slot.exit ??= exitRead(poolId).finally(() => { delete slot.exit; });
        result = await slot.exit;
      } else if (fault !== null) {
        // Z07-13.2: for the whole clock-fault episode entries are refused.
        result = clockError(null, 'clock fault: entries are refused');
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
      every(settings.supplyRefreshMs, () => { void refreshMints(); });
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
