// A moment is a point on the engine's one timeline. Events are ordered by
// (slot, transaction index, instruction index, receipt time), then by event id as the final tie-break,
// so the same data always replays in the same order (docs/ARCHITECTURE.md §16.1).

export interface Moment {
  readonly slot: bigint;
  /** Position of the transaction in its slot. `OFF_CHAIN` for facts that are not a transaction (status reads, ticks). */
  readonly txIndex: number;
  /** Position of the instruction in its transaction. `OFF_CHAIN` for facts that are not an instruction. */
  readonly ixIndex: number;
  /** When this process received the fact (ms since epoch, integer). Data, never read from a wall clock by the engine. */
  readonly receivedAt: number;
}

/** Index used by off-chain facts so they sort after every transaction in their slot. */
export const OFF_CHAIN = Number.MAX_SAFE_INTEGER;

const isIndex = (n: number): boolean => Number.isSafeInteger(n) && n >= 0;

/** Throws on a malformed moment. Every moment entering the engine passes through here. */
export const checkMoment = (m: Moment): Moment => {
  if (typeof m.slot !== 'bigint' || m.slot < 0n) throw new RangeError(`slot must be a bigint >= 0, got ${String(m.slot)}`);
  if (!isIndex(m.txIndex)) throw new RangeError(`txIndex must be an integer >= 0, got ${m.txIndex}`);
  if (!isIndex(m.ixIndex)) throw new RangeError(`ixIndex must be an integer >= 0, got ${m.ixIndex}`);
  if (!Number.isSafeInteger(m.receivedAt)) throw new RangeError(`receivedAt must be an integer, got ${m.receivedAt}`);
  return m;
};

const sign = (a: bigint | number, b: bigint | number): number => (a < b ? -1 : a > b ? 1 : 0);

export const compareMoments = (a: Moment, b: Moment): number =>
  sign(a.slot, b.slot) || sign(a.txIndex, b.txIndex) || sign(a.ixIndex, b.ixIndex) || sign(a.receivedAt, b.receivedAt);

/** Code-unit order, never locale order, so the tie-break is the same on every machine. */
const compareIds = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The total event order: moment first, then id. Two events with the same moment and id are the same event. */
export const compareEvents = (a: { readonly moment: Moment; readonly id: string }, b: { readonly moment: Moment; readonly id: string }): number =>
  compareMoments(a.moment, b.moment) || compareIds(a.id, b.id);

export const isAfter = (a: Moment, b: Moment): boolean => compareMoments(a, b) > 0;
