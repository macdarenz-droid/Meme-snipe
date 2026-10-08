// JSON-RPC 2.0 client (A-M14-01 logic 3-6): one POST per call with Node's built-in fetch, a timeout through
// AbortController, a response size cap, the parameter rules of methods.ts, error mapping and the context slot of every
// response. Stateless: buckets, priorities and failover are A-M14-02 (gateway.ts). Nothing here logs or returns a URL.
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62), review fixes C03-R1-2, R5, R7 and red team R8-2 included.
import type { Clock, Commitment, EventBus, Result, Slot, UnixMs } from '@bot/types';
import { parseJsonLossless } from './json.ts';
import { prepareParams } from './methods.ts';
import { MAX_TIMER_MS } from './timers.ts';
import {
  CONTEXT_SLOT_TOPIC, type CallRole, type CallValue, type ContextSlotEvent, type FetchLike, type MetricsPort,
  type ResolvedProvider, type RpcError, type Scheduler,
} from './types.ts';

/** `rpc.max_response_bytes` default: 50 MB (A-M14-01 config). */
export const DEFAULT_MAX_RESPONSE_BYTES = 52_428_800;

export interface RpcClientDeps {
  fetch: FetchLike;
  clock: Clock;
  scheduler: Scheduler;
  bus: EventBus;
  metrics: MetricsPort;
  /** Scrubs provider text of URLs and keys (redact.ts). */
  scrub: (text: string) => string;
  maxResponseBytes?: number;
}

export interface RequestOptions {
  role: CallRole;
  commitment?: Commitment;
  timeoutMs: number;
  /** A higher cap for one call (enumeration, A-M03-03); never below the configured default. */
  maxResponseBytes?: number;
  /**
   * The provider's remaining byte budget (gateway, owner rule; review C03 R3): an answer larger than this is aborted
   * as `too_large`, whatever the caps above allow.
   */
  byteBudget?: number;
  /** Told the number of response body bytes read, once per request that got a response (also partial reads). */
  onBytes?: (bytes: number) => void;
  /** Told how an answer refused as `too_large` was refused (the gateway sets the method's byte need from it). */
  onTooLarge?: (info: TooLargeInfo) => void;
}

/** An answer refused as `too_large` (red team C03 R6-1, R8-2). */
export interface TooLargeInfo {
  /** The least size the answer has: its declared Content-Length (nothing read), or the bytes read when the client stopped. */
  atLeastBytes: number;
  /** Refused on its declared Content-Length, before any body byte was read: `atLeastBytes` is its size. */
  declared: boolean;
  /**
   * The answer is larger than the client's own cap (`rpc.max_response_bytes`, or the call's higher cap), whatever the
   * byte budget: this client can never read it.
   */
  overOwnCap: boolean;
}

export interface RpcClient {
  request<T>(provider: ResolvedProvider, method: string, params: readonly unknown[], o: RequestOptions): Promise<Result<CallValue<T>, RpcError>>;
}

const rawJSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;
/** JSON body; a bigint parameter (a slot, an amount) is written as an exact JSON integer. */
function stringifyBody(body: unknown): string {
  return JSON.stringify(body, (_k, v: unknown) => (typeof v === 'bigint' ? rawJSON(v.toString()) : v));
}

/** RFC 9110 5.6.7 IMF-fixdate, e.g. `Sun, 06 Nov 1994 08:49:37 GMT`. */
const IMF_FIXDATE = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/;

/**
 * `Retry-After` in milliseconds (RFC 9110 10.2.3): delta-seconds (a non-negative integer) or an IMF-fixdate; anything
 * else, `Date.parse`'s lenient forms included (`garbage 7`, `-5`, `1.5`), counts as absent (Z03 ruling 1). A past date
 * gives 0; the gateway's back-off still pauses (gateway.ts `onLimited`).
 */
export function parseRetryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (header === null) return undefined;
  const h = header.trim();
  if (/^\d+$/.test(h)) return Number.parseInt(h, 10) * 1000;
  if (!IMF_FIXDATE.test(h)) return undefined;
  const at = Date.parse(h);
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

function contextSlotOf(result: unknown): Slot | null {
  if (typeof result !== 'object' || result === null || !('context' in result)) return null;
  const context = (result as { context: unknown }).context;
  if (typeof context !== 'object' || context === null || !('slot' in context)) return null;
  const s = (context as { slot: unknown }).slot;
  if (typeof s === 'bigint' && s >= 0n) return s;
  return typeof s === 'number' && Number.isSafeInteger(s) && s >= 0 ? BigInt(s) : null;
}

class TooLarge extends Error {}

