// Reads facts as of the decision moment and judges whether they can be used (docs/ARCHITECTURE.md §6.3, H16).
// Unknown, stale or degraded evidence is never passed on: the read fails with a typed reason and the gate rejects.
import type { AsOfEntry, Lookup } from '../engine/asof.ts';
import type { DeployerIndex } from './deployer-index.ts';
import type { Moment } from '../engine/moment.ts';
import type { Policy } from '../config/policy.ts';
import type { QualityFlag } from '../domain/index.ts';
import { type FactObs, parseStream, streamKey } from './facts.ts';
import type { EvidenceCode, FactName, GateReason, HardGate } from './reasons.ts';

/** What the gates may see: the decision moment and as-of lookups. The engine's `StrategyContext` is one. */
export interface GateContext {
  readonly now: Moment;
  lookup(key: string, asOf?: Moment): Lookup;
  /** Every value of a key in a range of moments, refused past now (the engine's `StrategyContext.history`). */
  history(key: string, from: Moment, to?: Moment): readonly AsOfEntry[] | { readonly ok: false; readonly reason: 'future' };
  /** Our own deployer index, fed with every released event (GATE-1b). Without it H14 reads a stored deployer fact. */
  readonly deployers?: DeployerIndex;
  /**
   * The chain tip as the process has observed it: the newest chain slot among the events released to the engine. Chain
   * state is judged fresh against it, the same rule live and in a backtest (supervisor ruling). Live, events are
   * released at their own chain slots, so it is the clock's slot; a backtest with an observation delay passes the
   * newest chain slot it has released, never the release moment's. A tip ahead of `now` is not believed.
   */
  readonly observedTip: bigint;
}

/**
 * How a fact stays current:
 * - 'state': chain state that changes (mint, pool, holders). Fresh while observed within `maxStateSlotLag` slots of
 *   now, or kept current by a stream that is gap-free since the observation and within that lag of now.
 * - 'event': a chain event that never changes once it happened (create, migration). Present is enough.
 * - 'series': an off-chain snapshot read as of now (SOL/USD, curve volume); its points are judged by the caller.
 * - 'offchain': a read with no slot (simulation, third-party checks). Fresh for `maxQuoteAgeMs`.
 * Chain facts ('state' and 'event') must say their commitment, and `processed` is refused: it can be rolled back.
 */
export type Freshness = 'state' | 'event' | 'series' | 'offchain';

/** Flags that do not make a value unusable. Every other flag does (CORE-1 flags fork-suspect, provider-degraded, partial, estimated; and rate-limited). */
const HARMLESS: ReadonlySet<QualityFlag> = new Set<QualityFlag>(['backfilled', 'deduplicated']);

export type Read<T> = { readonly ok: true; readonly fact: T } | { readonly ok: false; readonly reason: GateReason };

const evidenceReason = (input: FactName, code: EvidenceCode, neededBy: HardGate, detail: string, value?: string, limit?: string): GateReason => ({
  gate: 'H16', code, input, neededBy, detail, ...(value === undefined ? {} : { value }), ...(limit === undefined ? {} : { limit }),
});

/** Quality and time checks every fact passes, whatever its freshness class. */
const obsProblem = (obs: FactObs, now: Moment): { code: EvidenceCode; detail: string; value?: string } | null => {
  const bad = obs.quality.filter((q) => !HARMLESS.has(q));
  if (bad.length > 0) return { code: 'degraded', detail: `flagged ${[...bad].sort().join(', ')} by ${obs.provider}`, value: [...bad].sort().join(',') };
  if (obs.receivedAt > now.receivedAt) return { code: 'future', detail: `received at ${obs.receivedAt}, after now ${now.receivedAt}` };
  if (obs.slot !== null && obs.slot > now.slot) return { code: 'future', detail: `observed at slot ${obs.slot}, after now ${now.slot}` };
  if (obs.commitment === 'processed') return { code: 'degraded', detail: 'read at processed commitment', value: 'processed' };
  return null;
};

/** One reader per evaluation: each key is looked up once, so every gate sees the same value. */
export class Evidence {
  readonly #ctx: GateContext;
  readonly #policy: Policy;
  readonly #cache = new Map<string, unknown>();

  constructor(ctx: GateContext, policy: Policy) {
    this.#ctx = ctx;
    this.#policy = policy;
  }

