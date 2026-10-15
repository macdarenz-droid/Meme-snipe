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
import { checkM04Settings, intervalOf, M04_DEFAULTS, type M04Settings } from './settings.ts';
import { createPollSource, type PoolSource, type SourceRecord } from './source.ts';
import type {
  AccountsReader, ChainStatePort, MintInfo, PoolAddresses, PoolClass, PoolModelPort, PoolSnapshot, PoolStateLike, RawAccount, SchedulerPort,
  TrackerLog, TrackerMetrics, TrackerOutputs,
} from './types.ts';

export type FreshReadError = { code: 'E_STALE' | 'E_RPC'; detail: string };

export interface PoolTracker<P extends PoolStateLike> {
  watch(poolId: Pubkey, priority: PoolClass): void;
  unwatch(poolId: Pubkey): void;
  latest(poolId: Pubkey): PoolSnapshot<P> | null;
  history(poolId: Pubkey, fromMs: UnixMs, toMs: UnixMs): ReadonlyArray<PoolSnapshot<P>>;
  /** M01's orientation guard: the newest snapshot strictly before `slot`. */
  snapshotBefore(poolId: Pubkey, slot: Slot): PoolSnapshot<P> | null;
  lagNow(s: PoolSnapshot<P>): number;
  /** Display only (VM-07 `quote_age_ms`): lag × M15's measured slot time (bug B1). */
  lagMs(s: PoolSnapshot<P>): number;
  freshRead(poolId: Pubkey, maxLagSlots: number): Promise<Result<PoolSnapshot<P>, FreshReadError>>;
  /** Pools watched and ready (read once, mint known). */
  ready(): Pubkey[];
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

export interface TrackerDeps<P extends PoolStateLike> {
  model: PoolModelPort<P>; reader: AccountsReader; scheduler: SchedulerPort; chain: ChainStatePort; clock: Clock;
  outputs: TrackerOutputs<P>; log: TrackerLog; metrics?: TrackerMetrics; settings?: M04Settings;
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
  const checked = checkM04Settings(settings);
  if (!checked.ok) throw checked.error;
  const poll = (): PoolSource => createPollSource({ reader: deps.reader, scheduler: deps.scheduler, settings, log: deps.log, ...(deps.metrics === undefined ? {} : { metrics: deps.metrics }) });
  let source = deps.source ?? poll();
  const pools = new Map<Pubkey, Entry<P>>();
  const providers: string[] = [];
  const inflight = new Map<Pubkey, { exit?: Promise<Result<PoolSnapshot<P>, FreshReadError>>; entry?: Promise<Result<PoolSnapshot<P>, FreshReadError>> }>();
  /** The cancel of each periodic timer's pending fire (one slot per timer, so nothing grows). */
  const timers: Array<{ cancel: () => void }> = [];
  let mintsBusy = false;

