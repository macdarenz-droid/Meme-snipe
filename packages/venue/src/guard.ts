// A-M01-04 orientation guard (stateful) and its sampler. The guard owns the quarantine set (single writer, the event
// loop); a failed check quarantines the pool once and publishes `venue.pool_quarantined` (repeats within 1 h are not
// re-published). The sampler runs logic 4: every `check_interval_ms` per watched pool it reads the latest
// `sample_signatures` signatures (`getSignaturesForAddress`, confirmed [DA-08]) and their transactions (`getTransaction`,
// `maxSupportedTransactionVersion: 1` [LD-05]) at P3 through the `SwapSource` port, decodes the PumpSwap swaps
// (A-M02-03) and checks each against M04's snapshot before it. Our own fills (topic `fill.events`) are checked the same
// way. No quarantine without evidence: a failed read just waits for the next interval (edge 5).
import type { Clock, DecodedEvent, Pubkey, RawTransaction, Result, Signature, Slot, UnixMs } from '@bot/types';
import { checkOrientation, type OrientationResult, type OrientationSettings, type SwapEvent } from './orientation.ts';
import type { CpPoolState } from './pool.ts';

export type QuarantineReason = 'orientation' | 'negative_effective' | 'owner_changed';
export interface PoolQuarantined { poolId: Pubkey; reason: QuarantineReason; atMs: UnixMs }
export interface GuardLog { event(level: 'info' | 'warn' | 'error' | 'critical', code: string, fields: Readonly<Record<string, unknown>>): void }
export interface GuardMetrics {
  orientationCheck(status: OrientationResult['status']): void; poolQuarantined(reason: QuarantineReason): void;
  /** Gauge `pools_quarantined` (ruling Z07-19): entries in the quarantine set. */
  quarantinedPools(entries: number): void;
  /** Histogram `orientation_deviation_bps` (ruling Z07-28): every evaluated swap's deviation from the model. */
  orientationDeviation(bps: number): void;
}

export interface GuardSettings extends OrientationSettings { checkIntervalMs: number; sampleSignatures: number }
export const GUARD_DEFAULTS: Readonly<GuardSettings> = Object.freeze({ checkIntervalMs: 600_000, sampleSignatures: 5, maxSlotGap: 2 });

/** The config table of A-M01-04: interval 60 s..1 h, 1..20 signatures, 0..10 slots; integers (tolerance_bps retired, Z07-20). */
export function checkGuardSettings(s: GuardSettings): Result<GuardSettings, { code: 'E_CONFIG'; key: string }> {
  const bad = (key: string) => ({ ok: false as const, error: { code: 'E_CONFIG' as const, key } });
  const inRange = (v: number, lo: number, hi: number) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!inRange(s.checkIntervalMs, 60_000, 3_600_000)) return bad('venue.orientation.check_interval_ms');
  if (!inRange(s.sampleSignatures, 1, 20)) return bad('venue.orientation.sample_signatures');
  if (!inRange(s.maxSlotGap, 0, 10)) return bad('venue.orientation.max_slot_gap');
  return { ok: true, value: s };
}

const REPUBLISH_MS = 3_600_000;
/**
 * POLICY (ruling Z07-28): a passing swap further than this from the model is logged as a warning; it quarantines
 * nothing (the old 1% figure stays a metric only, `orientation_deviation_bps`).
 */
export const DEVIATION_WARN_BPS = 2_000;
/**
 * POLICY (ruling Z07-19): the quarantine set holds this many pools before a critical alert. It evicts nothing: a pool
 * leaves the set only by review, never on unwatch, so a re-watched pool stays quarantined.
 */
export const QUARANTINE_ALERT_ENTRIES = 10_000;

export interface OrientationGuard {
  checkAgainstEvent(p: CpPoolState, e: SwapEvent): OrientationResult;
  quarantined(poolId: Pubkey): boolean;
  /** Quarantine for a reason M04 found (owner changed, negative effective reserve) or a failed check. */
  quarantine(poolId: Pubkey, reason: QuarantineReason): void;
}