  get now(): Moment {
    return this.#ctx.now;
  }

  /** The raw value of `key` as of now, or undefined when there is none. Lookups never ask past now. */
  raw(key: string): unknown {
    return this.entry(key)?.value;
  }

  /** The as-of entry of `key` (value, moment and source event), or undefined when there is none. */
  entry(key: string): AsOfEntry | undefined {
    if (this.#cache.has(key)) return this.#cache.get(key) as AsOfEntry | undefined;
    const r = this.#ctx.lookup(key);
    const e: AsOfEntry | undefined = r.ok ? { moment: r.moment, value: r.value, source: r.source } : undefined;
    this.#cache.set(key, e);
    return e;
  }

  read<T extends { readonly obs: FactObs }>(name: FactName, key: string, parse: (v: unknown) => T | null, freshness: Freshness, neededBy: HardGate): Read<T> {
    const v = this.raw(key);
    if (v === undefined) return { ok: false, reason: evidenceReason(name, 'missing', neededBy, `no ${name} as of slot ${this.now.slot}`) };
    const fact = parse(v);
    if (fact === null) return { ok: false, reason: evidenceReason(name, 'malformed', neededBy, `${name} is not in the expected shape`) };
    const problem = obsProblem(fact.obs, this.now);
    if (problem) return { ok: false, reason: evidenceReason(name, problem.code, neededBy, `${name} ${problem.detail}`, problem.value) };
    if (freshness === 'state' || freshness === 'event') {
      const c = fact.obs.commitment;
      if (c === undefined) return { ok: false, reason: evidenceReason(name, 'malformed', neededBy, `${name} is a chain read without a commitment`) };
      if (c === 'processed') return { ok: false, reason: evidenceReason(name, 'degraded', neededBy, `${name} was read at processed commitment`, 'processed') };
    }
    const stale = this.#staleness(name, fact.obs, freshness, neededBy);
    return stale ? { ok: false, reason: stale } : { ok: true, fact };
  }

  #staleness(name: FactName, obs: FactObs, freshness: Freshness, neededBy: HardGate): GateReason | null {
    const now = this.now;
    const { maxStateSlotLag, maxQuoteAgeMs } = this.#policy.gates;
    if (freshness === 'event' || freshness === 'series') return null;
    if (freshness === 'offchain') {
      const age = now.receivedAt - obs.receivedAt;
      return age > maxQuoteAgeMs ? evidenceReason(name, 'stale', neededBy, `${name} is ${age} ms old`, String(age), String(maxQuoteAgeMs)) : null;
    }
    if (obs.slot === null) return evidenceReason(name, 'malformed', neededBy, `${name} is chain state without a slot`);
    const lag = BigInt(maxStateSlotLag);
    // Never past now: a tip ahead of the clock cannot have been observed.
    const tip = this.#ctx.observedTip < now.slot ? this.#ctx.observedTip : now.slot;
    if (obs.stream === undefined) {
      const behind = tip - obs.slot;
      return behind > lag ? evidenceReason(name, 'stale', neededBy, `${name} read at slot ${obs.slot}, ${behind} slots behind`, String(behind), String(lag)) : null;
    }
    const sv = this.raw(streamKey(obs.stream));
    if (sv === undefined) return evidenceReason('stream', 'missing', neededBy, `no head for stream ${obs.stream} that keeps ${name} current`);
    const stream = parseStream(sv);
    if (stream === null) return evidenceReason('stream', 'malformed', neededBy, `stream ${obs.stream} is not in the expected shape`);
    const problem = obsProblem(stream.obs, now);
    if (problem) return evidenceReason('stream', problem.code, neededBy, `stream ${obs.stream} ${problem.detail}`, problem.value);
    const head = stream.obs.slot ?? 0n;
    const behind = tip - head;
    if (behind > lag) return evidenceReason('stream', 'stale', neededBy, `stream ${obs.stream} is at slot ${head}, ${behind} slots behind`, String(behind), String(lag));
    if (stream.gapFreeSince > obs.slot) {
      return evidenceReason('stream', 'gap', neededBy, `stream ${obs.stream} had a gap after ${name} was observed at slot ${obs.slot} (gap-free since ${stream.gapFreeSince})`);
    }
    return null;
  }
}
