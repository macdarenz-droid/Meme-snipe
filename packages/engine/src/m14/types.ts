// M14 RPC gateway: public types (A-M14-01, A-M14-02; ARCH M14). `RpcGateway` and `RpcError` are the ARCH M14
// interface; `ProviderConfig` is the NEW config schema of A-M14-01 plus the owner's data-source fields (2026-10-06).
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62). Z03 additions: `limits.ownerMaxRps` (SPEC-A A-M14-02 config: a
// provider's bucket runs at the lower of its configured rate and the owner's own cap, Chainstack one read every 2 s)
// and `MetricsPort` typed by the M27 catalog, so the M27 registry is the port and every metric name is checked.
import type { Commitment, Result, Slot, UnixMs } from '@bot/types';
import type { CounterName, GaugeName, HistogramName, LabelsOf } from '../m27/catalog.ts';

export type Priority = 0 | 1 | 2 | 3 | 4;
export type CallRole = 'read' | 'send';
export type ProviderRole = 'read' | 'send' | 'stream';

export interface CallOptions { priority: Priority; role: CallRole; commitment?: Commitment; timeoutMs: number; provider?: string }

export type RpcErrorCode = 'E_RATE_LIMITED' | 'E_TIMEOUT' | 'E_HTTP' | 'E_RPC' | 'E_ALL_PROVIDERS_DOWN';
/**
 * ARCH M14 `RpcError`, plus two optional fields: `httpStatus` (the HTTP status of an `E_HTTP` or `E_RATE_LIMITED`
 * answer, read by the failover and back-off rules) and `rpcCode` (the JSON-RPC error code of an `E_RPC` answer:
 * "code kept", A-M14-01 logic 5). Messages never hold a URL or key (logic 2).
 */
export interface RpcError { code: RpcErrorCode; retryAfterMs?: number; message: string; httpStatus?: number; rpcCode?: number }

export interface CallValue<T> { value: T; providerLabel: string; latencyMs: number; contextSlot: Slot | null }

export type GatewayMode = 'normal' | 'degraded_reads';

export interface RpcGateway {
  call<T>(method: string, params: unknown[], o: CallOptions): Promise<Result<CallValue<T>, RpcError>>;
  mode(): GatewayMode;
}

/**
 * A documented provider limit: at most `count` requests per `windowMs`, for all methods together (`total`), for each
 * RPC method (`per_method`) or for `sendTransaction` (`send`); or at most `count` response bytes per `windowMs`
 * (`bytes`; the public RPC documents 100 MB per 30 s [LD-26]). `fact` names the register entry (for example LD-26).
 * Owner rule (2026-10-06): the configured rates stay at or below half of every request limit (checked at load), and
 * the gateway meters response bytes against half of every byte limit (review C03 R3).
 */
export interface DocumentedLimit { scope: 'total' | 'per_method' | 'send' | 'bytes'; count: number; windowMs: number; fact: string }

/**
 * A-M14-01 `ProviderConfig` (NEW config schema) with `limits.perMethodRps` and `documentedLimits` (owner rule), and
 * `limits.ownerMaxRps` (Z03): a cap the owner set below half of the documented limit. The registry runs every bucket
 * of the provider at no more than it (SPEC-A A-M14-02: "Chainstack the lower of 2.5 req/s and the owner's one read
 * every 2 s (0.5 req/s)").
 */
export interface ProviderConfig {
  label: string;
  transport: 'https' | 'wss';
  urlSecretRef: string;                    // name of the secret holding the full URL, including any key
  roles: ProviderRole[];
  unmeteredPrimary: boolean;
  failoverOrder: number;
  limits: { rps: number; sendRps?: number; heavyRps?: number; perMethodRps?: number; ownerMaxRps?: number };
  documentedLimits: DocumentedLimit[];
  /**
   * The RPC methods this provider serves on this plan (names from methods.ts), as its documentation states (Z03 ruling
   * 4): a method missing here is never sent to it.
   */
  methods: string[];
  /**
   * JSON-RPC errors the provider documents as rate limits in an HTTP 200 answer, by exact code and exact message (Z03
   * rulings 4 and 13): such an answer counts as a rate limit (pause, stop count, failover). Any other JSON-RPC error is
   * not a rate limit; an HTTP 429 always is. Empty when the provider documents none.
   */
  rateLimitRpcErrors: Array<{ code: number; message: string }>;
  /**
   * This process's share of the provider's budgets, in basis points (Z03 rulings m12 and 15), set by `loadProviders`
   * from the allocation: the rates above are already scaled by it, and the gateway meters response bytes against
   * `50% of each documented byte limit × budgetShareBps / 10,000`. Absent: the whole budget (a registry built by hand).
   */
  budgetShareBps?: number;
  metering: { unit: 'credits' | 'requests'; monthlyAllowance: number; methodCost: Record<string, number> } | null;
  allowInLivePaths: boolean;
}

/** Where the gateway runs: the engine never routes to a provider with `allowInLivePaths = false` (A-M14-01 logic 1). */
export type GatewayContext = 'engine' | 'research';

/** A provider whose URL was read from the secret store. The URL lives only here, in memory. */
export interface ResolvedProvider { config: ProviderConfig; url: string }

/** Published on the event bus for every response that carries a context slot (ARCH 5.0b I-07). */
export interface ContextSlotEvent { providerLabel: string; contextSlot: Slot; method: string; atMs: UnixMs }
export const CONTEXT_SLOT_TOPIC = 'rpc.context_slot';

// ---- ports (M27 logging and metrics, the secret store, timers and HTTP), injected so tests need no network ----
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';
/** M27's `Logger` satisfies this; the codes and their fields are in `M14_LOG_CODES` (log.ts). */
export interface LogPort { event(level: LogLevel, code: string, fields?: Readonly<Record<string, unknown>>): void }
export type Labels = Readonly<Record<string, string>>;
/** M27's `MetricsRegistry` satisfies this; names and label sets come from the M27 catalog. */
export interface MetricsPort {
  counter<N extends CounterName>(name: N, labels: LabelsOf<N>): { inc(by?: number): void };
  gauge<N extends GaugeName>(name: N, labels: LabelsOf<N>): { set(value: number): void };
  histogram<N extends HistogramName>(name: N, labels: LabelsOf<N>): { observe(value: number): void };
}
/** Reads a secret by name (ARCH 12.4: `/etc/bot/secrets.env`, loaded into the environment by systemd). */
export interface SecretSource { get(name: string): string | undefined }
/**
 * Timers and the monotonic time they run on. `set` returns a function that cancels the timer; `nowMs` is milliseconds
 * on a clock that never steps (any origin; production: `performance.now`, from the clock module), so pacing, pauses,
 * deadlines and the stop window survive a wall-clock step (review C03 R5).
 */
export interface Scheduler { set(fn: () => void, ms: number): () => void; nowMs(): number }
export type FetchLike = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;
