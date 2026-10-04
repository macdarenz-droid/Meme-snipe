// The worker's side of the engine's log: every applied book event is written to the ledger by LEDGER-1's one writer
// (`recordBookEvent`, the format the ledger replay check reads), every decision is journaled with its reasons, and
// entry reservations go through the ledger with the risk snapshot's account version (RISK-1, LEDGER-1c): written first,
// in one transaction that refuses a stale snapshot, and only then handed to the engine as a world event. A refusal goes
// back as a `reject`, so the strategy re-evaluates on a fresh snapshot; nothing is retried blindly.
import type { IntentId, ReservationId } from '../../../core/src/domain/index.ts';
import type { LogRecord } from '../../../core/src/engine/index.ts';
import type { Ledger } from '../../../core/src/ledger/index.ts';
import { applyBookEvent, type Book, type BookConfig, type BookEvent, emptyBook, isIllegal, isTerminal, isUnresolved } from '../../../core/src/lifecycle/index.ts';
import type { Lamports, MicroUsd } from '../../../core/src/units/index.ts';
import { GATE_REASONS_PREFIX, S0_DIAGNOSTIC_PREFIX, reservationOf, universeOfKey } from '../engine/strategy.ts';

/** Open intents for the host's update gate: intents not finished (`open_intents`, ops/README.md). */
export const openIntents = (book: Book): number => Object.values(book.intents).filter((s) => !isTerminal(s)).length;

export interface DeskDeps {
  readonly ledger: Ledger;
  readonly config: BookConfig;
  /** The book the ledger already holds (from `bookEventsOf`). */
  readonly restored: Book;
  readonly journal: (kind: 'decision' | 'entry' | 'exit', fields: Readonly<Record<string, unknown>>) => void;
  /** Puts a world event on the live Feed; returns its event id. */
  readonly report: (event: BookEvent) => string;
  /** The ledger's account changed: publish a fresh snapshot. */
  /** The account changed at a book event of this moment (its stray fees are judged fresh against it). */
  readonly accountChanged: (atMs: number) => void;
  /** The set of open intents may have changed. */
  readonly intentsChanged: (open: number) => void;
  /** The ledger refused an event the engine applied: the book and the ledger no longer agree. */
  readonly diverged: (reason: string) => void;
  /** A reservation was stored (the account's entry record). */
  readonly reserved: (r: { readonly intentId: string; readonly mint: string; readonly amount: bigint; readonly atMs: number }) => void;
  /**
   * A buy landed after its entry ended (`orphan_fill` of an entry, LEDGER-1b): its own position opens, which paper does
   * not settle yet. The worker raises an alert and stops entries (risk ruling on #133, until the late-landing card).
   */
  readonly lateBuy: (r: { readonly intentId: string; readonly positionId: string; readonly mint: string; readonly signature: string; readonly atMs: number }) => void;
  /** A position filled or closed (the paper wallet and closed-trade records). */
  readonly filled: (r: FilledRecord) => void;
  /**
   * Fill lines the journal already holds, by `fillKey` (`journaledFillKeys`): each is not written again when its fill
   * is booked again, and that fill is recorded with the line's own time, reasons and `sol_usd`.
   */
  readonly journaledFills?: Map<string, Readonly<Record<string, unknown>>>;
  /** The SOL/USD price a fill is booked at now (null before the first price), written on its line as `sol_usd`. */
  readonly solUsd?: (atMs: number) => MicroUsd | null;
  /** Test seam: called right after each of a fill's two durable writes (a crash image is taken there). */
  readonly crashPoint?: (point: 'fill-journaled' | 'fill-committed', intentId: string) => void;
  /**
   * A reason no entry may reserve exposure right now, or null. Checked at the reservation, the step where an approved
   * entry becomes exposure: a fault found inside a step reaches the engine as a halt fact only later, so an entry decided
   * at or after the fault is refused here (exits never reserve, so they are not affected).
   */
  readonly entriesBlocked?: () => string | null;
}

/** A booked fill for the paper account; `closes`: the trade closes whatever the position's status (a late sell). */
export interface FilledRecord {
  readonly purpose: 'entry' | 'exit';
  readonly positionId: string;
  readonly mint: string;
  readonly book: Book;
  readonly atMs: number;
  readonly reasons: readonly string[];
  /** The rate a fill re-booked from its held journal line is valued at (undefined: the price now). */
  readonly solUsd?: MicroUsd | null;
  readonly closes?: true;
}

