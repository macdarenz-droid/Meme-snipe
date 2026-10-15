// Provider health and the degraded-reads mode (SPEC-A A-M14-05 logic 1, 4 and 5; card Z08). Pure state over the
// answers the gateway reports (`GatewayDeps.observe`); no I/O. Times are wall-clock milliseconds as the caller passes
// them; a time that goes backwards is treated as no time passing.
//
// Logic 1, per provider: latency p50/p95/p99 over 60 s, `errorRateBps` over 5 min, `requestsPerMin` (last 60 s), the
// highest context slot seen and `slotLag = highestSeenSlot − slot`, `lastOkAtMs`. Status `down` after 10 s
// (`rpc.health.down_after_ms`) of attempts with no success, or 5 consecutive failures; `degraded` when the error rate
// is above 200 bps, the slot lag above 10 [ARCH 8.5], or a 429 came in the last 60 s; else `ok`.
// Logic 4: the unmetered primary with no success for 60 s while requests were attempted (`rpc.degraded.enter_after_ms`;
// answered only with 429s counts as no success) → `degraded_reads`, published and alerted (warn); back to `normal` after
// 60 s of continuous success (`rpc.degraded.exit_after_ms`).
// Logic 5: calls failing with E_ALL_PROVIDERS_DOWN for 10 s → overall `down`, alert critical.
import type { ProviderHealth, Slot, UnixMs } from '@bot/types';
import type { GatewayMode, LogPort, ProviderRole } from './types.ts';

export const LATENCY_WINDOW_MS = 60_000;
export const ERROR_WINDOW_MS = 300_000;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const MAX_CONSECUTIVE_FAILURES = 5;
export const DEGRADED_ERROR_BPS = 200;
export const DEGRADED_SLOT_LAG = 10;
/** Logic 5: E_ALL_PROVIDERS_DOWN for this long → overall `down`. */
export const ALL_DOWN_AFTER_MS = 10_000;

export interface Answer { provider: string; atMs: UnixMs; latencyMs: number; ok: boolean; rateLimited: boolean; contextSlot: Slot | null }

interface Track {
  label: string; role: ProviderRole;
  events: Array<{ atMs: number; latencyMs: number; ok: boolean; rateLimited: boolean }>;
  slot: Slot | null; lastOkAtMs: UnixMs | null; failingSince: number | null; consecutiveFailures: number;
}

/** The nearest-rank percentile of sorted values (null when empty). */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

export interface HealthTracker {
  record(a: Answer): void;
  health(nowMs: UnixMs, highestSeenSlot: Slot | null, usage?: (provider: string) => { used: number; allowance: number; projected: number } | null): ProviderHealth[];
}

