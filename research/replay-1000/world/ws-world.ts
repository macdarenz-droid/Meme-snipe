// REPLAY-1000: the worker's WebSockets, replayed from chain history on the virtual clock.
// - Helius: `slotSubscribe` (one notification per slot, at the slot's time) and `logsSubscribe` {mentions: [address]}
//   (each transaction that mentions the address, from the subscription's moment on, at its slot's time plus the
//   processed lag, in block order). Log lines come from the transaction's own meta, which is what the node streams.
//   The two program-wide streams (pump's create authority, its withdraw authority) carry only the replayed coins'
//   transactions and their creators' creates (README "Streams").
// - Coinbase: SOL-USD heartbeats each second and ticker messages from Coinbase's own trade history.
// - PumpPortal and anything else: the connection is refused (README "Streams").
import type { SocketFactory, SocketLike } from '../../../packages/worker/src/providers/http.ts';
import type { RawSig } from '../rpc.ts';
import type { ChainView } from './chain.ts';
import type { VirtualClock } from './vclock.ts';

/** A processed notification reaches the worker this long after its slot was produced. */
export const PROCESSED_LAG_MS = 400;
export const OPEN_MS = 50;
/** Slots read ahead per chunk of an address's history. */
const CHUNK_SLOTS = 1_500;

type Obj = Record<string, unknown>;

abstract class WorldSocket implements SocketLike {
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { readonly data: unknown }) => void) | null = null;
  onclose: ((ev: { readonly code: number; readonly reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  closed = false;
  protected readonly clock: VirtualClock;

  constructor(clock: VirtualClock) {
    this.clock = clock;
  }

  protected emit(o: unknown): void {
    if (this.closed) return;
    this.onmessage?.({ data: JSON.stringify(o, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)) });
  }

  abstract send(data: string): void;

  close(): void {
    this.closed = true;
    this.stopAll();
  }

  protected stopAll(): void {}
}

class RefusedSocket extends WorldSocket {
  constructor(clock: VirtualClock) {
    super(clock);
    clock.setTimeout(() => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.({ code: 1006, reason: 'replay: not served' });
    }, OPEN_MS);
  }
  send(): void {}
}

/** The transactions a logs stream carries, in order, from a slot on. */
export interface LogSource {
  /** Signatures in slots (fromSlot, toSlot], oldest first, block order within a slot. */
  between(fromSlot: number, toSlot: number): Promise<RawSig[]>;
}

/** Block order: slot, then position in the block (reverse page order where the node gave no position). */
export const blockOrder = (sigs: readonly RawSig[]): RawSig[] => {
  const pos = new Map(sigs.map((s, i) => [s.signature, i] as const));
  return [...sigs].sort((a, b) => a.slot - b.slot || (a.transactionIndex ?? -1) - (b.transactionIndex ?? -1) || pos.get(b.signature)! - pos.get(a.signature)!);
};

export interface HeliusWorldDeps {
  readonly clock: VirtualClock;
  readonly chain: ChainView;
  /** Program-wide streams carry only these transactions (by mentioned address). */
  readonly fixed: ReadonlyMap<string, readonly RawSig[]>;
  /** Log lines of a successful transaction (from its meta). */
  readonly logsOf: (signature: string) => Promise<string[] | null>;
  readonly stats: Map<string, number>;
  /**
   * Addresses whose logs stream is refused (the server answers the subscribe with an error, as Helius does for a
   * refused watch): the pools of coins replayed only for their migration and survival read (README "Coins").
   */
  readonly refuseLogs?: ReadonlySet<string>;
}

class HeliusSocket extends WorldSocket {
  readonly #d: HeliusWorldDeps;
  #next = 1;
  readonly #subs = new Map<number, { stop: () => void }>();

  constructor(d: HeliusWorldDeps) {
    super(d.clock);
    this.#d = d;
    d.clock.setTimeout(() => {
      if (!this.closed) this.onopen?.({});
    }, OPEN_MS);
  }

