// JSON-RPC subscriptions over one reconnecting WebSocket (Solana pubsub on Helius and Alchemy, and Helius Parsed
// Streams). Subscriptions are re-sent on every open; server subscription ids are forgotten on every drop.
import type { Timers } from '../scheduler/timers.ts';
import type { SocketFactory } from './http.ts';
import { ReconnectingSocket, type SocketOptions } from './socket.ts';

/** Fixed buckets: no address, signature or arbitrary stream name is retained by the meter. */
export const SOCKET_BYTE_KINDS = ['slots', 'accounts', 'logs', 'creates', 'migrations', 'rugs', 'trades', 'control', 'unattributed'] as const;
export type SocketByteKind = typeof SOCKET_BYTE_KINDS[number];

export interface SubscriptionSpec {
  readonly byteKind?: SocketByteKind;
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
  onBytes?(bytes: number, kind: SocketByteKind): void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class RpcSocket {
  readonly #socket: ReconnectingSocket;
  readonly #events: RpcSocketEvents;
  readonly #subs = new Map<number, SubscriptionSpec>();
  /** Request id → local handle, for subscribe requests in flight. */
  readonly #pending = new Map<number, { readonly handle: number; readonly unsubscribe: string; readonly byteKind: SocketByteKind }>();
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
    // Keep only the unsubscribe and bucket after removal, never the notification callback or watch's data.
    this.#pending.set(id, { handle: h, unsubscribe: spec.unsubscribe, byteKind: spec.byteKind ?? 'logs' });
    this.#socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: spec.method, params: spec.params }));
  }

  #message(text: string): void {
    const bytes = Buffer.byteLength(text, 'utf8');
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      this.#events.onBytes?.(bytes, 'unattributed');
      return; // not ours to decode; a malformed frame carries no fact
    }
    if (!isObj(m)) { this.#events.onBytes?.(bytes, 'unattributed'); return; }
    if (typeof m.id === 'number' && this.#pending.has(m.id)) {
      const pending = this.#pending.get(m.id)!;
      const h = pending.handle;
      this.#pending.delete(m.id);
      this.#events.onBytes?.(bytes, pending.byteKind);
      const spec = this.#subs.get(h);
      if (spec === undefined) {
        // Removed in flight: the server accepted a subscription we no longer want. Stop it on this connection,
        // without reviving it or touching a replacement watch (each add has its own handle and request id).
        if (typeof m.result === 'number') this.#socket.send(JSON.stringify({ jsonrpc: '2.0', id: this.#nextId++, method: pending.unsubscribe, params: [m.result] }));
        return;
      }
      if (typeof m.result === 'number') {
        this.#live.set(m.result, h);
        this.#serverOf.set(h, m.result);
        spec.onSubscribed?.();
      } else {
        spec.onRefused?.(isObj(m.error) && typeof m.error.code === 'number' ? m.error.code : null);
      }
      return;
    }
    if (typeof m.method !== 'string' || !isObj(m.params) || typeof m.params.subscription !== 'number') {
      this.#events.onBytes?.(bytes, typeof m.id === 'number' ? 'control' : 'unattributed');
      return;
    }
    const h = this.#live.get(m.params.subscription);
    let spec = h === undefined ? undefined : this.#subs.get(h);
    this.#events.onBytes?.(bytes, spec?.notification === m.method ? spec.byteKind ?? 'logs' : 'unattributed');
    // The byte charge may halt and remove this watch. A removed watch never delivers a notification.
    spec = h === undefined ? undefined : this.#subs.get(h);
    if (spec === undefined || spec.notification !== m.method) return;
    spec.onNotify(m.params.result);
  }
}
