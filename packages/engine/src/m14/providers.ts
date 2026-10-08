// Provider registry and endpoint validation (A-M14-01 logic 1 and 2; ARCH M14 "HTTPS only", CA-30; owner rule
// 2026-10-06 on data sources). Config problems return `E_CONFIG` and stop the load (fail closed); a missing secret
// only disables its provider. Messages name the provider label and the config key, never a URL or a key.
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62), review fixes C03 R4 and N2 included. Z03 adds `limits.ownerMaxRps`
// (SPEC-A A-M14-02: the bucket runs at the lower of the configured rate and the owner's cap).
import type { Result } from '@bot/types';
import { methodSpec } from './methods.ts';
import type { DocumentedLimit, GatewayContext, LogPort, ProviderConfig, ResolvedProvider, SecretSource } from './types.ts';

export interface ConfigProblem { key: string; message: string }
export interface ConfigError { code: 'E_CONFIG'; problems: ConfigProblem[] }
export interface ProviderWarning { label: string; code: 'egress_host_missing' | 'egress_allowlist_missing'; message: string }

export interface RegistryOptions {
  context: GatewayContext;
  /** Hosts of the M30 egress allowlist; a provider host not listed is a warning (A-M14-01 logic 1). */
  egressHosts?: readonly string[];
  /**
   * How each provider's budget (its rates and response bytes, at most 50% of the documented limits) is split between the
   * processes that read it (Z03 rulings m12 and 15; ARCH D04 and 11.1, SPEC-A A-M14-05: the engine, the sentinel and the
   * signer all read providers, and a research process reads under its own share). Required in every context. See
   * `Allocation`.
   */
  allocation?: Allocation;
  /**
   * `rpc.p0_reserve_bps`: the part of each rate only P0 may use (rulings 25, 31). Required, with no default, so the floor
   * is checked against the reserve the gateway will run with; `createRpcGateway` checks it again with its own.
   */
  p0ReserveBps: number;
}

/**
 * The split of every provider's budget (rates and response bytes) between consumers, in basis points of that budget,
 * and the consumer this process is. Per provider the shares add up to at most 10,000, or the load refuses (`E_CONFIG`,
 * `allocation_exceeds_cap`; SPEC-A A-M14-05 `E_ALLOCATION_EXCEEDS_CAP`). A provider with no share, or a share of 0, for
 * this consumer is not used by this process. Every rate of a provider is scaled by this consumer's share. A-M14-05
 * reads it from the root-owned `/etc/bot/rpc-allocation.json`.
 */
export interface Allocation { consumer: string; shares: Readonly<Record<string, Readonly<Record<string, number>>>> }

export interface ProviderRegistry {
  /** Enabled providers, in failover order. */
  providers: ResolvedProvider[];
  disabled: Array<{ label: string; reason: 'secret_missing' | 'no_allocation' }>;
  warnings: ProviderWarning[];
  /** False when fewer than two engine-usable read providers are enabled: the engine refuses live modes (edge case 1). */
  liveModesAllowed: boolean;
}

/** Hosts of Solana's public mainnet endpoint, "not intended for production applications" [LD-26, DA-09]. */
export const PUBLIC_MAINNET_HOSTS: readonly string[] = ['api.mainnet-beta.solana.com', 'api.mainnet.solana.com'];

/**
 * The public endpoint's documented limits [LD-26]: 100 requests per 10 s per IP, 40 per 10 s per IP for one method,
 * 100 MB per 30 s (taken as 10^8 bytes, the stricter reading). A provider on a public host is held to these whatever
 * its config says (the stricter limit wins; review C03 R4). The limits are per IP and each process has its own
 * limiter, so at most one process per host may configure the public endpoint: the recorder server runs the recorder
 * only, and a research tool on the same host must not run beside it.
 */
export const PUBLIC_MAINNET_LIMITS: readonly DocumentedLimit[] = Object.freeze([
  { scope: 'total', count: 100, windowMs: 10_000, fact: 'LD-26' },
  { scope: 'per_method', count: 40, windowMs: 10_000, fact: 'LD-26' },
  { scope: 'bytes', count: 100_000_000, windowMs: 30_000, fact: 'LD-26' },
] as const);

