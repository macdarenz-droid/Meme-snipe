// Live reads for the fact producers (FACTS-1). Each reader asks a provider through its quota scheduler and ingests the
// answer into the live feed under a raw key (core/src/facts/raw.ts), trimmed to the fields the producers read. It
// never makes a gate fact itself: core's FactProducer does, from the released answer, exactly as it would from the
// same answer replayed. A failed or malformed read ingests nothing, so the gate sees no fact and rejects (H16).
// Chain reads go to Helius at `confirmed` (standard RPC, 1 credit each, data.md §1.2); the gates refuse `processed`.
import {
  type Address, NATIVE_MINT, SYSTEM_PROGRAM, decodeBase58, decodeMint, isOnCurve, decodePool, decodeTokenAccount, firstFunder, fromBase64, poolAddress,
  pumpPoolAuthority, recordFromRpc, transactionEvents, type RpcTransactionBase64, type TransactionRecord,
} from '../../../core/src/chain/index.ts';
import {
  type AccountsRead, type ExecStats, type FunderRead, type HoldersRead, type SimRead, RAW, parseExecStats, parseSimRead,
} from '../../../core/src/facts/index.ts';
import { HELIUS_RPC_CREDITS } from '../scheduler/limits.ts';
import { P2, type Priority, type Scheduler } from '../scheduler/scheduler.ts';
import type { Timers } from '../scheduler/timers.ts';
import type { FrameBody, Source } from '../providers/canonical.ts';
import { isAddress } from '../providers/canonical.ts';
import { type HttpClient, type Secrets, parseJson, ProviderError, scrub, send } from '../providers/http.ts';
import type { IngestOptions } from '../providers/live-feed.ts';

/** Every JSON-RPC method the fact reads may call: reads only. Frozen; nothing that sends is or may be added. */
export const FACT_RPC_METHODS = Object.freeze(['getAccountInfo', 'getMultipleAccounts', 'getProgramAccounts', 'getTokenLargestAccounts', 'getSignaturesForAddress', 'getTransaction'] as const);
export type FactRpcMethod = (typeof FACT_RPC_METHODS)[number];

export interface Ingest {
  ingest(source: Source, body: FrameBody, o: IngestOptions): unknown;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const U64 = /^(0|[1-9][0-9]{0,19})$/;

export interface FactRpcOptions {
  /** Built on every call from `Secrets`, so the key is never kept. */
  readonly url: () => string;
  readonly http: HttpClient;
  /** The Helius scheduler. */
  readonly scheduler: Scheduler;
  readonly timeoutMs: number;
}

/** Helius JSON-RPC reads at `confirmed`, each one standard call through the scheduler. */
export class FactRpc {
  readonly #o: FactRpcOptions;
  #id = 1;

  constructor(o: FactRpcOptions) {
    this.#o = o;
  }

  async call(method: FactRpcMethod, params: readonly unknown[], priority: Priority): Promise<unknown> {
    if (!(FACT_RPC_METHODS as readonly string[]).includes(method)) throw new RangeError(`fact reads: method ${method} is not allowed`);
    const o = this.#o;
    return o.scheduler.run(priority, HELIUS_RPC_CREDITS, async () => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: this.#id++, method, params });
      const res = await send(o.http, 'helius', method, { method: 'POST', url: o.url(), headers: { 'content-type': 'application/json' }, body, timeoutMs: o.timeoutMs });
      if (res.status === 429) {
        o.scheduler.penalize();
        throw new ProviderError('helius', 'rate_limited', `${method} rate limited`, 429);
      }
      if (res.status !== 200) throw new ProviderError('helius', 'http', `${method} returned HTTP ${res.status}`, res.status);
      const json = parseJson('helius', method, res.text);
      if (!isObj(json)) throw new ProviderError('helius', 'shape', `${method} returned no object`);
      if (json['error'] !== undefined) {
        const e = json['error'];
        throw new ProviderError('helius', 'rpc', `${method} error ${isObj(e) && typeof e['code'] === 'number' ? e['code'] : 'unknown'}`);
      }
      return json['result'];
    });
  }