  const capacity = (cls: PoolClass): number => Math.ceil(settings.historyMs / intervalOf(settings, cls));
  const lagOf = (slot: Slot): number => {
    const d = deps.chain.highestSeenSlot() - slot;
    return d > 0n ? Number(d) : 0;
  };

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
      providerLabel, providerSlot: contextSlot, readLatencyMs: latencyMs, observationLagSlots: lagOf(contextSlot), rawHash: rawHashOf(accounts),
    };
  }

  /** The monotonic rule, then the ring and the outputs. `exit` reads are not discarded for lag. */
  function store(e: Entry<P>, s: PoolSnapshot<P>, exit: boolean): boolean {
    const ring = e.ring as SnapshotRing<P>;
    const last = ring.latest();
    if (last !== null && s.providerSlot < last.providerSlot) {
      deps.metrics?.counter('snapshot_out_of_order_total', {});
      return false;
    }
    if (!exit && s.observationLagSlots > settings.maxProviderLagSlots) {
      deps.outputs.providerLagging(s.providerLabel, s.observationLagSlots);
      return false;
    }
    ring.push(s);
    deps.metrics?.observe('observation_lag_slots', { pool: s.pool.poolId, provider: s.providerLabel }, s.observationLagSlots);
    deps.outputs.snapshot(s, e.cls);
    return true;
  }

  function onRecord(r: SourceRecord): void {
    for (const { poolId, accounts } of r.entries) {
      const e = pools.get(poolId);
      if (e === undefined || e.ring === null) continue;
      const s = snapshotOf(e, accounts, r.contextSlot, r.providerLabel, r.latencyMs);
      if (s !== null) store(e, s, false);
    }
  }
  source.onAccounts(onRecord);

  async function readPool(poolId: Pubkey, priority: 0 | 1, provider: string | undefined, exit: boolean): Promise<PoolSnapshot<P> | null> {
    const e = pools.get(poolId);
    if (e === undefined || e.addr === null) return null;
    const a = e.addr;
    const r = await deps.reader.read([a.poolId, a.baseVault, a.quoteVault], { priority, ...(provider === undefined ? {} : { provider }) });
    const now = pools.get(poolId);
    if (!r.ok || now === undefined || now.ring === null) return null;
    const s = snapshotOf(now, r.value.accounts, r.value.contextSlot, r.value.providerLabel, r.value.latencyMs);
    if (s !== null) store(now, s, exit);
    return s;
  }

  const nextProvider = (after: string): string | undefined => {
    const order = deps.providerOrder();
    const i = order.indexOf(after);
    return order.find((p, k) => p !== after && k > i) ?? order.find((p) => p !== after);
  };

  async function entryRead(poolId: Pubkey, maxLag: number): Promise<Result<PoolSnapshot<P>, FreshReadError>> {
    const first = await readPool(poolId, 1, undefined, false);
    if (first !== null && lagOf(first.providerSlot) <= maxLag) return { ok: true, value: first };
    const again = await readPool(poolId, 1, first === null ? undefined : nextProvider(first.providerLabel), false);
    if (again !== null && lagOf(again.providerSlot) <= maxLag) return { ok: true, value: again };
    if (first === null && again === null) return { ok: false, error: { code: 'E_RPC', detail: 'every read failed' } };
    deps.metrics?.counter('fresh_read_stale_total', {});
    return { ok: false, error: { code: 'E_STALE', detail: 're-read on the next provider is still behind' } };
  }

  async function exitRead(poolId: Pubkey): Promise<Result<PoolSnapshot<P>, FreshReadError>> {
    const first = await readPool(poolId, 0, undefined, true);
    const second = first !== null && lagOf(first.providerSlot) <= settings.buildLagSlots ? null : await readPool(poolId, 0, first === null ? undefined : nextProvider(first.providerLabel), true);
    const best = [first, second].filter((s): s is PoolSnapshot<P> => s !== null).sort((x, y) => (y.providerSlot > x.providerSlot ? 1 : y.providerSlot < x.providerSlot ? -1 : 0))[0];
    if (best === undefined) return { ok: false, error: { code: 'E_RPC', detail: 'every read failed' } };
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
      const lag = lagOf(last.providerSlot);
      if (lag > settings.staleLagSlots) {
        if (e.staleSinceMs !== null) continue;
        e.staleSinceMs = now;
        deps.log.event('warn', 'm04.pool_stale', { pool: poolId, lag_slots: lag });
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
      if (e !== undefined) {
        if (e.cls === priority) return;
        e.cls = priority;
        e.ring?.resize(capacity(priority));
        restartSource();
        return;
      }
      const entry: Entry<P> = { cls: priority, addr: null, canonical: null, mint: null, ring: null, staleSinceMs: null, boot: null, bootRetryAtMs: 0 };
      pools.set(poolId, entry);
      entry.boot = bootstrap(poolId);
    },
    unwatch: drop,
    latest: (poolId) => pools.get(poolId)?.ring?.latest() ?? null,
    history: (poolId, fromMs, toMs) => pools.get(poolId)?.ring?.history(fromMs, toMs) ?? [],
    snapshotBefore: (poolId, slot) => pools.get(poolId)?.ring?.before(slot) ?? null,
    lagNow: (s) => lagOf(s.providerSlot),
    lagMs: (s) => lagOf(s.providerSlot) * deps.chain.slotDurationMsEstimate(),
    async freshRead(poolId, maxLagSlots) {
      const started = deps.scheduler.nowMs();
      const exit = maxLagSlots === Number.POSITIVE_INFINITY;
      const slot = inflight.get(poolId) ?? {};
      inflight.set(poolId, slot);
      let result: Result<PoolSnapshot<P>, FreshReadError>;
      if (exit) {
        slot.exit ??= exitRead(poolId).finally(() => { delete slot.exit; });
        result = await slot.exit;
      } else if (slot.exit !== undefined) {
        // Edge 3: an exit read in flight serves the entry caller, who applies its own limit.
        const r = await slot.exit;
        result = r.ok && lagOf(r.value.providerSlot) > maxLagSlots ? { ok: false, error: { code: 'E_STALE', detail: 'the exit read is behind the entry limit' } } : r;
      } else {
        slot.entry ??= entryRead(poolId, maxLagSlots).finally(() => { delete slot.entry; });
        const r = await slot.entry;
        result = r.ok && lagOf(r.value.providerSlot) > maxLagSlots ? { ok: false, error: { code: 'E_STALE', detail: 'the shared read is behind this limit' } } : r;
      }
      deps.metrics?.observe('fresh_read_latency_ms', { grade: exit ? 'exit' : 'entry' }, deps.scheduler.nowMs() - started);
      return result;
    },
    ready: () => [...pools.values()].filter((e) => e.ring !== null).map((e) => (e.addr as PoolAddresses).poolId),
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
