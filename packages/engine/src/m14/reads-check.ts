// M0 exit check: do the two free providers answer reads (docs/blueprint/INTEGRATION.md, M0 row)? Loads the default
// providers through the registry and calls each one alone through the gateway (so the rate limiter applies): one getSlot
// and one getHealth (a second getSlot where getHealth is not served). The report holds only the label, PASS or FAIL, the
// slot and the latency; never a URL, key, header or response body. No HTTP code of its own: the m14 client sends.
import type { Clock, EventBus } from '@bot/types';
import { createRpcClient } from './client.ts';
import { DEFAULT_PROVIDERS } from './defaults.ts';
import { createRpcGateway, type StopState, type StopStore } from './gateway.ts';
import { envSecrets, loadProviders } from './providers.ts';
import { scrubberFor } from './redact.ts';
import type { CallOptions, FetchLike, LogPort, MetricsPort, Scheduler } from './types.ts';

export interface ReadCheckDeps {
  /** Holds the two secrets named by the default providers (`RPC_SHYFT_URL`, `RPC_CHAINSTACK_URL`). */
  env: Readonly<Record<string, string | undefined>>;
  fetch: FetchLike;
  clock: Clock;
  scheduler: Scheduler;
}

export interface ReadCheckResult { ok: boolean; lines: string[] }

const CALL_TIMEOUT_MS = 20_000;
const READ: CallOptions = { priority: 1, role: 'read', commitment: 'confirmed', timeoutMs: CALL_TIMEOUT_MS };
/** getHealth takes no commitment (methods.ts). */
const HEALTH: CallOptions = { priority: 1, role: 'read', timeoutMs: CALL_TIMEOUT_MS };
const noopLog: LogPort = { event: () => undefined };
const noopMetrics: MetricsPort = {
  counter: () => ({ inc: () => undefined }),
  gauge: () => ({ set: () => undefined }),
  histogram: () => ({ observe: () => undefined }),
};
const noopBus: EventBus = { publish: () => undefined, subscribe: () => () => undefined };

class MemoryStopStore implements StopStore {
  private state: StopState = { stopped: [], recent: [] };
  load(): StopState { return this.state; }
  save(state: StopState): void { this.state = state; }
}

/** A slot is printed only when it is plain digits; anything else is `-`. */
const slotText = (v: unknown): string => {
  const s = typeof v === 'number' || typeof v === 'bigint' || typeof v === 'string' ? String(v) : '';
  return /^\d{1,20}$/.test(s) ? s : '-';
};

export async function runReadCheck(deps: ReadCheckDeps): Promise<ReadCheckResult> {
  const labels = DEFAULT_PROVIDERS.map((p) => p.label);
  const urls = DEFAULT_PROVIDERS.map((p) => deps.env[p.urlSecretRef]).filter((u): u is string => typeof u === 'string' && u !== '');
  const scrub = scrubberFor(urls);
  const failAll = (): ReadCheckResult => ({ ok: false, lines: labels.map((l) => `${l} FAIL slot=- latency_ms=-`) });
  const allocation = { consumer: 'engine', shares: Object.fromEntries(labels.map((l) => [l, { engine: 10_000 }])) };
  const loaded = loadProviders(DEFAULT_PROVIDERS, envSecrets(deps.env), { context: 'engine', p0ReserveBps: 2_000, allocation }, noopLog);
  if (!loaded.ok) return failAll();
  const registry = loaded.value;
  const client = createRpcClient({ fetch: deps.fetch, clock: deps.clock, scheduler: deps.scheduler, bus: noopBus, metrics: noopMetrics, scrub });
  const gw = createRpcGateway({
    registry, context: 'engine', client, clock: deps.clock, scheduler: deps.scheduler, log: noopLog, metrics: noopMetrics,
    stopStore: new MemoryStopStore(), usage: { projectedOver80: () => false },
  });
  const lines: string[] = [];
  let ok = true;
  for (const label of labels) {
    const config = DEFAULT_PROVIDERS.find((p) => p.label === label)!;
    let pass = false;
    let slot = '-';
    let latency = '-';
    if (registry.providers.some((p) => p.config.label === label)) {
      try {
        const first = await gw.call<unknown>('getSlot', [], { ...READ, provider: label });
        if (first.ok) {
          slot = slotText(first.value.value);
          latency = String(Math.max(0, Math.round(first.value.latencyMs)));
          const second = config.methods.includes('getHealth')
            ? await gw.call<unknown>('getHealth', [], { ...HEALTH, provider: label })
            : await gw.call<unknown>('getSlot', [], { ...READ, provider: label });
          pass = second.ok && slot !== '-';
        }
      } catch {
        pass = false;
      }
    }
    if (!pass) ok = false;
    lines.push(scrub(`${label} ${pass ? 'PASS' : 'FAIL'} slot=${slot} latency_ms=${latency}`));
  }
  return { ok, lines };
}