/**
 * The read methods the engine's P0 calls use (ARCH M14 priorities: send, confirm and exit reads; Z03 ruling 26): pool,
 * vault and wallet reads, fill and expiry proofs, blockhash and slot. A provider counts toward the engine's two live
 * readers only when it serves all of them.
 */
export const P0_READ_METHODS: readonly string[] = Object.freeze([
  'getAccountInfo', 'getMultipleAccounts', 'getTransaction', 'getSlot', 'getSignatureStatuses', 'getLatestBlockhash',
  'getTokenAccountBalance',                       // ruling 30: the sell amount at exit and the 1-2 s evidence poll (ARCH M19, M20)
]);

/** The least rate a nonzero allocation share may leave a process: one request a minute (Z03 ruling 24). */
export const MIN_SHARED_RPS = 1 / 60;

/**
 * The rates of `limits` below one request a minute, each in full and in the part below the P0 reserve (every bucket
 * keeps `reserveBps` for P0; gateway.ts `Bucket`), as messages; empty when none (Z03 rulings 24, 25, 31).
 */
export function floorProblems(limits: ProviderConfig['limits'], reserveBps: number): string[] {
  const out: string[] = [];
  const { rps, heavyRps, perMethodRps, sendRps } = limits;
  for (const [name, rate] of [['rps', rps], ['heavyRps', heavyRps], ['perMethodRps', perMethodRps], ['sendRps', sendRps]] as const) {
    if (rate === undefined) continue;
    if (rate < MIN_SHARED_RPS) out.push(`${name} at ${rate} req/s, below one request a minute`);
    else if ((rate * (10_000 - reserveBps)) / 10_000 < MIN_SHARED_RPS) out.push(`${name} below P0 at ${(rate * (10_000 - reserveBps)) / 10_000} req/s, below one request a minute`);
  }
  return out;
}

/** Owner rule (2026-10-06): configured rates stay at or below this share of every documented limit. */
export const MAX_SHARE_OF_DOCUMENTED = 0.5;

