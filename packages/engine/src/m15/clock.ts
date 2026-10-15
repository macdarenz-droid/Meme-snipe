// M15 slot clock (B-M15-01): the primary slot and block height, the highest slot seen from any provider, per-provider
// height readings and the measured slot duration, so that observation lag (ARCH 8.5) and M18's expiry proof are
// computed soundly and never mix readings from different providers (ARCH M15 rule).
//
// VERIFY (research/verify-m0-m1/RESULTS.md, rows 28-30, read 2026-10-07): `getEpochInfo` returns `absoluteSlot` and
// `blockHeight` in one result [A-36]; `getBlockTime` is whole seconds, so it is never used for sub-second measurement
// [A-37]; `getRecentPerformanceSamples` returns `slot`, `numTransactions`, `numSlots`, `samplePeriodSecs` and
// `numNonVoteTransactions` (register #84).
import type { BlockHeight, Clock, EventBus, Result, Slot, UnixMs } from '@bot/types';
import { CONTEXT_SLOT_TOPIC, type ContextSlotEvent, type LogPort, type MetricsPort, type RpcGateway, type Scheduler } from '../m14/types.ts';
import type { M15Settings } from './settings.ts';
import { liveSlotTimeBasis, SLOT_MS_MAX, SLOT_MS_MIN, type SlotTimeBasis } from './slot-time.ts';

/** ARCH 5, M15: one reading from one response of one provider. */
export interface HeightReading { providerLabel: string; slot: Slot; blockHeight: BlockHeight; commitment: 'confirmed'; atMs: UnixMs }
export type HeightError = { code: 'E_RPC' | 'E_TIMEOUT' | 'E_PROVIDER_UNKNOWN' | 'E_PROVIDER_LAGGING' };

export interface SlotClock {
  slot(): Slot;
  blockHeight(): BlockHeight;
  slotDurationMsEstimate(): number;
  highestSeenSlot(): Slot;
  observationLagSlots(contextSlot: Slot): number;
  heightOn(providerLabel: string): Promise<Result<HeightReading, HeightError>>;
  providerSlotLag(providerLabel: string): number | null;
  lastReadingAgeMs(): number;
  /** The live basis of the one slot-to-time function (slot-time.ts): the primary reading and the slot estimate. */
  slotTimeBasis(): SlotTimeBasis;
}

export interface SlotClockDeps {
  gateway: RpcGateway;
  bus: EventBus;
  /** Wall clock: reading times (`atMs`), the time base of `slotTimeBasis`. */
  clock: Clock;
  scheduler: Scheduler;
  log: LogPort;
  metrics: MetricsPort;
  settings: M15Settings;
  /** The primary read provider's label (the slot-and-height loop reads it at P0). */
  primaryProvider: string;
  /** Every provider label M14 knows; `heightOn` refuses any other. */
  providers: readonly string[];
}

export interface RunningSlotClock extends SlotClock {
  /** Reads the first height and samples and starts both loops (context slots are subscribed from creation). */
  start(): Promise<void>;
  stop(): void;
}

/** ARCH 8.5 provider lag rule: a provider more than this many slots behind the highest seen slot is lagging. */
export const PROVIDER_LAG_LIMIT = 10;
/** Edge case 2: consecutive primary failures before the read is left to M14's failover. */
export const FAILOVER_AFTER = 3;
/** Logic 4: performance samples are read every 60 s at P4, the last 30 (30 one-minute samples, acceptance 4). */
export const SAMPLES_EVERY_MS = 60_000;
export const SAMPLES_LIMIT = 30;
/** CL-02 / ARCH 11.2: the poll interval in degraded reads. */
export const DEGRADED_POLL_MS = 10_000;
/** Lag returned when nothing has been seen yet: as stale as a number can say (fail closed). */
export const LAG_UNKNOWN = Number.MAX_SAFE_INTEGER;
const SAMPLES_TIMEOUT_MS = 5_000;

const maxSlot = (a: Slot, b: Slot): Slot => (a > b ? a : b);
const toLag = (d: bigint): number => (d <= 0n ? 0 : d > BigInt(LAG_UNKNOWN) ? LAG_UNKNOWN : Number(d));

/** A non-negative integer from a JSON number or (beyond 2^53) a bigint; null for anything else. */
function u64(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v >= 0n ? v : null;
  return Number.isSafeInteger(v) && (v as number) >= 0 ? BigInt(v as number) : null;
}

