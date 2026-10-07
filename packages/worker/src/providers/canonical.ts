// Frames and their one mapping to engine events. A frame is one raw live input as received (the recorder stores
// frames); `frameEvents` turns frames into the engine's FeedEvents. The live Feed and the backtest Feed over
// recorded frames both call it, so the same frames always give the same events in the same order
// (docs/ARCHITECTURE.md §16.1, the parity test).
//
// Order within a slot (Moment = slot, txIndex, ixIndex, receivedAt, then id):
// - Transactions: live sources never give a transaction's position in its block, so a signature's txIndex is
//   LIVE_TX_BASE + its rank in the slot by first arrival (frame `seq`). A later arrival never changes an earlier
//   rank, so a late frame cannot reorder what was already released. ixIndex 0 is the sighting; each decoded event
//   is 1 + outerIx * IX_STRIDE + innerIx, so events stay in execution order and a transaction stays contiguous.
// - Account states sort after every transaction of their slot (ACCOUNT_TX_INDEX), then by arrival.
// - The slot notice, then off-chain facts (third-party reads, lookups made late, world reports), come last.
import type { TransactionRecord } from '../../../core/src/chain/index.ts';
import { isNoChangePoolEvent, logEvents, toBase64, transactionEvents } from '../../../core/src/chain/index.ts';
import type { FeedEvent, Moment } from '../../../core/src/engine/index.ts';
import { OFF_CHAIN } from '../../../core/src/engine/index.ts';
import type { BookEvent } from '../../../core/src/lifecycle/index.ts';

export type Source = 'helius' | 'alchemy' | 'pumpportal' | 'helius-parsed' | 'jupiter' | 'rugcheck' | 'goplus' | 'coinbase' | 'github' | 'worker';

/** Above any real position in a block, below the indices reserved for accounts and off-chain facts. */
export const LIVE_TX_BASE = 2 ** 32;
/** Account states: after every transaction of their slot, before the slot notice and off-chain facts. */
export const ACCOUNT_TX_INDEX = OFF_CHAIN - 1;
/** Instruction positions per outer instruction. The runtime caps a transaction's instruction trace at 64. */
export const IX_STRIDE = 2 ** 16;

/** Events read from log lines sort after a transaction's instruction events: log position, not instruction position. */
export const LOG_IX_BASE = 2 ** 36;

export const eventIxIndex = (outerIx: number, innerIx: number): number => {
  if (!Number.isSafeInteger(outerIx) || outerIx < 0 || !Number.isSafeInteger(innerIx) || innerIx < 0 || innerIx >= IX_STRIDE) {
    throw new RangeError(`instruction position ${outerIx}.${innerIx} is out of range`);
  }
  return 1 + outerIx * IX_STRIDE + innerIx;
};

export type FrameBody =
  /** A slot notice (`slotSubscribe`). */
  | { readonly type: 'slot'; readonly slot: bigint; readonly parent: bigint | null; readonly root: bigint | null }
  /**
   * A signature seen without its transaction: a `logsSubscribe` notification, a Parsed Streams notification or a
   * PumpPortal message. `slot` is null when the source does not give one (PumpPortal). `via` names the
   * subscription (e.g. the mentioned address) and `detail` keeps the source's own fields, never decoded further.
   */
  | { readonly type: 'seen'; readonly signature: string; readonly slot: bigint | null; readonly err: unknown; readonly via: string; readonly detail: unknown }
  /**
   * The log lines of a `logsSubscribe` notification, kept for watches that read events from them (the creates
   * stream: creator, mint and slot at no RPC cost). Read only by DEC-1's `logEvents`.
   */
  | { readonly type: 'logs'; readonly signature: string; readonly slot: bigint; readonly err: unknown; readonly via: string; readonly logs: readonly string[]; readonly commitment?: 'confirmed' }
  /** A full transaction, decoded only by DEC-1's `transactionEvents`. */
  | { readonly type: 'tx'; readonly record: TransactionRecord }
  /** An account state (`accountSubscribe`, or `getAccountInfo` after a reconnect). */
  | { readonly type: 'account'; readonly slot: bigint; readonly address: string; readonly owner: string; readonly lamports: bigint; readonly data: Uint8Array }
  /** Any other fact: a RugCheck report, a Jupiter Tokens row, a feed status change. */
  | { readonly type: 'offchain'; readonly key: string; readonly value: unknown }
  /**
   * A fact that carries its own provenance (a GATE-1 fact with its `obs`, the worker's account snapshot): released
   * unwrapped, so its reader parses the value itself. Placed like an off-chain fact.
   */
  | { readonly type: 'fact'; readonly key: string; readonly value: unknown }
  /** A report that drives the lifecycle (send result, status read), placed like an off-chain fact. */
  | { readonly type: 'world'; readonly event: BookEvent };

