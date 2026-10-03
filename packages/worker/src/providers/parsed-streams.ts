// Helius Parsed Streams for graduations (§6.1; data.md §1.4, Fact-check F5): `parsedTransactionSubscribe` on
// `wss://beta.helius-rpc.com`, `confirmed` only, 1 credit per delivered event. We ask for `details: "raw"` (the
// smallest payload) and read only the signature and slot: Helius's decoding is never used. The transaction is
// fetched and decoded by DEC-1's `transactionEvents`, since a migration counts only with a
// `CompletePumpAmmMigrationEvent`.
import { PUMP_PROGRAM } from '../../../core/src/chain/index.ts';
import { HELIUS_PARSED_CREDITS_PER_EVENT, HELIUS_WS_CREDITS_PER_BYTE, HELIUS_WS_CREDITS_PER_CONNECTION } from '../scheduler/limits.ts';
import { P3, type Priority, type Scheduler } from '../scheduler/scheduler.ts';
import type { Timers } from '../scheduler/timers.ts';
import { isSignature } from './canonical.ts';
import type { SocketFactory } from './http.ts';
import type { LiveFeed } from './live-feed.ts';
import { RpcSocket } from './rpc-socket.ts';
import type { SocketOptions } from './socket.ts';
import type { TxFetcher } from './tx-fetcher.ts';

/**
 * The pump program's `migrate` instruction. Instruction names come from Helius's catalog (matched exactly, then
 * case- and separator-insensitively); the opt-in probe checks this filter with `describeProgram`.
 */
export const GRADUATION_FILTER = { programs: [PUMP_PROGRAM as string], instructionNames: ['migrate'], includeFailed: false } as const;

export interface ParsedStreamsOptions {
  readonly url: () => string;
  readonly factory: SocketFactory;
  readonly timers: Timers;
  readonly feed: LiveFeed;
  readonly scheduler: Scheduler;
  readonly fetcher?: TxFetcher;
  readonly fetchPriority?: Priority;
  readonly socket: SocketOptions;
  readonly filter?: Readonly<Record<string, unknown>>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class ParsedStreamsSource {
  readonly #o: ParsedStreamsOptions;
  readonly #rpc: RpcSocket;

  constructor(o: ParsedStreamsOptions) {
    this.#o = o;
    this.#rpc = new RpcSocket('helius-parsed', o.url, o.factory, o.timers, o.socket, {
      onOpen: () => {
        o.scheduler.meter(HELIUS_WS_CREDITS_PER_CONNECTION);
        this.#status('up', {});
      },
      onDown: (reason, wasOpen) => this.#status('down', { reason, wasOpen }),
      onBytes: (n) => o.scheduler.meter(n * HELIUS_WS_CREDITS_PER_BYTE),
    });
    this.#rpc.add({
      method: 'parsedTransactionSubscribe',
      params: [o.filter ?? GRADUATION_FILTER, { commitment: 'confirmed', details: 'raw' }],
      unsubscribe: 'parsedTransactionUnsubscribe',
      notification: 'parsedTransactionNotification',
      onNotify: (r) => this.#notify(r),
      onRefused: (code) => this.#status('refused', { code }),
    });
  }

  get socket(): RpcSocket {
    return this.#rpc;
  }

  start(): void {
    this.#rpc.start();
  }

  stop(): void {
    this.#rpc.stop();
  }

  #notify(r: unknown): void {
    const o = this.#o;
    o.scheduler.meter(HELIUS_PARSED_CREDITS_PER_EVENT);
    if (!isObj(r) || !isObj(r.value) || !isObj(r.value.transaction)) return;
    const tx = r.value.transaction;
    const signature = tx.signature;
    const slotNum = typeof tx.slot === 'number' ? tx.slot : isObj(r.context) ? r.context.slot : null;
    if (!isSignature(signature) || typeof slotNum !== 'number' || !Number.isSafeInteger(slotNum) || slotNum < 0) return;
    const err = tx.error ?? null;
    // Delivered at `confirmed`, usually after the horizon has passed its slot: placed as an off-chain report
    // (slot kept in `detail`) rather than released late and refused.
    const f = o.feed.ingest('helius-parsed', { type: 'seen', signature, slot: null, err, via: 'parsed:graduation', detail: { slot: BigInt(slotNum) } }, { receivedAt: o.timers.now() });
    if (!f.duplicate && err === null && o.fetcher) {
      o.fetcher.fetch(signature, o.fetchPriority ?? P3).catch(() => this.#status('fetch_failed', { signature }));
    }
  }

  #status(state: string, detail: Record<string, unknown>): void {
    this.#o.feed.ingest('worker', { type: 'offchain', key: 'feed:status:helius-parsed', value: { state, ...detail } }, { receivedAt: this.#o.timers.now() });
  }
}
