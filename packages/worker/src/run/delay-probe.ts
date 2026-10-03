// The measured delay scenario's input (supervisor ruling 2026-10-04, BT-1c): once a minute the newest signature the
// creates stream saw at `processed` (Helius logsSubscribe) is read at `confirmed` (getTransaction), and the recorder's
// `delays` table gets both arrival times on this host for that same signature and slot. Never the second-resolution
// block time as the reference. One Helius credit a minute (about 43,000 a month), at P3.
import { P3, type Timers } from '../scheduler/index.ts';
import type { TransactionRecord } from '../../../core/src/chain/index.ts';
import type { Frame } from '../providers/index.ts';

export interface DelayProbeOptions {
  readonly timers: Timers;
  /** The confirmed read (the TxFetcher's, so the transaction also goes on the feed). Null when not found. */
  readonly confirmed: (signature: string) => Promise<TransactionRecord | null>;
  readonly record: (row: Readonly<Record<string, unknown>>, atMs: number) => void;
  /** The `via` of the processed sightings sampled (the creates watch). */
  readonly via: string;
  readonly everyMs: number;
}

export class DelayProbe {
  readonly #o: DelayProbeOptions;
  #latest: { readonly signature: string; readonly slot: bigint | null; readonly at: number } | null = null;
  /** Recent sightings on other paths (PumpPortal publishes no commitment), the newest 5,000 signatures. */
  readonly #others = new Map<string, { source: string; at: number }[]>();
  #timer: ReturnType<Timers['setTimeout']> | null = null;
  #running = false;
  #inFlight = false;

  constructor(o: DelayProbeOptions) {
    this.#o = o;
  }

  /** Every frame (the worker's onFrame): processed sightings on the sampled watch. */
  frame(f: Frame): void {
    const b = f.body;
    if (b.type !== 'seen' || b.err !== null) return;
    if (b.via === this.#o.via) {
      if (!f.backfilled) this.#latest = { signature: b.signature, slot: b.slot, at: f.receivedAt };
      return;
    }
    const list = this.#others.get(b.signature);
    if (list !== undefined) list.push({ source: b.via, at: f.receivedAt });
    else {
      this.#others.set(b.signature, [{ source: b.via, at: f.receivedAt }]);
      if (this.#others.size > 5_000) this.#others.delete(this.#others.keys().next().value!);
    }
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    const tick = (): void => {
      if (!this.#running) return;
      void this.sample();
      this.#timer = this.#o.timers.setTimeout(tick, this.#o.everyMs);
    };
    this.#timer = this.#o.timers.setTimeout(tick, this.#o.everyMs);
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) this.#o.timers.clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** Reads the newest processed sighting at confirmed and records both arrivals. */
  async sample(): Promise<void> {
    const s = this.#latest;
    if (s === null || this.#inFlight) return;
    this.#latest = null;
    this.#inFlight = true;
    let r: TransactionRecord | null = null;
    let error: string | null = null;
    try {
      r = await this.#o.confirmed(s.signature);
    } catch (e) {
      error = e instanceof Error ? e.message : 'error';
    }
    const at = this.#o.timers.now();
    this.#o.record({
      signature: s.signature, slot: s.slot, processed_at_ms: s.at, processed_path: `helius logsSubscribe ${this.#o.via}`, processed_commitment: 'processed',
      confirmed_at_ms: r === null ? null : at, confirmed_path: 'helius getTransaction', confirmed_commitment: 'confirmed', confirmed_slot: r?.slot ?? null,
      found: r !== null, error, other_sightings: this.#others.get(s.signature) ?? [],
    }, at);
    this.#inFlight = false;
  }
}
