// Service HTTP clients (SPEC-A A-M14-03, card Z08): one limited, key-safe client per third-party HTTP service, and the
// Jupiter exit budget (CA-10: exits never wait for Jupiter).
//
// - Base URLs come from config (HTTPS only); a request path is resolved against the base and must stay on its origin.
// - Keys come from the secret store and are added by this module only (Jupiter `x-api-key`, CoinGecko Demo
//   `x-cg-demo-api-key`, Birdeye `X-API-KEY`); a caller passing a secret header name is refused. Any URL that is logged
//   or put in an error passes `redactUrl` first (every key-bearing query parameter becomes `[redacted]`).
// - Limits are at most 50% of each documented limit (owner rule 2026-10-06), as sliding windows (`SERVICE_LIMITS`).
//   A call waits for room in its window up to its timeout; a P0 call (exit work) never waits: no room now is
//   `E_RATE_LIMITED` at once. A 429 or 403 pauses the service for max(Retry-After, back-off 1 s → 60 s) and three of
//   them within ten minutes stop it until an operator resumes it (the same rule as the RPC gateway, A-M14-02).
// - Jupiter exit budget (logic 4): while any exit work is open (`beginExitWork` without `endExitWork`, each key expiring
//   after 120 s), Price and Tokens calls are refused at once (`exit_reserved`).
// - CoinGecko keeps a monthly cap (2,000 calls, `services.coingecko.monthly_cap`) through the usage ledger, so it
//   survives restarts; at the cap every call is refused until the next UTC month.
// - Sends (`helius_sender`, `jito`) need A-M14-04's send grants, which are M4 work: until then every send is refused
//   (`send_disabled`), like the RPC gateway's `rpc.send_enabled`.
// - Answers above 5 MB fail (`too_large`); a body that is not JSON fails (`not_json`). Answers are untrusted: callers
//   validate their shapes.
import type { HttpReq, Result, UnixMs } from '@bot/types';
import { parseRetryAfterMs } from './client.ts';
import { REDACTED } from './redact.ts';
import type { LogPort, MetricsPort, RpcError, Scheduler, SecretSource } from './types.ts';

export type ServiceName = 'jupiter' | 'dexscreener' | 'rugcheck' | 'coingecko' | 'birdeye' | 'helius_sender' | 'jito';
export const SEND_SERVICES: ReadonlySet<ServiceName> = new Set(['helius_sender', 'jito']);

/** Which of a service's limits a request draws on (Jupiter and DexScreener document more than one). */
export type Endpoint = 'swap' | 'price' | 'tokens' | 'execute' | 'pairs' | 'profiles' | 'default';

/** The frozen `HttpReq` (@bot/types) plus the endpoint whose limit the request draws on. */
export type ServiceReq = HttpReq & {
  /** Required for Jupiter (`swap`, `price`, `tokens`, `execute`); DexScreener `pairs` (default) or `profiles`. */
  endpoint?: Endpoint;
};

export interface HttpOptions { priority: 0 | 1 | 2 | 3 | 4; timeoutMs: number; sendGrantId?: string }

/** A sliding-window limit: at most `count` requests start in any `windowMs`. */
export interface WindowLimit { count: number; windowMs: number; fact: string }

/**
 * The configured limits, each 50% of its documented figure (SPEC-A A-M14-03 logic 2):
 * - Jupiter one shared bucket for Swap, Price and Tokens per organisation, 60 s sliding: keyed 1 req/s → 30 per 60 s,
 *   keyless 0.5 req/s → 15 per 60 s; `/swap/v2/execute` its own bucket, documented 50 req/s free-keyed and 20 keyless
 *   (EX-29 states requests per second) → 25 / 10 per second [EX-29, DA-29, DA-30].
 * - DexScreener 300/min for pairs, tokens and search → 150; 60/min for profiles and similar → 30 [DA-26, VF-15].
 * - RugCheck: a header limit of 15 with an undocumented window [TH-21], read as 15/min → 7/min.
 * - CoinGecko Demo 100/min → 50/min [DA-27], plus the monthly cap.
 */
