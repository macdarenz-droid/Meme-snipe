// REPLAY-1000: the chain as it stood at a past moment, read from the cached public RPC. Nothing here answers with a
// later state: signatures and transactions after the as-of slot do not exist yet, and account state is rebuilt from the
// transactions at or before it (accounts.ts), or refused.
import type { PublicRpc, RawSig } from '../rpc.ts';

/** Least spacing of the samples the slot clock interpolates between. */
export const THIN_MS = 20_000;

/** Slot ↔ time from (slot, blockTime) samples. Block times are whole seconds; a slot is placed mid-second. */
export class SlotClock {
  readonly #slots: number[];
  readonly #ms: number[];

  constructor(samples: readonly { readonly slot: number; readonly blockTime: number | null }[]) {
    const by = new Map<number, number>();
    for (const s of samples) if (s.blockTime !== null) by.set(s.slot, s.blockTime * 1000 + 500);
    const all = [...by].sort((a, b) => a[0] - b[0]);
    // Block times are whole seconds, so neighbouring samples can share one: interpolating between those would bunch many
    // slots into one instant. Samples are thinned to at least THIN_MS apart (and strictly later), so slots between two
    // kept samples are spread evenly, as the chain produces them (about 400 ms each).
    const pts: [number, number][] = [];
    for (const p of all) {
      const last = pts.at(-1);
      if (last === undefined || (p[1] - last[1] >= THIN_MS && p[0] > last[0])) pts.push(p);
    }
    this.#slots = pts.map((p) => p[0]);
    this.#ms = pts.map((p) => p[1]);
    if (this.#slots.length < 2) throw new Error('slot clock needs at least two samples');
  }

  get first(): number {
    return this.#slots[0]!;
  }
  get last(): number {
    return this.#slots.at(-1)!;
  }

  /** The time a slot was produced (ms), interpolated between samples; outside them at 400 ms a slot. */
  timeOf(slot: number): number {
    const s = this.#slots;
    const t = this.#ms;
    if (slot <= s[0]!) return t[0]! - (s[0]! - slot) * 400;
    if (slot >= s.at(-1)!) return t.at(-1)! + (slot - s.at(-1)!) * 400;
    let lo = 0;
    let hi = s.length - 1;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (s[m]! <= slot) lo = m;
      else hi = m;
    }
    const span = s[hi]! - s[lo]!;
    return Math.floor(t[lo]! + ((t[hi]! - t[lo]!) * (slot - s[lo]!)) / span);
  }

  /** The newest slot produced at or before `ms`. */
  slotAt(ms: number): number {
    let lo = this.#slots[0]! - 1_000_000;
    let hi = this.#slots.at(-1)! + 1_000_000;
    while (hi - lo > 1) {
      const m = Math.floor((lo + hi) / 2);
      if (this.timeOf(m) <= ms) lo = m;
      else hi = m;
    }
    return lo;
  }
}

/**
 * Commitment lag: a slot is processed when produced and confirmed about 1.2 s later (two to three slots). Reads at
 * confirmed see slots produced at least this long ago.
 */
export const CONFIRMED_LAG_MS = 1_200;
/** Slots per bucket of the cached as-of pages (about five minutes). */
export const BUCKET_SLOTS = 750;

export class ChainView {
  readonly rpc: PublicRpc;
  readonly clock: SlotClock;
  /** Anchors: signatures with known slots, oldest first, for paging an address's history back from a past slot. */
  readonly #anchors: readonly RawSig[];
  /** The newest slot data may be read at (the end of the replay plus margin): nothing newer is ever asked. */
  readonly #sigCache = new Map<string, RawSig[]>();

  constructor(rpc: PublicRpc, anchors: readonly RawSig[]) {
    this.rpc = rpc;
    this.#anchors = [...anchors].filter((a) => a.blockTime !== null).sort((a, b) => a.slot - b.slot);
    this.clock = new SlotClock(this.#anchors);
  }

  /** The confirmed slot at virtual time `ms`. */
  confirmedSlot(ms: number): number {
    return this.clock.slotAt(ms - CONFIRMED_LAG_MS);
  }

  /** The first anchor strictly after `slot` (pages anchored at it hold every signature at or before `slot`). */
  anchorAfter(slot: number): RawSig | null {
    const a = this.#anchors;
    let lo = 0;
    let hi = a.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (a[m]!.slot <= slot) lo = m + 1;
      else hi = m;
    }
    return a[lo] ?? null;
  }

  /**
   * An address's signatures as `getSignaturesForAddress` would have answered at `asOf`: newest first, only slots at or
   * before `asOf`, strictly older than `before` and newer than `until` when given, at most `limit`.
   */
  async signatures(address: string, asOf: number, o: { readonly before?: string; readonly until?: string; readonly limit: number }): Promise<RawSig[]> {
    const out: RawSig[] = [];
    let cursor: string | undefined;
    if (o.before !== undefined) cursor = o.before;
    else {
      // Pages anchored after asOf are cached; past the index's newest anchor (a read of today) the newest page is used.
      cursor = this.anchorAfter(asOf)?.signature;
    }
    for (;;) {
      const page = await this.rpc.sigPage(address, cursor);
      if (page.length === 0) return out;
      for (const x of page) {
        if (x.slot > asOf) continue;
        if (o.until !== undefined && x.signature === o.until) return out;
        out.push(x);
        if (out.length >= o.limit) return out;
      }
      if (page.length < 1000) return out;
      cursor = page.at(-1)!.signature;
    }
  }

  /**
   * An address's signatures at or before `asOf`, newest first, as a generator over cached pages: the first page is
   * anchored after the end of `asOf`'s 750-slot bucket (so reads at nearby moments share it), later ones by the page's
   * last signature. Slots after `asOf` are dropped.
   */
  async *newestFirst(address: string, asOf: number): AsyncGenerator<RawSig> {
    const bucketEnd = (Math.floor(asOf / BUCKET_SLOTS) + 1) * BUCKET_SLOTS;
    let cursor = this.anchorAfter(bucketEnd)?.signature;
    for (;;) {
      const page = await this.rpc.sigPage(address, cursor);
      if (page.length === 0) return;
      for (const x of page) if (x.slot <= asOf) yield x;
      if (page.length < 1000) return;
      cursor = page.at(-1)!.signature;
    }
  }

  /** Every signature of `address` in slots (fromSlot, toSlot], oldest first, paged back from an anchor after `toSlot`. */
  async signaturesBetween(address: string, fromSlot: number, toSlot: number): Promise<RawSig[]> {
    const key = `${address}:${fromSlot}:${toSlot}`;
    const hit = this.#sigCache.get(key);
    if (hit !== undefined) return hit;
    // Past the index's newest anchor (a range that reaches today) the newest page starts the walk (not cached).
    const out: RawSig[] = [];
    let cursor = this.anchorAfter(toSlot)?.signature;
    for (;;) {
      const page = await this.rpc.sigPage(address, cursor);
      if (page.length === 0) break;
      for (const x of page) if (x.slot > fromSlot && x.slot <= toSlot) out.push(x);
      if (page.at(-1)!.slot <= fromSlot || page.length < 1000) break;
      cursor = page.at(-1)!.signature;
    }
    out.reverse();
    this.#sigCache.set(key, out);
    return out;
  }

  /** A transaction in the RPC shape if it is confirmed by `asOf`, else null (it does not exist yet). */
  async transaction(signature: string, asOf: number): Promise<{ slot: number; [k: string]: unknown } | null> {
    const t = (await this.rpc.tx(signature)) as { slot: number } | null;
    if (t === null || t.slot > asOf) return null;
    return t as { slot: number };
  }
}