/**
 * The journal's `decision` line for one engine record (null when the record is not journaled): what the desk writes,
 * and what TEST-1's parity harness rebuilds from a replay, so both sides go through the same mapping.
 */
export const journalFields = (r: LogRecord): Readonly<Record<string, unknown>> | null => {
  if (r.type === 'start') return null;
  if (r.type === 'fault') return { action: 'fault', event: r.eventId, reasons: [`engine refused event ${r.eventId}: ${r.fault}`] };
  if (r.type === 'decision') {
    const action = r.action;
    // A candidate's reject carries its typed reasons (RUN-1c `gate_reasons`); an entry is `enter` (the runner's name).
    const typed = r.reasons.find((x) => x.startsWith(GATE_REASONS_PREFIX));
    // WORKER-1e: the S0 diagnostic parts the decision relied on, named on its line.
    const diag = r.reasons.find((x) => x.startsWith(S0_DIAGNOSTIC_PREFIX));
    const reasons = r.reasons.filter((x) => x !== typed && x !== diag);
    const reject = action === null && reasons[0] === 'reject';
    let gateReasons: unknown = null;
    if (typed !== undefined) {
      try {
        gateReasons = JSON.parse(typed.slice(GATE_REASONS_PREFIX.length));
      } catch {
        gateReasons = [{ gate: 'worker', code: 'unreadable', detail: 'typed reasons could not be read' }];
      }
    }
    return {
      action: action === null ? (reject ? 'reject' : 'none') : action.type === 'intent' ? action.event.type : action.type === 'propose_entry' ? 'enter' : action.type,
      intent: action === null ? null : action.type === 'intent' ? action.intentId : action.type === 'propose_entry' ? action.intent.id : null,
      result: r.result, ...(r.reason === undefined ? {} : { refused: r.reason }), event: r.eventId,
      reasons: reasons.length > 0 ? reasons : ['no reason given'],
      ...(reject ? { gate_reasons: gateReasons ?? [] } : {}),
      ...(diag === undefined ? {} : { s0_diagnostic: diag.slice(S0_DIAGNOSTIC_PREFIX.length).split(',') }),
    };
  }
  // A world event the engine refused; an applied one is not a decision line.
  return r.result === 'illegal' ? { action: 'world_refused', event: r.eventId, reasons: [`world event ${r.event.type} refused: ${r.reason ?? ''}`] } : null;
};

/** The key of a fill line: its intent and the tokens it booked in all (a later partial fill is a new line). */
export const fillKey = (intentId: string, tokens: bigint): string => `${intentId}:${tokens}`;

/** The `entry` and `exit` lines already in a journal, by `fillKey`: what a restart must not write again. */
export const journaledFillKeys = (lines: readonly Readonly<Record<string, unknown>>[]): Map<string, Readonly<Record<string, unknown>>> =>
  new Map(lines.flatMap((l) => ((l['kind'] === 'entry' || l['kind'] === 'exit') && typeof l['intent'] === 'string' && typeof l['tokens'] === 'string' && /^\d+$/.test(l['tokens'])
    ? [[fillKey(l['intent'], BigInt(l['tokens'])), l] as const] : [])));

/** On a fill recorded from a journal line that holds no `sol_usd` (written before it existed): valued at the price now. */
export const FILL_RATE_UNKNOWN = 'fill sol_usd unknown: valued at the price after restart';

/**
 * A fill line's SOL/USD rate (PAPER-1: each cash flow at its own rate): the price, null when there was none at booking
 * (valued as the live path did), or undefined when the line has no `sol_usd` field (an older line).
 */
export const lineRate = (line: Readonly<Record<string, unknown>> | undefined): MicroUsd | null | undefined => {
  const raw = line?.['sol_usd'];
  if (raw === null) return null;
  return typeof raw === 'string' && /^\d+$/.test(raw) ? (BigInt(raw) as MicroUsd) : undefined;
};

/** A journal line's `reasons` (strings only), or undefined when it has none. */
export const lineReasons = (line: Readonly<Record<string, unknown>> | undefined): string[] | undefined =>
  Array.isArray(line?.['reasons']) ? (line['reasons'] as unknown[]).filter((x): x is string => typeof x === 'string') : undefined;