export const SERVICE_LIMITS = {
  jupiter: {
    keyed: { shared: { count: 30, windowMs: 60_000, fact: 'EX-29' }, execute: { count: 25, windowMs: 1_000, fact: 'EX-29' } },
    keyless: { shared: { count: 15, windowMs: 60_000, fact: 'EX-29' }, execute: { count: 10, windowMs: 1_000, fact: 'EX-29' } },
  },
  dexscreener: { pairs: { count: 150, windowMs: 60_000, fact: 'DA-26' }, profiles: { count: 30, windowMs: 60_000, fact: 'DA-26' } },
  rugcheck: { count: 7, windowMs: 60_000, fact: 'TH-21' },
  coingecko: { count: 50, windowMs: 60_000, fact: 'DA-27' },
} as const;
export const COINGECKO_MONTHLY_CAP = 2_000;
export const MAX_SERVICE_RESPONSE_BYTES = 5 * 1_048_576;
/** Logic 4: an exit-work key left open expires after this long. */
export const EXIT_WORK_EXPIRY_MS = 120_000;
export const SERVICE_BACKOFF_BASE_MS = 1_000;
export const SERVICE_BACKOFF_MAX_MS = 60_000;
export const SERVICE_STOP_AFTER = 3;
export const SERVICE_STOP_WINDOW_MS = 600_000;
/** Ruling Z08-21: the longest Retry-After waited out (1 h); a longer one stops the service. */
export const MAX_RETRY_AFTER_MS = 3_600_000;

/** Secret header names this module adds; a caller may never pass them (case-insensitive). */
export const SECRET_HEADERS: readonly string[] = ['x-api-key', 'x-cg-demo-api-key', 'authorization'];
/** Query parameters that carry keys (Helius Sender takes `api-key` [VF-14]). */
export const SECRET_QUERY: readonly string[] = ['api-key', 'api_key', 'apikey', 'key', 'token', 'access_token', 'auth'];

export interface ServiceConfig {
  name: ServiceName;
  /** `services.<name>.base_url`, https only. */
  baseUrl: string;
  /** Secret-store name of the key, if the service takes one; the header it goes in. */
  key?: { secretRef: string; header: string };
}

export type HttpFetch = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal: AbortSignal }) => Promise<Response>;

/** Monthly call caps that survive a restart (the usage ledger implements it): true reserves one call. */
export interface MonthlyCapPort { take(service: string, atMs: UnixMs, cap: number): boolean }

export interface ServiceDeps {
  services: readonly ServiceConfig[];
  secrets: SecretSource;
  fetch: HttpFetch;
  /** Monotonic timers (windows, pauses, timeouts, exit-work expiry). */
  scheduler: Scheduler;
  /** Wall clock (UTC months of the CoinGecko cap, Retry-After dates). */
  nowMs: () => UnixMs;
  monthly: MonthlyCapPort;
  log: LogPort;
  metrics: MetricsPort;
  coingeckoMonthlyCap?: number;
}

export interface ServiceClients {
  http<T>(service: ServiceName, req: ServiceReq, o: HttpOptions): Promise<Result<T, RpcError>>;
  beginExitWork(key: string): void;
  endExitWork(key: string): void;
  resumeService(name: ServiceName): boolean;
  /** Starts left in each window now (`service_budget_remaining`). */
  remaining(): Array<{ service: ServiceName; bucket: string; left: number }>;
}

/** `url` with every key-bearing query parameter (the known ones and `extra`) replaced by `[redacted]`. */
export function redactUrl(url: string, extra: readonly string[] = []): string {
  const names = new Set([...SECRET_QUERY, ...extra].map((n) => n.toLowerCase()));
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return REDACTED;
  }
  if (u.username !== '' || u.password !== '') { u.username = REDACTED; u.password = ''; }
  const keys = [...u.searchParams.keys()];
  for (const k of keys) if (names.has(k.toLowerCase())) u.searchParams.set(k, REDACTED);
  return u.toString().split(encodeURIComponent(REDACTED)).join(REDACTED);
}

class Window {
  private starts: number[] = [];
  pausedUntil = Number.NEGATIVE_INFINITY;
  readonly limit: WindowLimit;
  constructor(limit: WindowLimit) { this.limit = limit; }
  /** When the next request may start, at or after `now`. */
  nextStart(now: number): number {
    while (this.starts.length > 0 && (this.starts[0] as number) <= now - this.limit.windowMs) this.starts.shift();
    const byCount = this.starts.length < this.limit.count ? now : (this.starts[this.starts.length - this.limit.count] as number) + this.limit.windowMs;
    return Math.max(now, byCount, this.pausedUntil);
  }
  take(at: number): void { this.starts.push(at); }
  left(now: number): number {
    while (this.starts.length > 0 && (this.starts[0] as number) <= now - this.limit.windowMs) this.starts.shift();
    return Math.max(0, this.limit.count - this.starts.filter((s) => s <= now).length);
  }
}

