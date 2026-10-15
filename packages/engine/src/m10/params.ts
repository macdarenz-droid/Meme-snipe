// M10 simulation parameter sets and model versions (A-M10-01 logic 2-4). A parameter set is a canonical-JSON file
// `sim-params/<name>.json`, read-only after creation; the active one is `sim.param_set`. Every simulated number names
// the set it came from through `fillModelVersion` and `costModelVersion`, which enter every trial key (A-M13-02).
//
// Addendum A10 (C-61): the set holds no slot time. SPEC-A's `slotMsAssumed` is replaced by the one slot-to-time function
// (m15/slot-time.ts, bug B1), so a file that still names `slotMsAssumed` is refused like any unknown field.
import { createHash } from 'node:crypto';
import { wilson } from '../m13/stats/intervals.ts';
import { SLOT_MS_MIN } from '../m15/slot-time.ts';
import { canonicalJson, type Cu, type FailureClass, type Lamports, type MicroLamportsPerCu, type Result, type UnixMs } from '@bot/types';

export type LatencySpec =
  | { kind: 'lognormal_prior'; medianMs: number; p95Ms: number }
  | { kind: 'empirical'; samplesMs: number[]; source: string; n: number; sourceSha256: string };

/** Where a value more optimistic than the prior came from (ruling Z06-3): a named source, its sample count and its hash. */
export interface Evidence { source: string; n: number; sourceSha256: string }
/** failure: fFailEntry, fFailExit, fExp, failureClassMix; sandwich: pSwEntry, pSwExit; gap: gapThroughStopP99Bps; cost: any cost. */
export type EvidenceKey = 'failure' | 'sandwich' | 'gap' | 'cost';

export interface SimCost {
  cuLimit: Cu; leanCuPriceMicroLamports: MicroLamportsPerCu; senderTipLamports: Lamports; jitoTipLamports: Lamports;
  premiumTipLamports: Lamports; premiumCuPriceMicroLamports: MicroLamportsPerCu; janitorPriorityLamports: Lamports;
}

export interface SimParamSet {
  name: string; createdAtMs: UnixMs; provenance: string;
  latency: LatencySpec;
  fFailEntry: number; fFailExit: number; fExp: number;
  failureClassMix: Partial<Record<FailureClass, number>>;
  pSwEntry: number; pSwExit: number;
  gapThroughStopP99Bps: number; gapSamples: number;
  cost: SimCost;
  evidence: Partial<Record<EvidenceKey, Evidence>>;
}

export interface ModelVersions { fillModelVersion: string; costModelVersion: string }
export type SimParamsError = { code: 'E_SIM_PARAMS'; problem: string };

/** Code versions of the fill and cost formulas: bump on any formula change (logic 3). */
export const FILL_MODEL_SEMVER = '1.0.0';
export const COST_MODEL_SEMVER = '1.0.0';

const FAILURE_CLASSES: readonly FailureClass[] = ['slippage', 'compute_exceeded', 'insufficient_funds_fee', 'account_state',
  'balance_mismatch', 'venue_disabled', 'token_program_refusal', 'blockhash_expired', 'unknown'];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const U64_RE = /^(0|[1-9][0-9]{0,19})$/;
const U64_MAX = 18_446_744_073_709_551_615n;
const CU_MAX = 1_400_000;
const MIX_TOLERANCE = 1e-9;
const COST_KEYS = ['cuLimit', 'leanCuPriceMicroLamports', 'senderTipLamports', 'jitoTipLamports', 'premiumTipLamports',
  'premiumCuPriceMicroLamports', 'janitorPriorityLamports'] as const;
const TOP_KEYS = ['name', 'createdAtMs', 'provenance', 'latency', 'fFailEntry', 'fFailExit', 'fExp', 'failureClassMix',
  'pSwEntry', 'pSwExit', 'gapThroughStopP99Bps', 'gapSamples', 'cost', 'evidence'] as const;
const EVIDENCE_KEYS: readonly EvidenceKey[] = ['failure', 'sandwich', 'gap', 'cost'];
const SHA256_RE = /^[0-9a-f]{64}$/;

