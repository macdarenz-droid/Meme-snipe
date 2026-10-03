// The ledger replay check (docs/ARCHITECTURE.md §15 item 2, `pnpm ledger:replay`). Reads a ledger file
// read-only and replays every stored book event through the CORE-1 reducer. The stored intent and position
// rows, attempts, fills and reservations must be exactly what the reducer produces; the first illegal event
// or difference fails the check with the row, the intent key, and the expected and stored values.
//
// How book events are stored (no table or column of its own; docs/DECISIONS.md, LEDGER-REPLAY):
// - `intent_event.seq` is the one global order. Each stored book event writes one intent row per intent it
//   persists, in effect order. The first row carries `detail = {"v":1,"book":<BookEvent>}`, checked strictly by
//   ./schema.ts on write and read, except a `created` row (from `recordIntent`), which stands for `propose_entry` (entry) or `trigger_exit` (exit). Further rows of
//   the same event have `detail = null`. An event that persists no intent but changes the book or a position
//   (a landing reported for an ended intent, `orphan_cleared`, a trigger merged into a running exit) writes
//   one row, with the status unchanged, for the intent it concerns (`stepRows`).
// - Each position the event persists gets one `position_event` row with its new state; a new position first
//   gets its `created` row from `openPosition`. A `trigger_exit` row carries the same versioned detail, so
//   an exit intent's `created` row can be replayed with its reasons. Every other position row has no detail.
// - Not stored, so not checked here: pause and resume, a restart that changes no intent, and ticks. Leaving
//   them out can only make the replay more permissive (they only refuse entries); it never changes a state.

import { canonical } from '../../engine/log.ts';
import {
  applyBookEvent, emptyBook, isIllegal, isTerminal, type Book, type BookEvent, type Effect, type IntentState, type PositionState,
} from '../../lifecycle/index.ts';
import { openLedgerReader, type IntentRecord, type LedgerPurpose, type LedgerReader, type StoredPositionEvent } from '../ledger.ts';
import { LedgerError } from '../errors.ts';
import { decodeBookDetail, encodeBookDetail } from './schema.ts';

export { BOOK_DETAIL_VERSION, decodeBookDetail, encodeBookDetail } from './schema.ts';

export type ReplaySource = Pick<LedgerReader,
  'purpose' | 'decisionModes' | 'allIntents' | 'intentEvents' | 'allPositions' | 'positionEvents' | 'allReservations' |
  'allAttempts' | 'allFills' | 'pendingOutbox' | 'foreignKeyViolations' | 'rowTotals'>;

export interface ReplayOptions {
  /**
   * The book's open-position limit. It only refuses entries, so the default (no limit) can never fail a
   * stored sequence the engine accepted; pass the session's limit to check it too.
   */
  readonly maxOpenPositions?: number;
  /**
   * Move ended intents and closed positions out of the replayed book, and bring one back when an event names it
   * (default true). The reducer copies its maps on every step, so without this a replay slows with the square of
   * the ledger's size. The reducer reads ended intents and closed positions only by id, so states are unchanged.
   */
  readonly compact?: boolean;
}

export type ReplayTable = 'ledger_meta' | 'decision' | 'intent' | 'intent_event' | 'position' | 'position_event' | 'attempt' | 'fill' | 'reservation' | 'reservation_event';

