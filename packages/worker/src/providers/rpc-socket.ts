// JSON-RPC subscriptions over one reconnecting WebSocket (Solana pubsub on Helius and Alchemy, and Helius Parsed
// Streams). Subscriptions are re-sent on every open; server subscription ids are forgotten on every drop.
import type { Timers } from '../scheduler/timers.ts';
import type { SocketFactory } from './http.ts';
import { ReconnectingSocket, type SocketOptions } from './socket.ts';

export interface SubscriptionSpec {
  readonly method: string;
  readonly params: readonly unknown[];
  readonly unsubscribe: string;
  readonly notification: string;
  onNotify(result: unknown): void;
  /** The server refused the subscription (bad params, limit reached). */
  onRefused?(code: number | null): void;
  /** The server confirmed the subscription; notifications flow from here (called on every reconnect). */
  onSubscribed?(): void;
}

export interface RpcSocketEvents {
  onOpen?(): void;
  onDown?(reason: string, wasOpen: boolean): void;
  /** Bytes received, for byte-metered providers. */
  onBytes?(bytes: number): void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class RpcSocket {
  readonly #socket: ReconnectingSocket;
  readonly #events: RpcSocketEvents;
  readonly #subs = new Map<number, SubscriptionSpec>();
  /** Request id → local handle, for subscribe requests in flight. */
  readonly #pending = new Map<number, number>();
  /** Server subscription id → local handle, valid until the connection drops. */
  readonly #live = new Map<number, number>();
  readonly #serverOf = new Map<number, number>();
  #nextHandle = 1;
  #nextId = 1;

  constructor(name: string, url: () => string, factory: SocketFactory, timers: Timers, opts: SocketOptions, events: RpcSocketEvents = {}) {
    this.#events = events;
    this.#socket = new ReconnectingSocket(name, url, factory, timers, opts, {
      onOpen: () => {
        this.#live.clear();
        this.#serverOf.clear();
        this.#pending.clear();
        for (const h of this.#subs.keys()) this.#subscribe(h);
        this.#events.onOpen?.();
      },
      onMessage: (text) => this.#message(text),
      onDown: (reason, wasOpen) => {
        this.#live.clear();
        this.#serverOf.clear();
        this.#pending.clear();
        this.#events.onDown?.(reason, wasOpen);
      },
    });
  }

  get socket(): ReconnectingSocket {
    return this.#socket;
  }

  get size(): number {
    return this.#subs.size;
  }

  start(): void {
    this.#socket.start();
  }

  stop(): void {
    this.#socket.stop();
  }

  add(spec: SubscriptionSpec): number {
    const h = this.#nextHandle++;
    this.#subs.set(h, spec);
    if (this.#socket.state === 'open') this.#subscribe(h);
    return h;
  }

  remove(h: number): void {
    const spec = this.#subs.get(h);
    if (spec === undefined) return;
    this.#subs.delete(h);
    const server = this.#serverOf.get(h);
    if (server !== undefined) {
      this.#serverOf.delete(h);
      this.#live.delete(server);
      this.#socket.send(JSON.stringify({ jsonrpc: '2.0', id: this.#nextId++, method: spec.unsubscribe, params: [server] }));
    }
  }

  #subscribe(h: number): void {
    const spec = this.#subs.get(h)!;
    const id = this.#nextId++;
    this.#pending.set(id, h);
    this.#socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: spec.method, params: spec.params }));
  }

  #message(text: string): void {
    this.#events.onBytes?.(Buffer.byteLength(text, 'utf8'));
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return; // not ours to decode; a malformed frame carries no fact
    }
    if (!isObj(m)) return;
    if (typeof m.id === 'number' && this.#pending.has(m.id)) {
      const h = this.#pending.get(m.id)!;
      this.#pending.delete(m.id);
      const spec = this.#subs.get(h);
      if (spec === undefined) return; // removed while in flight; the server drops it on the next reconnect
      if (typeof m.result === 'number') {
        this.#live.set(m.result, h);
        this.#serverOf.set(h, m.result);
        spec.onSubscribed?.();
      } else {
        spec.onRefused?.(isObj(m.error) && typeof m.error.code === 'number' ? m.error.code : null);
      }
      return;
    }
    if (typeof m.method !== 'string' || !isObj(m.params) || typeof m.params.subscription !== 'number') return;
    const h = this.#live.get(m.params.subscription);
    if (h === undefined) return;
    const spec = this.#subs.get(h);
    if (spec === undefined || spec.notification !== m.method) return;
    spec.onNotify(m.params.result);
  }
}
