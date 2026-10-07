// One WebSocket that reconnects. Backoff doubles from `initialMs` to `maxMs`; a stream silent for `idleMs` is
// treated as stale and reopened. `banMs` covers providers that ban a client for reconnecting too often
// (PumpPortal: one connection, bans expire after an hour): after `banAfterFailures` opens in a row that fail
// before they open, the next try waits `banMs`.
// RC-FIXES: the backoff resets only once a connection proves healthy (a message `healthyMs` or more after it opened), so
// a server that accepts and then closes at once (policy, credits, too many connections) keeps backing off instead of
// being reopened every `initialMs`. Connection attempts are also capped per rolling hour (`maxConnectsPerHour`): at the
// cap the next try waits for the window, and the down reason names the cap (the feed stays down, so a critical feed
// halts entries through the worker's existing feed path).
import type { Timers, TimerHandle } from '../scheduler/timers.ts';
import type { SocketFactory, SocketLike } from './http.ts';

export interface SocketOptions {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly idleMs: number;
  readonly banAfterFailures?: number;
  readonly banMs?: number;
  /** How long a connection must stay up (and then deliver a message) before the backoff resets. Default `idleMs`. */
  readonly healthyMs?: number;
  /** The most connection attempts in any rolling hour. Default `DEFAULT_CONNECTS_PER_HOUR`. */
  readonly maxConnectsPerHour?: number;
}

/** RC-FIXES: connection attempts allowed per rolling hour unless a socket sets its own ceiling. */
export const DEFAULT_CONNECTS_PER_HOUR = 60;
const HOUR_MS = 3_600_000;

export type SocketState = 'stopped' | 'connecting' | 'open' | 'waiting';

export interface SocketEvents {
  onOpen(): void;
  onMessage(text: string): void;
  /** The connection is gone (closed, failed or stale). `wasOpen` is false when it never opened. */
  onDown(reason: string, wasOpen: boolean): void;
}

export class ReconnectingSocket {
  readonly name: string;
  readonly #url: () => string;
  readonly #factory: SocketFactory;
  readonly #timers: Timers;
  readonly #opts: SocketOptions;
  readonly #events: SocketEvents;
  #socket: SocketLike | null = null;
  #state: SocketState = 'stopped';
  #retry: TimerHandle | null = null;
  #idle: TimerHandle | null = null;
  #delay: number;
  #failures = 0;
  #opens = 0;
  #openedAt = 0;
  #healthy = false;
  /** Times of the connection attempts in the last hour, oldest first. */
  readonly #attempts: number[] = [];
  #ceilingHits = 0;

  /** `url` is called on every connect, so a key is read from `Secrets` only when needed and never kept here. */
  constructor(name: string, url: () => string, factory: SocketFactory, timers: Timers, opts: SocketOptions, events: SocketEvents) {
    this.name = name;
    this.#url = url;
    this.#factory = factory;
    this.#timers = timers;
    this.#opts = opts;
    this.#events = events;
    this.#delay = opts.initialMs;
  }

  get state(): SocketState {
    return this.#state;
  }

  /** Connections opened so far (for the one-connection proof and the connection credit). */
  get opens(): number {
    return this.#opens;
  }

  /** Times a retry was pushed back by the hourly connection ceiling. */
  get ceilingHits(): number {
    return this.#ceilingHits;
  }

  start(): void {
    if (this.#state !== 'stopped') return;
    this.#connect();
  }

  stop(): void {
    this.#state = 'stopped';
    this.#clear();
    const s = this.#socket;
    this.#socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onerror = null;
      s.onclose = null;
      s.close(1000, 'stop');
    }
  }

  /** Sends when open; returns false otherwise (the owner re-sends its subscriptions on open). */
  send(text: string): boolean {
    if (this.#state !== 'open' || this.#socket === null) return false;
    this.#socket.send(text);
    return true;
  }

  /** Drops the connection and reconnects, as after a stale stream. */
  reconnect(reason: string): void {
    if (this.#state === 'stopped') return;
    this.#down(reason);
  }

  #clear(): void {
    if (this.#retry) this.#timers.clearTimeout(this.#retry);
    if (this.#idle) this.#timers.clearTimeout(this.#idle);
    this.#retry = this.#idle = null;
  }

  #connect(): void {
    this.#clear();
    this.#state = 'connecting';
    this.#attempts.push(this.#timers.now());
    let s: SocketLike;
    try {
      s = this.#factory(this.#url());
    } catch {
      this.#socket = null;
      this.#failed('connect threw', false);
      return;
    }
    this.#opens++;
    this.#socket = s;
    let opened = false;
    s.onopen = () => {
      if (this.#socket !== s) return;
      opened = true;
      this.#state = 'open';
      this.#failures = 0;
      this.#openedAt = this.#timers.now();
      this.#healthy = false;
      this.#armIdle();
      this.#events.onOpen();
    };
    s.onmessage = (ev) => {
      if (this.#socket !== s) return;
      this.#armIdle();
      if (!this.#healthy && this.#timers.now() - this.#openedAt >= (this.#opts.healthyMs ?? this.#opts.idleMs)) {
        this.#healthy = true;
        this.#delay = this.#opts.initialMs;
      }
      const d = ev.data;
      this.#events.onMessage(typeof d === 'string' ? d : d instanceof ArrayBuffer ? new TextDecoder().decode(d) : String(d));
    };
    s.onerror = () => {
      // A close always follows; the close handler reconnects.
    };
    s.onclose = (ev) => {
      if (this.#socket !== s) return;
      this.#socket = null;
      this.#failed(`closed ${ev.code}`, opened);
    };
  }

  #armIdle(): void {
    if (this.#idle) this.#timers.clearTimeout(this.#idle);
    this.#idle = this.#timers.setTimeout(() => {
      this.#idle = null;
      this.#down(`no message for ${this.#opts.idleMs} ms`);
    }, this.#opts.idleMs);
  }

  #down(reason: string): void {
    const s = this.#socket;
    const wasOpen = this.#state === 'open';
    this.#socket = null;
    if (s) {
      s.onopen = s.onmessage = s.onerror = null;
      s.onclose = null;
      s.close(4000, 'reconnect');
    }
    this.#failed(reason, wasOpen);
  }

  #failed(reason: string, wasOpen: boolean): void {
    this.#clear();
    if (this.#state === 'stopped') return;
    this.#state = 'waiting';
    if (!wasOpen) this.#failures++;
    let wait = this.#delay;
    this.#delay = Math.min(this.#opts.maxMs, this.#delay * 2);
    const banAfter = this.#opts.banAfterFailures;
    if (banAfter !== undefined && this.#opts.banMs !== undefined && this.#failures >= banAfter) {
      wait = this.#opts.banMs;
      this.#failures = 0;
    }
    const now = this.#timers.now();
    while (this.#attempts.length > 0 && this.#attempts[0]! <= now - HOUR_MS) this.#attempts.shift();
    const ceiling = this.#opts.maxConnectsPerHour ?? DEFAULT_CONNECTS_PER_HOUR;
    if (this.#attempts.length >= ceiling) {
      const free = this.#attempts[this.#attempts.length - ceiling]! + HOUR_MS - now;
      if (free > wait) {
        wait = free;
        this.#ceilingHits++;
        reason = `${reason}; reconnect ceiling ${ceiling}/h reached, next try in ${Math.ceil(free / 1000)} s`;
      }
    }
    this.#events.onDown(reason, wasOpen);
    if (this.#state !== 'waiting') return; // the owner stopped us
    this.#retry = this.#timers.setTimeout(() => {
      this.#retry = null;
      this.#connect();
    }, wait);
  }
}
