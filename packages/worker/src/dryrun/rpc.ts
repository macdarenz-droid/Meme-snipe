// The dry run's only way to the chain: read calls and `simulateTransaction`, each through the Helius quota scheduler.
// There is no send path. The method list below is closed and checked at run time before any request is built, and
// the no-send test (test/dryrun-nosend.test.ts) proves no module that can send is reachable from here.
import { fromBase64, toBase64 } from '../../../core/src/chain/index.ts';
import { HELIUS_RPC_CREDITS } from '../scheduler/limits.ts';
import { P2, type Priority, type Scheduler } from '../scheduler/scheduler.ts';
import { type HttpClient, parseJson, ProviderError, refusal429, send } from '../providers/http.ts';

/** Every JSON-RPC method the dry run may call. Frozen: nothing that sends a transaction is or may be added. */
export const DRYRUN_METHODS = Object.freeze(['getMultipleAccounts', 'getTokenLargestAccounts', 'simulateTransaction'] as const);
export type DryRunMethod = (typeof DRYRUN_METHODS)[number];

/** Thrown before any request is built when a method outside `DRYRUN_METHODS` is asked for. */
export class NoSendPath extends Error {
  constructor(method: string) {
    super(`dry run: method ${method} is not allowed (read and simulate only)`);
    this.name = 'NoSendPath';
  }
}

export interface DryRunRpcOptions {
  /** Built on every call from `Secrets`, so the key is never kept. */
  readonly url: () => string;
  readonly http: HttpClient;
  /** The Helius scheduler (every call is a standard RPC call: 1 credit, data.md §1.2). */
  readonly scheduler: Scheduler;
  readonly timeoutMs: number;
}

export interface RawAccount {
  readonly owner: string;
  readonly lamports: bigint;
  readonly data: Uint8Array;
  readonly executable: boolean;
}

export interface LargestAccount {
  readonly address: string;
  readonly amount: bigint;
}

export interface SimulationValue {
  readonly err: unknown;
  readonly logs: readonly string[];
  /** Post-state of the requested accounts, in request order; null when the account does not exist afterwards. */
  readonly accounts: readonly (RawAccount | null)[];
  readonly unitsConsumed: bigint | null;
  /**
   * Balances before and after, taken by the node in the same simulation (Agave returns them since 2.x; checked on
   * mainnet 2026-10-03 on 4.3.0). Lamports are indexed like the transaction's account keys; token balances name the
   * account index. Null when the provider does not return them.
   */
  readonly fee: bigint | null;
  readonly preBalances: readonly bigint[] | null;
  readonly postBalances: readonly bigint[] | null;
  readonly preTokenBalances: readonly TokenBalance[] | null;
  readonly postTokenBalances: readonly TokenBalance[] | null;
}

export interface TokenBalance {
  readonly accountIndex: number;
  readonly mint: string;
  readonly amount: bigint;
}

const PROVIDER = 'helius';
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const shape = (what: string) => new ProviderError(PROVIDER, 'shape', what);
const U64 = /^(0|[1-9][0-9]{0,19})$/;

const slotOf = (r: unknown, method: string): bigint => {
  if (!isObj(r) || !isObj(r.context) || !Number.isSafeInteger(r.context.slot)) throw shape(`${method} result has no context slot`);
  return BigInt(r.context.slot as number);
};

/** An account in base64 encoding, or null. Lamports above 2^53 are refused rather than rounded. */
export const rawAccount = (v: unknown, what: string): RawAccount | null => {
  if (v === null) return null;
  if (!isObj(v) || typeof v.owner !== 'string' || !Number.isSafeInteger(v.lamports) || typeof v.executable !== 'boolean') throw shape(`${what} is malformed`);
  if (!Array.isArray(v.data) || v.data[1] !== 'base64' || typeof v.data[0] !== 'string') throw shape(`${what} is not base64-encoded`);
  let data: Uint8Array;
  try {
    data = fromBase64(v.data[0]);
  } catch {
    throw shape(`${what} has invalid base64 data`);
  }
  return { owner: v.owner, lamports: BigInt(v.lamports as number), data, executable: v.executable };
};

/** Optional lamport balances: absent or null is null; present but not safe non-negative integers is malformed. */
const balances = (v: unknown, what: string): bigint[] | null => {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || !v.every((x) => Number.isSafeInteger(x) && (x as number) >= 0)) throw shape(`simulateTransaction ${what} is malformed`);
  return v.map((x) => BigInt(x as number));
};

const tokenBalances = (v: unknown, what: string): TokenBalance[] | null => {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw shape(`simulateTransaction ${what} is malformed`);
  return v.map((x: unknown) => {
    const amount = isObj(x) && isObj(x.uiTokenAmount) ? x.uiTokenAmount.amount : undefined;
    if (!isObj(x) || !Number.isSafeInteger(x.accountIndex) || typeof x.mint !== 'string' || typeof amount !== 'string' || !U64.test(amount)) {
      throw shape(`simulateTransaction ${what} entry is malformed`);
    }
    return { accountIndex: x.accountIndex as number, mint: x.mint, amount: BigInt(amount) };
  });
};

export class DryRunRpc {
  readonly #o: DryRunRpcOptions;
  #id = 1;

  constructor(o: DryRunRpcOptions) {
    this.#o = o;
  }

