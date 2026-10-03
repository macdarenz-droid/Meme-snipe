import { useSyncExternalStore } from 'react';
import { clearServer, loadSeen, loadServer, saveSeen, saveServer, type KeyValue } from './server.ts';

/**
 * Whether the app can reach the worker. `none`: no address saved. `connecting`: saved, no answer
 * yet. `online`: the last request reached the server. `offline`: it did not (Tailscale off, server
 * down, no network). `lastOk` is when the server last answered, kept across restarts.
 */
export interface Connection {
  origin: string | null;
  state: 'none' | 'connecting' | 'online' | 'offline';
  lastOk: string | null;
}

type Listener = () => void;

export class ConnectionStore {
  private value: Connection;
  private readonly listeners = new Set<Listener>();
  private readonly kv: KeyValue | null | undefined;

  /** `kv` defaults to localStorage. */
  constructor(kv?: KeyValue | null) {
    this.kv = kv;
    const origin = loadServer(kv);
    this.value = origin ? { origin, state: 'connecting', lastOk: loadSeen(origin, kv) } : { origin: null, state: 'none', lastOk: null };
  }

  get = (): Connection => this.value;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(next: Connection): void {
    const v = this.value;
    if (v.origin === next.origin && v.state === next.state && v.lastOk === next.lastOk) return;
    this.value = next;
    for (const fn of this.listeners) fn();
  }

  /** Saves a checked address and starts over; returns false when storage is blocked. */
  setServer(origin: string): boolean {
    const saved = saveServer(origin, this.kv);
    this.set({ origin, state: 'connecting', lastOk: saved ? loadSeen(origin, this.kv) : null });
    return saved;
  }

  clear(): void {
    clearServer(this.kv);
    this.set({ origin: null, state: 'none', lastOk: null });
  }

  /** A request to `origin` got an answer. Reports for an address that is no longer current are ignored. */
  reportOk(origin: string, at: string): void {
    if (origin !== this.value.origin) return;
    saveSeen(origin, at, this.kv);
    this.set({ origin, state: 'online', lastOk: at });
  }

  /** A request to `origin` could not reach it. */
  reportOffline(origin: string): void {
    if (origin !== this.value.origin) return;
    this.set({ ...this.value, state: 'offline' });
  }
}

let shared: ConnectionStore | null = null;

/** The app's one store, created on first use so tests and server rendering never touch storage early. */
export function connection(): ConnectionStore {
  shared ??= new ConnectionStore();
  return shared;
}

export function useConnection(store: ConnectionStore = connection()): Connection {
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}
