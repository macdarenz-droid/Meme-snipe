// Live reads for the fact producers (FACTS-1). Each reader asks a provider through its quota scheduler and ingests the
// answer into the live feed under a raw key (core/src/facts/raw.ts), trimmed to the fields the producers read. It
// never makes a gate fact itself: core's FactProducer does, from the released answer, exactly as it would from the
// same answer replayed. A failed or malformed read ingests nothing, so the gate sees no fact and rejects (H16).
// Chain reads go to Helius at `confirmed` (standard RPC, 1 credit each, data.md §1.2); the gates refuse `processed`.
import {
  type Address, NATIVE_MINT, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, decodeBase58, decodeMint, isOnCurve, decodePool, decodeTokenAccount, firstFunder, fromBase64, poolAddress,
  pumpPoolAuthority, recordFromRpc, transactionEvents, type RpcTransactionBase64, type TransactionRecord,
} from '../../../core/src/chain/index.ts';
import {
  type AccountsRead, type ExecStats, type FunderRead, type HoldersRead, type SimRead, RAW, parseExecStats, parseSimRead, parseVolumeHoursCsv,
} from '../../../core/src/facts/index.ts';
import { VOLUME_SERIES_START_DAY } from '../../../core/src/config/time.ts';
import type { Policy } from '../../../core/src/config/policy.ts';
import { HELIUS_RPC_CREDITS } from '../scheduler/limits.ts';
import { VOLUME_TAG, dayName, dayNumber, sha256Hex, volumeCheckPassed, volumeRelease, volumeReleaseAssets } from './volume-hours.ts';
import type { ChainVolumeStore, StoredVolumeDay } from './volume-store.ts';
import type { RugCheckRequest } from '../providers/deployer-check.ts';
import type { DeployerChecks } from './deployer-checks.ts';
import { P2, type Priority, type Scheduler, ScheduleRefused } from '../scheduler/scheduler.ts';
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

/** Puts one raw answer (`offchain` frame) somewhere: the feed, or a batch's list. */
type Put = (source: Source, key: string, value: unknown) => void;

/** H15's round-trip simulation at `spend`, handing its answer to `ingest` (the worker's `simReader`). */
export type SimFn = (mint: string, spend: bigint, ingest: (read: SimRead) => void) => Promise<boolean>;

/** What one coherent batch reads besides the accounts (READ-COHERENT): the holder view, the simulation, the cross-checks. */
export interface BatchRequest {
  /** The largest accounts (a bounded view), the complete scan, or no holder read. */
  readonly holders: 'largest' | 'all' | null;
  /** H15's simulation at this spend (the candidate's own), or none. */
  readonly spend: bigint | null;
  readonly xcheck: boolean;
}


/** Raw reads whose facts are judged by slot lag (evidence.ts 'state'): a batch's age is its oldest of these. */
const LAG_BOUND: ReadonlySet<string> = new Set(['read:accounts:', 'read:holders:', 'read:holders-all:']);

/** A batch's parts, named as the reads they replace (the `worker:fact-reads` counter's kinds). */
export type BatchPart = 'accounts' | 'holders' | 'holders-all' | 'sim' | 'xcheck';
/** Whether each part the batch asked for landed (a refused or failed part is false). */
export type BatchResult = Partial<Record<BatchPart, boolean>>;

type Scan = { readonly gpa: Awaited<ReturnType<FactRpc['getProgramAccounts']>>; readonly filter: Token2022Filter; readonly fallback: boolean };

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

/** A JSON-RPC error answer, with its code (null when the provider gave none). */
export class FactRpcError extends ProviderError {
  readonly rpcCode: number | null;
  constructor(method: string, code: number | null) {
    super('helius', 'rpc', `${method} error ${code ?? 'unknown'}`);
    this.rpcCode = code;
  }
}

/** The code Helius answered a mint-only getProgramAccounts with when the set is too large (gpa-probe run 37149567929). */
export const GPA_TOO_MANY_ACCOUNTS = -32600;

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
        throw new FactRpcError(method, isObj(e) && typeof e['code'] === 'number' ? e['code'] : null);
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
  async getProgramAccounts(program: string, mint: string, minContextSlot: bigint, priority: Priority, token2022: Token2022Filter = 'mintOnly'): Promise<{ slot: bigint; accounts: { address: string; owner: string; data: string }[] }> {
    const r = await this.call('getProgramAccounts', [program, { encoding: 'base64', commitment: 'confirmed', withContext: true, minContextSlot: Number(minContextSlot), filters: holderFilters(program, mint, token2022) }], priority);
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

/**
 * getProgramAccounts filters that let the node use its mint index rather than scan the program (supervisor ruling):
 * legacy SPL accounts are exactly 165 bytes; Token-2022 accounts carry AccountType = Account (2) at offset 165. The one-shot
 * call (never the cursor-paginated V2, which has no cross-page consistency). A Token-2022 account of exactly 165 bytes
 * (no extensions) would be missed; the exact sum to supply then fails and no holder fact is made, never a pass.
 */
export const holderFilters = (program: string, mint: string, token2022: Token2022Filter = 'mintOnly'): readonly Record<string, unknown>[] =>
  program === TOKEN_2022_PROGRAM
    ? token2022 === 'mintOnly' ? [{ memcmp: { offset: 0, bytes: mint } }] : [{ memcmp: { offset: 0, bytes: mint } }, { memcmp: { offset: 165, bytes: TOKEN_ACCOUNT_TYPE_B58 } }]
    : [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }];
