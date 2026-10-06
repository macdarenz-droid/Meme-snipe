// JSON-RPC subscriptions over one reconnecting WebSocket (Solana pubsub on Helius and Alchemy, and Helius Parsed
// Streams). Subscriptions are re-sent on every open; server subscription ids are forgotten on every drop.
import type { Timers } from '../scheduler/timers.ts';
import type { SocketFactory } from './http.ts';
import { ReconnectingSocket, type SocketOptions } from './socket.ts';
import { createHash } from 'node:crypto';

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
// Removed requests can wait for an ACK, but never accumulate without bound on a healthy, busy connection.
const MAX_REMOVED_PENDING = 256;
const watchKey = (s: SubscriptionSpec): string => createHash('sha256').update(JSON.stringify([s.method, s.params], (_k, v: unknown) =>
  isObj(v) ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : v)).digest('hex');

export class RpcSocket {
  readonly #socket: ReconnectingSocket;
  readonly #events: RpcSocketEvents;
  readonly #subs = new Map<number, SubscriptionSpec>();
  /** Request id → local handle, for subscribe requests in flight. */
  readonly #pending = new Map<number, { readonly handle: number; readonly unsubscribe: string; readonly byteKind: SocketByteKind; readonly key: string }>();
  /** Agave may give identical subscribe parameters the same server ID. Each desired handle owns that ID. */
  readonly #live = new Map<number, Set<number>>();
  readonly #serverOf = new Map<number, number>();
  readonly #keys = new Map<number, string>();
  /** Removed server IDs waiting for equivalent desired requests; only digests and unsubscribe methods survive. */
  readonly #deferred = new Map<number, { readonly key: string; readonly unsubscribe: string }>();
  #nextHandle = 1;
  #nextId = 1;

  constructor(name: string, url: () => string, factory: SocketFactory, timers: Timers, opts: SocketOptions, events: RpcSocketEvents = {}) {
    this.#events = events;
    this.#socket = new ReconnectingSocket(name, url, factory, timers, opts, {
      onOpen: () => {
        this.#live.clear();
        this.#serverOf.clear();
        this.#pending.clear();
        this.#deferred.clear();
        for (const h of this.#subs.keys()) this.#subscribe(h);
        this.#events.onOpen?.();
      },
      onMessage: (text) => this.#message(text),
      onDown: (reason, wasOpen) => {
        this.#live.clear();
        this.#serverOf.clear();
        this.#pending.clear();
        this.#deferred.clear();
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
    this.#pending.clear();
    this.#deferred.clear();
    this.#live.clear();
    this.#serverOf.clear();
  }

  add(spec: SubscriptionSpec): number {
    const h = this.#nextHandle++;
    this.#subs.set(h, spec);
    this.#keys.set(h, watchKey(spec));
    if (this.#socket.state === 'open') this.#subscribe(h);
    return h;
  }

  remove(h: number): void {
    const spec = this.#subs.get(h);
    if (spec === undefined) return;
    this.#subs.delete(h);
    const key = this.#keys.get(h)!;
    this.#keys.delete(h);
    const server = this.#serverOf.get(h);
    if (server !== undefined) {
      this.#serverOf.delete(h);
      const owners = this.#live.get(server);
      owners?.delete(h);
      if (owners?.size === 0) this.#live.delete(server);
      this.#release(server, key, spec.unsubscribe);
    }
    this.#flushDeferred();
    this.#boundRemoved();
  }

  #subscribe(h: number): void {
    const spec = this.#subs.get(h)!;
    const id = this.#nextId++;
    // After removal retain no callback or parameters: just the fixed bucket, unsubscribe method and watch digest.
    this.#pending.set(id, { handle: h, unsubscribe: spec.unsubscribe, byteKind: spec.byteKind ?? 'logs', key: this.#keys.get(h)! });
    this.#socket.send(JSON.stringify({ jsonrpc: '2.0', id, method: spec.method, params: spec.params }));
  }

  #pendingDesired(key: string): boolean {
    return [...this.#pending.values()].some((p) => p.key === key && this.#subs.has(p.handle));
  }

  #release(server: number, key: string, unsubscribe: string): void {
    if (this.#live.has(server)) { this.#deferred.delete(server); return; } // another desired handle owns this server ID
    if (this.#pendingDesired(key)) this.#deferred.set(server, { key, unsubscribe });
    else { this.#deferred.delete(server); this.#unsubscribe(server, unsubscribe); }
  }

  #unsubscribe(server: number, method: string): void {
    this.#socket.send(JSON.stringify({ jsonrpc: '2.0', id: this.#nextId++, method, params: [server] }));
  }

  #flushDeferred(): void {
    for (const [server, d] of this.#deferred) {
      if (this.#live.has(server)) this.#deferred.delete(server); // the replacement adopted it
      else if (!this.#pendingDesired(d.key)) { this.#deferred.delete(server); this.#unsubscribe(server, d.unsubscribe); }
    }
  }

  #boundRemoved(): void {
    const removed = [...this.#pending.values()].filter((p) => !this.#subs.has(p.handle)).length;
    if (removed + this.#deferred.size > MAX_REMOVED_PENDING) this.#socket.reconnect('removed subscription acknowledgements backlog');
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
        // A removed request may share its server ID with an equivalent replacement, even before that ACK arrives.
        if (typeof m.result === 'number') this.#release(m.result, pending.key, pending.unsubscribe);
        this.#flushDeferred();
        this.#boundRemoved();
        return;
      }
      if (typeof m.result === 'number') {
        const owners = this.#live.get(m.result) ?? new Set<number>();
        owners.add(h);
        this.#live.set(m.result, owners);
        this.#serverOf.set(h, m.result);
        this.#deferred.delete(m.result);
        spec.onSubscribed?.();
      } else {
        spec.onRefused?.(isObj(m.error) && typeof m.error.code === 'number' ? m.error.code : null);
      }
      this.#flushDeferred();
      return;
    }
    if (typeof m.method !== 'string' || !isObj(m.params) || typeof m.params.subscription !== 'number') {
      this.#events.onBytes?.(bytes, typeof m.id === 'number' ? 'control' : 'unattributed');
      return;
    }
    const handles = [...(this.#live.get(m.params.subscription) ?? [])];
    const counted = handles.map((h) => this.#subs.get(h)).find((s) => s?.notification === m.method);
    this.#events.onBytes?.(bytes, counted?.byteKind ?? (counted === undefined ? 'unattributed' : 'logs'));
    // The byte charge may halt and remove this watch. A removed watch never delivers a notification.
    for (const h of handles) {
      const spec = this.#subs.get(h);
      if (spec !== undefined && spec.notification === m.method) spec.onNotify(m.params.result);
    }
  }
}
