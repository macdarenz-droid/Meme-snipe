// REPLAY-1000: the keyless public Solana RPC, cached on disk. Only immutable answers are cached: finalized
// transactions, and signature pages anchored by a `before` signature (history older than a signature never changes).
// SOLANA_RPC is read from the environment and defaults to the public endpoint; never put a keyed URL in the repo.
// Requests are spaced per method and retried on 429/5xx (research/tail-proof/collect.ts pattern).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Keyless public endpoints, tried in order: publicnode's public Solana RPC (no account, no key; about 60 calls/s
 * measured on 6 Oct) and the Solana Foundation's public endpoint (10 calls per method per window, shared with every user
 * of this egress IP: 0.3 to 1 call/s measured). Both serve the same finalized chain; `verify` in collect.ts checks a
 * sample byte for byte. SOLANA_RPC (comma-separated) replaces the list.
 */
export const RPC_URLS = (process.env['SOLANA_RPC'] ?? 'https://solana-rpc.publicnode.com,https://api.mainnet-beta.solana.com').split(',').map((s) => s.trim()).filter((s) => s !== '');
export const DATA_DIR = process.env['REPLAY_DATA'] ?? join(dirname(fileURLToPath(import.meta.url)), 'data');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One signature entry as the RPC gives it (numbers, not bigints: this is the raw wire shape). */
export interface RawSig {
  readonly signature: string;
  readonly slot: number;
  readonly err: unknown;
  readonly blockTime: number | null;
  readonly memo?: string | null;
  readonly confirmationStatus?: string;
  /** The transaction's position in its block (the public RPC gives it; older cache pages may lack it). */
  readonly transactionIndex?: number;
}

export interface RpcStats {
  calls: Record<string, number>;
  cacheHits: Record<string, number>;
  retries: number;
}

/** Least spacing between calls started on one endpoint, ms. */
const SPACING_MS = (url: string): number => (url.includes('publicnode') ? Number(process.env['REPLAY_SPACING_MS'] ?? '6') : 400);

export class PublicRpc {
  readonly urls: readonly string[];
  readonly dir: string;
  readonly stats: RpcStats = { calls: {}, cacheHits: {}, retries: 0 };
  readonly #next = new Map<string, number>();
  #id = 1;

  constructor(urls: readonly string[] = RPC_URLS, dir = DATA_DIR) {
    this.urls = urls;
    this.dir = dir;
    for (const d of ['tx', 'sigs', 'misc']) mkdirSync(join(dir, d), { recursive: true });
  }