async function readCapped(res: Response, cap: number, abort: () => void, counted: (bytes: number) => void): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    if (res.body !== null) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > cap) {
          abort();
          throw new TooLarge();
        }
        chunks.push(value);
      }
    }
  } finally {
    counted(total);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

export function createRpcClient(deps: RpcClientDeps): RpcClient {
  const defaultCap = deps.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  if (!Number.isSafeInteger(defaultCap) || defaultCap < 1) throw new RangeError('rpc.max_response_bytes must be a positive integer');
  let nextId = 1;

  return {
    async request<T>(provider: ResolvedProvider, method: string, params: readonly unknown[], o: RequestOptions): Promise<Result<CallValue<T>, RpcError>> {
      const label = provider.config.label;
      const prepared = prepareParams(method, params, o.role, o.commitment);
      if (!prepared.ok) return { ok: false, error: { code: 'E_RPC', message: prepared.problem } };
      if (!(o.timeoutMs > 0 && o.timeoutMs <= MAX_TIMER_MS)) return { ok: false, error: { code: 'E_RPC', message: 'bad_options' } };
      const ownCap = Math.max(defaultCap, o.maxResponseBytes ?? 0);
      const cap = Math.min(ownCap, o.byteBudget ?? Number.POSITIVE_INFINITY);
      const tooLarge = (atLeastBytes: number, declared: boolean): void => { o.onTooLarge?.({ atLeastBytes, declared, overOwnCap: atLeastBytes > ownCap }); };
      const started = deps.scheduler.nowMs();                    // latency on the monotonic clock (review C03 R5)
      const ac = new AbortController();
      let timedOut = false;
      const cancel = deps.scheduler.set(() => { timedOut = true; ac.abort(); }, o.timeoutMs);
      const finish = (r: Result<CallValue<T>, RpcError>): Result<CallValue<T>, RpcError> => {
        cancel();
        deps.metrics.counter('rpc_requests_total', { provider: label, method, status: r.ok ? 'ok' : r.error.code }).inc();
        deps.metrics.histogram('rpc_latency_ms', { provider: label, method }).observe(deps.scheduler.nowMs() - started);
        return r;
      };
      const fail = (error: RpcError): Result<CallValue<T>, RpcError> => finish({ ok: false, error });
      const id = nextId++;
      let res: Response;
      try {
        res = await deps.fetch(provider.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: stringifyBody({ jsonrpc: '2.0', id, method, params: prepared.params }),
          signal: ac.signal,
        });
      } catch {
        return fail(timedOut ? { code: 'E_TIMEOUT', message: 'timeout' } : { code: 'E_HTTP', message: 'network_error' });
      }
      if (res.status === 429) {
        void res.body?.cancel().catch(() => undefined);
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), deps.clock.nowMs());
        return fail({ code: 'E_RATE_LIMITED', message: 'http_429', httpStatus: 429, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
      }
      if (res.status < 200 || res.status > 299) {
        void res.body?.cancel().catch(() => undefined);
        const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'), deps.clock.nowMs());
        return fail({ code: 'E_HTTP', message: `http_${res.status}`, httpStatus: res.status, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
      }
      const declared = Number.parseInt(res.headers.get('content-length') ?? '', 10);
      if (Number.isSafeInteger(declared) && declared > cap) {
        ac.abort();
        tooLarge(declared, true);
        return fail({ code: 'E_HTTP', message: 'too_large', httpStatus: res.status });
      }
      let bytes: Uint8Array;
      let read = 0;
      try {
        bytes = await readCapped(res, cap, () => ac.abort(), (n) => { read = n; o.onBytes?.(n); });
      } catch (e) {
        if (e instanceof TooLarge) {
          tooLarge(read, false);
          return fail({ code: 'E_HTTP', message: 'too_large', httpStatus: res.status });
        }
        // A connection lost while reading the body is a network error like one before the headers: no httpStatus, so
        // the gateway fails a P0/P1 read over to the next provider (A-M14-02 logic 4; review C03-R1-2).
        return fail(timedOut ? { code: 'E_TIMEOUT', message: 'timeout' } : { code: 'E_HTTP', message: 'network_error' });
      }
      let body: unknown;
      try {
        body = parseJsonLossless(new TextDecoder().decode(bytes));
      } catch {
        return fail({ code: 'E_HTTP', message: 'not_json', httpStatus: res.status });
      }
      if (typeof body !== 'object' || body === null || Array.isArray(body)) return fail({ code: 'E_HTTP', message: 'bad_response', httpStatus: res.status });
      // JSON-RPC 2.0: the answer names the version and echoes the request's id; anything else is not this call's answer
      // (Z03 ruling m8). A protocol error is a failure like a bad response.
      if ((body as { jsonrpc?: unknown }).jsonrpc !== '2.0' || (body as { id?: unknown }).id !== id) {
        return fail({ code: 'E_HTTP', message: 'protocol_error', httpStatus: res.status });
      }
      if ('error' in body && body.error !== undefined && body.error !== null) {
        const e = body.error as { code?: unknown; message?: unknown };
        const rpcCode = typeof e.code === 'number' && Number.isSafeInteger(e.code) ? e.code : undefined;
        const message = deps.scrub(typeof e.message === 'string' ? e.message : 'rpc_error');
        return fail({ code: 'E_RPC', message, ...(rpcCode === undefined ? {} : { rpcCode }) });
      }
      if (!('result' in body)) return fail({ code: 'E_HTTP', message: 'bad_response', httpStatus: res.status });
      const result = (body as { result: unknown }).result;
      const contextSlot = contextSlotOf(result);
      if (contextSlot !== null) {
        deps.bus.publish<ContextSlotEvent>(CONTEXT_SLOT_TOPIC, { providerLabel: label, contextSlot, method, atMs: deps.clock.nowMs() as UnixMs });
      }
      return finish({ ok: true, value: { value: result as T, providerLabel: label, latencyMs: deps.scheduler.nowMs() - started, contextSlot } });
    },
  };
}