export function createOrientationGuard(deps: { clock: Clock; log: GuardLog; publish(e: PoolQuarantined): void; metrics?: GuardMetrics; settings?: GuardSettings }): OrientationGuard {
  const settings = deps.settings ?? GUARD_DEFAULTS;
  const checked = checkGuardSettings(settings);
  if (!checked.ok) throw checked.error;
  // Never pruned (Z07-19): cleared only by review (a later card); unwatching a pool leaves it here.
  const set = new Map<Pubkey, { reason: QuarantineReason; publishedAtMs: number }>();

  function quarantine(poolId: Pubkey, reason: QuarantineReason): void {
    const now = deps.clock.nowMs();
    const prev = set.get(poolId);
    if (prev !== undefined && now - prev.publishedAtMs < REPUBLISH_MS) return;
    set.set(poolId, { reason, publishedAtMs: now });
    deps.metrics?.poolQuarantined(reason);
    deps.metrics?.quarantinedPools(set.size);
    if (prev === undefined && set.size === QUARANTINE_ALERT_ENTRIES) {
      deps.log.event('critical', 'm01.quarantine_set_large', { entries: set.size, alert_entries: QUARANTINE_ALERT_ENTRIES });
    }
    deps.log.event('critical', 'm01.pool_quarantined', { pool: poolId, reason });
    deps.publish({ poolId, reason, atMs: now });
  }

  return {
    checkAgainstEvent(p, e) {
      const r = checkOrientation(p, e, settings);
      deps.metrics?.orientationCheck(r.status);
      if (r.observedBps !== null) {
        deps.metrics?.orientationDeviation(r.observedBps);
        if (r.status === 'pass' && r.observedBps > DEVIATION_WARN_BPS) deps.log.event('warn', 'm01.orientation_deviation', { pool: p.poolId, observed_bps: r.observedBps, slot: e.slot });
      }
      if (r.status === 'fail') {
        deps.log.event('critical', 'm01.orientation_fail', { pool: p.poolId, observed_bps: r.observedBps, slot: e.slot });
        quarantine(p.poolId, 'orientation');
      }
      return r;
    },
    quarantined: (poolId) => set.has(poolId),
    quarantine,
  };
}

/** Reads for the sampler (the engine wires them to M14 at P3). */
export interface SwapSource {
  signatures(pool: Pubkey, limit: number): Promise<Result<Signature[], { code: string }>>;
  transaction(signature: Signature): Promise<Result<RawTransaction | null, { code: string }>>;
}

export interface OrientationSampler {
  /** Runs the checks that are due; resolves when they are done. A tick while one is running is skipped. */
  tick(watched: readonly Pubkey[]): Promise<void>;
  /** Our own fills, from topic `fill.events`. */
  onFillEvent(poolId: Pubkey, events: readonly DecodedEvent[]): void;
}

export function createOrientationSampler(deps: {
  clock: Clock; guard: OrientationGuard; source: SwapSource; decode(tx: RawTransaction): DecodedEvent[];
  /** M04: the newest snapshot of `poolId` strictly before `slot` (the guard checks the gap). */
  snapshotBefore(poolId: Pubkey, slot: Slot): CpPoolState | null;
  log: GuardLog; settings?: GuardSettings;
}): OrientationSampler {
  const settings = deps.settings ?? GUARD_DEFAULTS;
  const lastRun = new Map<Pubkey, number>();
  let running = false;

  const checkEvents = (poolId: Pubkey, events: readonly DecodedEvent[]): void => {
    for (const e of events) {
      if ((e.kind !== 'pumpswap_buy' && e.kind !== 'pumpswap_sell') || e.pool !== poolId) continue;
      const snap = deps.snapshotBefore(poolId, e.slot);
      if (snap === null) continue;                               // not evaluable: no snapshot before the swap
      deps.guard.checkAgainstEvent(snap, e);
    }
  };

  async function samplePool(poolId: Pubkey): Promise<void> {
    const sigs = await deps.source.signatures(poolId, settings.sampleSignatures);
    if (!sigs.ok) { deps.log.event('warn', 'm01.orientation_read_failed', { pool: poolId, error_code: sigs.error.code }); return; }
    for (const sig of sigs.value) {
      const tx = await deps.source.transaction(sig);
      if (!tx.ok) { deps.log.event('warn', 'm01.orientation_read_failed', { pool: poolId, error_code: tx.error.code }); return; }
      // Edge 4: failed transactions are skipped (the decoder returns no events for them too).
      if (tx.value === null || tx.value.meta.err !== null) continue;
      checkEvents(poolId, deps.decode(tx.value));
    }
  }

  return {
    async tick(watched) {
      if (running) return;
      running = true;
      try {
        for (const poolId of watched) {
          const now = deps.clock.nowMs();
          const last = lastRun.get(poolId);
          if (last !== undefined && now - last < settings.checkIntervalMs) continue;
          lastRun.set(poolId, now);
          if (!deps.guard.quarantined(poolId)) await samplePool(poolId);
        }
        for (const poolId of [...lastRun.keys()]) if (!watched.includes(poolId)) lastRun.delete(poolId);
      } finally {
        running = false;
      }
    },
    onFillEvent: checkEvents,
  };
}