  async #slot(url: string): Promise<void> {
    for (;;) {
      const now = Date.now();
      const at = this.#next.get(url) ?? 0;
      if (at <= now) {
        this.#next.set(url, now + SPACING_MS(url));
        return;
      }
      await sleep(at - now);
    }
  }

  /**
   * One JSON-RPC call with retries, on the first endpoint, then the next ones after repeated failures. A JSON-RPC error
   * answer is returned as `{ error }` (transient node errors are retried first).
   */
  async call(method: string, params: unknown[]): Promise<{ result?: unknown; error?: { code: number; message: string } }> {
    // Offline (a test fixture): only the cache answers.
    if (this.urls.length === 0) throw new Error(`offline: ${method} ${JSON.stringify(params).slice(0, 120)} is not in the cache`);
    // A transient failure (429, 5xx, a dropped connection, a node that is behind) is never an answer: the replay's virtual
    // time stands still while the world reads, so the call is retried until an endpoint answers. After 8 failures in a
    // row on one endpoint the next is tried, in turn.
    for (let attempt = 0; ; attempt++) {
      const url = this.urls[Math.floor(attempt / 8) % this.urls.length]!;
      await this.#slot(url);
      this.stats.calls[method] = (this.stats.calls[method] ?? 0) + 1;
      const backoff = Math.min(30_000, 500 * 2 ** Math.min(attempt % 8, 6));
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: this.#id++, method, params }), signal: AbortSignal.timeout(60_000) });
        if (res.status === 429 || res.status >= 500) {
          this.stats.retries++;
          await res.text().catch(() => '');
          await sleep(backoff);
          continue;
        }
        const body = (await res.json()) as { result?: unknown; error?: { code: number; message: string } };
        if (body.error !== undefined && [-32004, -32005, -32014, -32016, -32603, -32000].includes(body.error.code)) {
          this.stats.retries++;
          await sleep(backoff);
          continue;
        }
        return body;
      } catch {
        this.stats.retries++;
        await sleep(backoff);
      }
    }
  }

  /**
   * The result, from the first endpoint that has the data: an endpoint that answers "not in my ledger" (publicnode keeps
   * about 20 hours: -32020 for an older `before`, -32007/-32009/-32011 for missing slots) passes the call to the next.
   */
  async result<T>(method: string, params: unknown[]): Promise<T> {
    let r = await this.call(method, params);
    for (const url of this.urls.slice(1)) {
      if (r.error === undefined || ![-32020, -32007, -32009, -32011].includes(r.error.code)) break;
      this.stats.calls[`fallback:${method}`] = (this.stats.calls[`fallback:${method}`] ?? 0) + 1;
      r = await this.#fallback(url).call(method, params);
    }
    if (r.error !== undefined) throw new Error(`${method}: ${JSON.stringify(r.error)}`);
    return r.result as T;
  }

  readonly #fallbacks = new Map<string, PublicRpc>();
  #fallback(url: string): PublicRpc {
    let f = this.#fallbacks.get(url);
    if (f === undefined) this.#fallbacks.set(url, (f = new PublicRpc([url], this.dir)));
    return f;
  }

  #hit(kind: string): void {
    this.stats.cacheHits[kind] = (this.stats.cacheHits[kind] ?? 0) + 1;
  }

  /** A finalized transaction in the RPC's base64 shape, or null when the node does not have it. Cached when found. */
  async tx(signature: string): Promise<unknown | null> {
    const p = txFile(this.dir, signature);
    if (existsSync(p)) {
      this.#hit('tx');
      return readZ(p);
    }
    const params = [signature, { encoding: 'base64', commitment: 'finalized', maxSupportedTransactionVersion: 1 }];
    let t = await this.result<unknown>('getTransaction', params);
    // Not found on the first endpoint: asked of the others before it counts as not found.
    for (const url of this.urls.slice(1)) {
      if (t !== null) break;
      t = (await this.#fallback(url).call('getTransaction', params)).result ?? null;
    }
    if (t !== null) writeZ(p, t);
    return t;
  }

  /** Whether a transaction is cached (no call). */
  hasTx(signature: string): boolean {
    return existsSync(txFile(this.dir, signature));
  }

  /**
   * One page of an address's signatures strictly older than `before` (newest first), finalized. A page anchored by
   * `before` is immutable once finalized, so it is cached; an unanchored page (the newest) never is.
   */
  async sigPage(address: string, before: string | undefined, limit = 1000): Promise<RawSig[]> {
    const key = before === undefined ? null : join(this.dir, 'sigs', `${address}.${before.slice(0, 32)}.${limit}.json.zst`);
    if (key !== null && existsSync(key)) {
      this.#hit('sigs');
      return readZ(key) as RawSig[];
    }
    const page = await this.result<RawSig[]>('getSignaturesForAddress', [address, { limit, commitment: 'finalized', ...(before === undefined ? {} : { before }) }]);
    const clean = page.map((x) => ({ signature: x.signature, slot: x.slot, err: x.err ?? null, blockTime: x.blockTime ?? null, ...(typeof x.transactionIndex === 'number' ? { transactionIndex: x.transactionIndex } : {}) }));
    if (key !== null) writeZ(key, clean);
    return clean;
  }

  /** A JSON blob cached under misc/<name>.json, made by `make` on a miss. */
  async cached<T>(name: string, make: () => Promise<T>): Promise<T> {
    const p = join(this.dir, 'misc', `${name}.json`);
    if (existsSync(p)) {
      this.#hit('misc');
      return JSON.parse(readFileSync(p, 'utf8')) as T;
    }
    const v = await make();
    atomicWrite(p, JSON.stringify(v));
    return v;
  }
}

export const atomicWrite = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
};

/** Runs `f` over `items` with at most `n` in flight; results in input order. */
export const pool = async <T, R>(items: readonly T[], n: number, f: (item: T, i: number) => Promise<R>): Promise<R[]> => {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await f(items[i]!, i);
    }
  }));
  return out;
};

/** A transaction's cache file: zstd JSON, fanned out by the signature's first two characters. */
export const txFile = (dir: string, signature: string): string => join(dir, 'tx', signature.slice(0, 2), `${signature}.json.zst`);
export const readZ = (path: string): unknown => JSON.parse(zstdDecompressSync(readFileSync(path)).toString('utf8'));
let tmpSeq = 0;
/** Written whole, under a temporary name unique to this process (several processes share the cache). */
export const writeZ = (path: string, v: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`;
  writeFileSync(tmp, zstdCompressSync(Buffer.from(JSON.stringify(v))));
  renameSync(tmp, path);
};