interface Fill {
  readonly purpose: 'entry' | 'exit';
  readonly intentId: string;
  readonly positionId: string;
  readonly mint: string;
  readonly reasons: readonly string[];
  /** The journal line, or null when the journal already holds it. */
  readonly line: Readonly<Record<string, unknown>> | null;
  /** The rate the fill is valued at (`lineRate`; undefined: the price now). */
  readonly solUsd: MicroUsd | null | undefined;
  /** The fill's time from the held line, or null to use the booking time. */
  readonly atMs: number | null;
  /** A late sell that leaves the position at quantity 0: the trade closes whatever the position's status. */
  readonly closes: boolean;
}

export class Desk {
  readonly #d: DeskDeps;
  #book: Book;
  /** World event ids whose book event the ledger already holds (restored at start, or a reservation written first). */
  readonly #written = new Set<string>();
  /**
   * Reasons by intent: an entry's decision reasons, carried onto its `entry` line; an exit's trigger reasons, for a sell
   * that lands after the exit ended (see #fill). Bounded (`#prune`): an intent's go once it has ended and its position
   * holds nothing (no sale can land on an empty account; an entry's go at its fill, or with an empty position unfilled).
   * A late landing can be reported long after its block height (a lagging read, a wallet sweep), so height is no bound.
   */
  readonly #why = new Map<string, readonly string[]>();
  /** Engine records that were illegal or refused (should stay 0). */
  illegal = 0;
  /** Book events the ledger refused (should stay 0). */
  ledgerRefusals = 0;

  constructor(d: DeskDeps) {
    this.#d = d;
    this.#book = d.restored;
  }

  get book(): Book {
    return this.#book;
  }

  /** Marks world events whose book event is already in the ledger (the restore at start). */
  written(eventId: string): void {
    this.#written.add(eventId);
  }

  /** Takes records the engine added, each once, in order (the caller drops them afterwards). */
  consume(records: readonly LogRecord[]): void {
    for (const r of records) this.#one(r);
  }

  #one(r: LogRecord): void {
    const line = journalFields(r);
    if (line !== null) this.#d.journal('decision', line);
    if (r.type === 'start') return;
    if (r.type === 'fault') {
      this.illegal++;
      return;
    }
    if (r.type === 'decision') {
      const action = r.action;
      if (r.result === 'illegal') this.illegal++;
      if (r.result !== 'applied' || action === null) return;
      if (action.type === 'propose_entry') this.#why.set(action.intent.id, r.reasons);
      this.#write(action, r.at.receivedAt);
      if (action.type === 'intent' && action.event.type === 'approve_risk') this.#reserve(action.intentId, r.reasons, r.at.receivedAt);
      return;
    }
    // A world event: written unless the ledger already holds it.
    if (r.result === 'illegal') {
      this.illegal++;
      // One the ledger already holds: the engine and the ledger no longer agree, so entries stop until a restart.
      if (this.#written.has(r.eventId)) this.#d.diverged(`world event ${r.event.type} refused: ${r.reason ?? ''}`);
      return;
    }
    if (this.#written.delete(r.eventId)) return;
    this.#write(r.event, r.at.receivedAt);
  }

  #write(event: BookEvent, ts: number): void {
    const before = this.#book;
    // A fill is journaled before the ledger lets the position go (ARCHITECTURE §12.4): a kill between the two writes
    // must never leave a position closed in the ledger with no `exit` line, which a restart check reads as lost. The
    // other way round, the restart books the same fill again from the world and the line is not written twice.
    const step = applyBookEvent(before, event);
    const fill = isIllegal(step) ? null : this.#fill(before, step.state, event, ts);
    if (fill !== null && fill.line !== null) {
      this.#d.journal(fill.purpose, fill.line);
      this.#d.crashPoint?.('fill-journaled', fill.intentId);
    }
    try {
      this.#book = this.#d.ledger.recordBookEvent(before, event, { ts, limits: { maxHeld: (2n ** 62n) as Lamports, maxCount: Number.MAX_SAFE_INTEGER } }).book;
    } catch (e) {
      // The engine applied it, so the ledger refusing it is a divergence: counted, journaled, never hidden.
      this.ledgerRefusals++;
      const reason = `ledger refused ${event.type}: ${e instanceof Error ? e.message : String(e)}`;
      this.#d.journal('decision', { action: 'ledger_refused', reasons: [reason] });
      this.#d.diverged(reason);
      if (!isIllegal(step)) this.#book = step.state;
      return;
    }
    if (fill !== null) this.#d.crashPoint?.('fill-committed', fill.intentId);
    this.#keep(this.#book, event);
    this.#lateBuy(before, event, ts);
    this.#prune();
    this.#after(fill, ts);
  }

