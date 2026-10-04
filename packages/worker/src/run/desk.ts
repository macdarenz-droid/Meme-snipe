// The worker's side of the engine's log: every applied book event is written to the ledger by LEDGER-1's one writer
// (`recordBookEvent`, the format the ledger replay check reads), every decision is journaled with its reasons, and
// entry reservations go through the ledger with the risk snapshot's account version (RISK-1, LEDGER-1c): written first,
// in one transaction that refuses a stale snapshot, and only then handed to the engine as a world event. A refusal goes
// back as a `reject`, so the strategy re-evaluates on a fresh snapshot; nothing is retried blindly.
import type { IntentId, ReservationId } from '../../../core/src/domain/index.ts';
import type { LogRecord } from '../../../core/src/engine/index.ts';
import type { Ledger } from '../../../core/src/ledger/index.ts';
import { applyBookEvent, type Book, type BookConfig, type BookEvent, isIllegal, isTerminal, isUnresolved } from '../../../core/src/lifecycle/index.ts';
import type { Lamports } from '../../../core/src/units/index.ts';
import { GATE_REASONS_PREFIX, reservationOf } from '../engine/strategy.ts';

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
  readonly accountChanged: () => void;
  /** The set of open intents may have changed. */
  readonly intentsChanged: (open: number) => void;
  /** The ledger refused an event the engine applied: the book and the ledger no longer agree. */
  readonly diverged: (reason: string) => void;
  /** A reservation was stored (the account's entry record). */
  readonly reserved: (r: { readonly intentId: string; readonly mint: string; readonly amount: bigint; readonly atMs: number }) => void;
  /** A position filled or closed (the paper wallet and closed-trade records). */
  readonly filled: (r: { readonly purpose: 'entry' | 'exit'; readonly positionId: string; readonly mint: string; readonly book: Book; readonly atMs: number; readonly reasons: readonly string[] }) => void;
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
    const reasons = r.reasons.filter((x) => x !== typed);
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
    };
  }
  // A world event the engine refused; an applied one is not a decision line.
  return r.result === 'illegal' ? { action: 'world_refused', event: r.eventId, reasons: [`world event ${r.event.type} refused: ${r.reason ?? ''}`] } : null;
};

export class Desk {
  readonly #d: DeskDeps;
  #book: Book;
  /** World event ids whose book event the ledger already holds (restored at start, or a reservation written first). */
  readonly #written = new Set<string>();
  /** Decision reasons per entry intent, carried onto its `entry` line. */
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
    try {
      this.#book = this.#d.ledger.recordBookEvent(before, event, { ts, limits: { maxHeld: (2n ** 62n) as Lamports, maxCount: Number.MAX_SAFE_INTEGER } }).book;
    } catch (e) {
      // The engine applied it, so the ledger refusing it is a divergence: counted, journaled, never hidden.
      this.ledgerRefusals++;
      const reason = `ledger refused ${event.type}: ${e instanceof Error ? e.message : String(e)}`;
      this.#d.journal('decision', { action: 'ledger_refused', reasons: [reason] });
      this.#d.diverged(reason);
      const step = applyBookEvent(before, event);
      if (!isIllegal(step)) this.#book = step.state;
      return;
    }
    this.#after(before, event, ts);
  }

  #after(before: Book, event: BookEvent, ts: number): void {
    // The trade records first, so the account snapshot published next already holds this fill.
    this.#fills(before, event, ts);
    this.#d.accountChanged();
    this.#d.intentsChanged(openIntents(this.#book));
  }

  /** A reconcile that booked fills: the `entry` or `exit` line (after its `simulation` line) and the trade record. */
  #fills(before: Book, event: BookEvent, ts: number): void {
    if (event.type !== 'intent' || event.event.type !== 'reconcile') return;
    const s = this.#book.intents[event.intentId];
    const was = before.intents[event.intentId];
    if (s === undefined || s.fills.length === 0 || (was !== undefined && was.fills.length === s.fills.length)) return;
    const purpose = s.intent.purpose;
    const pid = s.intent.positionId;
    const p = this.#book.positions[pid];
    const tokens = s.fills.reduce((t, f) => t + f.tokens, 0n);
    const sol = s.fills.reduce((t, f) => t + f.sol, 0n);
    const fees = s.fills.reduce((t, f) => t + f.fees, 0n);
    const reasons = purpose === 'entry'
      ? ['entry filled (paper)', ...(this.#why.get(s.intent.id) ?? [])]
      : ['exit filled (paper)', ...(before.positions[pid]?.exitOwner?.reasons ?? [])];
    this.#why.delete(s.intent.id);
    this.#d.journal(purpose, { trade: pid, intent: s.intent.id, mint: s.intent.mint, tokens, sol, fees, position: p?.status ?? null, reasons });
    this.#d.filled({ purpose, positionId: pid, mint: s.intent.mint, book: this.#book, atMs: ts, reasons });
  }

  /** Writes the reservation first, then hands it to the engine; a refusal goes back as a reject. */
  #reserve(intentId: IntentId, reasons: readonly string[], ts: number): void {
    const req = reservationOf(reasons);
    const reject = (why: string): void => {
      this.#d.report({ type: 'intent', intentId, event: { type: 'reject', reason: why } });
    };
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
    this.#after(before, event, ts);
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