export interface ReplayFailure {
  /** `illegal`: the reducer refused the event. `divergence`: stored and replayed differ. `stamp`: purpose stamps. `schema`: a stored event off the schema. */
  readonly kind: 'illegal' | 'divergence' | 'stamp' | 'schema';
  readonly table: ReplayTable;
  /** The first differing row (its `seq` in an event table), or null for a whole-table check. */
  readonly seq: bigint | null;
  readonly intentId: string | null;
  readonly intentKey: string | null;
  readonly positionId: string | null;
  /** The event being replayed (its type, or the intent event's type). */
  readonly event: string | null;
  readonly reason: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

export interface ReplayCounts {
  readonly events: number;
  readonly intentRows: number;
  readonly positionRows: number;
  readonly intents: number;
  readonly positions: number;
}

export type ReplayReport =
  | { readonly ok: true; readonly purpose: LedgerPurpose; readonly counts: ReplayCounts }
  | { readonly ok: false; readonly purpose: string | null; readonly counts: ReplayCounts; readonly failure: ReplayFailure };

/** Decision modes a ledger of each purpose may hold. Shadow decisions run beside paper and live trading (quant.md §8). */
export const MODES_BY_PURPOSE: Readonly<Record<LedgerPurpose, readonly string[]>> = {
  live: ['live', 'shadow'],
  paper: ['paper', 'shadow'],
  backtest: ['replay'],
};

const PURPOSES: readonly string[] = ['live', 'paper', 'backtest'];

export interface StepRows {
  /** Intents to write one `intent_event` row each, in this order. */
  readonly intents: readonly string[];
  /** Positions to write (a new one: its `created` row, then its state if that differs), in this order. */
  readonly positions: readonly string[];
}

const persisted = (effects: readonly Effect[], entity: 'intent' | 'position'): string[] =>
  [...new Set(effects.flatMap((fx) => (fx.type === 'persist' && fx.entity === entity ? [fx.id] : [])))];

/** The intent a book event concerns when it persists none itself. */
const relatedIntent = (before: Book, e: BookEvent): string | null => {
  switch (e.type) {
    case 'intent': return e.intentId;
    case 'orphan_fill': return e.fill.intentId;
    case 'orphan_cleared': return before.orphans[e.signature]?.intentId ?? null;
    case 'trigger_exit':
    case 'exit_blocked': return before.positions[e.positionId]?.exitOwner?.intentId ?? null;
    default: return null;
  }
};

/**
 * The rows an applied book event writes, from the reducer's own `persist` effects; null when it writes none.
 * Shared by the replay and by every ledger writer, so the two can never disagree.
 */
export const stepRows = (before: Book, e: BookEvent, effects: readonly Effect[]): StepRows | null => {
  const intents = persisted(effects, 'intent');
  const positions = persisted(effects, 'position');
  if (intents.length > 0) return { intents, positions };
  const book = effects.some((fx) => fx.type === 'persist' && fx.entity === 'book');
  if (positions.length === 0 && !book) return null;
  const related = relatedIntent(before, e);
  if (related === null) {
    if (positions.length > 0) throw new LedgerError(`${e.type} changed a position but concerns no intent`);
    return null; // pause, resume, or a restart that changed no intent
  }
  return { intents: [related], positions };
};

/** The `event` column for a row written by this book event. */
export const rowEventName = (e: BookEvent): string => (e.type === 'intent' ? e.event.type : e.type);

/** The book event in a stored detail, or the schema's reason for refusing it. */
const bookOf = (detail: unknown): BookEvent | { readonly refused: string } => {
  try {
    return decodeBookDetail(detail);
  } catch (err) {
    if (err instanceof LedgerError) return { refused: err.message };
    throw err;
  }
};
const refused = (x: BookEvent | { readonly refused: string }): x is { readonly refused: string } => 'refused' in x;

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

class Failed extends Error {
  readonly failure: ReplayFailure;
  constructor(failure: ReplayFailure) {
    super(failure.reason);
    this.failure = failure;
  }
}

/** Replays a ledger already open for reading. Never writes; the caller owns the connection. */
export const replayLedger = (src: ReplaySource, options: ReplayOptions = {}): ReplayReport => {
  const counts = { events: 0, intentRows: 0, positionRows: 0, intents: 0, positions: 0 };
  const purpose = src.purpose() as string | undefined;
  try {
    return { ok: true, purpose: replay(src, options, counts, purpose), counts };
  } catch (err) {
    if (err instanceof Failed) return { ok: false, purpose: purpose ?? null, counts, failure: err.failure };
    throw err;
  }
};

/** Opens the file read-only, replays it and closes it. */
export const replayLedgerFile = (path: string, options: ReplayOptions = {}): ReplayReport => {
  const reader = openLedgerReader(path);
  try {
    return replayLedger(reader, options);
  } finally {
    reader.close();
  }
};

/** How many events between compactions of the replayed book. */
const COMPACT_EVERY = 64;

/** Ended intents and closed positions moved out of the replayed book (see ReplayOptions.compact). */
class Archive {
  readonly intents = new Map<string, IntentState>();
  readonly positions = new Map<string, PositionState>();
  /** Idempotency key of every archived intent, so a reused key is still refused. */
  readonly keys = new Map<string, string>();