  /** An exit's trigger reasons (merged into its owner by a later trigger). */
  #keep(book: Book, event: BookEvent): void {
    if (event.type !== 'trigger_exit') return;
    const owner = book.positions[event.positionId]?.exitOwner;
    if (owner) this.#why.set(owner.intentId, owner.reasons);
  }

  /** Drops reasons nothing can use any more (see `#why`). */
  #prune(): void {
    for (const id of this.#why.keys()) {
      const s = this.#book.intents[id];
      if (s === undefined || !isTerminal(s)) continue;
      if ((this.#book.positions[s.intent.positionId]?.quantity ?? 0n) === 0n) this.#why.delete(id);
    }
  }

  /**
   * After a restart: the exits' trigger reasons from the ledger's stored events (replayed from an empty book), so a late
   * sell after the restart still books its exit's reasons (a late stop counts as a stop).
   */
  rebuild(events: readonly BookEvent[], config: BookConfig): void {
    let book = emptyBook(config);
    for (const e of events) {
      const r = applyBookEvent(book, e);
      if (isIllegal(r)) continue;
      book = r.state;
      this.#keep(book, e);
    }
    this.#prune();
  }

  /** How many intents' reasons are kept (bounded; for tests). */
  get keptReasons(): number {
    return this.#why.size;
  }

  #after(fill: Fill | null, ts: number): void {
    // The trade records first, so the account snapshot published next already holds this fill.
    if (fill !== null) {
      this.#d.filled({ purpose: fill.purpose, positionId: fill.positionId, mint: fill.mint, book: this.#book, atMs: fill.atMs ?? ts, reasons: fill.reasons, ...(fill.solUsd === undefined ? {} : { solUsd: fill.solUsd }), ...(fill.closes ? { closes: true as const } : {}) });
    }
    this.#d.accountChanged(ts);
    this.#d.intentsChanged(openIntents(this.#book));
  }

  /**
   * A reconcile that books fills, or a late-landing sell booked after its exit ended (`orphan_fill`): its `entry` or
   * `exit` line (after its `simulation` line), or null. A line the journal already holds for the same intent and amount
   * (written before a kill that came ahead of the ledger) is not repeated. A late buy opens its own position, which is
   * not a paper trade: `#write` hands it to `lateBuy` instead (DECISIONS, PAPER-1). RISK-PARTIAL: a late sell that
   * leaves tokens held books its part when it lands.
   */
  #fill(before: Book, after: Book, event: BookEvent, ts: number): Fill | null {
    const id = event.type === 'intent' && event.event.type === 'reconcile' ? event.intentId
      : event.type === 'orphan_fill' && after.intents[event.fill.intentId]?.intent.purpose === 'exit' ? event.fill.intentId : null;
    if (id === null) return null;
    const s = after.intents[id];
    const was = before.intents[id];
    if (s === undefined || s.fills.length === 0 || (was !== undefined && was.fills.length === s.fills.length)) return null;
    const purpose = s.intent.purpose;
    const pid = s.intent.positionId;
    const p = after.positions[pid];
    const tokens = s.fills.reduce((t, f) => t + f.tokens, 0n);
    const sol = s.fills.reduce((t, f) => t + f.sol, 0n);
    const fees = s.fills.reduce((t, f) => t + f.fees, 0n);
    // An exit's reasons: its own, as owner of the position, or (a late landing after the exit ended, which clears the
    // owner or hands it to another exit) those kept when it was triggered, so a late stop still counts as a stop.
    const owner = before.positions[pid]?.exitOwner;
    const reasons = purpose === 'entry'
      ? ['entry filled (paper)', ...(this.#why.get(s.intent.id) ?? [])]
      : ['exit filled (paper)', ...(owner?.intentId === s.intent.id ? owner.reasons : (this.#why.get(s.intent.id) ?? []))];
    // An exit keeps its reasons for another of its attempts landing late (`#prune` drops them).
    if (purpose === 'entry') this.#why.delete(s.intent.id);
    // A late sell that leaves nothing closes the trade even if another exit owns the position now (run/CI review B2:
    // that exit can only end unfilled, and the position stays at quantity 0).
    const closes = event.type === 'orphan_fill' && p !== undefined && p.quantity === 0n;
    // An entry names the universe it was entered under (CFG-2): the runner expects a trade opened after its last
    // reply back after a restart, with that universe (RUN-1d contract).
    const universe = purpose === 'entry' ? { universe: universeOfKey(s.intent.key) } : {};
    // `sol_usd`: the rate this fill's cash flow is valued at, so a restart that catches the account up uses it too (PAPER-1).
    const solUsd = this.#d.solUsd?.(ts) ?? null;
    const line = { trade: pid, intent: s.intent.id, mint: s.intent.mint, tokens, sol, fees, position: p?.status ?? null, ...universe, sol_usd: solUsd, reasons };
    const key = fillKey(s.intent.id, tokens);
    const held = this.#d.journaledFills?.get(key);
    if (held !== undefined) {
      // Booked again after a kill that came ahead of the ledger: recorded as its line says (time, reasons, rate), once.
      this.#d.journaledFills!.delete(key);
      const rate = lineRate(held);
      const why = lineReasons(held) ?? reasons;
      const at = typeof held['ts'] === 'string' ? Date.parse(held['ts']) : Number.NaN;
      return { purpose, intentId: s.intent.id, positionId: pid, mint: s.intent.mint, reasons: rate === undefined ? [...why, FILL_RATE_UNKNOWN] : why, line: null, solUsd: rate, atMs: Number.isFinite(at) ? at : null, closes };
    }
    return { purpose, intentId: s.intent.id, positionId: pid, mint: s.intent.mint, reasons, line, solUsd, atMs: null, closes };
  }

  /** A late buy (`orphan_fill` of an entry) booked: its own position opened, which goes to `lateBuy`, never a trade. */
  #lateBuy(before: Book, event: BookEvent, ts: number): void {
    if (event.type !== 'orphan_fill') return;
    const i = this.#book.intents[event.fill.intentId];
    if (i?.intent.purpose !== 'entry' || i.fills.length <= (before.intents[event.fill.intentId]?.fills.length ?? 0)) return;
    this.#d.lateBuy({ intentId: i.intent.id, positionId: `${i.intent.positionId}.o${i.fills.length}`, mint: i.intent.mint, signature: event.fill.signature, atMs: ts });
  }

  /** Writes the reservation first, then hands it to the engine; a refusal goes back as a reject. */
  #reserve(intentId: IntentId, reasons: readonly string[], ts: number): void {
    const req = reservationOf(reasons);
    const reject = (why: string): void => {
      this.#d.report({ type: 'intent', intentId, event: { type: 'reject', reason: why } });
    };
    const blocked = this.#d.entriesBlocked?.() ?? null;
    if (blocked !== null) {
      this.#d.journal('decision', { action: 'entry_refused', intent: intentId, reasons: [`entries halted: ${blocked}`, 'no exposure reserved'] });
      return reject(`entries halted: ${blocked}`);
    }
    if (req === null || req.intentId !== intentId) return reject('reservation request missing from the risk decision');
    const event: BookEvent = {
      type: 'intent', intentId,
      event: { type: 'reserve_exposure', reservation: { id: req.reservationId as ReservationId, intentId, amount: req.amount as Lamports, status: 'held' } },
    };
    const before = this.#book;
    try {
      this.#book = this.#d.ledger.recordBookEvent(before, event, { ts, limits: { maxHeld: req.maxHeld as Lamports, maxCount: req.maxCount }, accountVersion: req.accountVersion }).book;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      return reject(`reservation refused, re-evaluate: ${/stale_snapshot/.test(why) ? 'stale_snapshot' : why}`);
    }
    const mint = before.intents[intentId]?.intent.mint ?? '';
    this.#d.reserved({ intentId, mint, amount: req.amount, atMs: ts });
    this.#after(null, ts);
    this.#written.add(this.#d.report(event));
  }

  /** Unresolved intents (reached the network, not reconciled): the heartbeat's count and the oldest age. */
  /** Unresolved intents: how many, the oldest's age, and each one's trade (its position id, as in the journal). */
  unresolved(nowMs: number, createdAt: (id: string) => number | null): { readonly count: number; readonly oldest_age_s: number | null; readonly trades: readonly string[] } {
    let oldest: number | null = null;
    let count = 0;
    const trades: string[] = [];
    for (const s of Object.values(this.#book.intents)) {
      if (!isUnresolved(s)) continue;
      count++;
      trades.push(s.intent.positionId);
      const t = createdAt(s.intent.id);
      if (t !== null && (oldest === null || t < oldest)) oldest = t;
    }
    return { count, oldest_age_s: oldest === null ? null : Math.max(0, Math.round((nowMs - oldest) / 1000)), trades };
  }
}
