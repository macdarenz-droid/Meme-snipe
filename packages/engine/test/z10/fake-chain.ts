// A fake Solana JSON-RPC for the recorder's composition tests and the soak (card Z10). SYNTHETIC: the account bytes are
// real mainnet fixtures (fixtures/mainnet, captured 2026-10-06), but every change over time is made up here: each second
// a seeded share of pools trade, which moves their two vault balances. Nothing is read from any network.
//
// Each provider is a URL (`https://<label>.fake/...`) with its own slot offset, so tests can put one provider behind
// or ahead of the others (C-84 skew test, the R6c probe).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { base58, decodePubkey } from '@bot/decoders';
import type { Clock, Pubkey, UnixMs } from '@bot/types';
import type { FetchLike, Scheduler } from '../../src/m14/types.ts';

export const FIXTURES = new URL('../../../../fixtures/mainnet/', import.meta.url).pathname;
export const SLOT_MS = 400;

/** Wall clock and monotonic timers on one virtual time line; timers in a heap, fired in time then creation order. */
export class VirtualTime implements Clock, Scheduler {
  readonly kind = 'sim' as const;
  private mono = 0;
  private seq = 0;
  private heap: Array<{ at: number; seq: number; fn: () => void; live: boolean }> = [];
  readonly wallStartMs: number;
  constructor(wallStartMs: number) { this.wallStartMs = wallStartMs; }
  nowMs(): UnixMs { return (this.wallStartMs + this.mono) as UnixMs; }
  /** The monotonic reading (M14 `Scheduler.nowMs`) and the wall reading are one line: a scheduler view of it. */
  readonly scheduler: Scheduler = { nowMs: () => this.mono, set: (fn, ms) => this.set(fn, ms) };
  set(fn: () => void, ms: number): () => void {
    const t = { at: this.mono + Math.max(0, ms), seq: this.seq++, fn, live: true };
    this.push(t);
    return () => { t.live = false; };
  }
  elapsedMs(): number { return this.mono; }
  /** Advances by `ms`, firing due timers in order and letting promise callbacks settle after each. */
  async advance(ms: number): Promise<void> {
    const end = this.mono + ms;
    await settle();
    for (;;) {
      const next = this.heap[0];
      if (next === undefined || next.at > end) break;
      this.pop();
      if (!next.live) continue;
      this.mono = Math.max(this.mono, next.at);
      next.fn();
      await settle();
    }
    this.mono = end;
    await settle();
  }
  private less(a: { at: number; seq: number }, b: { at: number; seq: number }): boolean { return a.at < b.at || (a.at === b.at && a.seq < b.seq); }
  private push(t: { at: number; seq: number; fn: () => void; live: boolean }): void {
    const h = this.heap;
    h.push(t);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i]!, h[p]!)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }
  private pop(): void {
    const h = this.heap;
    const last = h.pop()!;
    if (h.length === 0) return;
    h[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < h.length && this.less(h[l]!, h[m]!)) m = l;
      if (r < h.length && this.less(h[r]!, h[m]!)) m = r;
      if (m === i) return;
      [h[i], h[m]] = [h[m]!, h[i]!];
      i = m;
    }
  }
}

export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
}

/** A small seeded RNG (mulberry32): the soak is the same on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Acc { owner: string; data: Uint8Array }
export interface FixturePool { pool: Pubkey; baseMint: Pubkey; quoteMint: Pubkey; baseVault: Pubkey; quoteVault: Pubkey }
/** `slotOffset` moves the provider's context slots; `heightOffset` moves only its `getEpochInfo` answers (a node whose
 * height reading trails its own reads, to put the slot clock behind the tip). */
export interface ProviderBehaviour { slotOffset: number; heightOffset: number; down: boolean; slotOverride?: bigint }

/** Reads every pool set and config account of fixtures/mainnet. */
export function loadFixtureAccounts(): { accounts: Map<string, Acc>; pools: FixturePool[]; baseSlot: bigint; migrations: Array<{ signature: string; slot: bigint; blockTime: number; json: unknown }> } {
  const accounts = new Map<string, Acc>();
  const pools: FixturePool[] = [];
  let baseSlot = 0n;
  const add = (a: { pubkey: string; owner: string; data_base64: string; context_slot?: string }): void => {
    accounts.set(a.pubkey, { owner: a.owner, data: new Uint8Array(Buffer.from(a.data_base64, 'base64')) });
    if (a.context_slot !== undefined && BigInt(a.context_slot) > baseSlot) baseSlot = BigInt(a.context_slot);
  };
  for (const f of readdirSync(join(FIXTURES, 'pumpswap/pools')).sort()) {
    const d = JSON.parse(readFileSync(join(FIXTURES, 'pumpswap/pools', f), 'utf8')) as { pool: string; accounts: Array<{ role: string; pubkey: string; owner: string; data_base64: string; context_slot: string }> };
    for (const a of d.accounts) add(a);
    const by = (r: string): Pubkey => d.accounts.find((a) => a.role === r)!.pubkey as Pubkey;
    pools.push({ pool: d.pool as Pubkey, baseMint: by('base_mint'), quoteMint: by('quote_mint'), baseVault: by('base_vault'), quoteVault: by('quote_vault') });
  }
  for (const f of readdirSync(join(FIXTURES, 'config')).sort()) {
    const d = JSON.parse(readFileSync(join(FIXTURES, 'config', f), 'utf8')) as { accounts: Array<{ pubkey: string; owner: string; data_base64: string }> };
    for (const a of d.accounts) add(a);
  }
  const migrations = readdirSync(join(FIXTURES, 'tx/migration')).sort().map((f) => {
    const d = JSON.parse(readFileSync(join(FIXTURES, 'tx/migration', f), 'utf8')) as { signature: string; slot: number; blockTime: number; json: unknown };
    return { signature: d.signature, slot: BigInt(d.slot), blockTime: d.blockTime, json: d.json };
  });
  return { accounts, pools, baseSlot, migrations };
}