const LABEL = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const ROLES = ['read', 'send', 'stream'];
const SCOPES = ['total', 'per_method', 'send', 'bytes'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const positiveInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

/**
 * The largest rate (requests per second) the owner rule allows under a documented limit: half of `count` per
 * `windowMs` (2026-10-06; public RPC: 100 per 10 s → 5/s, 40 per 10 s per method → 2/s [LD-26]). The gateway spaces
 * requests at least 1/rate apart with no burst (A-M14-02), so any window of the documented length holds at most half
 * of the documented count, rounded up.
 */
export function maxRpsUnder(limit: Pick<DocumentedLimit, 'count' | 'windowMs'>): number {
  return (limit.count * MAX_SHARE_OF_DOCUMENTED * 1000) / limit.windowMs;
}

/**
 * The configured rate a documented limit bounds, or null when none does: a byte limit is metered by the gateway, and
 * a provider without the send role sends nothing.
 */
function rateFor(limit: DocumentedLimit, c: ProviderConfig): number | null | 'missing' {
  if (limit.scope === 'total') return c.limits.rps;
  if (limit.scope === 'per_method') return c.limits.perMethodRps ?? 'missing';
  if (limit.scope === 'bytes') return null;
  return c.roles.includes('send') ? c.limits.sendRps as number : null;    // the send role requires sendRps (checked above)
}

/** Owner rule: every configured rate at most half of each documented limit that bounds it. */
function checkRates(c: ProviderConfig, limits: readonly DocumentedLimit[], bad: (key: string, message: string) => void): void {
  for (const [j, l] of limits.entries()) {
    const rate = rateFor(l, c);
    if (rate === null) continue;
    const key = l.scope === 'total' ? 'limits.rps' : l.scope === 'per_method' ? 'limits.perMethodRps' : 'limits.sendRps';
    if (rate === 'missing') { bad(key, `is required by documentedLimits[${j}] (${l.scope} [${l.fact}])`); continue; }
    const cap = maxRpsUnder(l);
    if (rate > cap * (1 + 1e-12)) bad(key, `is ${rate}/s; the owner rule caps it at ${cap}/s (half of ${l.count} per ${l.windowMs} ms [${l.fact}])`);
  }
}

/**
 * The config the gateway runs (Z03, SPEC-A A-M14-02 config): every rate at most `limits.ownerMaxRps` when it is set,
 * so the bucket runs at the lower of the configured rate and the owner's cap. Validation (`checkRates`) reads the
 * configured rates first, so a rate above half of a documented limit is refused even when the owner's cap is lower.
 */
export function withOwnerCap(c: ProviderConfig): ProviderConfig {
  const cap = c.limits.ownerMaxRps;
  return cap === undefined ? c : mapRates(c, (v) => Math.min(v, cap));
}

/** `c` with every rate passed through `f` (`ownerMaxRps` kept as configured). */
function mapRates(c: ProviderConfig, f: (rps: number) => number): ProviderConfig {
  const { sendRps, heavyRps, perMethodRps, ownerMaxRps } = c.limits;
  return {
    ...c,
    limits: {
      rps: f(c.limits.rps),
      ...(ownerMaxRps === undefined ? {} : { ownerMaxRps }),
      ...(sendRps === undefined ? {} : { sendRps: f(sendRps) }),
      ...(heavyRps === undefined ? {} : { heavyRps: f(heavyRps) }),
      ...(perMethodRps === undefined ? {} : { perMethodRps: f(perMethodRps) }),
    },
  };
}

/**
 * Checks the allocation (Z03 ruling m12) and returns this consumer's share of each provider, in basis points. Problems:
 * a share that is not an integer in 0..10,000, or shares of one provider that add up to more than 10,000.
 */
function sharesOf(allocation: unknown, labels: readonly string[], problems: ConfigProblem[]): Map<string, number> {
  const out = new Map<string, number>();
  // Z03 ruling 22: a malformed allocation is E_CONFIG, never a TypeError.
  if (!isObject(allocation) || typeof allocation.consumer !== 'string' || allocation.consumer.length === 0 || !isObject(allocation.shares)) {
    problems.push({ key: 'rpc.allocation', message: 'must be { consumer, shares: { <provider>: { <consumer>: bps } } }' });
    return out;
  }
  const consumer = allocation.consumer;
  const shares = allocation.shares;
  for (const label of labels) {
    const entry: unknown = Object.hasOwn(shares, label) ? shares[label] : {};
    if (!isObject(entry)) {
      problems.push({ key: `rpc.allocation[${label}]`, message: 'must map each consumer to its share in basis points' });
      continue;
    }
    const byConsumer = entry as Readonly<Record<string, number>>;
    let sum = 0;
    for (const [consumer, bps] of Object.entries(byConsumer)) {
      if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) {
        problems.push({ key: `rpc.allocation[${label}][${consumer}]`, message: 'a share is an integer number of basis points, 0-10,000' });
      }
      sum += bps;
    }
    if (sum > 10_000) problems.push({ key: `rpc.allocation[${label}]`, message: `allocation_exceeds_cap: the shares add up to ${sum} bps, above 10,000` });
    out.set(label, Object.hasOwn(byConsumer, consumer) ? byConsumer[consumer] as number : 0);
  }
  return out;
}

