// The recorder's read path (card Z10): M14's registry, client, gateway, account ledger and provider health, and M15's
// slot clock, wired once. Read roles only: `rpc.send_enabled` stays false and no provider has a send role, so a call
// with `role = 'send'` is refused before any request (A-M14-04; Z10 "no send path").
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock, EventBus, UnixMs } from '@bot/types';
import type { Db } from '../m24/db.ts';
import { createRepos } from '../m24/repos.ts';
import { openUsageLedger } from '../m24/usage-ledger.ts';
import { createRpcClient } from '../m14/client.ts';
import { DEFAULT_PROVIDERS } from '../m14/defaults.ts';
import { createRpcGateway, type Gateway, type StopState, type StopStore } from '../m14/gateway.ts';
import { createDegradedProbe, createProviderMonitor, type ProviderMonitor } from '../m14/health.ts';
import { createUsageMeter, type UsageMeter } from '../m14/meter.ts';
import { loadProviders, type Allocation, type ProviderRegistry } from '../m14/providers.ts';
import { scrubberFor } from '../m14/redact.ts';
import type { M14Settings } from '../m14/settings.ts';
import type { FetchLike, LogPort, MetricsPort, ProviderConfig, Scheduler, SecretSource } from '../m14/types.ts';
import { consumerCaps } from '../m14/usage.ts';
import { createSlotClock, type RunningSlotClock } from '../m15/clock.ts';
import type { M15Settings } from '../m15/settings.ts';

/** The consumer this process is in the allocation file (A-M14-05). */
export const CONSUMER = 'engine';
/** The two secret names the recorder reads, and the credential files (systemd `LoadCredentialEncrypted`) they come from. */
export const SECRET_FILES: Readonly<Record<string, string>> = Object.freeze({ RPC_SHYFT_URL: 'rpc_shyft_url', RPC_CHAINSTACK_URL: 'rpc_chainstack_url' });

/** Secrets from the unit's credentials folder: only the two RPC URLs are ever read; any other name is undefined. */
export function credentialSecrets(dir: string | undefined): SecretSource {
  return {
    get(name: string): string | undefined {
      const file = SECRET_FILES[name];
      if (dir === undefined || dir === '' || file === undefined) return undefined;
      const path = join(dir, file);
      if (!existsSync(path)) return undefined;
      const v = readFileSync(path, 'utf8').trim();
      return v === '' ? undefined : v;
    },
  };
}

/** A synchronous in-process bus (M14 publishes context slots; M15 subscribes). A handler that throws is isolated. */
export function createBus(onError: (topic: string) => void): EventBus {
  const subs = new Map<string, Set<(e: unknown) => void>>();
  return {
    publish<T>(topic: string, e: T): void {
      for (const h of subs.get(topic) ?? []) {
        try { h(e); } catch { onError(topic); }
      }
    },
    subscribe<T>(topic: string, h: (e: T) => void): () => void {
      const set = subs.get(topic) ?? new Set();
      subs.set(topic, set);
      set.add(h as (e: unknown) => void);
      return () => { set.delete(h as (e: unknown) => void); };
    },
  };
}

const STOP_KEY = 'm14.stop_state';

/** M14's stop state in M24 `kv_state`, so a restart loop never resets the "stop after 3 failures" rule. */
export function kvStopStore(db: Db, nowMs: () => UnixMs): StopStore {
  const repos = createRepos();
  return {
    load(): StopState {
      const r = repos.kv_state.get(db.reader(), { key: STOP_KEY });
      if (r === null) return { stopped: [], recent: [] };
      const v = typeof r.valueJson === 'string' ? JSON.parse(r.valueJson) : r.valueJson;
      return v as StopState;                                            // the gateway checks the shape (bad_shape)
    },
    save(state: StopState): void {
      db.withTx((tx) => { const t = nowMs(); repos.kv_state.upsert(tx, { key: STOP_KEY, valueJson: JSON.stringify(state), createdAt: t, updatedAt: t }); });
    },
  };
}

export interface ReadPath {
  registry: ProviderRegistry;
  gateway: Gateway;
  monitor: ProviderMonitor;
  meter: UsageMeter;
  clock: RunningSlotClock;
  bus: EventBus;
  /** The enabled read providers' labels, in failover order. */
  labels: readonly string[];
  primary: string;
  /** Call every second: health mode machine and the degraded-mode probe. */
  tick(): void;
}

