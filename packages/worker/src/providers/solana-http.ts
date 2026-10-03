// Solana JSON-RPC over HTTP (Helius, Alchemy), every call through the provider's quota scheduler.
import { fromBase64, recordFromRpc, type RpcTransactionBase64, type TransactionRecord } from '../../../core/src/chain/index.ts';
import { ALCHEMY_CU, HELIUS_RPC_CREDITS } from '../scheduler/limits.ts';
import type { Priority, Scheduler } from '../scheduler/scheduler.ts';
import { type HttpClient, parseJson, ProviderError, send } from './http.ts';

export type RpcMethod = 'getTransaction' | 'getSignaturesForAddress' | 'getAccountInfo';

export interface RpcHttpOptions {
  readonly provider: 'helius' | 'alchemy';
  /** Built on every call from `Secrets`, so the key is never kept. */
  readonly url: () => string;
  readonly http: HttpClient;
  readonly scheduler: Scheduler;
  readonly timeoutMs: number;
}

/** Credits (Helius) or compute units (Alchemy) one call uses. */
export const callCost = (provider: 'helius' | 'alchemy', method: RpcMethod): number => (provider === 'helius' ? HELIUS_RPC_CREDITS : ALCHEMY_CU[method]);

export interface SignatureInfo {
  readonly signature: string;
  readonly slot: bigint;
  readonly err: unknown;
  /** Block time in seconds, or null when the node does not give it. */
  readonly blockTime: number | null;
}

export interface AccountInfo {
  readonly slot: bigint;
  /** Null when the account does not exist. */
  readonly value: { readonly owner: string; readonly lamports: bigint; readonly data: Uint8Array } | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class RpcHttp {
  readonly provider: 'helius' | 'alchemy';
  readonly #o: RpcHttpOptions;
  #id = 1;

  constructor(o: RpcHttpOptions) {
    this.provider = o.provider;
    this.#o = o;
  }

  async call(method: RpcMethod, params: readonly unknown[], priority: Priority): Promise<unknown> {
    const o = this.#o;
    return o.scheduler.run(priority, callCost(o.provider, method), async () => {
      const body = JSON.stringify({ jsonrpc: '2.0', id: this.#id++, method, params });
      const res = await send(o.http, o.provider, method, { method: 'POST', url: o.url(), headers: { 'content-type': 'application/json' }, body, timeoutMs: o.timeoutMs });
      if (res.status === 429) {
        o.scheduler.penalize();
        throw new ProviderError(o.provider, 'rate_limited', `${method} rate limited`, 429);
      }
      if (res.status !== 200) throw new ProviderError(o.provider, 'http', `${method} returned HTTP ${res.status}`, res.status);
      const json = parseJson(o.provider, method, res.text);
      if (!isObj(json)) throw new ProviderError(o.provider, 'shape', `${method} returned no object`);
      if (json.error !== undefined) {
        const code = isObj(json.error) && typeof json.error.code === 'number' ? json.error.code : 'unknown';
        throw new ProviderError(o.provider, 'rpc', `${method} error ${code}`);
      }
      return json.result;
    });
  }

  /** A confirmed transaction as DEC-1's record, or null when the node does not have it (yet). */
  async getTransaction(signature: string, priority: Priority): Promise<TransactionRecord | null> {
    const r = await this.call('getTransaction', [signature, { encoding: 'base64', commitment: 'confirmed', maxSupportedTransactionVersion: 1 }], priority);
    if (r === null) return null;
    if (!isObj(r)) throw new ProviderError(this.provider, 'shape', 'getTransaction result is not an object');
    try {
      return recordFromRpc(signature, r as unknown as RpcTransactionBase64);
    } catch {
      throw new ProviderError(this.provider, 'shape', 'getTransaction result does not decode');
    }
  }

  /** Signatures for `address`, newest first, older than `before` and newer than `until` when given. */
  async getSignaturesForAddress(address: string, opts: { readonly before?: string; readonly until?: string; readonly limit: number; readonly minContextSlot?: bigint }, priority: Priority): Promise<SignatureInfo[]> {
    const cfg: Record<string, unknown> = { commitment: 'confirmed', limit: opts.limit };
    if (opts.minContextSlot !== undefined) cfg.minContextSlot = Number(opts.minContextSlot);
    if (opts.before !== undefined) cfg.before = opts.before;
    if (opts.until !== undefined) cfg.until = opts.until;
    if (opts.before !== undefined) cfg.before = opts.before;
    const r = await this.call('getSignaturesForAddress', [address, cfg], priority);
    if (!Array.isArray(r)) throw new ProviderError(this.provider, 'shape', 'getSignaturesForAddress result is not an array');
    return r.map((x: unknown) => {
      if (!isObj(x) || typeof x.signature !== 'string' || !Number.isSafeInteger(x.slot)) throw new ProviderError(this.provider, 'shape', 'bad signature entry');
      return { signature: x.signature, slot: BigInt(x.slot as number), err: x.err ?? null, blockTime: Number.isSafeInteger(x.blockTime) ? (x.blockTime as number) : null };
    });
  }

  async getAccountInfo(address: string, priority: Priority): Promise<AccountInfo> {
    const r = await this.call('getAccountInfo', [address, { encoding: 'base64', commitment: 'processed' }], priority);
    if (!isObj(r) || !isObj(r.context) || !Number.isSafeInteger(r.context.slot)) throw new ProviderError(this.provider, 'shape', 'getAccountInfo result has no context');
    return { slot: BigInt(r.context.slot as number), value: r.value === null ? null : accountValue(this.provider, r.value) };
  }
}

/** The `value` of an account notification or `getAccountInfo` result, base64-encoded. */
export const accountValue = (provider: string, v: unknown): { readonly owner: string; readonly lamports: bigint; readonly data: Uint8Array } => {
  // JSON numbers above 2^53 lose precision when parsed; refuse them rather than carry a wrong balance.
  if (!isObj(v) || typeof v.owner !== 'string' || !Number.isSafeInteger(v.lamports) || !Array.isArray(v.data) || v.data[1] !== 'base64' || typeof v.data[0] !== 'string') {
    throw new ProviderError(provider, 'shape', 'account value is not base64-encoded');
  }
  return { owner: v.owner, lamports: BigInt(v.lamports as number), data: fromBase64(v.data[0]) };
};