export interface Frame {
  /** Arrival order in this process. Unique; the recorder keeps it. */
  readonly seq: number;
  /** Receipt time, integer ms, never decreasing with `seq`. */
  readonly receivedAt: number;
  readonly source: Source;
  /** Fetched after a gap to fill missed slots. */
  readonly backfilled: boolean;
  /**
   * Where the frame sits on the timeline, fixed by the live Feed at receipt and recorded:
   * `chain` places it at its own slot and in-slot position; `offchain` places it after everything else in
   * `slot` (the open slot at receipt), which is how a fact with no slot, or a lookup answered after its own slot
   * was released, enters the timeline without reaching back into the past. `arrival` (FILL-ORDER, set by the live
   * Feed on every off-chain placement since) keeps the slot's off-chain frames in arrival order (`seq`) after its
   * notice: a fill's transactions, ingested oldest first at one receipt time, would otherwise take id (signature)
   * order. Recordings made before it carry no `arrival` and replay as they did.
   */
  /** `first`: an off-chain body placed first in a chain slot (BEHIND: a shed range's gap, before any event of the range). */
  readonly place: { readonly at: 'chain' | 'offchain'; readonly slot: bigint; readonly arrival?: true; readonly first?: true };
  /** A later copy of a fact already received (see `dedupKey`). Recorded, never released. */
  readonly duplicate: boolean;
  /**
   * DEDUP-PER-WATCH: a `logs` copy of a transaction already taken from another watch (`echoKey`). Its events were
   * released with the first copy; this one releases only what belongs to its own watch: the hole a cut or undecodable
   * log makes in that watch's streams, and a mark that the transaction held a PumpSwap event DEC-1 cannot name
   * (`echoEvents`). Recordings made before it carry none: those copies were duplicates and replay as they did.
   */
  readonly echo?: true;
  /**
   * DEDUP-PER-WATCH (review N1): an echo standing in for a whole copy `shed` dropped, too late to be released whole (its
   * slot already released): its watch gets a hole (`logs:truncated:<via>`), as if the log were cut.
   */
  readonly lost?: true;
  /**
   * LATE-LOG: a chain fact that arrived after its slot was released, placed off-chain at the open slot instead (never
   * released out of order). Recordings made before it carry none: those frames were released late and refused.
   */
  readonly late?: true;
  readonly body: FrameBody;
}

const SIG = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const isSignature = (s: unknown): s is string => typeof s === 'string' && SIG.test(s);
export const isAddress = (s: unknown): s is string => typeof s === 'string' && ADDRESS.test(s);

/**
 * OOM-MINT: a signature's dedupe key, its kind and the first 22 characters of the signature (about 128 bits), copied into
 * a fresh flat string. The feed keeps every key for 1,500 slots: built as text around the whole signature, each one kept
 * the 88-character signature alive (about 44 MB at 12,000 swaps a minute); this is about a quarter of that.
 */
const signatureKey = (kind: string, signature: string, suffix = ''): string => {
  const text = `${kind}:${signature.slice(0, 22)}${suffix}`;
  const codes = new Array<number>(text.length);
  for (let i = 0; i < text.length; i++) codes[i] = text.charCodeAt(i);
  return String.fromCharCode(...codes);
};