/** `getEpochInfo` result → (slot, height), or null when malformed. */
export function parseEpochInfo(v: unknown): { slot: Slot; blockHeight: BlockHeight } | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  const s = u64(o.absoluteSlot), h = u64(o.blockHeight);
  return s === null || h === null ? null : { slot: s as Slot, blockHeight: h as BlockHeight };
}

/**
 * Logic 4: `1000 × Σ samplePeriodSecs / Σ numSlots`. Null when the list is empty, malformed, counts no slot, or gives a
 * slot time outside SLOT_MS_MIN..SLOT_MS_MAX (the caller keeps its previous estimate).
 */
export function slotMsFromSamples(v: unknown): { ms: number } | { problem: 'empty' | 'invalid' } {
  if (!Array.isArray(v)) return { problem: 'invalid' };
  if (v.length === 0) return { problem: 'empty' };
  let slots = 0, secs = 0;
  for (const s of v) {
    if (typeof s !== 'object' || s === null) return { problem: 'invalid' };
    const { numSlots, samplePeriodSecs } = s as Record<string, unknown>;
    if (!Number.isSafeInteger(numSlots) || (numSlots as number) < 0) return { problem: 'invalid' };
    if (!Number.isSafeInteger(samplePeriodSecs) || (samplePeriodSecs as number) <= 0) return { problem: 'invalid' };
    slots += numSlots as number;
    secs += samplePeriodSecs as number;
  }
  if (slots === 0) return { problem: 'empty' };
  const ms = (1_000 * secs) / slots;
  return ms >= SLOT_MS_MIN && ms <= SLOT_MS_MAX ? { ms } : { problem: 'invalid' };
}

