// PumpPortal's free `subscribeNewToken` and `subscribeMigration` on exactly one WebSocket (data.md §3.1,
// Fact-check F10: "ONLY USE ONE WEBSOCKET CONNECTION AT A TIME"; bans expire after an hour). A message is a
// sighting of its signature, placed off-chain (PumpPortal gives no slot); its fields are kept as given and never
// read as chain data. Migrations are fetched and decoded, because a migration counts only with a
// `CompletePumpAmmMigrationEvent` (§6.1); creates are not, at ~50k a day.
import { P3, type Priority } from '../scheduler/scheduler.ts';
import type { Timers } from '../scheduler/timers.ts';
import { isAddress, isSignature } from './canonical.ts';
import type { SocketFactory } from './http.ts';
import type { LiveFeed } from './live-feed.ts';
import { ReconnectingSocket, type SocketOptions } from './socket.ts';
import type { TxFetcher } from './tx-fetcher.ts';

export const PUMPPORTAL_URL = 'wss://pumpportal.fun/api/data';

/** One connection; reconnects back off from 5 s to 5 min, and three failed opens in a row wait out the one-hour ban. */
export const PUMPPORTAL_SOCKET: SocketOptions = { initialMs: 5_000, maxMs: 300_000, idleMs: 120_000, banAfterFailures: 3, banMs: 3_600_000 };

/** Fields seen in live messages (data.md §3.1). Anything else is dropped; nothing here is trusted as chain data. */
const KEPT = ['signature', 'mint', 'traderPublicKey', 'txType', 'initialBuy', 'solAmount', 'bondingCurveKey', 'vTokensInBondingCurve', 'vSolInBondingCurve', 'marketCapSol', 'name', 'symbol', 'uri', 'is_mayhem_mode', 'pool'] as const;

export interface PumpPortalOptions {
  readonly factory: SocketFactory;
  readonly timers: Timers;
  readonly feed: LiveFeed;
  readonly fetcher?: TxFetcher;
  /** Priority for fetching migration transactions (discovery: P3). */
  readonly migrationFetch?: Priority;
  readonly socket?: SocketOptions;
  readonly url?: string;
}

/** Process-wide: at most one PumpPortal connection exists, whatever constructs it. */
let active: PumpPortalSource | null = null;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class PumpPortalSource {
  readonly #o: PumpPortalOptions;
  readonly #socket: ReconnectingSocket;

  constructor(o: PumpPortalOptions) {
    this.#o = o;
    this.#socket = new ReconnectingSocket('pumpportal', () => o.url ?? PUMPPORTAL_URL, o.factory, o.timers, o.socket ?? PUMPPORTAL_SOCKET, {
      onOpen: () => {
        this.#socket.send(JSON.stringify({ method: 'subscribeNewToken' }));
        this.#socket.send(JSON.stringify({ method: 'subscribeMigration' }));
        this.#status('up', {});
      },
      onMessage: (text) => this.#message(text),
      onDown: (reason, wasOpen) => this.#status('down', { reason, wasOpen }),
    });
  }

  get socket(): ReconnectingSocket {
    return this.#socket;
  }

  /** Refuses to start while another PumpPortal connection is running. */
  start(): void {
    if (active !== null && active !== this) throw new Error('pumpportal: one connection only; stop the other source first');
    active = this;
    this.#socket.start();
  }

  stop(): void {
    this.#socket.stop();
    if (active === this) active = null;
  }

  #message(text: string): void {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return;
    }
    if (!isObj(m) || !isSignature(m.signature) || !isAddress(m.mint)) return; // acknowledgements and errors carry no fact
    const detail: Record<string, unknown> = {};
    for (const k of KEPT) if (m[k] !== undefined) detail[k] = m[k];
    const signature = m.signature;
    const txType = typeof m.txType === 'string' ? m.txType : 'unknown';
    const f = this.#o.feed.ingest('pumpportal', { type: 'seen', signature, slot: null, err: null, via: `pumpportal:${txType}`, detail }, { receivedAt: this.#o.timers.now() });
    // Only the two free streams are subscribed, so anything that is not a create is a migration candidate.
    if (!f.duplicate && txType !== 'create' && this.#o.fetcher) {
      this.#o.fetcher.fetch(signature, this.#o.migrationFetch ?? P3).catch(() => this.#status('fetch_failed', { signature }));
    }
  }

  #status(state: string, detail: Record<string, unknown>): void {
    this.#o.feed.ingest('worker', { type: 'offchain', key: 'feed:status:pumpportal', value: { state, ...detail } }, { receivedAt: this.#o.timers.now() });
  }
}
