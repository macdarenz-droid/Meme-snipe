import { useSyncExternalStore } from 'react';
import { clearServer, loadSeen, loadServer, saveSeen, saveServer, type KeyValue } from './server.ts';

/**
 * Whether the app can reach the worker. `none`: no address saved. `connecting`: saved, no answer
 * yet. `online`: the last answer was data that passed every check. `error`: the server answered,
 * but with an HTTP error or data that failed the checks. `offline`: no answer (Tailscale off,
 * server down, no network). `lastOk` is when good data last arrived, kept across restarts;
 * `lastAnswer` is when the server last answered at all.
 */
export interface Connection {
  origin: string | null;
  state: 'none' | 'connecting' | 'online' | 'error' | 'offline';
  lastOk: string | null;
  lastAnswer: string | null;
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
    this.value = origin ? { origin, state: 'connecting', lastOk: loadSeen(origin, kv), lastAnswer: null } : { origin: null, state: 'none', lastOk: null, lastAnswer: null };
  }

  get = (): Connection => this.value;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(next: Connection): void {
    const v = this.value;
    if (v.origin === next.origin && v.state === next.state && v.lastOk === next.lastOk && v.lastAnswer === next.lastAnswer) return;
    this.value = next;
    for (const fn of this.listeners) fn();
  }

  /** Saves a checked address and starts over; returns false when storage is blocked. */
  setServer(origin: string): boolean {
    const saved = saveServer(origin, this.kv);
    this.set({ origin, state: 'connecting', lastOk: saved ? loadSeen(origin, this.kv) : null, lastAnswer: null });
    return saved;
  }

  clear(): void {
    clearServer(this.kv);
    this.set({ origin: null, state: 'none', lastOk: null, lastAnswer: null });
  }

  /** A request to `origin` returned data that passed every check. Reports for an address that is no longer current are ignored. */
  reportOk(origin: string, at: string): void {
    if (origin !== this.value.origin) return;
    saveSeen(origin, at, this.kv);
    this.set({ origin, state: 'online', lastOk: at, lastAnswer: at });
  }

  /** `origin` answered, but with an HTTP error or data that failed the checks: not an update. */
  reportBad(origin: string, at: string): void {
    if (origin !== this.value.origin) return;
    this.set({ ...this.value, state: 'error', lastAnswer: at });
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