  /** Accounts at confirmed in one bank: base64 data, or null for an account that does not exist. */
  async getMultipleAccounts(addresses: readonly string[], priority: Priority, dataSlice?: { readonly offset: number; readonly length: number }): Promise<{ slot: bigint; accounts: ({ owner: string; data: string } | null)[] }> {
    if (addresses.length === 0 || addresses.length > 100 || !addresses.every(isAddress)) throw new RangeError('getMultipleAccounts takes 1 to 100 base58 addresses');
    const r = await this.call('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'confirmed', ...(dataSlice === undefined ? {} : { dataSlice }) }], priority);
    const slot = contextSlot(r, 'getMultipleAccounts');
    const value = (r as Obj)['value'];
    if (!Array.isArray(value) || value.length !== addresses.length) throw new ProviderError('helius', 'shape', 'getMultipleAccounts returned the wrong number of accounts');
    return {
      slot,
      accounts: value.map((v: unknown) => {
        if (v === null) return null;
        const d = isObj(v) ? v['data'] : undefined;
        if (!isObj(v) || typeof v['owner'] !== 'string' || !Array.isArray(d) || d[1] !== 'base64' || typeof d[0] !== 'string') throw new ProviderError('helius', 'shape', 'account is not base64-encoded');
        return { owner: v['owner'], data: d[0] };
      }),
    };
  }

  async getAccountInfo(address: string, priority: Priority): Promise<{ slot: bigint; account: { owner: string; data: string } | null }> {
    const r = await this.call('getAccountInfo', [address, { encoding: 'base64', commitment: 'confirmed' }], priority);
    const slot = contextSlot(r, 'getAccountInfo');
    const v = (r as Obj)['value'];
    if (v === null) return { slot, account: null };
    const d = isObj(v) ? v['data'] : undefined;
    if (!isObj(v) || typeof v['owner'] !== 'string' || !Array.isArray(d) || d[1] !== 'base64' || typeof d[0] !== 'string') throw new ProviderError('helius', 'shape', 'account is not base64-encoded');
    return { slot, account: { owner: v['owner'], data: d[0] } };
  }

  /** Every account of `program` whose bytes at offset 0 are `mint` (token accounts of that mint), in one response. */
  async getProgramAccounts(program: string, mint: string, minContextSlot: bigint, priority: Priority): Promise<{ slot: bigint; accounts: { address: string; owner: string; data: string }[] }> {
    const r = await this.call('getProgramAccounts', [program, { encoding: 'base64', commitment: 'confirmed', withContext: true, minContextSlot: Number(minContextSlot), filters: [{ memcmp: { offset: 0, bytes: mint } }] }], priority);
    const slot = contextSlot(r, 'getProgramAccounts');
    const value = (r as Obj)['value'];
    if (!Array.isArray(value)) throw new ProviderError('helius', 'shape', 'getProgramAccounts value is not an array');
    return {
      slot,
      accounts: value.map((x: unknown) => {
        const a = isObj(x) ? x['account'] : undefined;
        const d = isObj(a) ? a['data'] : undefined;
        if (!isObj(x) || typeof x['pubkey'] !== 'string' || !isObj(a) || typeof a['owner'] !== 'string' || !Array.isArray(d) || d[1] !== 'base64' || typeof d[0] !== 'string') {
          throw new ProviderError('helius', 'shape', 'bad program account entry');
        }
        return { address: x['pubkey'], owner: a['owner'], data: d[0] };
      }),
    };
  }

  async getTokenLargestAccounts(mint: string, priority: Priority): Promise<{ slot: bigint; accounts: { address: string; amount: bigint }[] }> {
    const r = await this.call('getTokenLargestAccounts', [mint, { commitment: 'confirmed' }], priority);
    const slot = contextSlot(r, 'getTokenLargestAccounts');
    const value = (r as Obj)['value'];
    if (!Array.isArray(value)) throw new ProviderError('helius', 'shape', 'getTokenLargestAccounts value is not an array');
    return {
      slot,
      accounts: value.map((x: unknown) => {
        if (!isObj(x) || !isAddress(x['address']) || typeof x['amount'] !== 'string' || !U64.test(x['amount'])) throw new ProviderError('helius', 'shape', 'bad largest-account entry');
        return { address: x['address'], amount: BigInt(x['amount']) };
      }),
    };
  }

  /** Signatures for `address`, newest first, older than `before` when given. */
  async getSignaturesForAddress(address: string, opts: { readonly before?: string; readonly limit: number }, priority: Priority): Promise<{ signature: string; slot: bigint; err: unknown }[]> {
    const cfg: Obj = { commitment: 'confirmed', limit: opts.limit };
    if (opts.before !== undefined) cfg['before'] = opts.before;
    const r = await this.call('getSignaturesForAddress', [address, cfg], priority);
    if (!Array.isArray(r)) throw new ProviderError('helius', 'shape', 'getSignaturesForAddress result is not an array');
    return r.map((x: unknown) => {
      if (!isObj(x) || typeof x['signature'] !== 'string' || !Number.isSafeInteger(x['slot'])) throw new ProviderError('helius', 'shape', 'bad signature entry');
      return { signature: x['signature'], slot: BigInt(x['slot'] as number), err: x['err'] ?? null };
    });
  }

  async getTransaction(signature: string, priority: Priority): Promise<TransactionRecord | null> {
    const r = await this.call('getTransaction', [signature, { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }], priority);
    if (r === null) return null;
    if (!isObj(r)) throw new ProviderError('helius', 'shape', 'getTransaction result is not an object');
    try {
      return recordFromRpc(signature, r as unknown as RpcTransactionBase64);
    } catch {
      throw new ProviderError('helius', 'shape', 'getTransaction result does not decode');
    }
  }
}

const contextSlot = (r: unknown, method: string): bigint => {
  if (!isObj(r) || !isObj(r['context']) || !Number.isSafeInteger(r['context']['slot'])) throw new ProviderError('helius', 'shape', `${method} result has no context slot`);
  return BigInt(r['context']['slot'] as number);
};

/** A third-party HTTP source with its own scheduler. */
export interface ThirdParty {
  readonly scheduler: Scheduler;
  readonly base?: string;
}

export interface FactReadersOptions {
  readonly feed: Ingest;
  readonly rpc: FactRpc;
  readonly http: HttpClient;
  readonly timers: Timers;
  readonly timeoutMs: number;
  readonly rugcheck?: ThirdParty;
  readonly goplus?: ThirdParty;
  /** Jupiter Tokens (the shared main bucket; the `tokens` lane is capped at 6 a minute for P3). */
  readonly jupiter?: ThirdParty & { readonly secrets: Secrets };
  readonly coinbase?: ThirdParty;
  /** Complete holder scans allowed per UTC day (getProgramAccounts is the costly read). Reached: no scan, H13 abstains. */
  readonly holderScansPerDay?: number;
}

export const RUGCHECK_BASE = 'https://api.rugcheck.xyz';
export const GOPLUS_BASE = 'https://api.gopluslabs.io';
export const JUPITER_BASE = 'https://api.jup.ag';
export const COINBASE_BASE = 'https://api.exchange.coinbase.com';
const HOUR_MS = 3_600_000;

export interface FunderOptions {
  /** The decision slot: later history never counts. */
  readonly asOfSlot: bigint;
  /** The wallet's first buy of the mint (the create, for the dev): its funding must come before it. */
  readonly beforeSlot: bigint;
  readonly maxPages: number;
  /** Transactions read oldest first looking for the funding. */
  readonly maxTransactions: number;
}

/** What one read cost and whether it ingested, for the worker's journal and the live-only veto rates. */
export interface ReadOutcome {
  readonly read: string;
  readonly ok: boolean;
  readonly detail: string;
}

export class FactReaders {
  readonly #o: FactReadersOptions;
  /** Vault and LP addresses per mint, once its pool was read. */
  readonly #layout = new Map<string, readonly string[]>();
  /** SOL/USD bars already ingested, by start. */
  readonly #bars = new Set<number>();
  readonly outcomes: ReadOutcome[] = [];