  #count(k: string, n = 1): void {
    this.#d.stats.set(k, (this.#d.stats.get(k) ?? 0) + n);
  }

  send(data: string): void {
    const m = JSON.parse(data) as { id: number; method: string; params: unknown[] };
    const reply = (o: Obj) => this.clock.setTimeout(() => this.emit({ jsonrpc: '2.0', id: m.id, ...o }), OPEN_MS);
    if (m.method.endsWith('Unsubscribe')) {
      const id = m.params[0] as number;
      this.#subs.get(id)?.stop();
      this.#subs.delete(id);
      reply({ result: true });
      return;
    }
    const id = this.#next++;
    if (m.method === 'slotSubscribe') {
      reply({ result: id });
      this.#subs.set(id, this.#slots(id));
      return;
    }
    if (m.method === 'logsSubscribe') {
      const f = m.params[0] as { mentions?: string[] };
      const address = f.mentions?.[0];
      if (address === undefined) {
        reply({ error: { code: -32602, message: 'replay: only mentions filters are served' } });
        return;
      }
      if (this.#d.refuseLogs?.has(address) === true) {
        this.#count('logs-refused');
        reply({ error: { code: -32602, message: 'replay: this address is not streamed' } });
        return;
      }
      reply({ result: id });
      this.#subs.set(id, this.#logs(id, address));
      return;
    }
    this.#count(`ws-refused:${m.method}`);
    reply({ error: { code: -32601, message: `replay: ${m.method} is not served` } });
  }

  protected override stopAll(): void {
    for (const s of this.#subs.values()) s.stop();
    this.#subs.clear();
  }

  #slots(id: number): { stop: () => void } {
    const { clock, chain } = this.#d;
    let stopped = false;
    let slot = chain.clock.slotAt(clock.now() + OPEN_MS) + 1;
    const step = (): void => {
      if (stopped || this.closed) return;
      this.emit({ jsonrpc: '2.0', method: 'slotNotification', params: { result: { slot, parent: slot - 1, root: slot - 32 }, subscription: id } });
      this.#count('slot-notices');
      slot++;
      clock.setTimeout(step, Math.max(0, chain.clock.timeOf(slot) - clock.now()));
    };
    clock.setTimeout(step, Math.max(0, chain.clock.timeOf(slot) - clock.now()));
    return { stop: () => void (stopped = true) };
  }

  #logs(id: number, address: string): { stop: () => void } {
    const { clock, chain, fixed } = this.#d;
    let stopped = false;
    // Transactions processed after the subscription is in place.
    let from = chain.clock.slotAt(clock.now() + OPEN_MS);
    const source: LogSource = fixed.has(address)
      ? { between: async (a, b) => blockOrder(fixed.get(address)!.filter((s) => s.slot > a && s.slot <= b)) }
      : { between: async (a, b) => blockOrder(await chain.signaturesBetween(address, a, b)) };
    const chunk = (): void => {
      if (stopped || this.closed) return;
      const to = from + CHUNK_SLOTS;
      const a = from;
      // Read the chunk (real I/O, time stands still), then schedule its notifications and the next chunk's read.
      void clock.hold((async () => {
        const sigs = await source.between(a, to);
        const lines = await Promise.all(sigs.map((s) => (s.err === null ? this.#d.logsOf(s.signature) : Promise.resolve([] as string[]))));
        return sigs.map((s, i) => ({ s, logs: lines[i] }));
      })()).then((items) => {
        if (stopped || this.closed) return;
        for (const { s, logs } of items) {
          clock.setTimeout(() => {
            if (stopped || this.closed) return;
            this.#count(s.err === null ? 'log-notices' : 'log-notices-failed');
            this.emit({ jsonrpc: '2.0', method: 'logsNotification', params: { result: { context: { slot: s.slot }, value: { signature: s.signature, err: s.err, logs: logs ?? [] } }, subscription: id } });
          }, Math.max(0, chain.clock.timeOf(s.slot) + PROCESSED_LAG_MS - clock.now()));
        }
        // The next chunk is read when this one's end is near (one chunk ahead of the clock).
        from = to;
        clock.setTimeout(chunk, Math.max(0, chain.clock.timeOf(a) - clock.now()));
      }, (e: unknown) => {
        clock.failure = e;
      });
    };
    chunk();
    return { stop: () => void (stopped = true) };
  }
}

/** One SOL-USD trade from Coinbase's history: time (ms) and price as Coinbase writes it. */
export interface CoinbaseTrade {
  readonly t: number;
  readonly price: string;
}

class CoinbaseSocket extends WorldSocket {
  readonly #trades: readonly CoinbaseTrade[];
  #stopped = false;
  constructor(clock: VirtualClock, trades: readonly CoinbaseTrade[]) {
    super(clock);
    this.#trades = trades;
    clock.setTimeout(() => {
      if (!this.closed) this.onopen?.({});
    }, OPEN_MS);
  }
  send(data: string): void {
    const m = JSON.parse(data) as Obj;
    if (m['type'] !== 'subscribe') return;
    this.clock.setTimeout(() => this.emit({ type: 'subscriptions', channels: [{ name: 'ticker', product_ids: ['SOL-USD'] }, { name: 'heartbeat', product_ids: ['SOL-USD'] }] }), OPEN_MS);
    // Heartbeats each second.
    const beat = (): void => {
      if (this.#stopped || this.closed) return;
      this.emit({ type: 'heartbeat', product_id: 'SOL-USD', time: new Date(this.clock.now()).toISOString() });
      this.clock.setTimeout(beat, 1_000);
    };
    this.clock.setTimeout(beat, 1_000);
    // Ticker: each trade after now, at its time plus 100 ms. The worker keeps one per 500 ms of trade time; the same
    // rule is applied here first (it gives the same kept set, CoinbaseSolPrice.#message), so idle trades cost nothing.
    let i = lowerBound(this.#trades, this.clock.now());
    let lastKept = Number.NEGATIVE_INFINITY;
    const tick = (): void => {
      if (this.#stopped || this.closed) return;
      const tr = this.#trades[i];
      if (tr === undefined) return;
      i++;
      if (tr.t - lastKept >= 500) {
        lastKept = tr.t;
        this.emit({ type: 'ticker', product_id: 'SOL-USD', price: tickerPrice(tr.price), time: new Date(tr.t).toISOString() });
      }
      const nx = this.#trades[i];
      if (nx !== undefined) this.clock.setTimeout(tick, Math.max(0, nx.t + 100 - this.clock.now()));
    };
    const first = this.#trades[i];
    if (first !== undefined) this.clock.setTimeout(tick, Math.max(0, first.t + 100 - this.clock.now()));
  }
  protected override stopAll(): void {
    this.#stopped = true;
  }
}

/**
 * The REST trade history writes prices with 8 decimals ("121.20000000"); the WebSocket ticker writes them at the
 * product's price increment ("121.2" for SOL-USD, 0.01). Trailing zeros are dropped: the same value, in the
 * ticker's form (CoinbaseSolPrice refuses more than 6 decimals).
 */
export const tickerPrice = (rest: string): string => (rest.includes('.') ? rest.replace(/0+$/, '').replace(/\.$/, '') : rest);

const lowerBound = (xs: readonly CoinbaseTrade[], t: number): number => {
  let lo = 0;
  let hi = xs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (xs[m]!.t <= t) lo = m + 1;
    else hi = m;
  }
  return lo;
};

export const socketWorld = (d: HeliusWorldDeps & { readonly coinbase: readonly CoinbaseTrade[] }): SocketFactory => (url) => {
  const host = new URL(url).host;
  if (host === 'mainnet.helius-rpc.com') return new HeliusSocket(d);
  if (host === 'ws-feed.exchange.coinbase.com') return new CoinbaseSocket(d.clock, d.coinbase);
  d.stats.set(`ws-refused-host:${host}`, (d.stats.get(`ws-refused-host:${host}`) ?? 0) + 1);
  return new RefusedSocket(d.clock);
};