/** POLICY (SPEC-A A-M10-05 `sim.calibration.min_samples`): samples behind a measured failure, sandwich, latency or cost value. */
export const CALIBRATION_MIN_SAMPLES = 100;
/** POLICY (SPEC-A A-M10-04 `sim.gap.min_samples`, never below 50): stop exits behind a measured gap-through-stop p99. */
export const GAP_MIN_SAMPLES = 50;

/**
 * `prior-2026-10`, the ARCH priors (logic 2): latency lognormal with median 1,500 ms and p95 5,000 ms (A-04); entry and
 * exit failure 20%, expiry 5% (A-03); failure classes all `unknown` (C-27); sandwich 10% on entries and exits (A-03,
 * C-25); gap-through-stop p99 2,000 bps with no samples (ARCH 3.5); ARCH 2.2 cost scenarios.
 */
export const PRIOR_2026_10: SimParamSet = Object.freeze({
  name: 'prior-2026-10',
  createdAtMs: Date.UTC(2026, 9, 15) as UnixMs,
  provenance: 'ARCH priors (SPEC-A A-M10-01 logic 2): latency A-04; failure, expiry and sandwich A-03, C-25, C-27; gap ARCH 3.5; cost ARCH 2.2',
  latency: { kind: 'lognormal_prior', medianMs: 1_500, p95Ms: 5_000 },
  fFailEntry: 0.2, fFailExit: 0.2, fExp: 0.05,
  failureClassMix: { unknown: 1 },
  pSwEntry: 0.1, pSwExit: 0.1,
  gapThroughStopP99Bps: 2_000, gapSamples: 0,
  evidence: {},
  cost: {
    cuLimit: 200_000 as Cu, leanCuPriceMicroLamports: 25_000n as MicroLamportsPerCu, senderTipLamports: 5_000n as Lamports,
    jitoTipLamports: 1_000n as Lamports, premiumTipLamports: 1_000_000n as Lamports, premiumCuPriceMicroLamports: 1_000_000n as MicroLamportsPerCu,
    janitorPriorityLamports: 5_000n as Lamports,
  },
}) as SimParamSet;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const prob = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 1;
const posMs = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v) && v > 0;

function onlyKeys(o: Record<string, unknown>, keys: readonly string[], where: string): string | null {
  for (const k of Object.keys(o)) if (!keys.includes(k)) return `${where}: unknown field ${JSON.stringify(k).slice(0, 80)}`;
  for (const k of keys) if (!Object.hasOwn(o, k)) return `${where}: missing field ${k}`;
  return null;
}

function u64(v: unknown): bigint | null {
  return typeof v === 'string' && U64_RE.test(v) && BigInt(v) <= U64_MAX ? BigInt(v) : null;
}

/**
 * The JSON form of a set (bigints as decimal strings, VM convention 2): what the file holds, canonicalised. Empirical
 * latency is written without `samplesMs`: the samples are read from its source file, which `sourceSha256` pins (Z06-8).
 */
export function simParamSetJson(set: SimParamSet): string {
  const latency = set.latency.kind === 'empirical'
    ? { kind: 'empirical', source: set.latency.source, n: set.latency.n, sourceSha256: set.latency.sourceSha256 }
    : set.latency;
  return canonicalJson({ ...set, latency, cost: { ...set.cost }, evidence: { ...set.evidence } });
}

/**
 * Reads a file next to the parameter sets (`sim-params/`); throws when it is missing.
 * Contract for the production reader (ruling Z06-14; none exists yet, the card that adds one implements this): it
 * resolves the real path of `sim-params/<fileName>` and refuses unless that path is still inside `sim-params/` (no
 * symbolic link or hard-coded path may lead out of it). `SOURCE_RE` below only checks the name's shape.
 */