export function createHealthTracker(providers: ReadonlyArray<{ label: string; role: ProviderRole }>, downAfterMs: number): HealthTracker {
  const tracks = new Map<string, Track>(providers.map((p) => [p.label, {
    label: p.label, role: p.role, events: [], slot: null, lastOkAtMs: null, failingSince: null, consecutiveFailures: 0,
  }]));
  const prune = (t: Track, now: number): void => {
    let i = 0;
    while (i < t.events.length && (t.events[i] as { atMs: number }).atMs <= now - ERROR_WINDOW_MS) i += 1;
    if (i > 0) t.events.splice(0, i);
  };
  return {
    record(a: Answer): void {
      const t = tracks.get(a.provider);
      if (t === undefined) return;
      t.events.push({ atMs: a.atMs, latencyMs: a.latencyMs, ok: a.ok, rateLimited: a.rateLimited });
      prune(t, a.atMs);
      if (a.contextSlot !== null && (t.slot === null || a.contextSlot > t.slot)) t.slot = a.contextSlot;
      if (a.ok) {
        t.lastOkAtMs = a.atMs;
        t.failingSince = null;
        t.consecutiveFailures = 0;
      } else {
        t.failingSince ??= a.atMs;
        t.consecutiveFailures += 1;
      }
    },
    health(nowMs, highestSeenSlot, usage): ProviderHealth[] {
      return [...tracks.values()].map((t) => {
        prune(t, nowMs);
        const recent = t.events.filter((e) => e.atMs > nowMs - LATENCY_WINDOW_MS);
        const lat = recent.map((e) => e.latencyMs).sort((a, b) => a - b);
        const errors = t.events.filter((e) => !e.ok).length;
        const errorRateBps = t.events.length === 0 ? 0 : Math.round((errors * 10_000) / t.events.length);
        // ProviderHealth.slotLag is a count of slots (a number); clamped first, so the bigint gap converts exactly.
        const gap: bigint | null = highestSeenSlot === null || t.slot === null ? null : highestSeenSlot > t.slot ? highestSeenSlot - t.slot : 0n;
        const slotLag = gap === null ? null : gap > 1_000_000n ? 1_000_000 : Number(gap);
        const limited = recent.some((e) => e.rateLimited && e.atMs > nowMs - RATE_LIMIT_WINDOW_MS);
        const down = (t.failingSince !== null && nowMs - t.failingSince >= downAfterMs) || t.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
        const degraded = errorRateBps > DEGRADED_ERROR_BPS || (slotLag !== null && slotLag > DEGRADED_SLOT_LAG) || limited;
        const u = usage?.(t.label) ?? null;
        return {
          endpointId: t.label, label: t.label, role: t.role,
          latencyMsP50: percentile(lat, 50), latencyMsP95: percentile(lat, 95), latencyMsP99: percentile(lat, 99),
          errorRateBps, requestsPerMin: recent.length, slot: t.slot, slotLag, lastOkAtMs: t.lastOkAtMs,
          status: down ? 'down' : degraded ? 'degraded' : 'ok',
          monthlyUsed: u === null ? null : u.used, monthlyAllowance: u === null ? null : u.allowance, projectedMonthEnd: u === null ? null : u.projected,
        };
      });
    },
  };
}

export interface ModeChange { mode: GatewayMode; since: UnixMs; reason: string }

export interface ModeMachine {
  /** An answer from the unmetered primary. */
  primaryAnswer(atMs: UnixMs, ok: boolean): void;
  /** The end of a whole gateway call: `allDown` when it failed with E_ALL_PROVIDERS_DOWN, `ok` when it succeeded. */
  callEnded(atMs: UnixMs, result: 'ok' | 'all_down' | 'other'): void;
  /** Re-evaluates the time rules with no new answer (call every second). */
  tick(atMs: UnixMs): void;
  mode(): GatewayMode;
  overall(): 'ok' | 'down';
}

export function createModeMachine(o: { enterAfterMs: number; exitAfterMs: number; log: LogPort; publish: (c: ModeChange) => void }): ModeMachine {
  let mode: GatewayMode = 'normal';
  let failingSince: number | null = null;
  let okSince: number | null = null;
  let allDownSince: number | null = null;
  let overall: 'ok' | 'down' = 'ok';
  const evaluate = (now: number): void => {
    if (mode === 'normal' && failingSince !== null && now - failingSince >= o.enterAfterMs) {
      mode = 'degraded_reads';
      okSince = null;
      o.log.event('warn', 'm14.mode_changed', { rpc_mode: mode, reason: 'primary_failing' });
      o.publish({ mode, since: now, reason: 'primary_failing' });
    } else if (mode === 'degraded_reads' && okSince !== null && now - okSince >= o.exitAfterMs) {
      mode = 'normal';
      failingSince = null;
      o.log.event('info', 'm14.mode_changed', { rpc_mode: mode, reason: 'primary_recovered' });
      o.publish({ mode, since: now, reason: 'primary_recovered' });
    }
    if (overall === 'ok' && allDownSince !== null && now - allDownSince >= ALL_DOWN_AFTER_MS) {
      overall = 'down';
      o.log.event('critical', 'm14.all_providers_down', {});
    }
  };
  return {
    primaryAnswer(atMs, ok): void {
      if (ok) {
        failingSince = null;
        okSince ??= atMs;
      } else {
        failingSince ??= atMs;
        okSince = null;
      }
      evaluate(atMs);
    },
    callEnded(atMs, result): void {
      if (result === 'ok') {
        allDownSince = null;
        if (overall === 'down') { overall = 'ok'; o.log.event('info', 'm14.providers_recovered', {}); }
      } else if (result === 'all_down') {
        allDownSince ??= atMs;
      }
      evaluate(atMs);
    },
    tick(atMs): void { evaluate(atMs); },
    mode: () => mode,
    overall: () => overall,
  };
}