function checkOne(raw: unknown, i: number, problems: ConfigProblem[]): ProviderConfig | null {
  const at = `rpc.providers[${i}]`;
  const bad = (key: string, message: string): null => { problems.push({ key: `${at}.${key}`, message }); return null; };
  if (!isObject(raw)) return bad('', 'must be an object');
  const c = raw as unknown as ProviderConfig;
  const before = problems.length;
  if (typeof c.label !== 'string' || !LABEL.test(c.label)) bad('label', 'must match [a-z0-9][a-z0-9_-]{0,31}');
  if (c.transport !== 'https' && c.transport !== 'wss') bad('transport', 'must be https or wss');
  if (typeof c.urlSecretRef !== 'string' || !SECRET_NAME.test(c.urlSecretRef)) bad('urlSecretRef', 'must name a secret ([A-Z][A-Z0-9_]*)');
  if (!Array.isArray(c.roles) || c.roles.length === 0 || c.roles.some((r) => !ROLES.includes(r)) || new Set(c.roles).size !== c.roles.length) {
    bad('roles', 'must be a non-empty list of distinct read, send, stream');
  } else if (c.roles.includes('stream') !== (c.transport === 'wss')) {
    bad('roles', 'stream needs transport wss; read and send need transport https');
  }
  if (typeof c.unmeteredPrimary !== 'boolean') bad('unmeteredPrimary', 'must be a boolean');
  if (typeof c.allowInLivePaths !== 'boolean') bad('allowInLivePaths', 'must be a boolean');
  if (typeof c.failoverOrder !== 'number' || !Number.isSafeInteger(c.failoverOrder) || c.failoverOrder < 0) bad('failoverOrder', 'must be an integer ≥ 0');
  if (!isObject(c.limits) || !positive(c.limits.rps)) {
    bad('limits.rps', 'must be a positive number');
  } else {
    for (const k of ['sendRps', 'heavyRps', 'perMethodRps'] as const) {
      const v = c.limits[k];
      if (v !== undefined && (!positive(v) || v > c.limits.rps)) bad(`limits.${k}`, 'must be a positive number no larger than limits.rps');
    }
    if (c.limits.ownerMaxRps !== undefined && !positive(c.limits.ownerMaxRps)) bad('limits.ownerMaxRps', 'must be a positive number');
    if (Array.isArray(c.roles) && c.roles.includes('send') && c.limits.sendRps === undefined) bad('limits.sendRps', 'is required for the send role');
  }
  if (c.metering !== null && !(isObject(c.metering) && (c.metering.unit === 'credits' || c.metering.unit === 'requests')
    && positiveInt(c.metering.monthlyAllowance) && isObject(c.metering.methodCost)
    && Object.values(c.metering.methodCost).every((v) => typeof v === 'number' && Number.isFinite(v) && v >= 0))) {
    bad('metering', 'must be null or { unit, monthlyAllowance, methodCost }');
  }
  if (!Array.isArray(c.methods) || c.methods.length === 0 || new Set(c.methods).size !== c.methods.length
    || c.methods.some((m) => typeof m !== 'string' || methodSpec(m) === null)) {
    bad('methods', 'must be a non-empty list of distinct methods the gateway knows (the methods the provider serves)');
  }
  if (!Array.isArray(c.rateLimitRpcErrors)
    || c.rateLimitRpcErrors.some((e) => !isObject(e) || !Number.isSafeInteger(e.code) || typeof e.message !== 'string' || e.message.length === 0)) {
    bad('rateLimitRpcErrors', 'must list the { code, message } JSON-RPC errors the provider documents as rate limits (empty when none)');
  }
  if (c.unmeteredPrimary === true && c.metering !== null) bad('unmeteredPrimary', 'the unmetered primary must have metering null');
  if (c.unmeteredPrimary === true && Array.isArray(c.roles) && !c.roles.includes('read')) bad('unmeteredPrimary', 'the unmetered primary must have the read role');
  if (!Array.isArray(c.documentedLimits) || c.documentedLimits.length === 0) {
    bad('documentedLimits', 'must list the provider\'s documented limits (owner rule: rates at most 50% of them)');
  } else {
    c.documentedLimits.forEach((l: unknown, j) => {
      if (!isObject(l) || !SCOPES.includes(l.scope as string) || !positiveInt(l.count) || !positiveInt(l.windowMs)
        || typeof l.fact !== 'string' || l.fact.length === 0) bad(`documentedLimits[${j}]`, 'must be { scope, count, windowMs, fact }');
    });
    if (!c.documentedLimits.some((l) => isObject(l) && l.scope === 'total')) bad('documentedLimits', 'must include the total limit');
  }
  if (problems.length > before) return null;
  checkRates(c, c.documentedLimits, bad);
  return problems.length > before ? null : withOwnerCap(c);
}