  /** Moves every ended intent and closed position out of the book. Keeps the order of what stays. */
  compact(book: Book): Book {
    const intents: Record<string, IntentState> = {};
    for (const [id, s] of Object.entries(book.intents)) {
      if (isTerminal(s)) {
        this.intents.set(id, s);
        this.keys.set(s.intent.key, id);
      } else intents[id] = s;
    }
    const positions: Record<string, PositionState> = {};
    for (const [id, p] of Object.entries(book.positions)) {
      if (p.status === 'closed') this.positions.set(id, p);
      else positions[id] = p;
    }
    return { ...book, intents, positions };
  }

  /** Brings back every archived intent and position this event can read, before the reducer sees it. */
  restore(book: Book, e: BookEvent): Book {
    const intentOf = (id: string | undefined): IntentState | undefined =>
      id === undefined ? undefined : (book.intents[id] ?? this.intents.get(id));
    const ids: (string | undefined)[] = [];
    const pids: (string | undefined)[] = [];
    switch (e.type) {
      case 'propose_entry':
        ids.push(e.intent.id, this.keys.get(e.intent.key));
        pids.push(e.intent.positionId);
        break;
      case 'intent':
        ids.push(e.intentId);
        pids.push(intentOf(e.intentId)?.intent.positionId);
        break;
      case 'orphan_fill': {
        const i = intentOf(e.fill.intentId);
        ids.push(e.fill.intentId);
        if (i !== undefined) pids.push(i.intent.positionId, `${i.intent.positionId}.o${i.fills.length + 1}`);
        break;
      }
      case 'orphan_cleared':
        ids.push(book.orphans[e.signature]?.intentId);
        break;
      case 'trigger_exit':
      case 'exit_blocked': {
        const p = book.positions[e.positionId] ?? this.positions.get(e.positionId);
        pids.push(e.positionId);
        ids.push(p?.exitOwner?.intentId, e.type === 'trigger_exit' ? e.intentId : undefined);
        break;
      }
      default:
        break; // tick, restart, pause and resume read ended intents and closed positions only to skip them
    }
    let intents = book.intents;
    let positions = book.positions;
    for (const id of ids) {
      const s = id === undefined ? undefined : this.intents.get(id);
      if (s === undefined) continue;
      intents = { ...intents, [s.intent.id]: s };
      this.intents.delete(s.intent.id);
    }
    for (const id of pids) {
      const p = id === undefined ? undefined : this.positions.get(id);
      if (p === undefined) continue;
      positions = { ...positions, [p.id]: p };
      this.positions.delete(p.id);
    }
    return intents === book.intents && positions === book.positions ? book : { ...book, intents, positions };
  }

