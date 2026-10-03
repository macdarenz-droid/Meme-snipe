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
import { toBase64, transactionEvents } from '../../../core/src/chain/index.ts';
import type { FeedEvent, Moment } from '../../../core/src/engine/index.ts';
import { OFF_CHAIN } from '../../../core/src/engine/index.ts';
import type { BookEvent } from '../../../core/src/lifecycle/index.ts';

export type Source = 'helius' | 'alchemy' | 'pumpportal' | 'helius-parsed' | 'jupiter' | 'rugcheck' | 'worker';

/** Above any real position in a block, below the indices reserved for accounts and off-chain facts. */
export const LIVE_TX_BASE = 2 ** 32;
/** Account states: after every transaction of their slot, before the slot notice and off-chain facts. */
export const ACCOUNT_TX_INDEX = OFF_CHAIN - 1;
/** Instruction positions per outer instruction. The runtime caps a transaction's instruction trace at 64. */
export const IX_STRIDE = 2 ** 16;

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
  /** A full transaction, decoded only by DEC-1's `transactionEvents`. */
  | { readonly type: 'tx'; readonly record: TransactionRecord }
  /** An account state (`accountSubscribe`, or `getAccountInfo` after a reconnect). */
  | { readonly type: 'account'; readonly slot: bigint; readonly address: string; readonly owner: string; readonly lamports: bigint; readonly data: Uint8Array }
  /** Any other fact: a RugCheck report, a Jupiter Tokens row, a feed status change. */
  | { readonly type: 'offchain'; readonly key: string; readonly value: unknown }
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
   * was released, enters the timeline without reaching back into the past.
   */
  readonly place: { readonly at: 'chain' | 'offchain'; readonly slot: bigint };
  /** A later copy of a fact already received (see `dedupKey`). Recorded, never released. */
  readonly duplicate: boolean;
  readonly body: FrameBody;
}

const SIG = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export const isSignature = (s: unknown): s is string => typeof s === 'string' && SIG.test(s);
export const isAddress = (s: unknown): s is string => typeof s === 'string' && ADDRESS.test(s);

/**
 * Two frames with the same key carry the same fact; the first to arrive wins (data.md §8.1C: two providers,
 * first copy wins, deduplicated by slot and signature). Null for facts that are never duplicates.
 */
export const dedupKey = (b: FrameBody): string | null => {
  switch (b.type) {
    case 'slot': return `slot:${b.slot}`;
    case 'seen': return `seen:${b.signature}`;
    case 'tx': return `tx:${b.record.signature}`;
    case 'account': return `acct:${b.address}:${b.slot}:${b.lamports}:${toBase64(b.data)}`;
    default: return null;
  }
};

/** The signature a chain-placed frame belongs to, for its rank in the slot. */
const signatureOf = (b: FrameBody): string | null => (b.type === 'seen' ? b.signature : b.type === 'tx' ? b.record.signature : null);

const pad = (n: number): string => String(n).padStart(5, '0');

/** Chain slot of a frame body, when it has one. */
export const chainSlot = (b: FrameBody): bigint | null => {
  switch (b.type) {
    case 'slot':
    case 'account': return b.slot;
    case 'seen': return b.slot;
    case 'tx': return b.record.slot;
    default: return null;
  }
};

/**
 * Ranks signatures in one slot by first arrival. `ranks` is the slot's running table: the live Feed keeps it
 * across releases so a late frame gets the next rank, and the pure path builds it from all frames at once.
 */
export const rankIn = (ranks: Map<string, number>, frame: Frame): void => {
  if (frame.place.at !== 'chain') return;
  const sig = signatureOf(frame.body);
  if (sig !== null && !ranks.has(sig)) ranks.set(sig, ranks.size);
};

const meta = (f: Frame) => ({ source: f.source, backfilled: f.backfilled, seq: f.seq });

/** The events of one frame. `ranks` must already hold the frame's signature when it is chain-placed. */
export const eventsOfFrame = (f: Frame, ranks: ReadonlyMap<string, number>): FeedEvent[] => {
  const off: Moment = { slot: f.place.slot, txIndex: OFF_CHAIN, ixIndex: OFF_CHAIN, receivedAt: f.receivedAt };
  const chain = f.place.at === 'chain';
  // Off-chain placement can repeat a fact whose dedup key was already forgotten (older than keepSlots), so its
  // ids carry the frame's seq: event ids stay unique for the whole run, as the replay requires.
  const sfx = chain ? '' : `#${f.seq}`;
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
    case 'tx': {
      const r = b.record;
      // Only DEC-1's decoder reads transaction bytes (FEED-1 card: never a second decoder).
      return transactionEvents(r).map((e): FeedEvent => {
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
      return [{ kind: 'market', id: `${b.key}#${f.seq}`, moment: off, key: b.key, value: { value: b.value, ...meta(f) } }];
    case 'world':
      return [{ kind: 'world', id: `world#${f.seq}`, moment: off, event: b.event }];
  }
};

/**
 * The backtest Feed's view of recorded frames: the duplicates the live Feed marked are dropped, signatures are
 * ranked by first arrival, and each frame becomes its events. Feed the result to `createReplay`, which sorts it
 * into the engine's total order. Placement and duplicates are read from the frames, as the live Feed recorded
 * them, so nothing here depends on when the frames arrived relative to the release point.
 */
export const frameEvents = (frames: readonly Frame[]): FeedEvent[] => {
  const kept = frames.filter((f) => !f.duplicate).sort((a, b) => a.seq - b.seq);
  const ranks = new Map<bigint, Map<string, number>>();
  for (const f of kept) {
    let r = ranks.get(f.place.slot);
    if (r === undefined) ranks.set(f.place.slot, (r = new Map()));
    rankIn(r, f);
  }
  return kept.flatMap((f) => eventsOfFrame(f, ranks.get(f.place.slot)!));
};
