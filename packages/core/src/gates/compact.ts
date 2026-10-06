// CREATE-COMPACT: what the live store keeps of a create event and of a curve trade event (`Shape`). A create that never
// migrates stays in the store for the create keep (13 hours), and its create and its first curve trade were kept as
// released: about 4.3 KB a create (measured, 1.28 KB the create and 3.05 KB the trade), about 250 MB at three times
// the live rate. Their store readers read only these fields:
// - a curve trade: `checkCurveTails` and its collapse (`tailVerdict`): the event's `trailing` and `extra`, `txSlot` and
//   `signature` (the entry's source otherwise);
// - a create: the hard gates' create alias (`aliasCreate`, `createOf`): the event's `name` and `data.mint`, `creator`
//   and `timestamp`, and `txSlot`, `source` and `backfilled`; the strategy's deployer (`#deployerOf`): `data.creator`,
//   `user` and `tokenTotalSupply`.
// A value of any other shape is kept as released.
import { flatCopy } from '../engine/asof.ts';

type Obj = Readonly<Record<string, unknown>>;
/** A string field as a flat copy (a decoded field can be a slice of the whole event's text); anything else as it is. */
const own = (v: unknown): unknown => (typeof v === 'string' ? flatCopy(v) : v);
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

// Built as object literals of a fixed shape (a field the released value lacks stays undefined, which every reader above
// treats as absent): an object filled field by field measured larger.

/** A curve trade event as its store readers read it (`checkCurveTails`). */
export const compactCurveTrade = (v: unknown): unknown => {
  if (!isObj(v) || !isObj(v['event'])) return v;
  const ev = v['event'];
  return Object.freeze({ txSlot: v['txSlot'], signature: own(v['signature']), event: Object.freeze({ trailing: ev['trailing'], extra: own(ev['extra']) }) });
};

/** A create event as its store readers read it (the hard gates' create alias, the strategy's deployer). */
export const compactCreate = (v: unknown): unknown => {
  if (!isObj(v) || !isObj(v['event']) || !isObj(v['event']['data'])) return v;
  const ev = v['event'];
  const d = ev['data'] as Obj;
  // The creator usually signs its own create: one string for both then.
  const creator = own(d['creator']);
  const user = d['user'] === d['creator'] ? creator : own(d['user']);
  return Object.freeze({
    txSlot: v['txSlot'], source: v['source'], backfilled: v['backfilled'],
    event: Object.freeze({ name: ev['name'], data: Object.freeze({ mint: own(d['mint']), creator, user, timestamp: d['timestamp'], tokenTotalSupply: d['tokenTotalSupply'] }) }),
  });
};
