// Test doubles for M14: a fake clock with ordered timers, an in-process mock HTTP server (real `Response` objects, no
// network), and recording log, metrics and event-bus ports.
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62); runner moved from node:test to Vitest.
import type { Clock, EventBus, UnixMs } from '@bot/types';
import type { RecentLimited, StoppedProvider, StopState, StopStore } from '../../src/m14/gateway.ts';
import { METHODS } from '../../src/m14/methods.ts';
import type { FetchLike, Labels, LogLevel, LogPort, MetricsPort, ProviderConfig, Scheduler } from '../../src/m14/types.ts';

export class FakeTime implements Clock, Scheduler {
  readonly kind = 'sim' as const;
  now = 1_000_000;
  private timers: Array<{ at: number; seq: number; fn: () => void }> = [];
  private seq = 0;
  nowMs(): UnixMs { return this.now as UnixMs; }
  set(fn: () => void, ms: number): () => void {
    const t = { at: this.now + ms, seq: this.seq++, fn };
    this.timers.push(t);
    return () => { this.timers = this.timers.filter((x) => x !== t); };
  }
  pending(): number { return this.timers.length; }
  /** Advances the clock by `ms`, firing due timers in order and letting promises settle after each one. */
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    await flush();
    for (;;) {
      this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.timers[0];
      if (next === undefined || next.at > end) break;
      this.timers.shift();
      this.now = Math.max(this.now, next.at);
      next.fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

/** Lets pending promise callbacks run. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
}

/** A StopStore in memory; share one between two gateways to model a restart. */
export class MemoryStopStore implements StopStore {
  stopped: StoppedProvider[] = [];
  recent: RecentLimited[] = [];
  saves = 0;
  load(): StopState { return { stopped: this.stopped, recent: this.recent }; }
  save(state: StopState): void { this.saves += 1; this.stopped = [...state.stopped]; this.recent = [...state.recent]; }
}

export class RecordingLog implements LogPort {
  events: Array<{ level: LogLevel; code: string; fields: Readonly<Record<string, unknown>> }> = [];
  event(level: LogLevel, code: string, fields: Readonly<Record<string, unknown>> = {}): void { this.events.push({ level, code, fields }); }
}

export class RecordingMetrics implements MetricsPort {
  counts = new Map<string, number>();
  gauges = new Map<string, number>();
  observations: Array<{ name: string; labels: Labels; value: number }> = [];
  private static key(name: string, labels: Labels): string { return `${name}${JSON.stringify(labels)}`; }
  counter(name: string, labels: Labels): { inc(by?: number): void } {
    const k = RecordingMetrics.key(name, labels);
    return { inc: (by = 1) => { this.counts.set(k, (this.counts.get(k) ?? 0) + by); } };
  }
  gauge(name: string, labels: Labels): { set(value: number): void } {
    const k = RecordingMetrics.key(name, labels);
    return { set: (v) => { this.gauges.set(k, v); } };
  }
  histogram(name: string, labels: Labels): { observe(value: number): void } {
    return { observe: (value) => { this.observations.push({ name, labels, value }); } };
  }
  count(name: string, labels: Labels): number { return this.counts.get(RecordingMetrics.key(name, labels)) ?? 0; }
}

export class RecordingBus implements EventBus {
  published: Array<{ topic: string; e: unknown }> = [];
  publish<T>(topic: string, e: T): void { this.published.push({ topic, e }); }
  subscribe<T>(_topic: string, _h: (e: T) => void): () => void { return () => undefined; }
}

export interface SeenRequest { url: string; body: { jsonrpc: string; id: number; method: string; params: unknown[] }; signal: AbortSignal }
export type Handler = (req: SeenRequest) => Response | Promise<Response>;

/** An in-process mock HTTP server: routes by URL to a handler and records every request body. */
export class MockServer {
  seen: SeenRequest[] = [];
  private handlers = new Map<string, Handler>();
  route(url: string, h: Handler): void { this.handlers.set(url, h); }
  readonly fetch: FetchLike = async (url, init) => {
    const req: SeenRequest = { url, body: JSON.parse(init.body) as SeenRequest['body'], signal: init.signal };
    this.seen.push(req);
    const h = this.handlers.get(url);
    if (h === undefined) throw new TypeError('fetch failed');
    return h(req);
  };
}

export const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
export const rpcResult = (result: unknown): Handler => (req) => json({ jsonrpc: '2.0', id: req.body.id, result });

/** A handler that never answers until the request is aborted (a hung provider). */
export const hang: Handler = (req) => new Promise<Response>((_resolve, reject) => {
  req.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
});

export const PUBLIC_RPC_LIMITS = [
  { scope: 'total', count: 100, windowMs: 10_000, fact: 'LD-26' },
  { scope: 'per_method', count: 40, windowMs: 10_000, fact: 'LD-26' },
] as const;

export function provider(over: Partial<ProviderConfig> & { label: string }): ProviderConfig {
  return {
    transport: 'https',
    urlSecretRef: `RPC_URL_${over.label.toUpperCase().replace(/-/g, '_')}`,
    roles: ['read'],
    unmeteredPrimary: false,
    failoverOrder: 1,
    limits: { rps: 5 },
    documentedLimits: [{ scope: 'total', count: 10, windowMs: 1_000, fact: 'LD-33' }],
    methods: Object.keys(METHODS),                     // Z03 ruling 4: every method unless a case says otherwise
    rateLimitRpcErrors: [],
    metering: null,
    allowInLivePaths: true,
    ...over,
  };
}
