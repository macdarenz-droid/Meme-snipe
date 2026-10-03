// Jupiter on the free key (execution.md §2.1–2.5, data.md §2): Tokens V2 (`/tokens/v2/recent`, `/tokens/v2/search`)
// and Swap V2 quotes (`/swap/v2/order`, `/swap/v2/build`), key in `x-api-key`. Every call goes through the
// Jupiter scheduler (one 60-per-minute main bucket shared by Swap, Price and Tokens) and every response's
// `x-ratelimit-remaining` corrects it. Answers enter the timeline as off-chain facts, so a decision that reads a
// quote reads it from the Feed and the replay sees the same quote.
import type { Priority, Scheduler } from '../scheduler/scheduler.ts';
import type { Timers } from '../scheduler/timers.ts';
import { isAddress } from './canonical.ts';
import { type HttpClient, parseJson, ProviderError, type Secrets, scrub, send } from './http.ts';
import type { LiveFeed } from './live-feed.ts';

export const JUPITER_BASE = 'https://api.jup.ag';

export interface JupiterOptions {
  readonly http: HttpClient;
  readonly secrets: Secrets;
  readonly scheduler: Scheduler;
  readonly feed: LiveFeed;
  readonly timers: Timers;
  readonly timeoutMs: number;
  readonly base?: string;
}

/** Query for `/order` and `/build`. Slippage is always ours (owner rule via §10: never Jupiter's RTSE default). */
export interface SwapQuery {
  readonly inputMint: string;
  readonly outputMint: string;
  /** Raw units of the input mint, as a decimal integer string. */
  readonly amount: string;
  readonly slippageBps: number;
  readonly taker: string;
  /** Further documented parameters, passed as given (e.g. `excludeRouters`, `priorityFeeLamports`). */
  readonly extra?: Readonly<Record<string, string>>;
}

const checkSwap = (q: SwapQuery): void => {
  if (!isAddress(q.inputMint) || !isAddress(q.outputMint) || !isAddress(q.taker)) throw new RangeError('swap query needs base58 mints and taker');
  if (!/^[1-9][0-9]*$/.test(q.amount)) throw new RangeError('amount must be a positive integer string');
  if (!Number.isSafeInteger(q.slippageBps) || q.slippageBps < 0 || q.slippageBps > 10_000) throw new RangeError('slippageBps must be an integer from 0 to 10000');
  for (const k of ['inputMint', 'outputMint', 'amount', 'slippageBps', 'taker']) if (q.extra && k in q.extra) throw new RangeError(`${k} cannot be overridden through extra`);
};

export class JupiterClient {
  readonly #o: JupiterOptions;

  constructor(o: JupiterOptions) {
    this.#o = o;
  }

  /** Newest tokens by first-pool time (30 by default). Discovery: P3, Tokens lane (≤ 6 a minute). */
  async tokensRecent(priority: Priority): Promise<unknown[]> {
    const rows = await this.#get('/tokens/v2/recent', {}, priority, 'tokens', 'tokens/recent');
    if (!Array.isArray(rows)) throw new ProviderError('jupiter', 'shape', 'tokens/recent did not return a list');
    this.#rows(rows);
    return rows;
  }

  /** Up to 100 mints in one call. */
  async tokensSearch(mints: readonly string[], priority: Priority): Promise<unknown[]> {
    if (mints.length === 0 || mints.length > 100 || !mints.every(isAddress)) throw new RangeError('search takes 1 to 100 base58 mints');
    const rows = await this.#get('/tokens/v2/search', { query: mints.join(',') }, priority, 'tokens', 'tokens/search');
    if (!Array.isArray(rows)) throw new ProviderError('jupiter', 'shape', 'tokens/search did not return a list');
    this.#rows(rows);
    return rows;
  }

  /** Managed quote with an unsigned transaction. Exits ask at P0. */
  async order(q: SwapQuery, priority: Priority): Promise<unknown> {
    checkSwap(q);
    const r = await this.#get('/swap/v2/order', this.#swapParams(q), priority, 'swap', 'swap/order');
    this.#fact(`jupiter:order:${q.inputMint}:${q.outputMint}`, { query: { ...q }, response: r });
    return r;
  }

  /** Raw instructions from the Metis router (no platform fee). */
  async build(q: SwapQuery, priority: Priority): Promise<unknown> {
    checkSwap(q);
    const r = await this.#get('/swap/v2/build', this.#swapParams(q), priority, 'swap', 'swap/build');
    this.#fact(`jupiter:build:${q.inputMint}:${q.outputMint}`, { query: { ...q }, response: r });
    return r;
  }

  #swapParams(q: SwapQuery): Record<string, string> {
    return { ...q.extra, inputMint: q.inputMint, outputMint: q.outputMint, amount: q.amount, slippageBps: String(q.slippageBps), taker: q.taker };
  }

  #rows(rows: readonly unknown[]): void {
    for (const row of rows) {
      const id = typeof row === 'object' && row !== null ? (row as { id?: unknown }).id : undefined;
      if (isAddress(id)) this.#fact(`jupiter:token:${id}`, row);
    }
  }

  #fact(key: string, value: unknown): void {
    this.#o.feed.ingest('jupiter', { type: 'offchain', key, value }, { receivedAt: this.#o.timers.now() });
  }

  async #get(path: string, query: Readonly<Record<string, string>>, priority: Priority, lane: string, what: string): Promise<unknown> {
    const o = this.#o;
    return o.scheduler.run(priority, 0, async () => {
      const url = `${o.base ?? JUPITER_BASE}${path}${Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : ''}`;
      const res = await send(o.http, 'jupiter', what, { method: 'GET', url, headers: { 'x-api-key': o.secrets.get('JUPITER_API_KEY') }, timeoutMs: o.timeoutMs });
      const remaining = Number(res.header('x-ratelimit-remaining'));
      if (res.header('x-ratelimit-remaining') !== null && Number.isFinite(remaining)) o.scheduler.observeRemaining(remaining);
      if (res.status === 429) {
        o.scheduler.penalize();
        throw new ProviderError('jupiter', 'rate_limited', `${what} rate limited`, 429);
      }
      if (res.status !== 200) {
        // Jupiter's error bodies name the problem (e.g. NO_ROUTES_FOUND, an exit-risk signal); keep a short, scrubbed part.
        const body = scrub(res.text.slice(0, 200), o.secrets, ['JUPITER_API_KEY']);
        throw new ProviderError('jupiter', 'http', `${what} returned HTTP ${res.status}: ${body}`, res.status);
      }
      return parseJson('jupiter', what, res.text);
    }, lane);
  }
}