/** A synthetic pubkey from a label (SYNTHETIC clones of the fixture pools). */
export const synthKey = (label: string): Pubkey => base58.encode(createHash('sha256').update(label).digest()) as Pubkey;

export class FakeChain {
  readonly accounts: Map<string, Acc>;
  readonly pools: FixturePool[];
  readonly baseSlot: bigint;
  readonly migrations: ReturnType<typeof loadFixtureAccounts>['migrations'];
  readonly behaviour = new Map<string, ProviderBehaviour>();
  readonly calls = new Map<string, number>();
  /** Calls by `label method`. */
  readonly byMethod = new Map<string, number>();
  /** Pool ids served as aliases of a fixture pool (same account bytes; SYNTHETIC). */
  readonly aliases = new Map<string, string>();
  migrationsVisible = 0;
  /** A getMultipleAccounts that names any of these keys answers an RPC error (a read that never reaches the account). */
  readonly failKeys = new Set<string>();
  private readonly rand: () => number;
  private lastEvolveSec = -1;

  private readonly time: VirtualTime;
  constructor(time: VirtualTime, o: { seed: number; tradeShare?: number } = { seed: 1 }) {
    this.time = time;
    const f = loadFixtureAccounts();
    this.accounts = f.accounts;
    this.pools = f.pools;
    this.baseSlot = f.baseSlot;
    this.migrations = f.migrations;
    this.rand = rng(o.seed);
    this.tradeShare = o.tradeShare ?? 0.3;
  }
  private readonly tradeShare: number;

  provider(label: string): ProviderBehaviour {
    let b = this.behaviour.get(label);
    if (b === undefined) { b = { slotOffset: 0, heightOffset: 0, down: false }; this.behaviour.set(label, b); }
    return b;
  }

  tipSlot(): bigint { return this.baseSlot + BigInt(Math.floor(this.time.elapsedMs() / SLOT_MS)); }
  slotFor(label: string): bigint {
    const b = this.provider(label);
    if (b.slotOverride !== undefined) return b.slotOverride;
    const s = this.tipSlot() + BigInt(b.slotOffset);
    return s < 1n ? 1n : s;
  }

  /** Each new second, a seeded share of fixture pools trade: base and quote vault amounts move in opposite ways. */
  private evolve(): void {
    const sec = Math.floor(this.time.elapsedMs() / 1_000);
    if (sec === this.lastEvolveSec) return;
    this.lastEvolveSec = sec;
    for (const p of this.pools) {
      if (this.rand() >= this.tradeShare) continue;
      const base = this.accounts.get(p.baseVault), quote = this.accounts.get(p.quoteVault);
      if (base === undefined || quote === undefined) continue;
      const bv = new DataView(base.data.buffer, base.data.byteOffset), qv = new DataView(quote.data.buffer, quote.data.byteOffset);
      const b = bv.getBigUint64(64, true), q = qv.getBigUint64(64, true);
      // A swap of up to 0.5% of the quote side, constant product (fees left out: the shape, not the price, matters here).
      const dq = (q * BigInt(Math.floor(this.rand() * 50))) / 10_000n;
      const buy = this.rand() < 0.5;
      const q2 = buy ? q + dq : q - dq;
      if (q2 <= 0n) continue;
      const b2 = (b * q) / q2;
      // Copy on write: a snapshot already handed out never changes under its reader.
      const nb = new Uint8Array(base.data), nq = new Uint8Array(quote.data);
      new DataView(nb.buffer).setBigUint64(64, b2, true);
      new DataView(nq.buffer).setBigUint64(64, q2, true);
      this.accounts.set(p.baseVault, { owner: base.owner, data: nb });
      this.accounts.set(p.quoteVault, { owner: quote.owner, data: nq });
    }
  }