interface ServiceState {
  config: ServiceConfig; key: string | null; origin: string; basePath: string;
  windows: Map<string, Window>; limitedAt: number[]; stopped: boolean;
}

const isPlainHeaders = (h: unknown): h is Record<string, string> => typeof h === 'object' && h !== null && !Array.isArray(h);

export function createServiceClients(deps: ServiceDeps): ServiceClients {
  const monthlyCap = deps.coingeckoMonthlyCap ?? COINGECKO_MONTHLY_CAP;
  if (!Number.isSafeInteger(monthlyCap) || monthlyCap < 0 || monthlyCap > COINGECKO_MONTHLY_CAP) throw new RangeError('services.coingecko.monthly_cap must be 0-2,000');
  const states = new Map<ServiceName, ServiceState>();
  for (const c of deps.services) {
    let base: URL;
    try {
      base = new URL(c.baseUrl);
    } catch {
      throw new RangeError(`services.${c.name}.base_url is not a URL`);
    }
    if (base.protocol !== 'https:') throw new RangeError(`services.${c.name}.base_url must be https:`);
    if (states.has(c.name)) throw new RangeError(`services.${c.name} is configured twice`);
    const key = c.key === undefined ? null : deps.secrets.get(c.key.secretRef) ?? null;
    if (c.key !== undefined && !SECRET_HEADERS.includes(c.key.header.toLowerCase())) throw new RangeError(`services.${c.name}: ${c.key.header} is not a known secret header`);
    const windows = new Map<string, Window>();
    if (c.name === 'jupiter') {
      const l = key === null || key === '' ? SERVICE_LIMITS.jupiter.keyless : SERVICE_LIMITS.jupiter.keyed;
      windows.set('shared', new Window(l.shared));
      windows.set('execute', new Window(l.execute));
    } else if (c.name === 'dexscreener') {
      windows.set('pairs', new Window(SERVICE_LIMITS.dexscreener.pairs));
      windows.set('profiles', new Window(SERVICE_LIMITS.dexscreener.profiles));
    } else if (c.name === 'rugcheck') {
      windows.set('default', new Window(SERVICE_LIMITS.rugcheck));
    } else if (c.name === 'coingecko') {
      windows.set('default', new Window(SERVICE_LIMITS.coingecko));
    } else if (!SEND_SERVICES.has(c.name)) {
      // Birdeye: per plan [DA-22], off by default (D17 (e) not taken): no limit is configured, so it is refused.
      throw new RangeError(`services.${c.name}: no documented limit is configured`);
    }
    states.set(c.name, { config: c, key: key === '' ? null : key, origin: base.origin, basePath: base.pathname.replace(/\/+$/, ''), windows, limitedAt: [], stopped: false });
  }
  const exitWork = new Map<string, number>();
  const mono = (): number => deps.scheduler.nowMs();
  const exitOpen = (): boolean => {
    const now = mono();
    for (const [k, until] of exitWork) if (until <= now) exitWork.delete(k);
    return exitWork.size > 0;
  };
  const fail = <T>(code: RpcError['code'], message: string, extra: Partial<RpcError> = {}): Result<T, RpcError> => ({ ok: false, error: { code, message, ...extra } });
  const count = (service: ServiceName, status: string): void => { deps.metrics.counter('service_requests_total', { service, status }).inc(); };

  const windowOf = (st: ServiceState, req: ServiceReq): { name: string; w: Window } | RpcError => {
    if (st.config.name === 'jupiter') {
      if (req.endpoint === 'execute') return { name: 'execute', w: st.windows.get('execute') as Window };
      if (req.endpoint === 'swap' || req.endpoint === 'price' || req.endpoint === 'tokens') return { name: 'shared', w: st.windows.get('shared') as Window };
      return { code: 'E_HTTP', message: 'endpoint_required' };
    }
    if (st.config.name === 'dexscreener') {
      const name = req.endpoint === 'profiles' ? 'profiles' : req.endpoint === undefined || req.endpoint === 'pairs' ? 'pairs' : null;
      return name === null ? { code: 'E_HTTP', message: 'bad_endpoint' } : { name, w: st.windows.get(name) as Window };
    }
    return { name: 'default', w: st.windows.get('default') as Window };
  };

  const onLimited = (st: ServiceState, retryAfterMs: number | undefined, status: number): void => {
    const now = mono();
    st.limitedAt = [...st.limitedAt.filter((t) => t > now - SERVICE_STOP_WINDOW_MS), now];
    // Ruling Z08-21: a Retry-After above the cap is not waited out blindly: the service stops (critical) until resumed.
    if (retryAfterMs !== undefined && retryAfterMs > MAX_RETRY_AFTER_MS) {
      if (!st.stopped) {
        st.stopped = true;
        deps.log.event('critical', 'm14.service_stopped', { service: st.config.name, limited_in_window: st.limitedAt.length, reason: 'retry_after_too_long', retry_after_ms: retryAfterMs });
      }
      return;
    }
    const backoff = Math.min(SERVICE_BACKOFF_MAX_MS, SERVICE_BACKOFF_BASE_MS * 2 ** (st.limitedAt.length - 1));
    const pause = Math.max(backoff, retryAfterMs ?? 0);
    for (const x of st.windows.values()) x.pausedUntil = Math.max(x.pausedUntil, now + pause);
    deps.log.event('warn', 'm14.service_paused', { service: st.config.name, pause_ms: pause, http_status: status });
    if (st.limitedAt.length >= SERVICE_STOP_AFTER && !st.stopped) {
      st.stopped = true;
      deps.log.event('critical', 'm14.service_stopped', { service: st.config.name, limited_in_window: st.limitedAt.length });
    }
  };

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => { deps.scheduler.set(resolve, ms); });

  return {
    async http<T>(service: ServiceName, req: ServiceReq, o: HttpOptions): Promise<Result<T, RpcError>> {
      if (SEND_SERVICES.has(service)) return fail('E_RPC', 'send_disabled');
      const st = states.get(service);
      if (st === undefined) return fail('E_HTTP', 'service_not_configured');
      if (!(Number.isFinite(o.timeoutMs) && o.timeoutMs > 0 && o.timeoutMs <= 600_000)) return fail('E_HTTP', 'bad_options');
      if (st.stopped) return fail('E_RATE_LIMITED', 'service_stopped');
      if (req.headers !== undefined) {
        if (!isPlainHeaders(req.headers)) return fail('E_HTTP', 'bad_headers');
        for (const h of Object.keys(req.headers)) if (SECRET_HEADERS.includes(h.toLowerCase())) return fail('E_HTTP', 'secret_header');
      }
      if (req.query !== undefined) {
        for (const q of Object.keys(req.query)) if (SECRET_QUERY.includes(q.toLowerCase())) return fail('E_HTTP', 'secret_query');
      }
      const target = windowOf(st, req);
      if ('code' in target) return { ok: false, error: target };
      if (service === 'jupiter' && (req.endpoint === 'price' || req.endpoint === 'tokens') && exitOpen()) {
        deps.metrics.counter('jupiter_exit_reserved_total', {}).inc();
        return fail('E_RATE_LIMITED', 'exit_reserved');
      }
      // The path is appended to the base URL's path; it may not leave it (no `//`, `..`, `?`, `#` or `\`).
      if (!/^\/[A-Za-z0-9._~\-/,%:@!$&'()*+;=]*$/.test(req.path) || req.path.includes('//') || req.path.split('/').some((seg) => seg === '..' || seg === '.')) {
        return fail('E_HTTP', 'bad_path');
      }
      const url = new URL(`${st.basePath}${req.path}`, st.origin);
      for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
      const started = mono();
      const deadline = started + o.timeoutMs;
      const startAt = target.w.nextStart(started);
      if (startAt > started && o.priority === 0) return fail('E_RATE_LIMITED', 'no_room_for_exit');      // exits never wait
      if (startAt >= deadline) return fail('E_RATE_LIMITED', 'window_full');
      if (service === 'coingecko') {
        let ok = false;
        try {
          ok = deps.monthly.take('coingecko', deps.nowMs(), monthlyCap);
        } catch {
          ok = false;                                                      // fail closed
        }
        if (!ok) return fail('E_RATE_LIMITED', 'monthly_cap');
      }
      target.w.take(startAt);
      if (startAt > started) await sleep(startAt - started);
      const headers: Record<string, string> = { accept: 'application/json', ...(req.headers ?? {}) };
      if (st.key !== null && st.config.key !== undefined) headers[st.config.key.header] = st.key;
      let body: string | undefined;
      if (req.body !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(req.body); }
      const ac = new AbortController();
      let timedOut = false;
      const left = Math.max(1, deadline - mono());
      const cancel = deps.scheduler.set(() => { timedOut = true; ac.abort(); }, left);
      const done = (r: Result<T, RpcError>): Result<T, RpcError> => { cancel(); count(service, r.ok ? 'ok' : r.error.code); return r; };
      let res: Response;
      try {
        res = await deps.fetch(url.toString(), { method: req.method, headers, ...(body === undefined ? {} : { body }), signal: ac.signal });
      } catch {
        return done(fail(timedOut ? 'E_TIMEOUT' : 'E_HTTP', timedOut ? 'timeout' : 'network_error'));
      }
      if (service === 'jupiter' && res.headers.get('x-ratelimit-remaining') === '0') {
        // DA-30: the headers come on 200 and 429 answers; `x-ratelimit-reset` is Unix seconds. The window waits until the
        // reset, at most its own length; without a readable reset, its whole length.
        const reset = res.headers.get('x-ratelimit-reset');
        const resetInMs = reset !== null && /^\d{1,12}$/.test(reset.trim()) ? Number(reset.trim()) * 1_000 - deps.nowMs() : Number.NaN;
        const wait = Number.isFinite(resetInMs) ? Math.min(Math.max(0, resetInMs), target.w.limit.windowMs) : target.w.limit.windowMs;
        target.w.pausedUntil = Math.max(target.w.pausedUntil, mono() + wait);
      }
      if (res.status === 429 || res.status === 403) {
        void res.body?.cancel().catch(() => undefined);
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), deps.nowMs());
        onLimited(st, retryAfterMs, res.status);
        return done(fail(res.status === 429 ? 'E_RATE_LIMITED' : 'E_HTTP', `http_${res.status}`, { httpStatus: res.status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }));
      }
      if (res.status < 200 || res.status > 299) {
        void res.body?.cancel().catch(() => undefined);
        return done(fail('E_HTTP', `http_${res.status}`, { httpStatus: res.status }));
      }
      const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
      if (Number.isSafeInteger(declared) && declared > MAX_SERVICE_RESPONSE_BYTES) {
        ac.abort();
        return done(fail('E_HTTP', 'too_large', { httpStatus: res.status }));
      }
      let text: string;
      try {
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.byteLength > MAX_SERVICE_RESPONSE_BYTES) return done(fail('E_HTTP', 'too_large', { httpStatus: res.status }));
        text = new TextDecoder().decode(bytes);
      } catch {
        return done(fail(timedOut ? 'E_TIMEOUT' : 'E_HTTP', timedOut ? 'timeout' : 'network_error'));
      }
      try {
        return done({ ok: true, value: JSON.parse(text) as T });
      } catch {
        return done(fail('E_HTTP', 'not_json', { httpStatus: res.status }));
      }
    },
    beginExitWork(key: string): void { exitWork.set(key, mono() + EXIT_WORK_EXPIRY_MS); },
    endExitWork(key: string): void { exitWork.delete(key); },
    resumeService(name: ServiceName): boolean {
      const st = states.get(name);
      if (st === undefined || !st.stopped) return false;
      st.stopped = false;
      st.limitedAt = [];
      deps.log.event('info', 'm14.service_resumed', { service: name });
      return true;
    },
    remaining(): Array<{ service: ServiceName; bucket: string; left: number }> {
      const now = mono();
      const out: Array<{ service: ServiceName; bucket: string; left: number }> = [];
      for (const [service, st] of states) {
        let least = Number.POSITIVE_INFINITY;
        for (const [bucket, w] of st.windows) {
          const left = w.left(now);
          least = Math.min(least, left);
          out.push({ service, bucket, left });
        }
        if (Number.isFinite(least)) deps.metrics.gauge('service_budget_remaining', { service }).set(least);   // the tightest bucket
      }
      return out;
    },
  };
}