/**
 * Two frames with the same key carry the same fact; the first to arrive wins (data.md §8.1C: two providers,
 * first copy wins, deduplicated by slot and signature). Null for facts that are never duplicates.
 */
export const dedupKey = (b: FrameBody): string | null => {
  switch (b.type) {
    case 'slot': return `slot:${b.slot}`;
    case 'seen': return signatureKey('seen', b.signature);
    // A confirmed watch's copy is a different fact from a processed one: the stronger commitment is kept apart.
    case 'logs': return signatureKey('logs', b.signature, b.commitment === undefined ? '' : `:${b.commitment}`);
    case 'tx': return signatureKey('tx', b.record.signature);
    case 'account': return `acct:${b.address}:${b.slot}:${b.lamports}:${toBase64(b.data)}`;
    default: return null;
  }
};

/**
 * DEDUP-PER-WATCH: a `logs` copy's key on its own watch. A copy whose `dedupKey` was taken from another watch is an
 * echo (released as `echoEvents`); one whose key here was taken too is a duplicate (a second provider on the same watch).
 */
export const echoKey = (b: Extract<FrameBody, { type: 'logs' }>): string => signatureKey('logs', b.signature, `${b.commitment === undefined ? '' : `:${b.commitment}`}@${b.via}`);

/** The signature a chain-placed frame belongs to, for its rank in the slot. */
const signatureOf = (b: FrameBody): string | null => (b.type === 'seen' || b.type === 'logs' ? b.signature : b.type === 'tx' ? b.record.signature : null);

const pad = (n: number): string => String(n).padStart(5, '0');
/** A frame's seq in an event id: 12 digits, so string order is arrival order (seq stays below 10^12 in any run). */
export const seqId = (seq: number): string => String(seq).padStart(12, '0');

/** Chain slot of a frame body, when it has one. */
export const chainSlot = (b: FrameBody): bigint | null => {
  switch (b.type) {
    case 'slot':
    case 'account':
    case 'logs': return b.slot;
    case 'seen': return b.slot;
    case 'tx': return b.record.slot;
    default: return null;
  }
};

/**
 * Ranks signatures in one slot by first arrival. `ranks` is the slot's running table: the live Feed keeps it
 * across releases so a late frame gets the next rank, and the pure path builds it from all frames at once.
 */
/** A slot's transaction ranks by signature: a Map, or `SigRanks`. */
export interface Ranks {
  readonly size: number;
  has(signature: string): boolean;
  get(signature: string): number | undefined;
  set(signature: string, rank: number): unknown;
}

/**
 * SEEN-TAGS: a slot's ranks keyed by each signature's first 22 characters (about 128 bits, the dedupe keys' argument)
 * as a fresh flat string. The live feed keeps every slot's ranks for 1,500 slots; keyed by the whole signature, each
 * rank kept its 88-character signature alive (about 28 MB of the 3× run's heap at 1 h).
 */
export class SigRanks implements Ranks {
  readonly #m = new Map<string, number>();
  get size(): number {
    return this.#m.size;
  }
  has(signature: string): boolean {
    return this.#m.has(signatureKey('r', signature));
  }
  get(signature: string): number | undefined {
    return this.#m.get(signatureKey('r', signature));
  }
  set(signature: string, rank: number): this {
    this.#m.set(signatureKey('r', signature), rank);
    return this;
  }
}

export const rankIn = (ranks: Ranks, frame: Frame): void => {
  if (frame.place.at !== 'chain') return;
  const sig = signatureOf(frame.body);
  if (sig !== null && !ranks.has(sig)) ranks.set(sig, ranks.size);
};

const meta = (f: Frame) => ({ source: f.source, backfilled: f.backfilled, seq: f.seq });

