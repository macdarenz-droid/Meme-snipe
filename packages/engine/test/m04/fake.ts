// Test doubles for M04 (card Z07): a tiny pool model (reserves as little-endian integers in the vault data), a
// scripted accounts reader and a chain-state stub. The real PumpSwap model is exercised in tracker-venue.test.ts.
import type { Commitment, Pubkey, Result, Slot, UnixMs } from '@bot/types';
import type { AccountsReader, ChainStatePort, PoolModelPort, RawAccount, ReadResult, TrackerOutputs, PoolSnapshot, PoolClass } from '../../src/m04/types.ts';

export interface FakePool { poolId: Pubkey; asOfSlot: Slot; commitment: Commitment; observedAtMs: UnixMs; base: bigint; quote: bigint }

export const u64 = (v: bigint): Uint8Array => { const b = Buffer.alloc(8); b.writeBigInt64LE(v); return new Uint8Array(b); };
const read64 = (d: Uint8Array): bigint => Buffer.from(d).readBigInt64LE(0);

export const fakeModel: PoolModelPort<FakePool> = {
  addresses(poolId, raw) {
    if (raw === null) return { ok: false, error: { code: 'E_CLOSED', detail: '' } };
    if (raw.owner !== 'amm') return { ok: false, error: { code: 'E_OWNER_CHANGED', detail: '' } };
    if (raw.data[0] === 9) return { ok: false, error: { code: 'E_LAYOUT', detail: '' } };
    return { ok: true, value: { poolId, baseVault: `${poolId}:b`, quoteVault: `${poolId}:q`, tokenMint: `${poolId}:m` } };
  },
  mint: (raw) => (raw !== null && raw.owner === 'tok' ? { supply: 1_000n, decimals: 6 } : null),
  build(addr, a, _mint, ctx) {
    if (a.pool === null) return { ok: false, error: { code: 'E_CLOSED', detail: '' } };
    if (a.pool.owner !== 'amm') return { ok: false, error: { code: 'E_OWNER_CHANGED', detail: '' } };
    if (a.pool.data[0] === 9) return { ok: false, error: { code: 'E_LAYOUT', detail: '' } };
    if (a.baseVault === null || a.quoteVault === null) return { ok: false, error: { code: 'E_PARTIAL', detail: '' } };
    if (a.baseVault.owner !== 'tok' || a.quoteVault.owner !== 'tok') return { ok: false, error: { code: 'E_OWNER_CHANGED', detail: '' } };
    const base = read64(a.baseVault.data), quote = read64(a.quoteVault.data);
    if (quote < 0n) return { ok: false, error: { code: 'E_NEGATIVE_EFFECTIVE', detail: '' } };
    return { ok: true, value: { poolId: addr.poolId, asOfSlot: ctx.asOfSlot, commitment: 'confirmed', observedAtMs: ctx.observedAtMs, base, quote } };
  },
  effectiveQuote: (p) => p.quote,
  spot: (p) => (p.base === 0n ? null : `${p.quote}/${p.base}`),
  feeTotalBps: (p) => (p.base === 7n ? null : 30),
  recordBytes: 32,
  encode(p, out, at) {
    const v = new DataView(out.buffer, out.byteOffset + at, 32);
    v.setBigInt64(0, p.base, true); v.setBigInt64(8, p.quote, true); v.setBigUint64(16, p.asOfSlot, true); v.setFloat64(24, p.observedAtMs, true);
  },
  decode(addr, buf, at) {
    const v = new DataView(buf.buffer, buf.byteOffset + at, 32);
    return { poolId: addr.poolId, base: v.getBigInt64(0, true), quote: v.getBigInt64(8, true), asOfSlot: v.getBigUint64(16, true) as Slot, commitment: 'confirmed', observedAtMs: v.getFloat64(24, true) as UnixMs };
  },
  canonicalCreator: async () => 'creator',
  recordFields: (p) => ({ base: p.base.toString(), quote: p.quote.toString() }),
};

/** The three accounts of pool `id` with these reserves (the fake model's layout). */
export function poolAccounts(id: string, base: bigint, quote: bigint): Map<string, RawAccount | null> {
  return new Map<string, RawAccount | null>([
    [id, { owner: 'amm', data: new Uint8Array(8) }], [`${id}:b`, { owner: 'tok', data: u64(base) }], [`${id}:q`, { owner: 'tok', data: u64(quote) }],
    [`${id}:m`, { owner: 'tok', data: new Uint8Array(82) }],
  ]);
}