export function createSlotClock(deps: SlotClockDeps): RunningSlotClock {
  const { gateway, bus, clock, scheduler, log, metrics, settings, primaryProvider } = deps;
  const known = new Set(deps.providers);
  if (!known.has(primaryProvider)) throw new RangeError('m15: the primary provider is not a known provider');

  let highestSeen: Slot | null = null;
  const lastContextSlot = new Map<string, Slot>();
  let primary: HeightReading | null = null;
  let slotMs = settings.slotMsInitial;
  let primaryFailures = 0;
  let unsubscribe: (() => void) | null = null;
  let cancelPoll: (() => void) | null = null;
  let cancelSamples: (() => void) | null = null;
  let running = false;

  /** Logic 1, applied to context slots and to the clock's own readings: max, with the outlier rule. */
  const observe = (provider: string, s: Slot, method: string): void => {
    if (highestSeen !== null && s > highestSeen + BigInt(settings.maxFutureSlotJump)) {
      const old = highestSeen;
      const agreeing = [...lastContextSlot].some(([p, cs]) => p !== provider && cs + BigInt(PROVIDER_LAG_LIMIT) >= old);
      if (agreeing) {
        log.event('warn', 'm15.slot_outlier', { provider, context_slot: s, highest_seen_slot: old, method });
        return;
      }
    }
    highestSeen = highestSeen === null ? s : maxSlot(highestSeen, s);
    const prev = lastContextSlot.get(provider);
    lastContextSlot.set(provider, prev === undefined ? s : maxSlot(prev, s));
    metrics.gauge('highest_seen_slot', {}).set(Number(highestSeen));
    for (const [p, cs] of lastContextSlot) metrics.gauge('provider_slot_lag', { provider: p }).set(toLag(highestSeen - cs));
  };

  const onContextSlot = (e: ContextSlotEvent): void => {
    if (typeof e?.contextSlot !== 'bigint' || e.contextSlot < 0n || typeof e.providerLabel !== 'string') return;
    observe(e.providerLabel, e.contextSlot, e.method);
  };

  const readEpochInfo = async (provider: string | undefined): Promise<Result<HeightReading, HeightError>> => {
    const r = await gateway.call<unknown>('getEpochInfo', [], {
      priority: 0, role: 'read', commitment: 'confirmed', timeoutMs: settings.heightTimeoutMs, ...(provider === undefined ? {} : { provider }),
    });
    if (!r.ok) return { ok: false, error: { code: r.error.code === 'E_TIMEOUT' ? 'E_TIMEOUT' : 'E_RPC' } };
    // Never combine a slot from one provider with a height from another: both come from this one response.
    if (provider !== undefined && r.value.providerLabel !== provider) return { ok: false, error: { code: 'E_RPC' } };
    const parsed = parseEpochInfo(r.value.value);
    if (parsed === null) return { ok: false, error: { code: 'E_RPC' } };
    return { ok: true, value: { providerLabel: r.value.providerLabel, slot: parsed.slot, blockHeight: parsed.blockHeight, commitment: 'confirmed', atMs: clock.nowMs() } };
  };

  /** Logic 2 and edge case 2: one primary read; after 3 primary failures in a row, M14 picks the provider. */
  const pollHeight = async (): Promise<void> => {
    const failedOver = primaryFailures >= FAILOVER_AFTER;
    const r = await readEpochInfo(failedOver ? undefined : primaryProvider);
    if (r.ok) {
      primary = r.value;
      if (r.value.providerLabel === primaryProvider) primaryFailures = 0;
      observe(r.value.providerLabel, r.value.slot, 'getEpochInfo');
    } else if (!failedOver) {
      primaryFailures++;
      if (primaryFailures === FAILOVER_AFTER) log.event('warn', 'm15.height_failover', { provider: primaryProvider, failures: primaryFailures });
    }
    metrics.gauge('height_reading_age_ms', {}).set(ageMs());
  };

  /** Logic 4 and edge case 4: keep the previous estimate on an empty, malformed or failed read. */
  const pollSamples = async (): Promise<void> => {
    const r = await gateway.call<unknown>('getRecentPerformanceSamples', [SAMPLES_LIMIT], { priority: 4, role: 'read', timeoutMs: SAMPLES_TIMEOUT_MS });
    if (!r.ok) return;
    const est = slotMsFromSamples(r.value.value);
    if ('problem' in est) {
      log.event('warn', 'm15.samples_empty', { reason: est.problem });
      return;
    }
    slotMs = est.ms;
    metrics.gauge('slot_duration_ms_estimate', {}).set(slotMs);
  };

  const ageMs = (): number => (primary === null ? Infinity : Math.max(0, clock.nowMs() - primary.atMs));

  const loop = (fn: () => Promise<void>, every: () => number, setCancel: (c: (() => void) | null) => void): void => {
    if (!running) return;
    setCancel(scheduler.set(() => {
      void fn().catch(() => undefined).finally(() => loop(fn, every, setCancel));
    }, every()));
  };

  const subscribe = (): void => { unsubscribe ??= bus.subscribe<ContextSlotEvent>(CONTEXT_SLOT_TOPIC, onContextSlot); };
  // Context slots count from creation, so a reading taken during start already has them.
  subscribe();

  const api: RunningSlotClock = {
    slot() {
      if (primary === null) throw new RangeError('m15: no height reading yet');
      return primary.slot;
    },
    blockHeight() {
      if (primary === null) throw new RangeError('m15: no height reading yet');
      return primary.blockHeight;
    },
    slotDurationMsEstimate: () => slotMs,
    // Edge case 1: before any context slot this is the primary reading's slot (the readings feed the same max).
    highestSeenSlot: () => highestSeen ?? (0n as Slot),
    observationLagSlots: (contextSlot) => (highestSeen === null ? LAG_UNKNOWN : toLag(highestSeen - contextSlot)),
    providerSlotLag(p) {
      const cs = lastContextSlot.get(p);
      return cs === undefined || highestSeen === null ? null : toLag(highestSeen - cs);
    },
    async heightOn(p) {
      if (!known.has(p)) {
        log.event('warn', 'm15.provider_unknown', { provider: p });
        return { ok: false, error: { code: 'E_PROVIDER_UNKNOWN' } };
      }
      const lag = api.providerSlotLag(p);
      if (lag !== null && lag > PROVIDER_LAG_LIMIT) return { ok: false, error: { code: 'E_PROVIDER_LAGGING' } };
      const r = await readEpochInfo(p);
      if (r.ok) observe(p, r.value.slot, 'getEpochInfo');
      return r;
    },
    lastReadingAgeMs: ageMs,
    slotTimeBasis() {
      if (primary === null) throw new RangeError('m15: no height reading yet');
      return liveSlotTimeBasis({ slot: primary.slot, atMs: primary.atMs }, slotMs);
    },
    async start() {
      if (running) return;
      running = true;
      subscribe();
      await Promise.all([pollHeight(), pollSamples()]);
      loop(pollHeight, () => (gateway.mode() === 'degraded_reads' ? DEGRADED_POLL_MS : settings.heightPollMs), (c) => { cancelPoll = c; });
      loop(pollSamples, () => SAMPLES_EVERY_MS, (c) => { cancelSamples = c; });
    },
    stop() {
      running = false;
      unsubscribe?.();
      cancelPoll?.();
      cancelSamples?.();
      unsubscribe = cancelPoll = cancelSamples = null;
    },
  };
  return api;
}