/** The events of one frame. `ranks` must already hold the frame's signature when it is chain-placed. */
export const eventsOfFrame = (f: Frame, ranks: Pick<Ranks, 'get'>): FeedEvent[] => {
  // FILL-ORDER: same-moment events are released in id order, and ids start with the signature; an `arrival` frame
  // therefore takes its arrival order in `ixIndex` (1 + seq, after the slot notice's 0). Receipt times never decrease
  // with seq, so this only settles ties that id order settled before.
  const off: Moment = f.place.first === true
    // BEHIND: at the slot's first position, so a shed range's gap precedes every shed event (a log event sits at
    // LIVE_TX_BASE + its rank and LOG_IX_BASE + its line); only a kept transaction at index 0 can sort with it, and
    // nothing shed comes before that.
    ? { slot: f.place.slot, txIndex: 0, ixIndex: 0, receivedAt: f.receivedAt }
    : { slot: f.place.slot, txIndex: OFF_CHAIN, ixIndex: f.place.arrival === true ? 1 + f.seq : OFF_CHAIN, receivedAt: f.receivedAt };
  const chain = f.place.at === 'chain';
  // Off-chain placement can repeat a fact whose dedup key was already forgotten (older than keepSlots), so its
  // ids carry the frame's seq: event ids stay unique for the whole run, as the replay requires.
  // The seq is zero-padded so ids of one key sort in arrival order: events at the same moment are ordered by id.
  const sfx = chain ? '' : `#${seqId(f.seq)}`;
  const b = f.body;
  const txIndexOf = (sig: string): number => {
    const r = ranks.get(sig);
    if (r === undefined) throw new RangeError(`signature ${sig} has no rank in slot ${f.place.slot}`);
    return LIVE_TX_BASE + r;
  };
  switch (b.type) {
    case 'slot':
      return [{
        kind: 'market', id: `slot:${b.slot}${sfx}`, moment: chain ? { slot: b.slot, txIndex: OFF_CHAIN, ixIndex: 0, receivedAt: f.receivedAt } : off,
        key: 'chain:slot', value: { slot: b.slot, parent: b.parent, root: b.root, ...meta(f) },
      }];
    case 'seen':
      return [{
        kind: 'market', id: `seen:${b.signature}${sfx}`,
        moment: chain ? { slot: f.place.slot, txIndex: txIndexOf(b.signature), ixIndex: 0, receivedAt: f.receivedAt } : off,
        key: `seen:${b.via}`, value: { signature: b.signature, slot: b.slot, err: b.err, via: b.via, detail: b.detail, ...meta(f) },
      }];
    case 'logs': {
      // A confirmed watch's copy of a transaction already seen at processed is its own event: ids keep them apart.
      const cs = b.commitment === undefined ? '' : `:${b.commitment}`;
      if (f.echo === true) return echoEvents(f, b, cs, sfx, txIndexOf, off);
      // DEC-1's log reader: a failed transaction yields none; a cut log is reported, never guessed past.
      let read: ReturnType<typeof logEvents>;
      try {
        read = logEvents(b.logs, b.err);
      } catch (e) {
        return [{ kind: 'market', id: `log:${b.signature}${cs}:undecodable${sfx}`, moment: chain ? { slot: f.place.slot, txIndex: txIndexOf(b.signature), ixIndex: LOG_IX_BASE, receivedAt: f.receivedAt } : off, key: `logs:undecodable:${b.via}`, value: { signature: b.signature, txSlot: b.slot, error: e instanceof Error ? e.message : 'undecodable', ...meta(f) } }];
      }
      const events: FeedEvent[] = read.events.map((e): FeedEvent => {
        const subject = e.name === 'other' ? e.program : ('mint' in e.data ? e.data.mint : 'pool' in e.data ? e.data.pool : e.program);
        return {
          kind: 'market', id: `log:${b.signature}${cs}:${pad(e.logIndex)}${sfx}`,
          moment: chain ? { slot: f.place.slot, txIndex: txIndexOf(b.signature), ixIndex: LOG_IX_BASE + e.logIndex, receivedAt: f.receivedAt } : off,
          key: `logs:${e.program}:${e.name}:${subject}`,
          value: { event: e, signature: b.signature, txSlot: b.slot, truncated: read.truncated, via: b.via, ...(b.commitment === undefined ? {} : { commitment: b.commitment }), ...meta(f) },
        };
      });
      if (read.truncated && events.length === 0) {
        events.push({ kind: 'market', id: `log:${b.signature}${cs}:truncated${sfx}`, moment: chain ? { slot: f.place.slot, txIndex: txIndexOf(b.signature), ixIndex: LOG_IX_BASE, receivedAt: f.receivedAt } : off, key: `logs:truncated:${b.via}`, value: { signature: b.signature, txSlot: b.slot, ...meta(f) } });
      }
      return events;
    }
    case 'tx': {
      const r = b.record;
      // Only DEC-1's decoder reads transaction bytes (FEED-1 card: never a second decoder). A transaction it cannot
      // decode is a fact gap, never a crash: one `tx:undecodable` event, and no `ev:` event, so a cut log it was
      // fetched for stays a hole (the deployer index clears a hole only on an `ev:` event).
      let decoded: ReturnType<typeof transactionEvents>;
      try {
        decoded = transactionEvents(r);
      } catch (e) {
        return [{
          kind: 'market', id: `txerr:${r.signature}${sfx}`,
          moment: chain ? { slot: f.place.slot, txIndex: txIndexOf(r.signature), ixIndex: 0, receivedAt: f.receivedAt } : off,
          key: 'tx:undecodable', value: { signature: r.signature, txSlot: r.slot, error: e instanceof Error ? e.message : 'undecodable', ...meta(f) },
        }];
      }
      return decoded.map((e): FeedEvent => {
        const subject = e.name === 'other' ? e.program : ('mint' in e.data ? e.data.mint : 'pool' in e.data ? e.data.pool : e.program);
        return {
          kind: 'market', id: `ev:${r.signature}:${pad(e.outerIx)}:${pad(e.innerIx)}${sfx}`,
          moment: chain ? { slot: f.place.slot, txIndex: txIndexOf(r.signature), ixIndex: eventIxIndex(e.outerIx, e.innerIx), receivedAt: f.receivedAt } : off,
          key: `${e.program}:${e.name}:${subject}`,
          value: { event: e, txSlot: r.slot, blockTime: r.blockTime, ...meta(f) },
        };
      });
    }
    case 'account':
      return [{
        kind: 'market', id: `acct:${b.address}:${b.slot}:${f.seq}`,
        moment: chain ? { slot: f.place.slot, txIndex: ACCOUNT_TX_INDEX, ixIndex: 0, receivedAt: f.receivedAt } : off,
        // Bytes as base64: event values are deep-frozen, and a typed array with elements cannot be frozen.
        key: `account:${b.address}`, value: { address: b.address, slot: b.slot, owner: b.owner, lamports: b.lamports, data: toBase64(b.data), ...meta(f) },
      }];
    case 'offchain':
      return [{ kind: 'market', id: `${b.key}${sfx}`, moment: off, key: b.key, value: { value: b.value, ...meta(f) } }];
    case 'fact':
      return [{ kind: 'market', id: `${b.key}${sfx}`, moment: off, key: b.key, value: b.value }];
    case 'world':
      return [{ kind: 'world', id: `world${sfx}`, moment: off, event: b.event }];
  }
};