export type SimParamsReader = (fileName: string) => string;
const SOURCE_RE = /^[a-z0-9][a-z0-9._-]{0,127}(\/[a-z0-9][a-z0-9._-]{0,127}){0,3}$/;
/** Empirical specs whose samples came from a verified source file (Z06-9: the latency model accepts no other). */
const verifiedLatency = new WeakSet<object>();
export function isVerifiedEmpiricalLatency(spec: LatencySpec): boolean {
  return spec.kind === 'empirical' && verifiedLatency.has(spec);
}

/** Z06-12: a measured latency is never shorter than one slot at the fastest slot time a basis accepts (SLOT_MS_MIN). */
export const MIN_LATENCY_MS = SLOT_MS_MIN;
const COST_FIELDS = ['cuLimit', 'leanCuPriceMicroLamports', 'senderTipLamports', 'jitoTipLamports', 'premiumTipLamports',
  'premiumCuPriceMicroLamports', 'janitorPriorityLamports'] as const;
type EvidenceSchema = EvidenceKey | 'latency';
/** Z06-11: the fields each evidence record holds beside `sig` and `slot` (cost: any non-empty subset of the cost fields). */
function recordProblem(kind: EvidenceSchema, r: Record<string, unknown>): string | null {
  const extra = Object.keys(r).filter((k) => k !== 'sig' && k !== 'slot');
  const exactly = (key: string, ok: (v: unknown) => boolean, what: string): string | null =>
    extra.length === 1 && extra[0] === key && ok(r[key]) ? null : `records must be {sig, slot, ${key}} with ${key} ${what}`;
  switch (kind) {
    case 'failure': return exactly('ok', (v) => typeof v === 'boolean', 'a boolean');
    case 'sandwich': return exactly('sandwiched', (v) => typeof v === 'boolean', 'a boolean');
    case 'gap': return exactly('gapBps', (v) => Number.isSafeInteger(v) && (v as number) >= 0, 'an integer >= 0');
    case 'latency': return exactly('latencyMs', (v) => typeof v === 'number' && Number.isFinite(v) && v >= MIN_LATENCY_MS, `finite and >= ${MIN_LATENCY_MS}`);
    case 'cost':
      if (extra.length === 0 || !extra.every((k) => (COST_FIELDS as readonly string[]).includes(k))) return 'records must be {sig, slot} and one or more cost fields';
      for (const k of extra) {
        const v = r[k];
        if (k === 'cuLimit' ? !(Number.isSafeInteger(v) && (v as number) >= 0) : u64(v) === null) return `cost record field ${k} must be ${k === 'cuLimit' ? 'an integer' : 'a u64 decimal string'}`;
      }
      return null;
  }
}

/**
 * Rulings Z06-8, Z06-11, Z06-12: an evidence source is a file read through `read` (a path under `sim-params/`, no `..`),
 * NDJSON with one JSON object per line, each a record of its group's schema with a `sig` (string) and `slot` (integer).
 * It is accepted only when sha256 of its bytes (UTF-8) equals `sourceSha256` and it holds at least `n` distinct records,
 * one per `sig` (a repeat of the same record counts once; two different records for one signature are refused, Z06-15).
 * Returns the distinct records in file order, or the problem.
 */