/**
 * `mintOnly` (the default: every Token-2022 account of the mint, including 165-byte ones without extensions; served by
 * Helius in gpa-probe run 37149567929) or `indexed` (AccountType at 165; the fallback when a mint-only call is refused).
 */
export type Token2022Filter = 'mintOnly' | 'indexed';

/** Base58 of the single byte 2 (AccountType::Account). */
export const TOKEN_ACCOUNT_TYPE_B58 = '3';

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
  /** DATA-1c's volume releases: the regime's chain volume. */
  readonly releases?: ReleasesSource;
  /** RUG-1c's on-demand deployer check, cached per creator under a daily credit cap (`DeployerChecks`). */
  readonly deployerChecks?: DeployerChecks;
  /** Complete holder scans allowed per UTC day (default HOLDER_SCANS_PER_DAY). Reached: no scan, H12/H13 abstain. */
  readonly holderScansPerDay?: number;
  readonly token2022Filter?: Token2022Filter;
}

/** Trial default (supervisor ruling): 100 complete holder scans a UTC day, about 1,200 Helius credits at the published
 * price; revisit once gpa-probe measures the real cost. */
export const HOLDER_SCANS_PER_DAY = 100;

export const RUGCHECK_BASE = 'https://api.rugcheck.xyz';
export const GOPLUS_BASE = 'https://api.gopluslabs.io';
export const JUPITER_BASE = 'https://api.jup.ag';
export const COINBASE_BASE = 'https://api.exchange.coinbase.com';
export const RELEASES_BASE = 'https://api.github.com/repos/macdarenz-droid/Meme-snipe';
export const DOWNLOADS_BASE = 'https://github.com/macdarenz-droid/Meme-snipe';
/** Release list pages read per pass (100 releases a page); more would mean a runaway list, and the rest stay unknown. */
export const RELEASE_PAGES_MAX = 10;

/** Where chain volume comes from: the GitHub API (metadata, REST quota) and github.com (asset downloads, outside it). */
export interface ReleasesSource {
  /** The REST API's scheduler (GITHUB_RELEASES); `base` is the API's repository URL. */
  readonly api: ThirdParty;
  /** github.com downloads (GITHUB_DOWNLOADS); `base` is the repository's web URL. */
  readonly downloads: ThirdParty;
  /** Verified days kept across restarts; without it every start reads the whole window. */
  readonly store?: ChainVolumeStore;
  /** Told when a stored day's release changed (a tamper signal): that day is unknown from then on. */
  readonly alert?: (detail: string) => void;
}
/** A day whose volume asset is not published yet is asked again at most once in this long. */
export const VOLUME_RETRY_MS = 3_600_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

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

/** The off-curve owners (PDAs) of a scan's token accounts, sorted; an account that does not decode is skipped (the producer refuses the set). */
const offCurveOwners = (accounts: readonly { readonly owner: string; readonly data: string }[]): string[] => {
  const owners = new Set<string>();
  for (const a of accounts) {
    try {
      const o = decodeTokenAccount(fromBase64(a.data), a.owner as Address).owner;
      if (!isOnCurve(decodeBase58(o))) owners.add(o);
    } catch {
      // Nothing to classify.
    }
  }
  return [...owners].sort();
};

export class FactReaders {
  readonly #o: FactReadersOptions;
  /** Vault and LP addresses per mint, once its pool was read. */
  readonly #layout = new Map<string, readonly string[]>();
  /** SOL/USD bars already ingested, by start. */
  readonly #bars = new Set<number>();
  /** Chain-volume days ingested (never read again, but checked against each listing), the last failed attempt of the
   * others, and the days refused for good (their release changed after they were verified). */
  readonly #volumeDays = new Map<number, StoredVolumeDay>();
  readonly #volumeTried = new Map<number, number>();
  readonly #volumeTampered = new Set<number>();
  #volumeStoreRead = false;
  readonly outcomes: ReadOutcome[] = [];

