// The live SOL/USD price for risk (`worker:sol-price`, R1 wants one younger than maxQuoteAgeMs): Coinbase Exchange's
// public `ticker` channel for SOL-USD, one WebSocket, no key (the same exchange FACTS-1 reads SOL/USD bars from).
// Each fact is dated at the trade's own exchange time, never at its receipt, so a stalled feed ages instead of looking
// fresh. At most one fact per `minGapMs`: prices tick many times a second.
import { MICRO_PER_USD } from '../../../core/src/units/index.ts';
import type { Timers } from '../scheduler/index.ts';
import type { SocketFactory } from './http.ts';
import type { LiveFeed } from './live-feed.ts';
import { ReconnectingSocket, type SocketOptions } from './socket.ts';

export const COINBASE_WS_URL = 'wss://ws-feed.exchange.coinbase.com';
const SOCKET: SocketOptions = { initialMs: 1_000, maxMs: 30_000, idleMs: 30_000 };

/** A decimal dollar string as micro-dollars, exactly (more than 6 decimals is refused, never rounded). */
export const dollarsToMicro = (s: string): bigint | null => {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(s);
  if (m === null) return null;
  return BigInt(m[1]!) * MICRO_PER_USD + BigInt((m[2] ?? '').padEnd(6, '0'));
};

export interface CoinbaseOptions {
  readonly factory: SocketFactory;
  readonly timers: Timers;
  readonly feed: Pick<LiveFeed, 'ingest'>;
  /** The fact key (the strategy's SOL_PRICE_KEY). */
  readonly key: string;
  readonly minGapMs?: number;
  readonly url?: string;
  readonly socket?: SocketOptions;
}

export class CoinbaseSolPrice {
  readonly #o: CoinbaseOptions;
  readonly #socket: ReconnectingSocket;
  #lastAt = Number.NEGATIVE_INFINITY;

  constructor(o: CoinbaseOptions) {
    this.#o = o;
    this.#socket = new ReconnectingSocket('coinbase', () => o.url ?? COINBASE_WS_URL, o.factory, o.timers, o.socket ?? SOCKET, {
      onOpen: () => {
        this.#socket.send(JSON.stringify({ type: 'subscribe', product_ids: ['SOL-USD'], channels: ['ticker'] }));
        this.#status('up', {});
      },
      onMessage: (text) => this.#message(text),
      onDown: (reason, wasOpen) => this.#status('down', { reason, wasOpen }),
    });
  }

  get socket(): ReconnectingSocket {
    return this.#socket;
  }

  start(): void {
    this.#socket.start();
  }

  stop(): void {
    this.#socket.stop();
  }

  #message(text: string): void {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (typeof m !== 'object' || m === null) return;
    const t = m as Record<string, unknown>;
    if (t['type'] !== 'ticker' || t['product_id'] !== 'SOL-USD' || typeof t['price'] !== 'string' || typeof t['time'] !== 'string') return;
    const value = dollarsToMicro(t['price']);
    const tradeAt = Date.parse(t['time']);
    const now = this.#o.timers.now();
    if (value === null || value <= 0n || !Number.isFinite(tradeAt)) return;
    // A trade time ahead of our clock is taken as now: never dated in the future.
    const atMs = Math.min(Math.floor(tradeAt), now);
    if (atMs - this.#lastAt < (this.#o.minGapMs ?? 500)) return;
    this.#lastAt = atMs;
    this.#o.feed.ingest('coinbase', { type: 'fact', key: this.#o.key, value: { value, atMs } }, { receivedAt: now });
  }

  #status(state: string, detail: Record<string, unknown>): void {
    this.#o.feed.ingest('worker', { type: 'offchain', key: 'feed:status:coinbase', value: { state, ...detail } }, { receivedAt: this.#o.timers.now() });
  }
}