function readEvidence(where: string, kind: EvidenceSchema, e: { source: string; n: number; sourceSha256: string }, read: SimParamsReader): Array<Record<string, unknown>> | string {
  if (!SOURCE_RE.test(e.source) || e.source.split('/').some((part) => part === '.' || part === '..')) return `${where}: source must be a file path under sim-params/`;
  let text: string;
  try { text = read(e.source); } catch { return `${where}: source file missing`; }
  if (createHash('sha256').update(text, 'utf8').digest('hex') !== e.sourceSha256) return `${where}: sha256 of the source file does not match sourceSha256`;
  const byId = new Map<string, string>(), records: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let r: unknown;
    try { r = JSON.parse(line); } catch { return `${where}: source is not NDJSON`; }
    if (!isObj(r)) return `${where}: every source line must be a JSON object`;
    if (!isSignatureShape(r.sig)) return `${where}: every record needs a sig (a base58 transaction signature of 64 bytes)`;
    if (!Number.isSafeInteger(r.slot) || (r.slot as number) < 0) return `${where}: every record needs a slot (an integer >= 0)`;
    const problem = recordProblem(kind, r);
    if (problem !== null) return `${where}: ${problem}`;
    // Z06-15: one record per transaction signature (a signature lands in one slot only).
    const id = r.sig as string, body = canonicalJson(r), prev = byId.get(id);
    if (prev !== undefined) {
      if (prev !== body) return `${where}: two different records for sig ${id.slice(0, 12)}…`;
      continue;
    }
    byId.set(id, body);
    records.push(r);
  }
  if (records.length < e.n) return `${where}: the source holds ${records.length} distinct records, fewer than n = ${e.n}`;
  return records;
}

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
/** Bytes a base58 string decodes to (Bitcoin alphabet), or null when it is not base58. */
function base58Length(s: string): number | null {
  let n = 0n, zeros = 0;
  for (const ch of s) {
    const d = BASE58.indexOf(ch);
    if (d < 0) return null;
    if (n === 0n && d === 0) zeros++;
    n = n * 58n + BigInt(d);
  }
  let bytes = 0;
  for (; n > 0n; n >>= 8n) bytes++;
  return zeros + bytes;
}
/** Z06-15: a transaction signature: base58 that decodes to exactly 64 bytes. */
export function isSignatureShape(s: unknown): boolean {
  return typeof s === 'string' && s.length >= 64 && s.length <= 88 && base58Length(s) === 64;
}

/** Nearest-rank p99 of integers (the ⌈0.99·N⌉-th smallest). */
function p99(xs: readonly number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(0.99 * sorted.length) - 1)] as number;
}

function parseLatency(v: unknown, read: SimParamsReader): LatencySpec | string {
  if (!isObj(v)) return 'latency: not an object';
  if (v.kind === 'lognormal_prior') {
    const p = onlyKeys(v, ['kind', 'medianMs', 'p95Ms'], 'latency');
    if (p !== null) return p;
    if (!posMs(v.medianMs) || !posMs(v.p95Ms) || (v.p95Ms as number) <= (v.medianMs as number)) return 'latency: need 0 < medianMs < p95Ms';
    // A prior is never faster than the ARCH prior (ruling Z06-3): measured latency comes as `empirical` with its source.
    const prior = PRIOR_2026_10.latency as { medianMs: number; p95Ms: number };
    if ((v.medianMs as number) < prior.medianMs || (v.p95Ms as number) < prior.p95Ms) return 'latency: a lognormal prior faster than prior-2026-10 needs measured (empirical) latency';
    return { kind: 'lognormal_prior', medianMs: v.medianMs as number, p95Ms: v.p95Ms as number };
  }
  if (v.kind === 'empirical') {
    // Z06-8: the samples are never stated inline; they are the `latencyMs` of the source file's distinct records.
    const p = onlyKeys(v, ['kind', 'source', 'n', 'sourceSha256'], 'latency');
    if (p !== null) return p;
    if (!Number.isSafeInteger(v.n) || (v.n as number) < CALIBRATION_MIN_SAMPLES) return `latency: empirical latency needs n >= ${CALIBRATION_MIN_SAMPLES}`;
    if (typeof v.source !== 'string' || v.source.length === 0) return 'latency: source is required';
    if (typeof v.sourceSha256 !== 'string' || !SHA256_RE.test(v.sourceSha256)) return 'latency: sourceSha256 must be a sha256 hex digest';
    const e = { source: v.source, n: v.n as number, sourceSha256: v.sourceSha256 };
    const records = readEvidence('latency', 'latency', e, read);
    if (typeof records === 'string') return records;
    // Z06-13: frozen, so nothing can change the samples after they were verified.
    const samplesMs = Object.freeze(records.map((r) => r.latencyMs as number)) as number[];
    const spec: LatencySpec = Object.freeze({ kind: 'empirical', samplesMs, source: e.source, n: e.n, sourceSha256: e.sourceSha256 });
    verifiedLatency.add(spec);
    return spec;
  }
  return 'latency: kind must be lognormal_prior or empirical';
}