  /** The whole book: archived and live. */
  merge(book: Book): Book {
    return { ...book, intents: { ...Object.fromEntries(this.intents), ...book.intents }, positions: { ...Object.fromEntries(this.positions), ...book.positions } };
  }
}

type Fail = (f: Omit<ReplayFailure, 'intentKey' | 'positionId' | 'expected' | 'actual'> & Partial<ReplayFailure>) => never;

const replay = (src: ReplaySource, options: ReplayOptions, counts: { -readonly [K in keyof ReplayCounts]: number }, purpose: string | undefined): LedgerPurpose => {
  const fail: Fail = (f) => {
    throw new Failed({
      intentKey: f.intentId == null ? null : (intents.get(f.intentId)?.intent.key ?? null),
      positionId: null, expected: null, actual: null, ...f,
    });
  };
  const intents = new Map<string, IntentRecord>();

  if (purpose === undefined || !PURPOSES.includes(purpose)) {
    fail({ kind: 'stamp', table: 'ledger_meta', seq: null, intentId: null, event: null, reason: 'the file has no valid purpose stamp', expected: PURPOSES, actual: purpose ?? null });
  }
  const stamp = purpose as LedgerPurpose;
  const modes = src.decisionModes();
  const foreign = modes.filter((m) => !MODES_BY_PURPOSE[stamp].includes(m));
  if (foreign.length > 0) {
    fail({ kind: 'stamp', table: 'decision', seq: null, intentId: null, event: null, reason: `mixed stamps: a ${stamp} ledger holds ${foreign.join(', ')} decisions`, expected: MODES_BY_PURPOSE[stamp], actual: modes });
  }

  for (const r of src.allIntents()) intents.set(r.intent.id, r);
  const storedPositions = new Map(src.allPositions().map((p) => [p.positionId, p]));
  const iRows = src.intentEvents();
  const pRows = src.positionEvents();
  const queues = new Map<string, StoredPositionEvent[]>();
  for (const r of pRows) {
    const q = queues.get(r.positionId);
    if (q === undefined) queues.set(r.positionId, [r]);
    else q.push(r);
  }
  const used = new Map<string, number>();
  let lastPositionSeq = -1n;
  const opened = new Set<string>();
  let book = emptyBook({ maxOpenPositions: options.maxOpenPositions ?? Number.MAX_SAFE_INTEGER });
  const created = new Set<string>();
  const archive = options.compact === false ? null : new Archive();

  const peekPosition = (pid: string): StoredPositionEvent | undefined => queues.get(pid)?.[used.get(pid) ?? 0];

  const takePosition = (pid: string, want: { status: string; quantity: bigint; cost: bigint; event: string; detail: unknown }, ctx: { seq: bigint; intentId: string; event: string }) => {
    const row = peekPosition(pid);
    const expected = { status: want.status, quantity: want.quantity, cost: want.cost, event: want.event, detail: want.detail };
    if (row === undefined) {
      fail({ kind: 'divergence', table: 'position_event', seq: ctx.seq, intentId: ctx.intentId, positionId: pid, event: ctx.event, reason: 'a replayed position change has no stored row', expected, actual: null });
    }
    const actual = { status: row.status, quantity: row.quantity, cost: row.cost, event: row.event, detail: row.detail };
    if (row.seq <= lastPositionSeq) {
      fail({ kind: 'divergence', table: 'position_event', seq: row.seq, intentId: ctx.intentId, positionId: pid, event: ctx.event, reason: 'position rows are out of order', expected, actual });
    }
    if (!same(expected, actual)) {
      fail({ kind: 'divergence', table: 'position_event', seq: row.seq, intentId: ctx.intentId, positionId: pid, event: ctx.event, reason: 'stored position state differs from the replay', expected, actual });
    }
    used.set(pid, (used.get(pid) ?? 0) + 1);
    lastPositionSeq = row.seq;
    counts.positionRows++;
  };

  let i = 0;
  while (i < iRows.length) {
    const row = iRows[i]!;
    const record = intents.get(row.intentId);
    const at = { seq: row.seq, intentId: row.intentId };
    let event: BookEvent;
    if (row.event === 'created' && row.detail === null) {
      if (record === undefined || created.has(row.intentId)) {
        fail({ ...at, kind: 'divergence', table: 'intent_event', event: 'created', reason: 'intent created twice' });
      }
      created.add(row.intentId);
      if (record.intent.purpose === 'entry') {
        event = { type: 'propose_entry', intent: record.intent };
      } else {
        const next = peekPosition(record.intent.positionId);
        const trigger = bookOf(next?.detail ?? null);
        if (next !== undefined && next.detail !== null && refused(trigger)) {
          fail({ ...at, seq: next.seq, kind: 'schema', table: 'position_event', positionId: record.intent.positionId, event: next.event, reason: trigger.refused, actual: next.detail });
        }
        if (refused(trigger) || trigger.type !== 'trigger_exit' || trigger.intentId !== row.intentId) {
          fail({ ...at, kind: 'divergence', table: 'position_event', positionId: record.intent.positionId, event: 'trigger_exit', reason: 'exit intent created without its trigger_exit row', actual: trigger });
        }
        event = trigger;
      }
    } else {
      if (row.detail === null) {
        fail({ ...at, kind: 'divergence', table: 'intent_event', event: row.event, reason: 'row does not start a stored book event (no detail)', actual: null });
      }
      const stored = bookOf(row.detail);
      if (refused(stored)) fail({ ...at, kind: 'schema', table: 'intent_event', event: row.event, reason: stored.refused, actual: row.detail });
      event = stored;
    }
    try {
      encodeBookDetail(event); // an event rebuilt from the intent and position tables meets the same schema
    } catch (err) {
      if (!(err instanceof LedgerError)) throw err;
      fail({ ...at, kind: 'schema', table: 'intent', event: event.type, reason: err.message, actual: event });
    }
    const name = rowEventName(event);
    if (archive !== null) {
      if (counts.events % COMPACT_EVERY === 0) book = archive.compact(book);
      book = archive.restore(book, event);
    }

    let step: ReturnType<typeof applyBookEvent>;
    try {
      step = applyBookEvent(book, event);
    } catch (err) {
      fail({ ...at, kind: 'illegal', table: 'intent_event', event: name, reason: `malformed event: ${(err as Error).message}`, actual: event });
    }
    if (isIllegal(step)) {
      fail({ ...at, kind: 'illegal', table: 'intent_event', event: name, reason: `${step.reason} (from ${step.from})`, actual: event });
    }
    const rows = stepRows(book, event, step.effects);
    if (rows === null || rows.intents[0] !== row.intentId) {
      fail({ ...at, kind: 'divergence', table: 'intent_event', event: name, reason: 'the stored event does not write this intent', expected: rows?.intents ?? [], actual: [row.intentId] });
    }
    counts.events++;

    rows.intents.forEach((id, k) => {
      const r = iRows[i + k];
      const state = step.state.intents[id];
      const expected = { intentId: id, status: state?.status, event: k === 0 && row.event === 'created' && row.detail === null ? 'created' : name, continuation: k > 0 };
      if (r === undefined) {
        fail({ ...at, intentId: id, kind: 'divergence', table: 'intent_event', event: name, reason: 'a replayed intent change has no stored row', expected, actual: null });
      }
      const actual = { intentId: r.intentId, status: r.status, event: r.event, continuation: k > 0 ? r.detail === null : false };
      if (!same(expected, actual)) {
        fail({ seq: r.seq, intentId: r.intentId, kind: 'divergence', table: 'intent_event', event: name, reason: 'stored intent row differs from the replay', expected, actual });
      }
      counts.intentRows++;
    });
    i += rows.intents.length;

    for (const pid of rows.positions) {
      const p = step.state.positions[pid]!;
      if (!opened.has(pid)) {
        const stored = storedPositions.get(pid);
        const want = { positionId: pid, mint: p.mint, venue: p.venue, entryIntentId: p.entryIntentId };
        const have = stored && { positionId: stored.positionId, mint: stored.mint, venue: stored.venue, entryIntentId: stored.entryIntentId };
        if (!same(want, have ?? null)) {
          fail({ ...at, kind: 'divergence', table: 'position', positionId: pid, event: name, reason: 'stored position differs from the replay', expected: want, actual: have ?? null });
        }
        takePosition(pid, { status: 'opening', quantity: 0n, cost: 0n, event: 'created', detail: null }, { ...at, event: name });
        opened.add(pid);
        counts.positions++;
        if (p.status === 'opening' && p.quantity === 0n && p.cost === 0n) continue;
      }
      takePosition(pid, { status: p.status, quantity: p.quantity, cost: p.cost, event: name, detail: event.type === 'trigger_exit' ? encodeBookDetail(event) : null }, { ...at, event: name });
    }
    book = step.state;
  }

  let leftover: StoredPositionEvent | undefined;
  for (const [pid, q] of queues) {
    const r = q[used.get(pid) ?? 0];
    if (r !== undefined && (leftover === undefined || r.seq < leftover.seq)) leftover = r;
  }
  if (leftover !== undefined) {
    fail({ kind: 'divergence', table: 'position_event', seq: leftover.seq, intentId: null, positionId: leftover.positionId, event: leftover.event, reason: 'stored position row that no replayed event wrote', actual: leftover });
  }
  for (const pid of storedPositions.keys()) {
    if (!opened.has(pid)) fail({ kind: 'divergence', table: 'position', seq: null, intentId: null, positionId: pid, event: null, reason: 'stored position that no replayed event created' });
  }
  checkTables(src, archive === null ? book : archive.merge(book), intents, fail);
  counts.intents = intents.size;
  return stamp;
};

/**
 * Attempts, fills and reservations must be exactly those in the replayed intents. Per intent first, then whole
 * tables: no row may lack its parent (`foreign_key_check`), and each table's total must equal the replayed total,
 * so a row for an intent that does not exist cannot hide outside the per-intent reads.
 */
const checkTables = (src: ReplaySource, book: Book, intents: ReadonlyMap<string, IntentRecord>, fail: Fail): void => {
  const replayed = { fill: 0, attempt: 0, reservation: 0, reservation_event: 0 };
  const byIntent = <T extends { readonly intentId: string }>(rows: readonly T[]): Map<string, T[]> => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const list = m.get(r.intentId);
      if (list === undefined) m.set(r.intentId, [r]);
      else list.push(r);
    }
    return m;
  };
  const allAttempts = byIntent(src.allAttempts());
  const allFills = byIntent(src.allFills());
  const reservations = new Map(src.allReservations().map((r) => [r.intentId, r]));
  const pending = new Set(src.pendingOutbox().flatMap((o) => (o.intentId === null ? [] : [`${o.effect.type}|${o.intentId}`])));
  for (const id of intents.keys()) {
    const state: IntentState | undefined = book.intents[id];
    if (state === undefined) fail({ kind: 'divergence', table: 'intent', seq: null, intentId: id, event: null, reason: 'stored intent that no replayed event created' });
    const attempts = allAttempts.get(id) ?? [];
    if (!same(state.attempts, attempts)) {
      fail({ kind: 'divergence', table: 'attempt', seq: null, intentId: id, event: null, reason: 'stored attempts differ from the replay', expected: state.attempts, actual: attempts });
    }
    const fills = allFills.get(id) ?? [];
    if (!same(state.fills, fills)) {
      fail({ kind: 'divergence', table: 'fill', seq: null, intentId: id, event: null, reason: 'stored fills differ from the replay', expected: state.fills, actual: fills });
    }
    const want = state.reservation;
    const have = reservations.get(id);
    const expected = want && { reservationId: want.id, amount: want.amount, status: want.status };
    const actual = have && { reservationId: have.reservationId, amount: have.amount, status: have.ended ?? 'held' };
    const awaitingRunner = want !== null && have !== undefined && have.ended === null &&
      pending.has(`${want.status === 'released' ? 'release_reservation' : 'keep_reservation'}|${id}`);
    if (!same(expected ?? null, actual ?? null) && !(awaitingRunner && same({ ...expected, status: 'held' }, actual))) {
      fail({ kind: 'divergence', table: 'reservation', seq: null, intentId: id, event: null, reason: 'stored reservation differs from the replay', expected: expected ?? null, actual: actual ?? null });
    }
    replayed.attempt += state.attempts.length;
    replayed.fill += state.fills.length;
    if (want !== null) replayed.reservation++;
    if (have?.ended != null) replayed.reservation_event++;
  }
  const orphan = src.foreignKeyViolations()[0];
  if (orphan !== undefined) {
    const table = (TOTALLED as readonly string[]).includes(orphan.table) ? (orphan.table as ReplayTable) : 'intent';
    fail({ kind: 'divergence', table, seq: orphan.rowid, intentId: null, event: null, reason: `${orphan.table} row ${String(orphan.rowid)} has no ${orphan.parent} row`, actual: orphan });
  }
  const stored = src.rowTotals();
  for (const table of TOTALLED) {
    if (stored[table] !== replayed[table]) {
      fail({ kind: 'divergence', table, seq: null, intentId: null, event: null, reason: `${table} holds ${stored[table]} rows, the replay accounts for ${replayed[table]}`, expected: replayed[table], actual: stored[table] });
    }
  }
};

const TOTALLED = ['fill', 'attempt', 'reservation', 'reservation_event'] as const;