  constructor(o: FactReadersOptions) {
    this.#o = o;
  }

  #ingest(source: Source, key: string, value: unknown): void {
    this.#o.feed.ingest(source, { type: 'offchain', key, value }, { receivedAt: this.#o.timers.now() });
  }

  async #guard(read: string, f: () => Promise<string>): Promise<boolean> {
    try {
      this.outcomes.push({ read, ok: true, detail: await f() });
      return true;
    } catch (e) {
      this.outcomes.push({ read, ok: false, detail: e instanceof Error ? e.message : 'failed' });
      return false;
    }
  }

  /** The canonical pool of a pump mint: PDA(index 0, pool authority of the mint, mint, wrapped SOL). */
  static canonicalPool(mint: string): string {
    return poolAddress(0, pumpPoolAuthority(mint as Address), mint as Address, NATIVE_MINT);
  }

  /**
   * Mint, canonical pool, both vaults and the LP mint in one bank (`read:accounts:<mint>`). The first read of a mint
   * learns the vault and LP addresses from the pool, then reads all five together.
   */
  async readAccounts(mint: string, priority: Priority = P2): Promise<boolean> {
    return this.#guard(`accounts:${mint}`, async () => {
      const pool = FactReaders.canonicalPool(mint);
      let addresses = this.#layout.get(mint) ?? [mint, pool];
      let r = await this.#o.rpc.getMultipleAccounts(addresses, priority);
      if (!this.#layout.has(mint)) {
        const p = r.accounts[1];
        if (p === null || p === undefined) throw new Error(`no pool account at ${pool}`);
        const decoded = decodePool(fromBase64(p.data)).value;
        addresses = [mint, pool, decoded.poolBaseTokenAccount, decoded.poolQuoteTokenAccount, decoded.lpMint];
        this.#layout.set(mint, addresses);
        r = await this.#o.rpc.getMultipleAccounts(addresses, priority);
      }
      const read: AccountsRead = {
        mint, slot: r.slot, commitment: 'confirmed',
        accounts: addresses.map((address, i) => ({ address, owner: r.accounts[i]?.owner ?? null, data: r.accounts[i]?.data ?? null })),
      };
      this.#ingest('helius', RAW.accounts(mint), read);
      return `slot ${r.slot}`;
    });
  }

  /**
   * The 20 largest token accounts of a mint with their owners and the owners' programs (`read:holders:<mint>`).
   * Balances and supply come from one read of the token accounts and the mint together; the slot is the oldest read.
   */
  async readHolders(mint: string, priority: Priority = P2): Promise<boolean> {
    return this.#guard(`holders:${mint}`, async () => {
      const largest = await this.#o.rpc.getTokenLargestAccounts(mint, priority);
      const accts = await this.#o.rpc.getMultipleAccounts([...largest.accounts.map((a) => a.address), mint], priority);
      const m = accts.accounts.at(-1);
      if (m === null || m === undefined) throw new Error('mint account missing');
      const supply = decodeMint(fromBase64(m.data), m.owner as Address).supply;
      const tokens = largest.accounts.map((a, i) => {
        const v = accts.accounts[i];
        if (v === null || v === undefined) return null;
        const t = decodeTokenAccount(fromBase64(v.data), v.owner as Address);
        if (t.mint !== mint) throw new Error(`token account ${a.address} is not of ${mint}`);
        return { address: a.address, owner: t.owner as string, amount: t.amount };
      }).filter((x): x is { address: string; owner: string; amount: bigint } => x !== null);
      const owners = [...new Set(tokens.map((t) => t.owner))];
      const programs = owners.length === 0 ? { slot: accts.slot, accounts: [] } : await this.#o.rpc.getMultipleAccounts(owners, priority, { offset: 0, length: 0 });
      const programOf = new Map(owners.map((o, i) => {
        const a = programs.accounts[i];
        // A plain wallet (System-owned) or an account that does not exist is a system wallet: null.
        return [o, a === null || a === undefined || a.owner === SYSTEM_PROGRAM ? null : a.owner] as const;
      }));
      const slots = [largest.slot, accts.slot, programs.slot];
      const read: HoldersRead = {
        mint, slot: slots.reduce((a, b) => (b < a ? b : a)), commitment: 'confirmed', supply,
        accounts: tokens.map((t) => ({ address: t.address, owner: t.owner, ownerProgram: programOf.get(t.owner) ?? null, amount: t.amount })),
      };
      this.#ingest('helius', RAW.holders(mint), read);
      return `${tokens.length} accounts, slot ${read.slot}`;
    });
  }

  /**
   * The complete holder set of a mint (`read:holders-all:<mint>`): the mint read at confirmed, then one
   * getProgramAccounts on its own token program filtered by the mint at offset 0, then the programs of the off-curve
   * owners (PDAs). Run only for candidates that pass every other gate. Each scan counts against the daily cap; at the
   * cap nothing is read and H12/H13 stay not covered.
   */
  async readHoldersAll(mint: string, priority: Priority = P2): Promise<boolean> {
    const day = Math.floor(this.#o.timers.now() / 86_400_000);
    if (this.#scanDay !== day) {
      this.#scanDay = day;
      this.#scans = 0;
    }
    if (this.#scans >= (this.#o.holderScansPerDay ?? 0)) {
      this.outcomes.push({ read: `holders-all:${mint}`, ok: false, detail: 'daily scan cap reached' });
      return false;
    }
    this.#scans++;
    return this.#guard(`holders-all:${mint}`, async () => {
      const started = this.#o.timers.now();
      const m = await this.#o.rpc.getAccountInfo(mint, priority);
      if (m.account === null) throw new Error('mint account missing');
      // Supply first (slot A), then the scan at a bank no older than A (slot B >= A): with no mint authority the supply
      // can only fall, so balances summing to the supply at A prove nothing was left out and nothing burned between.
      const gpa = await this.#o.rpc.getProgramAccounts(m.account.owner, mint, m.slot, priority);
      if (gpa.slot < m.slot) throw new Error(`scan at slot ${gpa.slot} is older than the supply read at ${m.slot}`);
      const owners = new Set<string>();
      for (const a of gpa.accounts) {
        try {
          const o = decodeTokenAccount(fromBase64(a.data), a.owner as Address).owner;
          if (!isOnCurve(decodeBase58(o))) owners.add(o);
        } catch {
          // The producer refuses the set; nothing to classify here.
        }
      }
      const offCurve = [...owners].sort();
      const ownerPrograms: { owner: string; program: string | null }[] = [];
      for (let i = 0; i < offCurve.length; i += 100) {
        const chunk = offCurve.slice(i, i + 100);
        const r = await this.#o.rpc.getMultipleAccounts(chunk, priority, { offset: 0, length: 0 });
        chunk.forEach((o, k) => ownerPrograms.push({ owner: o, program: r.accounts[k]?.owner ?? null }));
      }
      this.#ingest('helius', RAW.holdersAll(mint), {
        mint, slot: gpa.slot, commitment: 'confirmed', program: m.account.owner, mintSlot: m.slot, mintData: m.account.data, accounts: gpa.accounts, ownerPrograms,
      });
      return `${gpa.accounts.length} accounts at slot ${gpa.slot}, ${this.#o.timers.now() - started} ms`;
    });
  }

  #scanDay = -1;
  #scans = 0;

  /**
   * A wallet's first funder (`read:funder:<wallet>`): pages back through its signatures to the oldest successful one
   * and reads the first SOL transfer into it (core chain/system.ts). History longer than `maxPages` pages is
   * reported incomplete, never guessed.
   */
  async readFunder(wallet: string, o: FunderOptions, priority: Priority = P2): Promise<boolean> {
    return this.#guard(`funder:${wallet}`, async () => {
      this.#ingest('helius', RAW.funder(wallet), await this.funderOf(wallet, o, priority));
      return 'ok';
    });
  }

  /**
   * The funder lookup itself, without ingesting (the backfill writes it to the supplement). The wallet's successful
   * transactions are read oldest first, up to `beforeSlot` (its first buy, or the create for the dev), until one
   * credits it with SOL from another account (core chain/system.ts). A first transaction that does not fund it (a
   * third party creating its token account, a close refund) is passed over, never read as "no funder". No credit found
   * before `beforeSlot`, a history longer than `maxPages`, or more than `maxTransactions` read: incomplete.
   * Signatures after `asOfSlot` are skipped: RPC answers with today's history.
   */
  async funderOf(wallet: string, o: FunderOptions, priority: Priority = P2): Promise<FunderRead> {
    const none: FunderRead = { wallet, asOfSlot: o.asOfSlot, complete: false, funder: null, signature: null, slot: null, atMs: null };
    const limit = o.beforeSlot < o.asOfSlot ? o.beforeSlot : o.asOfSlot;
    const sigs: { signature: string; slot: bigint; err: unknown }[] = [];
    let before: string | undefined;
    let reached = false;
    for (let p = 0; p < o.maxPages && !reached; p++) {
      const page = await this.#o.rpc.getSignaturesForAddress(wallet, before === undefined ? { limit: 1000 } : { before, limit: 1000 }, priority);
      sigs.push(...page);
      reached = page.length < 1000;
      before = page.at(-1)?.signature;
    }
    if (!reached) return none;
    const oldestFirst = sigs.filter((x) => x.err === null && x.slot <= limit).reverse();
    for (const sig of oldestFirst.slice(0, o.maxTransactions)) {
      const rec = await this.#o.rpc.getTransaction(sig.signature, priority);
      if (rec === null) return none;
      const f = firstFunder(rec, wallet);
      if (f !== null) return { wallet, asOfSlot: o.asOfSlot, complete: true, funder: f.from, signature: rec.signature, slot: rec.slot, atMs: rec.blockTime === null ? null : rec.blockTime * 1000 };
    }
    return none;
  }

  /**
   * A mint's history from its creation for the insider precompute (H13): every signature of the mint paged back to
   * the oldest, then every successful transaction in slots s0..s0+`insiderSlots` and up to the slot that completes
   * the first `firstBuyers` distinct buyers, fetched at confirmed and ingested as transactions; then the coverage of
   * `mint-txs:<mint>` (from s0, open after the last fetched slot) and each first buyer's funder. A history longer
   * than `maxPages` pages, or one whose oldest transaction is not the create, ingests no coverage: H13 stays unknown.
   */
  async readMintHistory(mint: string, o: { readonly maxPages: number; readonly funderPages: number; readonly funderTransactions: number; readonly insiderSlots: number; readonly firstBuyers: number; readonly asOfSlot: bigint }, priority: Priority = P2): Promise<boolean> {
    const done = await this.#guard(`mint-history:${mint}`, async () => {
      const sigs: { signature: string; slot: bigint; err: unknown }[] = [];
      let before: string | undefined;
      let reached = false;
      for (let p = 0; p < o.maxPages && !reached; p++) {
        const page = await this.#o.rpc.getSignaturesForAddress(mint, before === undefined ? { limit: 1000 } : { before, limit: 1000 }, priority);
        sigs.push(...page);
        reached = page.length < 1000;
        before = page.at(-1)?.signature;
      }
      if (!reached) throw new Error(`history longer than ${o.maxPages} pages`);
      const oldestFirst = sigs.filter((x) => x.err === null).reverse();
      const s0 = oldestFirst[0]?.slot;
      if (s0 === undefined) throw new Error('no successful transaction');
      const firstSlot = new Map<string, bigint>();
      let through = s0 + BigInt(o.insiderSlots);
      let complete: bigint | null = null;
      let curveDone: bigint | null = null;
      let createOf: string | null = null;
      let fetched = 0;
      for (const sig of oldestFirst) {
        // Fetch whole slots: position inside a slot is unknown, so the boundary slot is read completely. After the
        // curve's CompleteEvent no curve buy can follow, so its slot ends the list when fewer buyers came.
        if (sig.slot > through && (complete !== null || (curveDone !== null && sig.slot > curveDone))) break;
        const rec = await this.#o.rpc.getTransaction(sig.signature, priority);
        if (rec === null) throw new Error(`transaction ${sig.signature} not found`);
        const events = transactionEvents(rec);
        if (fetched === 0) {
          const c = events.find((e) => e.name === 'CreateEvent' && e.data.mint === mint);
          if (c === undefined || c.name !== 'CreateEvent') throw new Error('oldest transaction is not the create');
          createOf = c.data.creator;
        }
        fetched++;
        this.#o.feed.ingest('helius', { type: 'tx', record: rec }, { receivedAt: this.#o.timers.now(), lookup: true });
        for (const e of events) {
          if (e.name === 'TradeEvent' && e.data.mint === mint && e.data.isBuy && !firstSlot.has(e.data.user)) firstSlot.set(e.data.user, rec.slot);
          if (e.name === 'CompleteEvent' && e.data.mint === mint && curveDone === null) {
            curveDone = rec.slot;
            if (curveDone > through) through = curveDone;
          }
        }
        if (complete === null && firstSlot.size >= o.firstBuyers) {
          complete = [...firstSlot.values()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[o.firstBuyers - 1]!;
          if (complete > through) through = complete;
        }
      }
      if (complete === null && curveDone === null) throw new Error(`fewer than ${o.firstBuyers} buyers and the curve is not complete`);
      const last = complete ?? curveDone!;
      const stream = `mint-txs:${mint}`;
      const via = `sigs:${mint}`;
      this.#ingest('worker', `coverage:${stream}:start`, { fromSlot: s0, via });
      this.#ingest('worker', `coverage:${stream}:gap`, { fromSlot: through + 1n, toSlot: null, reason: 'not fetched', via });
      const buyers = [...firstSlot].filter(([, at]) => at <= last).map(([w]) => w).sort();
      const creator = createOf;
      if (creator !== null) await this.readFunder(creator, { asOfSlot: o.asOfSlot, beforeSlot: s0, maxPages: o.funderPages, maxTransactions: o.funderTransactions }, priority);
      for (const w of buyers) {
        if (w === creator) continue;
        await this.readFunder(w, { asOfSlot: o.asOfSlot, beforeSlot: firstSlot.get(w)!, maxPages: o.funderPages, maxTransactions: o.funderTransactions }, priority);
      }
      return `${fetched} transactions from slot ${s0} through ${through}, ${buyers.length} first buyers`;
    });
    return done;
  }

  /** RugCheck's report, trimmed to the authorities (`read:rugcheck:<mint>`). Both fields must be present. */
  async readRugCheck(mint: string, priority: Priority = P2): Promise<boolean> {
    const s = this.#o.rugcheck;
    if (s === undefined) return false;
    return this.#guard(`rugcheck:${mint}`, async () => {
      const v = await this.#getJson(s, 'rugcheck', 'report', `${s.base ?? RUGCHECK_BASE}/v1/tokens/${mint}/report`, priority);
      if (!isObj(v) || !('mintAuthority' in v) || !('freezeAuthority' in v) || v['mint'] !== mint) throw new ProviderError('rugcheck', 'shape', 'report has no authorities for this mint');
      const a = v['mintAuthority'];
      const f = v['freezeAuthority'];
      if (!(a === null || typeof a === 'string') || !(f === null || typeof f === 'string')) throw new ProviderError('rugcheck', 'shape', 'report authorities are malformed');
      this.#ingest('rugcheck', RAW.rugcheck(mint), { mint, mintAuthority: a === '' ? null : a, freezeAuthority: f === '' ? null : f });
      return 'ok';
    });
  }

  /** GoPlus token security, trimmed to `mintable` and `freezable` status (`read:goplus:<mint>`). */
  async readGoPlus(mint: string, priority: Priority = P2): Promise<boolean> {
    const s = this.#o.goplus;
    if (s === undefined) return false;
    return this.#guard(`goplus:${mint}`, async () => {
      const v = await this.#getJson(s, 'goplus', 'token_security', `${s.base ?? GOPLUS_BASE}/api/v1/solana/token_security?contract_addresses=${mint}`, priority);
      const r = isObj(v) && isObj(v['result']) ? v['result'][mint] : undefined;
      if (!isObj(v) || v['code'] !== 1 || !isObj(r)) throw new ProviderError('goplus', 'shape', 'token_security has no result for this mint');
      const status = (x: unknown): string | null => (isObj(x) && (x['status'] === '0' || x['status'] === '1') ? x['status'] : null);
      this.#ingest('goplus', RAW.goplus(mint), { mint, mintable: status(r['mintable']), freezable: status(r['freezable']) });
      return 'ok';
    });
  }

  /** Jupiter Tokens `audit` authority flags (`read:jupiter-audit:<mint>`). */
  async readJupiterAudit(mint: string, priority: Priority = P2): Promise<boolean> {
    const s = this.#o.jupiter;
    if (s === undefined) return false;
    return this.#guard(`jupiter:${mint}`, async () => {
      const v = await this.#getJson(s, 'jupiter', 'tokens/search', `${s.base ?? JUPITER_BASE}/tokens/v2/search?query=${mint}`, priority, { 'x-api-key': s.secrets.get('JUPITER_API_KEY') }, 'tokens', s.secrets);
      const row = Array.isArray(v) ? v.find((x: unknown) => isObj(x) && x['id'] === mint) : undefined;
      if (!isObj(row)) throw new ProviderError('jupiter', 'shape', 'tokens/search has no row for this mint');
      const audit = isObj(row['audit']) ? row['audit'] : {};
      const flag = (x: unknown): boolean | null => (typeof x === 'boolean' ? x : null);
      this.#ingest('jupiter', RAW.jupiter(mint), { mint, mintAuthorityDisabled: flag(audit['mintAuthorityDisabled']), freezeAuthorityDisabled: flag(audit['freezeAuthorityDisabled']) });
      return 'ok';
    });
  }

  /** Every cross-check source configured, in parallel. H16 needs at least one answer under 2 s old at the decision. */
  async readCrossChecks(mint: string, priority: Priority = P2): Promise<boolean[]> {
    return Promise.all([this.readRugCheck(mint, priority), this.readGoPlus(mint, priority), this.readJupiterAudit(mint, priority)]);
  }

  /**
   * Hourly SOL/USD bars from Coinbase (the backtest's source), each released once usable: closed, and one more bar
   * later, as BT-1's `usableFrom` rule for a fixed series. Exact close digits are kept from the raw text.
   */
  async readSolUsd(hoursBack: number, priority: Priority = P2): Promise<boolean> {
    const s = this.#o.coinbase;
    if (s === undefined) return false;
    return this.#guard('sol-usd', async () => {
      const now = this.#o.timers.now();
      const end = Math.floor(now / HOUR_MS) * HOUR_MS;
      const url = `${s.base ?? COINBASE_BASE}/products/SOL-USD/candles?granularity=3600&start=${new Date(end - hoursBack * HOUR_MS).toISOString()}&end=${new Date(end).toISOString()}`;
      const text = await this.#getText(s, 'coinbase', 'candles', url, priority);
      const NUM = '(-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?)';
      const candle = new RegExp(`\\[\\s*(\\d+)\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*,\\s*${NUM}\\s*\\]`, 'g');
      const bars: { start: number; close: string }[] = [];
      for (const m of text.matchAll(candle)) {
        const start = Number(m[1]) * 1000;
        const close = m[5]!;
        if (/^\d+(\.\d+)?$/.test(close) && start % HOUR_MS === 0 && start + 2 * HOUR_MS <= now && !this.#bars.has(start)) bars.push({ start, close });
      }
      for (const b of bars.sort((a, c) => a.start - c.start)) {
        this.#bars.add(b.start);
        this.#ingest('coinbase', RAW.solUsd, b);
      }
      return `${bars.length} bars`;
    });
  }

  /** A round-trip simulation answer (H15), from the simulation builder. Refused unless well formed. */
  ingestSim(read: SimRead): void {
    if (parseSimRead(read) === null) throw new RangeError('malformed simulation read');
    this.#ingest('helius', RAW.sim(read.mint), read);
  }

  /** The worker's own execution statistics (regime, live only). */
  ingestExecStats(stats: ExecStats): void {
    if (parseExecStats(stats) === null) throw new RangeError('malformed execution statistics');
    this.#ingest('worker', RAW.exec, stats);
  }

  async #getText(s: ThirdParty, provider: string, what: string, url: string, priority: Priority, headers: Record<string, string> = {}, lane?: string, secrets?: Secrets): Promise<string> {
    const o = this.#o;
    return s.scheduler.run(priority, 0, async () => {
      const res = await send(o.http, provider, what, { method: 'GET', url, headers: { 'user-agent': 'zeroed', ...headers }, timeoutMs: o.timeoutMs });
      if (res.status === 429) {
        s.scheduler.penalize();
        throw new ProviderError(provider, 'rate_limited', `${what} rate limited`, 429);
      }
      if (res.status !== 200) {
        const body = secrets === undefined ? '' : `: ${scrub(res.text.slice(0, 120), secrets, ['JUPITER_API_KEY'])}`;
        throw new ProviderError(provider, 'http', `${what} returned HTTP ${res.status}${body}`, res.status);
      }
      return res.text;
    }, lane);
  }

  async #getJson(s: ThirdParty, provider: string, what: string, url: string, priority: Priority, headers: Record<string, string> = {}, lane?: string, secrets?: Secrets): Promise<unknown> {
    return parseJson(provider, what, await this.#getText(s, provider, what, url, priority, headers, lane, secrets));
  }
}

