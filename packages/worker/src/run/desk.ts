// The worker's side of the engine's log: every applied book event is written to the ledger by LEDGER-1's one writer
// (`recordBookEvent`, the format the ledger replay check reads), every decision is journaled with its reasons, and
// entry reservations go through the ledger with the risk snapshot's account version (RISK-1, LEDGER-1c): written first,
// in one transaction that refuses a stale snapshot, and only then handed to the engine as a world event. A refusal goes
// back as a `reject`, so the strategy re-evaluates on a fresh snapshot; nothing is retried blindly.
import type { IntentId, ReservationId } from '../../../core/src/domain/index.ts';
import type { LogRecord } from '../../../core/src/engine/index.ts';
import { type Ledger, LedgerError } from '../../../core/src/ledger/index.ts';
import { decodeBookDetail, stepRows } from '../../../core/src/ledger/replay/index.ts';
import { applyBookEvent, type Book, type BookConfig, type BookEvent, emptyBook, isIllegal, isTerminal, isUnresolved } from '../../../core/src/lifecycle/index.ts';
import type { Lamports } from '../../../core/src/units/index.ts';
import { reservationOf } from '../engine/strategy.ts';

/** The book events stored in a ledger, in order, rebuilt the way the ledger replay check reads them. */
export const bookEventsOf = (ledger: Pick<Ledger, 'intentEvents' | 'allIntents' | 'positionEvents'>, config: BookConfig): { readonly events: BookEvent[]; readonly book: Book } => {
  const intents = new Map(ledger.allIntents().map((r) => [r.intent.id as string, r]));
  const triggers = new Map<string, BookEvent>();
  for (const p of ledger.positionEvents()) {
    if (p.detail === null) continue;
    const e = decodeBookDetail(p.detail);
    if (e.type === 'trigger_exit') triggers.set(e.intentId, e);
  }
  const rows = ledger.intentEvents();
  const events: BookEvent[] = [];
  let book = emptyBook(config);
  let i = 0;
  while (i < rows.length) {
    const row = rows[i]!;
    let event: BookEvent;
    if (row.event === 'created' && row.detail === null) {
      const rec = intents.get(row.intentId);
      if (rec === undefined) throw new LedgerError(`ledger: intent ${row.intentId} has events but no record`);
      if (rec.intent.purpose === 'entry') event = { type: 'propose_entry', intent: rec.intent };
      else {
        const t = triggers.get(row.intentId);
        if (t === undefined) throw new LedgerError(`ledger: exit intent ${row.intentId} has no trigger_exit row`);
        event = t;
      }
    } else if (row.detail !== null) {
      event = decodeBookDetail(row.detail);
    } else {
      throw new LedgerError(`ledger: row ${row.seq} does not start a stored book event`);
    }
    const step = applyBookEvent(book, event);
    if (isIllegal(step)) throw new LedgerError(`ledger: stored ${event.type} is refused by the reducer: ${step.reason}`);
    const written = stepRows(book, event, step.effects);
    i += Math.max(1, written?.intents.length ?? 1);
    book = step.state;
    events.push(event);
  }
  return { events, book };
};

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
  /** A reservation was stored (the account's entry record). */
  readonly reserved: (r: { readonly intentId: string; readonly mint: string; readonly amount: bigint; readonly atMs: number }) => void;
  /** A position filled or closed (the paper wallet and closed-trade records). */
  readonly filled: (r: { readonly purpose: 'entry' | 'exit'; readonly positionId: string; readonly mint: string; readonly book: Book; readonly atMs: number; readonly reasons: readonly string[] }) => void;
}

export class Desk {
  readonly #d: DeskDeps;
  #book: Book;
  #cursor = 0;
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

  /** Takes the records the engine added since the last call. Index-based, so the caller may drop consumed records. */
  consume(records: readonly LogRecord[], from: number): number {
    for (let k = Math.max(from, this.#cursor); k < records.length; k++) this.#one(records[k]!);
    this.#cursor = records.length;
    return records.length;
  }

  /** Forget the cursor after the caller dropped consumed records. */
  rewind(): void {
    this.#cursor = 0;
  }

  #one(r: LogRecord): void {
    if (r.type === 'start') return;
    if (r.type === 'fault') {
      this.illegal++;
      this.#d.journal('decision', { action: 'fault', event: r.eventId, reasons: [`engine refused event ${r.eventId}: ${r.fault}`] });
      return;
    }
    if (r.type === 'decision') {
      const action = r.action;
      this.#d.journal('decision', {
        action: action === null ? 'none' : action.type === 'intent' ? action.event.type : action.type,
        intent: action === null ? null : action.type === 'intent' ? action.intentId : action.type === 'propose_entry' ? action.intent.id : null,
        result: r.result, ...(r.reason === undefined ? {} : { refused: r.reason }), event: r.eventId,
        reasons: r.reasons.length > 0 ? r.reasons : ['no reason given'],
      });
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
      this.#d.journal('decision', { action: 'world_refused', event: r.eventId, reasons: [`world event ${r.event.type} refused: ${r.reason ?? ''}`] });
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
      this.#d.journal('decision', { action: 'ledger_refused', reasons: [`ledger refused ${event.type}: ${e instanceof Error ? e.message : String(e)}`] });
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
  unresolved(nowMs: number, createdAt: (id: string) => number | null): { readonly count: number; readonly oldest_age_s: number | null } {
    let oldest: number | null = null;
    let count = 0;
    for (const s of Object.values(this.#book.intents)) {
      if (!isUnresolved(s)) continue;
      count++;
      const t = createdAt(s.intent.id);
      if (t !== null && (oldest === null || t < oldest)) oldest = t;
    }
    return { count, oldest_age_s: oldest === null ? null : Math.max(0, Math.round((nowMs - oldest) / 1000)) };
  }
}