/**
 * A PumpSwap event DEC-1 cannot name (a deposit, a withdrawal, an admin instruction): it may move the reserves without a
 * swap event (WATCH-1c's `#chainOther`) and names no pool, so only the watches that saw its transaction can say which
 * pools it may have touched. A named one carries its own `pool`, which the first copy's event already gives.
 */
// POOL-FIRST-READ part 2: an event proven to leave the reserves unchanged is not echoed (only its exact discriminators).
const unnamedPoolEvent = (e: { readonly program: string; readonly name: string }): boolean => e.program === 'pump_amm' && e.name === 'other' && !isNoChangePoolEvent(e);

/**
 * DEDUP-PER-WATCH: an echo's events, on its own watch only (ids carry the watch, so each watch's copy stays apart):
 * `logs:undecodable:<via>` when DEC-1 cannot read the log, `logs:truncated:<via>` when the log was cut (whether or not
 * events came before the cut: the first copy's events carry `truncated` for the first watch only), and
 * `logs:pool-other:<via>` when the log holds a PumpSwap event DEC-1 cannot name. Nothing the first copy released is
 * released again, so no swap, create or trade is counted twice.
 */
const echoEvents = (
  f: Frame, b: Extract<FrameBody, { type: 'logs' }>, cs: string, sfx: string, txIndexOf: (sig: string) => number, off: Moment,
): FeedEvent[] => {
  const chain = f.place.at === 'chain';
  const at = (ix: number): Moment => (chain ? { slot: f.place.slot, txIndex: txIndexOf(b.signature), ixIndex: ix, receivedAt: f.receivedAt } : off);
  const id = (what: string): string => `log:${b.signature}${cs}@${b.via}:${what}${sfx}`;
  let read: ReturnType<typeof logEvents>;
  try {
    read = logEvents(b.logs, b.err);
  } catch (e) {
    return [{ kind: 'market', id: id('undecodable'), moment: at(LOG_IX_BASE), key: `logs:undecodable:${b.via}`, value: { signature: b.signature, txSlot: b.slot, error: e instanceof Error ? e.message : 'undecodable', ...meta(f) } }];
  }
  const out: FeedEvent[] = [];
  const other = read.events.find(unnamedPoolEvent);
  if (other !== undefined) {
    out.push({
      kind: 'market', id: id('pool-other'), moment: at(LOG_IX_BASE + other.logIndex), key: `logs:pool-other:${b.via}`,
      value: { signature: b.signature, name: other.name, txSlot: b.slot, via: b.via, ...(b.commitment === undefined ? {} : { commitment: b.commitment }), ...meta(f) },
    });
  }
  // `txSlot`: the transaction's own slot, which a late echo's off-chain placement does not show. A `lost` echo's watch
  // missed the transaction's events (its whole copy was shed): a hole too.
  if (read.truncated || f.lost === true) out.push({ kind: 'market', id: id('truncated'), moment: at(LOG_IX_BASE), key: `logs:truncated:${b.via}`, value: { signature: b.signature, txSlot: b.slot, ...meta(f) } });
  return out;
};