/** Static validation of `rpc.providers` (no secrets read). Returned configs carry the owner's cap (`withOwnerCap`). */
export function validateProviderConfigs(raw: unknown, opts: Pick<RegistryOptions, 'context'>): Result<ProviderConfig[], ConfigError> {
  const problems: ConfigProblem[] = [];
  if (!Array.isArray(raw)) return { ok: false, error: { code: 'E_CONFIG', problems: [{ key: 'rpc.providers', message: 'must be a list' }] } };
  const checked = raw.map((p, i) => checkOne(p, i, problems));
  if (problems.length > 0) return { ok: false, error: { code: 'E_CONFIG', problems } };
  const configs = checked as ProviderConfig[];
  const labels = configs.map((c) => c.label);
  if (new Set(labels).size !== labels.length) problems.push({ key: 'rpc.providers', message: 'labels must be distinct' });
  const primaries = configs.filter((c) => c.unmeteredPrimary);
  if (primaries.length !== 1) problems.push({ key: 'rpc.providers', message: `exactly one unmeteredPrimary is required; found ${primaries.length}` });
  const readers = configs.filter((c) => c.roles.includes('read'));
  const orders = readers.map((c) => c.failoverOrder);
  if (new Set(orders).size !== orders.length) problems.push({ key: 'rpc.providers', message: 'read providers need distinct failoverOrder values' });
  if (opts.context === 'engine') {
    const live = readers.filter((c) => c.allowInLivePaths);
    if (live.length < 2) problems.push({ key: 'rpc.providers', message: 'the engine needs at least two read providers allowed in live paths' });
    if (primaries.length === 1 && !(primaries[0] as ProviderConfig).allowInLivePaths) {
      problems.push({ key: 'rpc.providers', message: 'the engine\'s unmetered primary must be allowed in live paths' });
    }
  } else if (readers.length < 1) {
    problems.push({ key: 'rpc.providers', message: 'at least one read provider is required' });
  }
  if (problems.length > 0) return { ok: false, error: { code: 'E_CONFIG', problems } };
  return { ok: true, value: [...configs].sort((a, b) => a.failoverOrder - b.failoverOrder) };
}

/**
 * Validates the providers, reads each URL from the secret store by reference and checks it. URLs are kept only in the
 * returned objects (memory). A missing secret disables that provider and logs `m14.provider_disabled`.
 */