export type ReadPathError = { code: 'E_PROVIDERS' | 'E_ALLOCATION'; message: string };

export function createReadPath(o: {
  db: Db; settings: M14Settings; slot: M15Settings; secrets: SecretSource; fetch: FetchLike; clock: Clock; scheduler: Scheduler;
  log: LogPort; metrics: MetricsPort; allocation: Allocation; credits: unknown; usageDbPath: string; providers?: readonly ProviderConfig[];
}): { ok: true; value: ReadPath } | { ok: false; error: ReadPathError } {
  const configs = o.providers ?? DEFAULT_PROVIDERS;
  if (configs.some((c) => c.roles.some((r) => r !== 'read'))) return { ok: false, error: { code: 'E_PROVIDERS', message: 'the recorder takes read providers only' } };
  const loaded = loadProviders(configs, o.secrets, { context: 'engine', p0ReserveBps: o.settings.p0ReserveBps, allocation: o.allocation }, o.log);
  if (!loaded.ok) return { ok: false, error: { code: 'E_PROVIDERS', message: loaded.error.problems.map((p) => `${p.key}: ${p.message}`).join('; ') } };
  const registry = loaded.value;
  const labels = registry.providers.map((p) => p.config.label);
  const primary = registry.providers.find((p) => p.config.unmeteredPrimary)?.config.label;
  if (primary === undefined) return { ok: false, error: { code: 'E_PROVIDERS', message: 'no unmetered primary read provider is enabled' } };
  const metered = registry.providers.flatMap((p) => (p.config.metering === null ? [] : [{ label: p.config.label, metering: p.config.metering }]));
  const caps = consumerCaps(o.credits, new Map([...o.settings.accountCaps].filter(([l]) => metered.some((m) => m.label === l))), CONSUMER);
  if (!caps.ok) return { ok: false, error: { code: 'E_ALLOCATION', message: caps.error.problems.map((p) => `${p.provider}: ${p.message}`).join('; ') } };
  const nowMs = (): UnixMs => o.clock.nowMs();
  const meter = createUsageMeter({
    consumer: CONSUMER, providers: metered, caps: caps.value, blockUnits: o.settings.reserveBlockUnits, alertBps: o.settings.burnAlertBps,
    openLedger: () => openUsageLedger(o.usageDbPath), nowMs, log: o.log,
  });
  const bus = createBus((topic) => o.log.event('error', 'recorder.bus_handler_failed', { topic }));
  const scrub = scrubberFor(registry.providers.map((p) => p.url));
  const client = createRpcClient({ fetch: o.fetch, clock: o.clock, scheduler: o.scheduler, bus, metrics: o.metrics, scrub, maxResponseBytes: o.settings.maxResponseBytes });
  const monitor = createProviderMonitor({
    providers: registry.providers.map((p) => ({ label: p.config.label, role: 'read' as const, unmeteredPrimary: p.config.unmeteredPrimary })),
    downAfterMs: o.settings.healthDownAfterMs, enterAfterMs: o.settings.degradedEnterAfterMs, exitAfterMs: o.settings.degradedExitAfterMs,
    nowMs, log: o.log, publish: (c) => bus.publish('rpc.mode', c), meter,
  });
  const gateway = createRpcGateway({
    registry, context: 'engine', client, clock: o.clock, scheduler: o.scheduler, log: o.log, metrics: o.metrics,
    stopStore: kvStopStore(o.db, nowMs), p0ReserveBps: o.settings.p0ReserveBps, usage: meter, mode: monitor.mode, meter, observe: monitor.observe,
    sendEnabled: false,
  });
  const clock = createSlotClock({ gateway, bus, clock: o.clock, scheduler: o.scheduler, log: o.log, metrics: o.metrics, settings: o.slot, primaryProvider: primary, providers: labels });
  const probe = createDegradedProbe({ gateway, primary, nowMs: () => o.scheduler.nowMs() });
  return { ok: true, value: { registry, gateway, monitor, meter, clock, bus, labels, primary, tick() { monitor.tick(); probe.tick(); } } };
}