/**
 * The gateway's A-M14-05 wiring in one place: `observe` feeds the health tracker and the mode machine, `mode` and
 * `health` read them, and the `publish` callback carries `rpc.mode` (the composition root publishes it on the bus).
 */
export interface ProviderMonitor {
  observe: {
    answer(a: { provider: string; latencyMs: number; ok: boolean; rateLimited: boolean; timeout?: boolean; contextSlot: Slot | null }): void;
    callEnded(result: 'ok' | 'all_down' | 'other'): void;
  };
  mode(): GatewayMode;
  overall(): 'ok' | 'down';
  tick(): void;
  health(highestSeenSlot: Slot | null, usage?: (provider: string) => { used: number; allowance: number; projected: number } | null): ProviderHealth[];
}

export function createProviderMonitor(o: {
  providers: ReadonlyArray<{ label: string; role: ProviderRole; unmeteredPrimary: boolean }>;
  downAfterMs: number; enterAfterMs: number; exitAfterMs: number;
  nowMs: () => UnixMs; log: LogPort; publish: (c: ModeChange) => void;
  /** Ruling Z08-22: the account ledger's four counts get every answer (ok, error, timeout). */
  meter?: { record(provider: string, outcome: 'ok' | 'error' | 'timeout'): void };
}): ProviderMonitor {
  const tracker = createHealthTracker(o.providers, o.downAfterMs);
  const machine = createModeMachine({ enterAfterMs: o.enterAfterMs, exitAfterMs: o.exitAfterMs, log: o.log, publish: o.publish });
  const primaries = new Set(o.providers.filter((p) => p.unmeteredPrimary).map((p) => p.label));
  return {
    observe: {
      answer(a): void {
        const atMs = o.nowMs();
        tracker.record({ provider: a.provider, atMs, latencyMs: a.latencyMs, ok: a.ok, rateLimited: a.rateLimited, contextSlot: a.contextSlot });
        if (primaries.has(a.provider)) machine.primaryAnswer(atMs, a.ok);
        o.meter?.record(a.provider, a.ok ? 'ok' : a.timeout === true ? 'timeout' : 'error');
      },
      callEnded(result): void { machine.callEnded(o.nowMs(), result); },
    },
    mode: () => machine.mode(),
    overall: () => machine.overall(),
    tick(): void { machine.tick(o.nowMs()); },
    health: (highestSeenSlot, usage) => tracker.health(o.nowMs(), highestSeenSlot, usage),
  };
}

/** Ruling Z08-17: at most one health probe of the primary every this long while degraded. */
export const DEGRADED_PROBE_EVERY_MS = 30_000;

/**
 * Ruling Z08-17. While `degraded_reads`, every P≥2 call is refused, so with no position (no P0/P1 traffic) nothing
 * would ever reach the primary and the mode could never end. This probe sends one P1 `getSlot` pinned to the primary at
 * most every 30 s, through the gateway (so inside its limiter and buckets); the answer reaches the mode machine through
 * `observe`, and 60 s of success ends the mode. It sends nothing in `normal` mode. Call `tick()` every second.
 */
export function createDegradedProbe(o: {
  gateway: { call(method: string, params: unknown[], opts: { priority: 1; role: 'read'; commitment: 'confirmed'; timeoutMs: number; provider: string }): Promise<unknown>; mode(): GatewayMode };
  primary: string; nowMs: () => number; everyMs?: number; timeoutMs?: number;
}): { tick(): void } {
  const every = o.everyMs ?? DEGRADED_PROBE_EVERY_MS;
  let last = Number.NEGATIVE_INFINITY;
  let inFlight = false;
  return {
    tick(): void {
      const now = o.nowMs();
      if (o.gateway.mode() !== 'degraded_reads' || inFlight || (now - last < every && now >= last)) return;
      last = now;
      inFlight = true;
      void o.gateway.call('getSlot', [], { priority: 1, role: 'read', commitment: 'confirmed', timeoutMs: o.timeoutMs ?? 3_000, provider: o.primary })
        .catch(() => undefined).finally(() => { inFlight = false; });
    },
  };
}