export function loadProviders(raw: unknown, secrets: SecretSource, opts: RegistryOptions, log: LogPort): Result<ProviderRegistry, ConfigError> {
  const valid = validateProviderConfigs(raw, opts);
  if (!valid.ok) return valid;
  const problems: ConfigProblem[] = [];
  // Z03 rulings m12 and 15: every process, research included, reads providers under its configured share of each budget.
  if (opts.allocation === undefined) {
    return { ok: false, error: { code: 'E_CONFIG', problems: [{ key: 'rpc.allocation', message: 'the provider allocation is required (each process reads under its share of every budget; ARCH D04)' }] } };
  }
  const shares = sharesOf(opts.allocation, valid.value.map((c) => c.label), problems);
  if (!Number.isInteger(opts.p0ReserveBps) || opts.p0ReserveBps < 1_000 || opts.p0ReserveBps > 5_000) {
    return { ok: false, error: { code: 'E_CONFIG', problems: [{ key: 'rpc.p0_reserve_bps', message: 'must be 1,000-5,000' }] } };
  }
  for (const c of valid.value) {
    const share = shares.get(c.label) ?? 0;
    if (share === 0) continue;
    // Z03 rulings 24, 25 and 31: a share that is on leaves every rate of the provider at least one request a minute,
    // also below the P0 reserve; 0 is the only way to turn it off.
    for (const problem of floorProblems(mapRates(c, (v) => (v * share) / 10_000).limits, opts.p0ReserveBps)) {
      problems.push({ key: `rpc.allocation[${c.label}]`, message: `a share of ${share} bps leaves ${problem}; use 0 to turn it off` });
    }
  }
  // Z03 ruling 23 (ARCH D04: a primary and a backup): the engine starts only with two live read providers it has a share of.
  if (opts.context === 'engine' && problems.length === 0) {
    const live = valid.value.filter((c) => c.roles.includes('read') && c.allowInLivePaths && (shares.get(c.label) ?? 0) > 0
      && P0_READ_METHODS.every((m) => c.methods.includes(m)));             // ruling 26: a backup serves every P0 read
    if (live.length < 2) problems.push({ key: 'rpc.allocation', message: `the engine needs a share of at least two live read providers serving every P0 read method; it has ${live.length}` });
  }
  if (problems.length > 0) return { ok: false, error: { code: 'E_CONFIG', problems } };
  const providers: ResolvedProvider[] = [];
  const disabled: ProviderRegistry['disabled'] = [];
  const warnings: ProviderWarning[] = [];
  if (opts.egressHosts === undefined) {
    warnings.push({ label: '*', code: 'egress_allowlist_missing', message: 'no egress allowlist given; provider hosts not cross-checked' });
  }
  for (const configured of valid.value) {
    const share = shares.get(configured.label) ?? 0;
    if (share === 0) {
      disabled.push({ label: configured.label, reason: 'no_allocation' });
      log.event('info', 'm14.provider_disabled', { provider: configured.label, reason: 'no_allocation' });
      continue;
    }
    const c = { ...(share === 10_000 ? configured : mapRates(configured, (v) => (v * share) / 10_000)), budgetShareBps: share };
    const key = `rpc.providers[${c.label}]`;
    const url = secrets.get(c.urlSecretRef);
    if (url === undefined || url.trim() === '') {
      disabled.push({ label: c.label, reason: 'secret_missing' });
      log.event('error', 'm14.provider_disabled', { provider: c.label, reason: 'secret_missing' });
      continue;
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      problems.push({ key, message: 'the URL in the secret is not a valid URL' });
      continue;
    }
    if (parsed.protocol !== `${c.transport}:`) {
      problems.push({ key, message: `the URL scheme must be ${c.transport}: (HTTPS only, CA-30); found ${parsed.protocol}` });
      continue;
    }
    // A fully qualified name ends in a dot (`api.mainnet-beta.solana.com.`) and reaches the same host (review C03 N2).
    const host = parsed.hostname.replace(/\.+$/, '');
    let config = c;
    if (PUBLIC_MAINNET_HOSTS.includes(host)) {
      if (c.allowInLivePaths) {
        problems.push({ key, message: 'the public mainnet endpoint may be configured only with allowInLivePaths = false [LD-26, DA-09]' });
        continue;
      }
      config = { ...c, documentedLimits: [...c.documentedLimits, ...PUBLIC_MAINNET_LIMITS] };
      const before = problems.length;
      checkRates(config, config.documentedLimits, (k, message) => problems.push({ key: `${key}.${k}`, message }));
      if (problems.length > before) continue;
    }
    if (opts.egressHosts !== undefined && !opts.egressHosts.includes(host)) {
      warnings.push({ label: c.label, code: 'egress_host_missing', message: 'the provider host is not in the egress allowlist' });
    }
    providers.push({ config, url });
  }
  if (problems.length > 0) return { ok: false, error: { code: 'E_CONFIG', problems } };
  const liveReaders = providers.filter((p) => p.config.roles.includes('read') && p.config.allowInLivePaths);
  const liveModesAllowed = opts.context === 'engine' && liveReaders.length >= 2;
  return { ok: true, value: { providers, disabled, warnings, liveModesAllowed } };
}

/** The secret store as systemd delivers it: environment variables (ARCH 12.4). */
export function envSecrets(env: Readonly<Record<string, string | undefined>>): SecretSource {
  return { get: (name) => (Object.hasOwn(env, name) ? env[name] : undefined) };
}