/** True when DEC-1's decoder reads the transaction: a fetched transaction it cannot decode is not a read one. */
export const decodable = (r: TransactionRecord): boolean => {
  try {
    transactionEvents(r);
    return true;
  } catch {
    return false;
  }
};

/**
 * Frames as events, re-sorted: the duplicates the live Feed marked are dropped, signatures are ranked by first
 * arrival, and each frame becomes its events. Feed the result to `createReplay`, which sorts it into the engine's
 * total order. Only for data with no release record (e.g. a historical dataset): a re-sort accepts late facts the
 * live engine refused, so recorded live data is replayed with `replayRecorded` and its release sequence. Placement and duplicates are read from the frames, as the live Feed recorded
 * them, so nothing here depends on when the frames arrived relative to the release point.
 */
export const frameEvents = (frames: readonly Frame[]): FeedEvent[] => {
  // DEDUP-PER-WATCH: an echo only exists in recorded live data, which has its release record: replayed with
  // `replayRecorded`, never re-sorted here (a whole copy that `shed` dropped would be released here as well as its stand-in).
  if (frames.some((f) => f.echo === true)) throw new RangeError('recorded live frames (with echoes) replay with replayRecorded and their release record');
  const kept = frames.filter((f) => !f.duplicate).sort((a, b) => a.seq - b.seq);
  const ranks = new Map<bigint, Map<string, number>>();
  for (const f of kept) {
    let r = ranks.get(f.place.slot);
    if (r === undefined) ranks.set(f.place.slot, (r = new Map()));
    rankIn(r, f);
  }
  return kept.flatMap((f) => eventsOfFrame(f, ranks.get(f.place.slot)!));
};
