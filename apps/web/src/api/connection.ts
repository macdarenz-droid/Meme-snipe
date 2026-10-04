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
  /** `update`: the server answered, but only with fields this app does not know (it is newer than the app; APP-COMPAT). */
  state: 'none' | 'connecting' | 'online' | 'error' | 'update' | 'offline';
  lastOk: string | null;
  lastAnswer: string | null;
}

type Listener = () => void;

/**
 * A bad answer from an endpoint stops counting after this long without another answer from it,
 * so an endpoint the app stopped polling (another mode or month) cannot hold "Server error" forever.
 * A polled endpoint answers at least every 5 minutes plus the request timeout (src/api/poll.ts).
 */
export const BAD_ANSWER_TTL_MS = 10 * 60_000;

export class ConnectionStore {
  private value: Connection;
  private readonly listeners = new Set<Listener>();
  private readonly kv: KeyValue | null | undefined;
  /** Endpoints whose last answer was bad, with when that answer came and whether only new fields refused it. */
  private readonly bad = new Map<string, { at: number; cause: 'error' | 'update' }>();

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
    this.bad.clear();
    const saved = saveServer(origin, this.kv);
    this.set({ origin, state: 'connecting', lastOk: saved ? loadSeen(origin, this.kv) : null, lastAnswer: null });
    return saved;
  }

  clear(): void {
    this.bad.clear();
    clearServer(this.kv);
    this.set({ origin: null, state: 'none', lastOk: null, lastAnswer: null });
  }

  /**
   * A request to `origin` for `endpoint` returned data that passed every check. The state stays
   * "error" while any other endpoint's last answer was bad. Reports for an address that is no
   * longer current are ignored.
   */
  reportOk(origin: string, at: string, endpoint = ''): void {
    if (origin !== this.value.origin) return;
    this.bad.delete(endpoint);
    saveSeen(origin, at, this.kv);
    this.set({ origin, state: this.badState(at) ?? 'online', lastOk: at, lastAnswer: at });
  }

  /**
   * `origin` answered for `endpoint`, but with an HTTP error or data that failed the checks: not an update. `cause`
   * 'update' when only fields this app does not know refused it (APP-COMPAT); any real error outranks it.
   */
  reportBad(origin: string, at: string, endpoint = '', cause: 'error' | 'update' = 'error'): void {
    if (origin !== this.value.origin) return;
    this.bad.set(endpoint, { at: Date.parse(at), cause });
    this.set({ ...this.value, state: this.badState(at) ?? 'error', lastAnswer: at });
  }

  /** "error" while any endpoint's last bad answer is a real error, else "update" while any is new fields only; null when none. */
  private badState(at: string): 'error' | 'update' | null {
    const now = Date.parse(at);
    for (const [k, b] of this.bad) if (now - b.at >= BAD_ANSWER_TTL_MS) this.bad.delete(k);
    const causes = [...this.bad.values()].map((b) => b.cause);
    return causes.includes('error') ? 'error' : causes.includes('update') ? 'update' : null;
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