export interface Call { keys: Pubkey[]; priority: number; provider: string | undefined }

/** A reader over a mutable account map; `slot()` and `provider()` decide each answer's context slot and label. */
export class ScriptedReader implements AccountsReader {
  accounts = new Map<string, RawAccount | null>();
  calls: Call[] = [];
  fail = false;
  slot: (call: Call) => bigint = () => 1_000n;
  provider: (call: Call) => string = (c) => c.provider ?? 'primary';
  latency = 7;
  /** Holds every answer until released (overlap tests). */
  gate: Promise<void> | null = null;
  async read(keys: readonly Pubkey[], o: { priority: 0 | 1 | 2 | 3 | 4; provider?: string }): Promise<Result<ReadResult, { code: string; message: string }>> {
    const call = { keys: [...keys], priority: o.priority, provider: o.provider };
    this.calls.push(call);
    if (this.gate !== null) await this.gate;
    if (this.fail) return { ok: false, error: { code: 'E_ALL_PROVIDERS_DOWN', message: 'down' } };
    return { ok: true, value: { contextSlot: this.slot(call) as Slot, providerLabel: this.provider(call), latencyMs: this.latency, accounts: keys.map((k) => this.accounts.get(k) ?? null) } };
  }
}

export class FakeChain implements ChainStatePort {
  highest = 1_000n;
  slotMs = 250;
  /** The slot clock's estimate; null: follow `highest` (an honest cluster). */
  expected: bigint | null = null;
  highestSeenSlot(): Slot { return this.highest as Slot; }
  expectedSlot(): Slot { return (this.expected ?? this.highest) as Slot; }
  slotDurationMsEstimate(): number { return this.slotMs; }
}

/** Records every output. */
export class Outputs<P extends FakePool = FakePool> implements TrackerOutputs<P> {
  snapshots: Array<{ s: PoolSnapshot<P>; cls: PoolClass }> = [];
  closedEvents: Array<{ poolId: string; reason: string }> = [];
  staleEvents: Array<{ poolId: string; lagSlots: number }> = [];
  freshEvents: string[] = [];
  quarantines: Array<[string, string]> = [];
  lagging: Array<[string, number]> = [];
  unwatchedPools: string[] = [];
  snapshot(s: PoolSnapshot<P>, cls: PoolClass): void { this.snapshots.push({ s, cls }); }
  closed(e: { poolId: string; reason: string }): void { this.closedEvents.push(e); }
  stale(e: { poolId: string; lagSlots: number }): void { this.staleEvents.push({ poolId: e.poolId, lagSlots: e.lagSlots }); }
  fresh(e: { poolId: string }): void { this.freshEvents.push(e.poolId); }
  quarantine(poolId: string, reason: string): void { this.quarantines.push([poolId, reason]); }
  providerLagging(label: string, lag: number): void { this.lagging.push([label, lag]); }
  unwatched(poolId: string): void { this.unwatchedPools.push(poolId); }
}

export class Logs {
  lines: Array<[string, string, Record<string, unknown>]> = [];
  event(level: string, code: string, fields: Readonly<Record<string, unknown>>): void { this.lines.push([level, code, { ...fields }]); }
  codes(): string[] { return this.lines.map(([, c]) => c); }
}

export class Metrics {
  counts = new Map<string, number>();
  observed: Array<[string, Record<string, string>, number]> = [];
  gauges = new Map<string, number>();
  counter(name: string, labels: Readonly<Record<string, string>>): void { const k = `${name}${JSON.stringify(labels)}`; this.counts.set(k, (this.counts.get(k) ?? 0) + 1); }
  observe(name: string, labels: Readonly<Record<string, string>>, v: number): void { this.observed.push([name, { ...labels }, v]); }
  gauge(name: string, labels: Readonly<Record<string, string>>, v: number): void { this.gauges.set(`${name}${JSON.stringify(labels)}`, v); }
  count(name: string, labels: Record<string, string> = {}): number { return this.counts.get(`${name}${JSON.stringify(labels)}`) ?? 0; }
}