/**
 * Validates a parsed parameter file (edge cases: `E_SIM_PARAMS` on anything missing, unknown or out of range) and reads
 * every evidence source it names through `read` (Z06-8), so no set with unverified evidence is ever returned.
 */
export function parseSimParamSet(v: unknown, read: SimParamsReader): Result<SimParamSet, SimParamsError> {
  const fail = (problem: string): Result<SimParamSet, SimParamsError> => ({ ok: false, error: { code: 'E_SIM_PARAMS', problem } });
  if (!isObj(v)) return fail('not an object');
  const top = onlyKeys(v, TOP_KEYS, 'set');
  if (top !== null) return fail(top);
  if (typeof v.name !== 'string' || !NAME_RE.test(v.name)) return fail('name must be lower-case letters, digits and dashes');
  if (!Number.isSafeInteger(v.createdAtMs) || (v.createdAtMs as number) < 0) return fail('createdAtMs must be Unix ms');
  if (typeof v.provenance !== 'string' || v.provenance.length === 0) return fail('provenance is required');
  const latency = parseLatency(v.latency, read);
  if (typeof latency === 'string') return fail(latency);
  for (const k of ['fFailEntry', 'fFailExit', 'fExp', 'pSwEntry', 'pSwExit'] as const) if (!prob(v[k])) return fail(`${k} must be in [0, 1)`);
  const mix = v.failureClassMix;
  if (!isObj(mix)) return fail('failureClassMix: not an object');
  let sum = 0;
  for (const [k, x] of Object.entries(mix)) {
    if (!(FAILURE_CLASSES as readonly string[]).includes(k)) return fail(`failureClassMix: unknown class ${JSON.stringify(k).slice(0, 80)}`);
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) return fail(`failureClassMix.${k} must be in [0, 1]`);
    sum += x;
  }
  if (Math.abs(sum - 1) > MIX_TOLERANCE) return fail('failureClassMix must sum to 1');
  if (!Number.isSafeInteger(v.gapThroughStopP99Bps) || (v.gapThroughStopP99Bps as number) < 0) return fail('gapThroughStopP99Bps must be an integer >= 0');
  if (!Number.isSafeInteger(v.gapSamples) || (v.gapSamples as number) < 0) return fail('gapSamples must be an integer >= 0');
  const c = v.cost;
  if (!isObj(c)) return fail('cost: not an object');
  const ck = onlyKeys(c, COST_KEYS, 'cost');
  if (ck !== null) return fail(ck);
  if (!Number.isSafeInteger(c.cuLimit) || (c.cuLimit as number) < 1 || (c.cuLimit as number) > CU_MAX) return fail('cost.cuLimit must be 1..1,400,000');
  const big: Record<string, bigint> = {};
  for (const k of COST_KEYS.slice(1)) {
    const b = u64(c[k]);
    if (b === null) return fail(`cost.${k} must be a u64 decimal string`);
    big[k] = b;
  }
  const ev = v.evidence;
  if (!isObj(ev)) return fail('evidence: not an object');
  const evidence: Partial<Record<EvidenceKey, Evidence>> = {};
  const recordsOf: Partial<Record<EvidenceKey, Array<Record<string, unknown>>>> = {};
  for (const [k, e] of Object.entries(ev)) {
    if (!(EVIDENCE_KEYS as readonly string[]).includes(k)) return fail(`evidence: unknown key ${JSON.stringify(k).slice(0, 80)}`);
    if (!isObj(e)) return fail(`evidence.${k}: not an object`);
    const ek = onlyKeys(e, ['source', 'n', 'sourceSha256'], `evidence.${k}`);
    if (ek !== null) return fail(ek);
    const min = k === 'gap' ? GAP_MIN_SAMPLES : CALIBRATION_MIN_SAMPLES;
    if (typeof e.source !== 'string' || e.source.length === 0) return fail(`evidence.${k}: source is required`);
    if (!Number.isSafeInteger(e.n) || (e.n as number) < min) return fail(`evidence.${k}: n must be an integer >= ${min}`);
    if (typeof e.sourceSha256 !== 'string' || !SHA256_RE.test(e.sourceSha256)) return fail(`evidence.${k}: sourceSha256 must be a sha256 hex digest`);
    const entry = { source: e.source, n: e.n as number, sourceSha256: e.sourceSha256 };
    const records = readEvidence(`evidence.${k}`, k as EvidenceKey, entry, read);
    if (typeof records === 'string') return fail(records);
    evidence[k as EvidenceKey] = entry;
    recordsOf[k as EvidenceKey] = records;
  }
  // Ruling Z06-3: any value more optimistic than prior-2026-10 needs evidence for its group.
  const P = PRIOR_2026_10;
  const need = (key: EvidenceKey, field: string): Result<SimParamSet, SimParamsError> | null =>
    evidence[key] === undefined ? fail(`${field} is more optimistic than prior-2026-10 without ${key} evidence (source, n, sourceSha256)`) : null;
  const checks: Array<[boolean, EvidenceKey, string]> = [
    [(v.fFailEntry as number) < P.fFailEntry, 'failure', 'fFailEntry'], [(v.fFailExit as number) < P.fFailExit, 'failure', 'fFailExit'],
    [(v.fExp as number) < P.fExp, 'failure', 'fExp'],
    [canonicalJson(mix) !== canonicalJson(P.failureClassMix), 'failure', 'failureClassMix'],
    [(v.pSwEntry as number) < P.pSwEntry, 'sandwich', 'pSwEntry'], [(v.pSwExit as number) < P.pSwExit, 'sandwich', 'pSwExit'],
    [(v.gapThroughStopP99Bps as number) < P.gapThroughStopP99Bps, 'gap', 'gapThroughStopP99Bps'],
    [(c.cuLimit as number) < P.cost.cuLimit, 'cost', 'cost.cuLimit'],
    ...COST_KEYS.slice(1).map((k) => [(big[k] as bigint) < (P.cost[k] as bigint), 'cost', `cost.${k}`] as [boolean, EvidenceKey, string]),
  ];
  for (const [optimistic, key, field] of checks) if (optimistic) { const r = need(key, field); if (r !== null) return r; }
  if ((v.gapThroughStopP99Bps as number) < P.gapThroughStopP99Bps && (v.gapSamples as number) < GAP_MIN_SAMPLES) {
    return fail(`gapSamples must be at least ${GAP_MIN_SAMPLES} for a measured gapThroughStopP99Bps`);
  }
  // Ruling Z06-11: each stated value of a group with evidence is no more optimistic than what its records give (failure
  // and sandwich: the Wilson 95% upper bound, Z06-16; gap: nearest-rank p99; cost: rounded-up mean). Failure records carry only `ok`, so fExp and the class mix cannot be measured from them and stay at the prior.
  const notBelow = (field: string, stated: number | bigint, computed: number | bigint): Result<SimParamSet, SimParamsError> | null =>
    stated < computed ? fail(`${field} ${String(stated)} is more optimistic than its evidence (${String(computed)})`) : null;
  const checksAgainstRecords: Array<() => Result<SimParamSet, SimParamsError> | null> = [];
  const fr = recordsOf.failure;
  if (fr !== undefined) {
    // Z06-16: against the Wilson 95% upper bound, so a lucky small sample cannot lower a probability.
    const rate = wilson(fr.filter((r) => r.ok === false).length, fr.length).high;
    checksAgainstRecords.push(() => notBelow('fFailEntry', v.fFailEntry as number, rate), () => notBelow('fFailExit', v.fFailExit as number, rate),
      () => ((v.fExp as number) < P.fExp ? fail('fExp cannot be measured from failure records (no expiry field); it stays at or above prior-2026-10') : null),
      () => (canonicalJson(mix) !== canonicalJson(P.failureClassMix) ? fail('failureClassMix cannot be measured from failure records (no class field); it stays at prior-2026-10') : null));
  }
  const sr = recordsOf.sandwich;
  if (sr !== undefined) {
    const rate = wilson(sr.filter((r) => r.sandwiched === true).length, sr.length).high;
    checksAgainstRecords.push(() => notBelow('pSwEntry', v.pSwEntry as number, rate), () => notBelow('pSwExit', v.pSwExit as number, rate));
  }
  const gr = recordsOf.gap;
  if (gr !== undefined) {
    checksAgainstRecords.push(() => notBelow('gapThroughStopP99Bps', v.gapThroughStopP99Bps as number, p99(gr.map((r) => r.gapBps as number))),
      () => ((v.gapSamples as number) > gr.length ? fail(`gapSamples ${v.gapSamples as number} exceeds the ${gr.length} gap records`) : null));
  }
  const cr = recordsOf.cost;
  if (cr !== undefined) {
    for (const k of COST_FIELDS) {
      const seen = cr.filter((r) => Object.hasOwn(r, k));
      const stated = k === 'cuLimit' ? BigInt(c.cuLimit as number) : (big[k] as bigint);
      if (seen.length >= CALIBRATION_MIN_SAMPLES) {
        const sum = seen.reduce((t, r) => t + BigInt(r[k] as string | number), 0n), n = BigInt(seen.length);
        checksAgainstRecords.push(() => notBelow(`cost.${k}`, stated, (sum + n - 1n) / n));   // the mean, rounded up
      } else if (stated < (k === 'cuLimit' ? BigInt(P.cost.cuLimit) : (P.cost[k] as bigint))) {
        return fail(`cost.${k} is below prior-2026-10 but only ${seen.length} cost records measure it (need ${CALIBRATION_MIN_SAMPLES})`);
      }
    }
  }
  for (const check of checksAgainstRecords) { const r = check(); if (r !== null) return r; }
  return {
    ok: true,
    value: {
      evidence,
      name: v.name, createdAtMs: v.createdAtMs as UnixMs, provenance: v.provenance, latency,
      fFailEntry: v.fFailEntry as number, fFailExit: v.fFailExit as number, fExp: v.fExp as number,
      failureClassMix: { ...(mix as Partial<Record<FailureClass, number>>) },
      pSwEntry: v.pSwEntry as number, pSwExit: v.pSwExit as number,
      gapThroughStopP99Bps: v.gapThroughStopP99Bps as number, gapSamples: v.gapSamples as number,
      cost: {
        cuLimit: c.cuLimit as Cu, leanCuPriceMicroLamports: big.leanCuPriceMicroLamports as MicroLamportsPerCu,
        senderTipLamports: big.senderTipLamports as Lamports, jitoTipLamports: big.jitoTipLamports as Lamports,
        premiumTipLamports: big.premiumTipLamports as Lamports, premiumCuPriceMicroLamports: big.premiumCuPriceMicroLamports as MicroLamportsPerCu,
        janitorPriorityLamports: big.janitorPriorityLamports as Lamports,
      },
    },
  };
}