  /**
   * A SYNTHETIC copy of a fixture pool at a new address, with its own two vaults (copies of the fixture's, whose token
   * authority, bytes 32-64 of an SPL token account, is the new pool) and the pool's data naming them. It trades like
   * every pool (evolve). The mint is the fixture's, so the canonical-creator check still holds.
   */
  clonePool(from: FixturePool, label: string): FixturePool {
    const pool = synthKey(`${label}:pool`), baseVault = synthKey(`${label}:base`), quoteVault = synthKey(`${label}:quote`);
    const swap = (data: Uint8Array, a: string, b: string): Uint8Array => {
      const out = new Uint8Array(data);
      const old = decodePubkey(a), nu = decodePubkey(b);
      for (let i = 0; i + 32 <= out.length; i++) if (old.every((x, k) => out[i + k] === x)) out.set(nu, i);
      return out;
    };
    const src = this.accounts.get(from.pool) as Acc;
    let poolData = swap(src.data, from.baseVault, baseVault);
    poolData = swap(poolData, from.quoteVault, quoteVault);
    this.accounts.set(pool, { owner: src.owner, data: poolData });
    for (const [v, nv] of [[from.baseVault, baseVault], [from.quoteVault, quoteVault]] as const) {
      const a = this.accounts.get(v) as Acc;
      const d = new Uint8Array(a.data);
      d.set(decodePubkey(pool), 32);
      this.accounts.set(nv, { owner: a.owner, data: d });
    }
    const p: FixturePool = { pool, baseMint: from.baseMint, quoteMint: from.quoteMint, baseVault, quoteVault };
    this.pools.push(p);
    return p;
  }

  /** Forgets a clone's accounts (a pool that closed; keeps the fake's own memory bounded in long soaks). */
  dropPool(p: FixturePool): void {
    for (const k of [p.pool, p.baseVault, p.quoteVault]) this.accounts.delete(k);
    const i = this.pools.indexOf(p);
    if (i >= 0) this.pools.splice(i, 1);
  }

  private account(key: string): Acc | null {
    return this.accounts.get(this.aliases.get(key) ?? key) ?? null;
  }

  private answer(label: string, method: string, params: unknown[]): { result?: unknown; error?: { code: number; message: string } } {
    const slot = this.slotFor(label);
    const ctx = { context: { slot } };
    switch (method) {
      case 'getEpochInfo': return { result: { absoluteSlot: slot + BigInt(this.provider(label).heightOffset), blockHeight: slot - 20_000_000n, epoch: 1000, slotIndex: 1, slotsInEpoch: 432_000, transactionCount: null } };
      case 'getSlot': return { result: slot };
      case 'getHealth': return { result: 'ok' };
      case 'getRecentPerformanceSamples': return { result: Array.from({ length: 30 }, (_, i) => ({ slot: slot - BigInt(i * 150), numSlots: 150, numTransactions: 1, numNonVoteTransactions: 1, samplePeriodSecs: 60 })) };
      case 'getMultipleAccounts': {
        this.evolve();
        const keys = params[0] as string[];
        if (keys.some((k) => this.failKeys.has(k))) return { error: { code: -32603, message: 'Internal error' } };
        return { result: { ...ctx, value: keys.map((k) => { const a = this.account(k); return a === null ? null : { owner: a.owner, data: [Buffer.from(a.data).toString('base64'), 'base64'], lamports: 2_000_000, executable: false, rentEpoch: 0, space: a.data.length }; }) } };
      }
      case 'getSignaturesForAddress': {
        const visible = this.migrations.slice(0, this.migrationsVisible).sort((a, b) => (b.slot > a.slot ? 1 : b.slot < a.slot ? -1 : 0));
        return { result: visible.map((m) => ({ signature: m.signature, slot: m.slot, err: null, memo: null, blockTime: m.blockTime, confirmationStatus: 'confirmed' })) };
      }
      case 'getTransaction': {
        const m = this.migrations.find((x) => x.signature === params[0]);
        return { result: m === undefined ? null : m.json };
      }
      default: return { error: { code: -32601, message: 'Method not found' } };
    }
  }

  readonly fetch: FetchLike = async (url, init) => {
    const label = /^https:\/\/([a-z]+)\.fake\//.exec(url)?.[1] ?? 'unknown';
    this.calls.set(label, (this.calls.get(label) ?? 0) + 1);
    const req = JSON.parse(init.body) as { id: unknown; method: string; params?: unknown[] };
    if (this.provider(label).down) return new Response('unavailable', { status: 503 });
    this.byMethod.set(`${label} ${req.method}`, (this.byMethod.get(`${label} ${req.method}`) ?? 0) + 1);
    const a = this.answer(label, req.method, req.params ?? []);
    return new Response(jsonWithBigints({ jsonrpc: '2.0', id: req.id, ...a }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
}

/** JSON text with every bigint written as a JSON number (RPC slots are u64). */
export function jsonWithBigints(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? `__u64:${x}__` : x)).replace(/"__u64:(-?\d+)__"/g, '$1');
}

export const FAKE_SECRETS: Readonly<Record<string, string>> = Object.freeze({ RPC_SHYFT_URL: 'https://shyft.fake/rpc?api_key=TEST', RPC_CHAINSTACK_URL: 'https://chainstack.fake/TESTKEY' });