  async call(method: DryRunMethod, params: readonly unknown[], priority: Priority): Promise<unknown> {
    // Runtime trap: checked first, so a forbidden method never reaches the scheduler or the network.
    if (!(DRYRUN_METHODS as readonly string[]).includes(method)) throw new NoSendPath(method);
    // P0 and P1 belong to exits, reconciliation and open positions; the dry run never takes their capacity.
    if (priority < P2) throw new RangeError(`dry run: priority P${priority} is reserved; use P2 or P3`);
    const o = this.#o;
    return o.scheduler.run(priority, HELIUS_RPC_CREDITS, async () => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: this.#id++, method, params });
      const res = await send(o.http, PROVIDER, method, { method: 'POST', url: o.url(), headers: { 'content-type': 'application/json' }, body, timeoutMs: o.timeoutMs });
      if (res.status === 429) throw refusal429(o.scheduler, PROVIDER, method, res.text);
      if (res.status !== 200) throw new ProviderError(PROVIDER, 'http', `${method} returned HTTP ${res.status}`, res.status);
      const json = parseJson(PROVIDER, method, res.text);
      if (!isObj(json)) throw shape(`${method} returned no object`);
      if (json.error !== undefined) {
        const code = isObj(json.error) && typeof json.error.code === 'number' ? json.error.code : 'unknown';
        throw new ProviderError(PROVIDER, 'rpc', `${method} error ${code}`);
      }
      return json.result;
    });
  }

  /** Accounts at `processed`, at or after `minContextSlot`. */
  async getMultipleAccounts(addresses: readonly string[], minContextSlot: bigint, priority: Priority): Promise<{ readonly slot: bigint; readonly accounts: (RawAccount | null)[] }> {
    if (addresses.length === 0 || addresses.length > 100) throw new RangeError('getMultipleAccounts takes 1 to 100 addresses');
    const r = await this.call('getMultipleAccounts', [addresses, { encoding: 'base64', commitment: 'processed', minContextSlot: Number(minContextSlot) }], priority);
    const slot = slotOf(r, 'getMultipleAccounts');
    const value = (r as Record<string, unknown>).value;
    if (!Array.isArray(value) || value.length !== addresses.length) throw shape('getMultipleAccounts returned the wrong number of accounts');
    return { slot, accounts: value.map((v, i) => rawAccount(v, `account ${i}`)) };
  }

  /** The 20 largest token accounts of a mint, largest first, at or after `minContextSlot`. */
  async getTokenLargestAccounts(mint: string, minContextSlot: bigint, priority: Priority): Promise<{ readonly slot: bigint; readonly accounts: LargestAccount[] }> {
    const r = await this.call('getTokenLargestAccounts', [mint, { commitment: 'processed', minContextSlot: Number(minContextSlot) }], priority);
    const slot = slotOf(r, 'getTokenLargestAccounts');
    const value = (r as Record<string, unknown>).value;
    if (!Array.isArray(value)) throw shape('getTokenLargestAccounts value is not an array');
    return {
      slot,
      accounts: value.map((x: unknown) => {
        if (!isObj(x) || typeof x.address !== 'string' || typeof x.amount !== 'string' || !U64.test(x.amount)) throw shape('bad largest-account entry');
        return { address: x.address, amount: BigInt(x.amount) };
      }),
    };
  }

  /**
   * Simulates an unsigned wire transaction (zeroed signatures): `sigVerify: false`, `replaceRecentBlockhash: true`,
   * inner instructions on, and the post-state of `accounts` read back (security.md §2.3, safety.md §6).
   */
  async simulate(wire: Uint8Array, accounts: readonly string[], minContextSlot: bigint, priority: Priority): Promise<{ readonly slot: bigint; readonly value: SimulationValue }> {
    const cfg = {
      encoding: 'base64',
      commitment: 'processed',
      sigVerify: false,
      replaceRecentBlockhash: true,
      minContextSlot: Number(minContextSlot),
      innerInstructions: true,
      accounts: { encoding: 'base64', addresses: accounts },
    };
    const r = await this.call('simulateTransaction', [toBase64(wire), cfg], priority);
    const slot = slotOf(r, 'simulateTransaction');
    const v = (r as Record<string, unknown>).value;
    if (!isObj(v) || !('err' in v)) throw shape('simulateTransaction value is malformed');
    const logs = v.logs === null || v.logs === undefined ? [] : v.logs;
    if (!Array.isArray(logs) || !logs.every((l) => typeof l === 'string')) throw shape('simulateTransaction logs are malformed');
    const err = v.err ?? null;
    let post: (RawAccount | null)[] = [];
    // A failed simulation returns no account state; a successful one must return every requested account.
    if (err === null) {
      if (!Array.isArray(v.accounts) || v.accounts.length !== accounts.length) throw shape('simulateTransaction returned the wrong number of accounts');
      post = v.accounts.map((a, i) => rawAccount(a, `simulated account ${i}`));
    }
    const units = v.unitsConsumed;
    if (units !== undefined && units !== null && !Number.isSafeInteger(units)) throw shape('simulateTransaction unitsConsumed is malformed');
    if (v.fee !== undefined && v.fee !== null && !(Number.isSafeInteger(v.fee) && (v.fee as number) >= 0)) throw shape('simulateTransaction fee is malformed');
    return {
      slot,
      value: {
        err,
        logs: logs as string[],
        accounts: post,
        unitsConsumed: typeof units === 'number' ? BigInt(units) : null,
        fee: typeof v.fee === 'number' ? BigInt(v.fee) : null,
        preBalances: balances(v.preBalances, 'preBalances'),
        postBalances: balances(v.postBalances, 'postBalances'),
        preTokenBalances: tokenBalances(v.preTokenBalances, 'preTokenBalances'),
        postTokenBalances: tokenBalances(v.postTokenBalances, 'postTokenBalances'),
      },
    };
  }
}