/**
 * Loads `sim-params/<name>.json` through `read` (the caller's file reader for that folder). The file's own name must
 * match. Any problem, including a read error, is `E_SIM_PARAMS`: simulation modes refuse to start on it.
 */
export function loadSimParamSet(name: string, read: SimParamsReader): Result<SimParamSet, SimParamsError> {
  if (!NAME_RE.test(name)) return { ok: false, error: { code: 'E_SIM_PARAMS', problem: 'invalid set name' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(read(`${name}.json`));
  } catch {
    return { ok: false, error: { code: 'E_SIM_PARAMS', problem: 'file missing or not JSON' } };
  }
  const r = parseSimParamSet(parsed, read);
  if (r.ok && r.value.name !== name) return { ok: false, error: { code: 'E_SIM_PARAMS', problem: 'file name and set name differ' } };
  return r;
}

/** Logic 3: `fill-<semver>-<sha256(canonical set)[0..12]>`, and the same for the cost model. */
export function modelVersions(set: SimParamSet): ModelVersions {
  const h = createHash('sha256').update(simParamSetJson(set)).digest('hex').slice(0, 12);
  return { fillModelVersion: `fill-${FILL_MODEL_SEMVER}-${h}`, costModelVersion: `cost-${COST_MODEL_SEMVER}-${h}` };
}