  constructor(o: FactReadersOptions) {
    this.#o = o;
  }

  #ingest(source: Source, key: string, value: unknown): void {
    this.#o.feed.ingest(source, { type: 'offchain', key, value }, { receivedAt: this.#o.timers.now() });
  }

  /** Where a read puts its answer: the feed now, or a batch's list until the whole batch has landed (`readBatch`). */
  readonly #now: Put = (source, key, value) => this.#ingest(source, key, value);

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
        return { address: a.address, owner: t.owner as string, amount: t.amount, delegate: t.delegate as string | null, delegatedAmount: t.delegatedAmount };
      }).filter((x): x is { address: string; owner: string; amount: bigint; delegate: string | null; delegatedAmount: bigint } => x !== null);
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
        accounts: tokens.map((t) => ({ address: t.address, owner: t.owner, ownerProgram: programOf.get(t.owner) ?? null, amount: t.amount, delegate: t.delegate, delegatedAmount: t.delegatedAmount })),
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
    if (!this.#takeScan()) {
      this.outcomes.push({ read: `holders-all:${mint}`, ok: false, detail: 'daily scan cap reached' });
      return false;
    }
    return this.#guard(`holders-all:${mint}`, async () => {
      const started = this.#o.timers.now();
      const m = await this.#o.rpc.getAccountInfo(mint, priority);
      if (m.account === null) throw new Error('mint account missing');
      // Supply first (slot A), then the scan at a bank no older than A (slot B >= A): with no mint authority the supply
      // can only fall, so balances summing to the supply at A prove nothing was left out and nothing burned between.
      const { gpa, filter, fallback } = await this.#scan(m.account.owner, mint, m.slot, priority);
      if (gpa.slot < m.slot) throw new Error(`scan at slot ${gpa.slot} is older than the supply read at ${m.slot}`);
      const offCurve = offCurveOwners(gpa.accounts);
      const ownerPrograms: { owner: string; program: string | null }[] = [];
      for (let i = 0; i < offCurve.length; i += 100) {
        const chunk = offCurve.slice(i, i + 100);
        const r = await this.#o.rpc.getMultipleAccounts(chunk, priority, { offset: 0, length: 0 });
        chunk.forEach((o, k) => ownerPrograms.push({ owner: o, program: r.accounts[k]?.owner ?? null }));
      }
      this.#ingest('helius', RAW.holdersAll(mint), {
        mint, slot: gpa.slot, commitment: 'confirmed', program: m.account.owner, mintSlot: m.slot, mintData: m.account.data, accounts: gpa.accounts, ownerPrograms,
        filter: m.account.owner === TOKEN_2022_PROGRAM ? filter : 'legacy', fallback,
      });
      return `${gpa.accounts.length} accounts at slot ${gpa.slot}, ${filter}${fallback ? ' after a refused mint-only scan' : ''}, ${this.#o.timers.now() - started} ms`;
    });
  }

  /** The mint, canonical pool, both vaults and the LP mint, learning the vault and LP addresses from the pool once. */
  async #layoutOf(mint: string, priority: Priority): Promise<{ readonly addresses: readonly string[]; readonly slot: bigint | null }> {
    const known = this.#layout.get(mint);
    if (known !== undefined) return { addresses: known, slot: null };
    const pool = FactReaders.canonicalPool(mint);
    const r = await this.#o.rpc.getMultipleAccounts([mint, pool], priority);
    const p = r.accounts[1];
    if (p === null || p === undefined) throw new Error(`no pool account at ${pool}`);
    const decoded = decodePool(fromBase64(p.data)).value;
    const addresses = [mint, pool, decoded.poolBaseTokenAccount, decoded.poolQuoteTokenAccount, decoded.lpMint];
    const m = r.accounts[0];
    if (m !== null && m !== undefined) this.#mintProgram.set(mint, m.owner);
    this.#layout.set(mint, addresses);
    return { addresses, slot: r.slot };
  }

  /** Owners of the mint's holders seen so far (largest-account discovery and scans), so one bank can classify them. */
  readonly #owners = new Map<string, Set<string>>();

  /**
   * READ-COHERENT: a candidate's stage-2 and stage-3 read inputs as one coherent batch, so every fact the decision
   * needs is fresh at one moment. Inputs judged by slot lag (mint, pool, LP, holders) come from ONE bank: the mint,
   * pool, vaults and LP mint, the listed holder accounts and their owners in one getMultipleAccounts (slot A). The
   * complete scan (slot B), the simulation and the cross-checks run alongside it, never after it. What is only
   * discovery comes first and is never a fact: the pool layout, and the largest accounts with their owners (which
   * accounts to list, which owners to classify). Nothing is put on the feed until the whole batch has answered; then
   * every answer goes on at once between `read-batch:<mint>` and `reads:<mint>` (RAW.batchOpen, RAW.batchClose), and the
   * strategy judges the candidate at the close, on the batch alone.
   *
   * Refused parts (no frame, so the gate rejects): a largest-account list whose owners at A were not all in the bank; a
   * scan older than A (H12/H13: the supply must be read first) or with an off-curve owner the bank did not classify
   * (remembered, so the next batch classifies it); a scan past the daily cap. The listed accounts are only which ones
   * the view lists: balances, supply and owners are all at A, and GATE-1d bounds whatever the list leaves out.
   */
  async readBatch(mint: string, req: BatchRequest, priority: Priority = P2): Promise<BatchResult> {
    const frames: { source: Source; key: string; value: unknown }[] = [];
    const put: Put = (source, key, value) => void frames.push({ source, key, value });
    // Each part's outcome under its old read kind, so the coverage report counts reads as before.
    const parts: Promise<readonly [BatchPart, boolean]>[] = [];
    const as = (part: BatchPart) => (ok: boolean) => [part, ok] as const;
    let banked = false;
    const prep = await this.#attempt(`batch-prep:${mint}`, async () => {
      const layout = await this.#layoutOf(mint, priority);
      const known = this.#owners.get(mint) ?? new Set<string>();
      this.#owners.set(mint, known);
      let listed: readonly string[] = [];
      let minSlot = layout.slot ?? 0n;
      if (req.holders !== null) {
        const largest = await this.#o.rpc.getTokenLargestAccounts(mint, priority);
        listed = largest.accounts.map((a) => a.address);
        minSlot = largest.slot > minSlot ? largest.slot : minSlot;
        if (listed.length > 0) {
          const toks = await this.#o.rpc.getMultipleAccounts(listed, priority);
          for (const t of toks.accounts) {
            if (t === null) continue;
            try {
              known.add(decodeTokenAccount(fromBase64(t.data), t.owner as Address).owner);
            } catch {
              // Not a token account: the bank's decode refuses it.
            }
          }
        }
      }
      return { value: { layout: layout.addresses, listed: req.holders === 'largest' ? listed : [], minSlot }, detail: `${listed.length} listed, ${known.size} owners` };
    });
    const p = prep;
    if (p !== null) {
      const ownersOf = [...(this.#owners.get(mint) ?? [])].filter((o) => !p.layout.includes(o) && !p.listed.includes(o)).sort();
      const addresses = [...p.layout, ...p.listed, ...ownersOf];
      // The scan's program is the mint's owner, learnt from the layout read (the mint is in every bank).
      const mintOwner = this.#mintProgram.get(mint);
      const scanned = req.holders === 'all' && mintOwner !== undefined && this.#takeScan();
      if (req.holders === 'all' && !scanned) this.outcomes.push({ read: `holders-all:${mint}`, ok: false, detail: mintOwner === undefined ? 'mint program not known' : 'daily scan cap reached' });
      // The final round: every call at once.
      const bank = addresses.length <= 100 ? this.#o.rpc.getMultipleAccounts(addresses, priority) : Promise.reject(new Error(`${addresses.length} accounts do not fit one bank`));
      const scan = scanned ? this.#scan(mintOwner!, mint, p.minSlot, priority) : null;
      bank.catch(() => undefined);
      scan?.catch(() => undefined);
      if (req.spend !== null && this.simulate !== null) {
        const sim = this.simulate;
        const spend = req.spend;
        parts.push(sim(mint, spend, (read) => {
          if (parseSimRead(read) === null) throw new RangeError('malformed simulation read');
          put('helius', RAW.sim(read.mint), read);
        }).catch(() => false).then(as('sim')));
      }
      if (req.xcheck) parts.push(this.readCrossChecks(mint, priority, put).then((x) => x.some(Boolean)).then(as('xcheck')));
      banked = await this.#guard(`accounts:${mint}`, async () => {
        const b = await bank;
        const at = (address: string) => b.accounts[addresses.indexOf(address)] ?? null;
        const m = at(mint);
        if (m !== null) this.#mintProgram.set(mint, m.owner);
        put('helius', RAW.accounts(mint), { mint, slot: b.slot, commitment: 'confirmed', accounts: p.layout.map((address) => ({ address, owner: at(address)?.owner ?? null, data: at(address)?.data ?? null })) } satisfies AccountsRead);
        if (req.holders === 'largest') parts.push(this.#guard(`holders:${mint}`, async () => this.#bankedHolders(mint, b.slot, p.listed, at, put)).then(as('holders')));
        if (scan !== null) parts.push(this.#guard(`holders-all:${mint}`, async () => this.#bankedScan(mint, b.slot, await scan, at, put)).then(as('holders-all')));
        return `slot ${b.slot}`;
      });
      if (!banked) await scan?.catch(() => undefined);
    }
    const done = await Promise.all(parts);
    if (frames.length > 0) {
      // The batch's age by slot: its oldest input judged by slot lag (mint, pool, LP, holders).
      const slots = frames.filter((f) => LAG_BOUND.has(f.key.slice(0, f.key.lastIndexOf(':') + 1))).map((f) => (isObj(f.value) && typeof f.value['slot'] === 'bigint' ? f.value['slot'] : null)).filter((x): x is bigint => x !== null);
      const oldest = slots.length === 0 ? null : slots.reduce((a, b) => (b < a ? b : a));
      const keys = frames.map((f) => f.key).sort();
      // One synchronous block: the members never reach the feed without their close.
      this.#ingest('worker', RAW.batchOpen(mint), { mint, members: keys });
      try {
        for (const f of frames) this.#ingest(f.source, f.key, f.value);
      } finally {
        this.#ingest('worker', RAW.batchClose(mint), { mint, slot: oldest, members: keys });
      }
    }
    // Every part asked for is counted: one that never ran (no prep, no bank, no scan) failed.
    const out: Partial<Record<BatchPart, boolean>> = { accounts: banked };
    if (req.holders !== null) out[req.holders === 'all' ? 'holders-all' : 'holders'] = false;
    if (req.spend !== null && this.simulate !== null) out.sim = false;
    if (req.xcheck) out.xcheck = false;
    for (const [part, ok] of done) out[part] = ok;
    return out;
  }

  /** `#guard` for a step that returns a value: null (and a failed outcome) when it throws. */
  async #attempt<T>(read: string, f: () => Promise<{ readonly value: T; readonly detail: string }>): Promise<T | null> {
    let out: T | null = null;
    await this.#guard(read, async () => {
      const r = await f();
      out = r.value;
      return r.detail;
    });
    return out;
  }

  /** The program of each mint (Token or Token-2022), from its last bank: the scan's program. */
  readonly #mintProgram = new Map<string, string>();

  /** H15's simulation, set by the worker's wiring (`withSim`); a batch asks it for the candidate's spend. */
  simulate: SimFn | null = null;

  /** The largest accounts at the bank's slot: balances, supply and owners' programs all from that one bank. */
  #bankedHolders(mint: string, slot: bigint, listed: readonly string[], at: (address: string) => { owner: string; data: string } | null, put: Put): string {
    const m = at(mint);
    if (m === null) throw new Error('mint account missing');
    const supply = decodeMint(fromBase64(m.data), m.owner as Address).supply;
    const known = this.#owners.get(mint)!;
    const accounts: HoldersRead['accounts'][number][] = [];
    const unclassified: string[] = [];
    for (const address of listed) {
      const v = at(address);
      if (v === null) continue;
      const t = decodeTokenAccount(fromBase64(v.data), v.owner as Address);
      if (t.mint !== mint) throw new Error(`token account ${address} is not of ${mint}`);
      const owner = t.owner as string;
      if (!known.has(owner)) {
        known.add(owner);
        unclassified.push(owner);
        continue;
      }
      const o = at(owner);
      // A plain wallet (System-owned) or an account that does not exist is a system wallet: null.
      accounts.push({ address, owner, ownerProgram: o === null || o.owner === SYSTEM_PROGRAM ? null : o.owner, amount: t.amount, delegate: t.delegate as string | null, delegatedAmount: t.delegatedAmount });
    }
    if (unclassified.length > 0) throw new Error(`owners ${unclassified.sort().join(', ')} were not in the bank`);
    put('helius', RAW.holders(mint), { mint, slot, commitment: 'confirmed', supply, accounts } satisfies HoldersRead);
    return `${accounts.length} accounts, slot ${slot}`;
  }

  /** The complete scan, refused unless at or after the bank's supply read and with every off-curve owner classified by it. */
  #bankedScan(mint: string, slot: bigint, s: Scan, at: (address: string) => { owner: string; data: string } | null, put: Put): string {
    const m = at(mint);
    if (m === null) throw new Error('mint account missing');
    if (s.gpa.slot < slot) throw new Error(`scan at slot ${s.gpa.slot} is older than the supply read at ${slot}`);
    const known = this.#owners.get(mint)!;
    const offCurve = offCurveOwners(s.gpa.accounts);
    const missing = offCurve.filter((o) => !known.has(o));
    for (const o of missing) known.add(o);
    if (missing.length > 0) throw new Error(`off-curve owners ${missing.join(', ')} were not in the bank`);
    put('helius', RAW.holdersAll(mint), {
      mint, slot: s.gpa.slot, commitment: 'confirmed', program: m.owner, mintSlot: slot, mintData: m.data, accounts: s.gpa.accounts,
      ownerPrograms: offCurve.map((o) => ({ owner: o, program: at(o)?.owner ?? null })),
      filter: m.owner === TOKEN_2022_PROGRAM ? s.filter : 'legacy', fallback: s.fallback,
    });
    return `${s.gpa.accounts.length} accounts at slot ${s.gpa.slot}, ${s.filter}`;
  }

  /**
   * One getProgramAccounts of the mint's token accounts at a bank no older than `minSlot` (the scan already taken off
   * the daily cap). Only the refusal of a too-large mint-only scan (-32600) earns one indexed retry, counted as its own
   * scan. Every other failure (a 429, a timeout, "minimum context slot not reached", a legacy program) propagates: no
   * retry. The retry's result stays fail-safe: an extension-less account holding tokens breaks the sum and no fact forms.
   */
  async #scan(program: string, mint: string, minSlot: bigint, priority: Priority): Promise<Scan> {
    const filter: Token2022Filter = this.#o.token2022Filter ?? 'mintOnly';
    try {
      return { gpa: await this.#o.rpc.getProgramAccounts(program, mint, minSlot, priority, filter), filter, fallback: false };
    } catch (e) {
      if (!(e instanceof FactRpcError && e.rpcCode === GPA_TOO_MANY_ACCOUNTS && program === TOKEN_2022_PROGRAM && filter === 'mintOnly')) throw e;
      if (!this.#takeScan()) throw new Error('mint-only scan refused and the daily scan cap is reached');
      return { gpa: await this.#o.rpc.getProgramAccounts(program, mint, minSlot, priority, 'indexed'), filter: 'indexed', fallback: true };
    }
  }

  #scanDay = -1;
  #scans = 0;

  /** One scan off today's cap, or false when the cap is reached. */
  #takeScan(): boolean {
    const day = Math.floor(this.#o.timers.now() / 86_400_000);
    if (this.#scanDay !== day) {
      this.#scanDay = day;
      this.#scans = 0;
    }
    if (this.#scans >= (this.#o.holderScansPerDay ?? HOLDER_SCANS_PER_DAY)) return false;
    this.#scans++;
    return true;
  }

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
  async readRugCheck(mint: string, priority: Priority = P2, put: Put = this.#now): Promise<boolean> {
    const s = this.#o.rugcheck;
    if (s === undefined) return false;
    return this.#guard(`rugcheck:${mint}`, async () => {
      const v = await this.#getJson(s, 'rugcheck', 'report', `${s.base ?? RUGCHECK_BASE}/v1/tokens/${mint}/report`, priority);
      if (!isObj(v) || !('mintAuthority' in v) || !('freezeAuthority' in v) || v['mint'] !== mint) throw new ProviderError('rugcheck', 'shape', 'report has no authorities for this mint');
      const a = v['mintAuthority'];
      const f = v['freezeAuthority'];
      if (!(a === null || typeof a === 'string') || !(f === null || typeof f === 'string')) throw new ProviderError('rugcheck', 'shape', 'report authorities are malformed');
      put('rugcheck', RAW.rugcheck(mint), { mint, mintAuthority: a === '' ? null : a, freezeAuthority: f === '' ? null : f });
      return 'ok';
    });
  }

  /** GoPlus token security, trimmed to `mintable` and `freezable` status (`read:goplus:<mint>`). */
  async readGoPlus(mint: string, priority: Priority = P2, put: Put = this.#now): Promise<boolean> {
    const s = this.#o.goplus;
    if (s === undefined) return false;
    return this.#guard(`goplus:${mint}`, async () => {
      const v = await this.#getJson(s, 'goplus', 'token_security', `${s.base ?? GOPLUS_BASE}/api/v1/solana/token_security?contract_addresses=${mint}`, priority);
      const r = isObj(v) && isObj(v['result']) ? v['result'][mint] : undefined;
      if (!isObj(v) || v['code'] !== 1 || !isObj(r)) throw new ProviderError('goplus', 'shape', 'token_security has no result for this mint');
      const status = (x: unknown): string | null => (isObj(x) && (x['status'] === '0' || x['status'] === '1') ? x['status'] : null);
      put('goplus', RAW.goplus(mint), { mint, mintable: status(r['mintable']), freezable: status(r['freezable']) });
      return 'ok';
    });
  }

  /** Jupiter Tokens `audit` authority flags (`read:jupiter-audit:<mint>`). */
  async readJupiterAudit(mint: string, priority: Priority = P2, put: Put = this.#now): Promise<boolean> {
    const s = this.#o.jupiter;
    if (s === undefined) return false;
    return this.#guard(`jupiter:${mint}`, async () => {
      const v = await this.#getJson(s, 'jupiter', 'tokens/search', `${s.base ?? JUPITER_BASE}/tokens/v2/search?query=${mint}`, priority, { 'x-api-key': s.secrets.get('JUPITER_API_KEY') }, 'tokens', s.secrets);
      const row = Array.isArray(v) ? v.find((x: unknown) => isObj(x) && x['id'] === mint) : undefined;
      if (!isObj(row)) throw new ProviderError('jupiter', 'shape', 'tokens/search has no row for this mint');
      const audit = isObj(row['audit']) ? row['audit'] : {};
      const flag = (x: unknown): boolean | null => (typeof x === 'boolean' ? x : null);
      put('jupiter', RAW.jupiter(mint), { mint, mintAuthorityDisabled: flag(audit['mintAuthorityDisabled']), freezeAuthorityDisabled: flag(audit['freezeAuthorityDisabled']) });
      return 'ok';
    });
  }

  /** Every cross-check source configured, in parallel. H16 needs at least one answer under 2 s old at the decision. */
  async readCrossChecks(mint: string, priority: Priority = P2, put: Put = this.#now): Promise<boolean[]> {
    return Promise.all([this.readRugCheck(mint, priority, put), this.readGoPlus(mint, priority, put), this.readJupiterAudit(mint, priority, put)]);
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

  /**
   * The regime's chain volume (§6.4). Each pass:
   * 1. On the first pass, days kept in the store are re-checked (text against its sha256, the cross-check, the CSV)
   *    and ingested, so a restart reads only new days. A record that fails is ignored and its day read again.
   * 2. The release list is read through the GitHub API (`releases?per_page=100`, 1 or 2 calls) and every
   *    `data-volume-DAY` release is checked with `volumeReleaseAssets` (GitHub Actions' own prerelease, both assets
   *    uploaded by it, with a sha256 digest).
   * 3. A day already ingested whose listed asset ids or digests differ from what was verified is tampered: its hours
   *    are ingested again as uncovered (the producer then drops the day), the store marks it, `alert` is told, and it
   *    is never used again. Releases are never edited, so a change is not a publish delay.
   * 4. Each other day the window reaches (series start or the 365-day cap, up to yesterday) is downloaded from
   *    github.com, each asset checked against its digest, the cross-check against the day, and the CSV's 24 rows
   *    ingested as `read:chain-volume-hour` (an uncovered hour as `covered: false`), then stored.
   * A day missing or refused ingests nothing (unknown, never zero) and is tried again at most once per VOLUME_RETRY_MS.
   * A rate limit or a refused schedule ends the pass; the next one goes on.
   */
  async readChainVolume(regime: Pick<Policy['regime'], 'volumeLagDays' | 'volumeWindowDays'>, priority: Priority = P2): Promise<boolean> {
    const src = this.#o.releases;
    if (src === undefined) return false;
    const today = Math.floor(this.#o.timers.now() / DAY_MS);
    const first = Math.max(VOLUME_SERIES_START_DAY, today - regime.volumeLagDays - regime.volumeWindowDays + 1);
    const downloadBase = src.downloads.base ?? DOWNLOADS_BASE;
    if (!this.#volumeStoreRead) {
      this.#volumeStoreRead = true;
      for (const d of src.store?.load() ?? []) {
        const day = dayNumber(d.day);
        if (day === null || d.tag !== volumeRelease(d.day)) continue;
        if (d.tampered) {
          this.#volumeTampered.add(day);
          continue;
        }
        if (day < first || day >= today) continue;
        const rows = sha256Hex(d.hours.text) === d.hours.sha256 && sha256Hex(d.check.text) === d.check.sha256 && volumeCheckPassed(d.check.text, d.day)
          ? parseVolumeHoursCsv(d.hours.text, day) : null;
        if (rows === null) continue;
        for (const r of rows) this.#ingest('github', RAW.volumeHour, r);
        this.#volumeDays.set(day, d);
        this.outcomes.push({ read: `chain-volume:${d.day}`, ok: true, detail: `${rows.length} hours from the store` });
      }
    }
    const limited = (e: unknown): boolean => e instanceof ScheduleRefused || (e instanceof ProviderError && (e.kind === 'rate_limited' || e.status === 403));
    // The release list: every data-volume release by tag (a tag listed twice is refused).
    const listed = new Map<string, unknown>();
    try {
      const api = src.api;
      const json = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
      for (let page = 1; page <= RELEASE_PAGES_MAX; page++) {
        const v = JSON.parse(await this.#getText(api, 'github', 'release list', `${api.base ?? RELEASES_BASE}/releases?per_page=100&page=${page}`, priority, json)) as unknown;
        if (!Array.isArray(v)) throw new ProviderError('github', 'shape', 'release list is not an array');
        for (const r of v) {
          const tag = typeof r === 'object' && r !== null ? (r as Record<string, unknown>)['tag_name'] : undefined;
          if (typeof tag === 'string' && VOLUME_TAG.test(tag)) listed.set(tag, listed.has(tag) ? null : r);
        }
        if (v.length < 100) break;
      }
    } catch (e) {
      this.outcomes.push({ read: 'chain-volume:list', ok: false, detail: e instanceof Error ? e.message : 'failed' });
      return false;
    }
    // Days already verified must still match their release.
    for (const [day, d] of this.#volumeDays) {
      if (!listed.has(d.tag)) continue;
      const refs = volumeReleaseAssets(listed.get(d.tag), d.day, downloadBase);
      if (refs !== null && refs.hours.id === d.hours.id && refs.hours.sha256 === d.hours.sha256 && refs.check.id === d.check.id && refs.check.sha256 === d.check.sha256) continue;
      const rows = parseVolumeHoursCsv(d.hours.text, day) ?? [];
      for (const r of rows) this.#ingest('github', RAW.volumeHour, { ...r, covered: false });
      this.#volumeDays.delete(day);
      this.#volumeTampered.add(day);
      src.store?.save({ ...d, tampered: true });
      const detail = `${d.day} volume unknown: release ${d.tag} changed after it was verified`;
      this.outcomes.push({ read: `chain-volume:${d.day}`, ok: false, detail });
      src.alert?.(detail);
    }
    let all = true;
    for (let day = first; day < today; day++) {
      if (this.#volumeDays.has(day)) continue;
      if (this.#volumeTampered.has(day)) {
        all = false;
        continue;
      }
      const tried = this.#volumeTried.get(day);
      if (tried !== undefined && this.#o.timers.now() - tried < VOLUME_RETRY_MS) {
        all = false;
        continue;
      }
      const name = dayName(day);
      const read = `chain-volume:${name}`;
      try {
        const unknown = (why: string) => new ProviderError('github', 'shape', `${name} volume unknown: ${why}`);
        const tag = volumeRelease(name);
        if (!listed.has(tag)) throw unknown('not published');
        const refs = volumeReleaseAssets(listed.get(tag), name, downloadBase);
        if (refs === null) throw unknown('release provenance does not hold');
        const get = async (ref: { readonly url: string; readonly sha256: string }) => {
          const text = await this.#getText(src.downloads, 'github', 'volume asset', ref.url, priority);
          if (sha256Hex(text) !== ref.sha256) throw unknown('an asset does not match its digest');
          return text;
        };
        const check = await get(refs.check);
        if (!volumeCheckPassed(check, name)) throw unknown('the cross-check did not pass for this day');
        const hours = await get(refs.hours);
        const rows = parseVolumeHoursCsv(hours, day);
        if (rows === null) throw unknown('malformed asset');
        for (const r of rows) this.#ingest('github', RAW.volumeHour, r);
        const stored: StoredVolumeDay = { tag, day: name, hours: { id: refs.hours.id, sha256: refs.hours.sha256, text: hours }, check: { id: refs.check.id, sha256: refs.check.sha256, text: check }, tampered: false };
        this.#volumeDays.set(day, stored);
        src.store?.save(stored);
        this.outcomes.push({ read, ok: true, detail: `${rows.length} hours` });
      } catch (e) {
        this.outcomes.push({ read, ok: false, detail: e instanceof Error ? e.message : 'failed' });
        this.#volumeTried.set(day, this.#o.timers.now());
        all = false;
        if (limited(e)) return false;
      }
    }
    return all;
  }

  /**
   * RUG-1c: one deployer's prior mints judged through the per-creator cache (`DeployerChecks`): only mints not yet
   * held, and those not final once the creator's re-read gap has passed, are read from the history. Ingests any new
   * `rug:<mint>` labels, then the creator's `coverage:rugs:deployer:<creator>` fact at the asking slot. True when that
   * fact covers every prior mint (H14 accepts it); a fact that does not is ingested too, so H14 says why.
   */
  async readDeployerCheck(req: RugCheckRequest): Promise<boolean> {
    const c = this.#o.deployerChecks;
    if (c === undefined) return false;
    let covered = false;
    const ok = await this.#guard(`deployer-check:${req.creator}`, async () => {
      const r = await c.check(req, this.#o.timers.now());
      for (const f of r.facts) this.#ingest('helius', f.key, f.value);
      covered = r.covered;
      return `${req.mints.length} prior mints, ${r.read.length} read, ${r.credits} credits${covered ? '' : ', not covered'}`;
    });
    return ok && covered;
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

