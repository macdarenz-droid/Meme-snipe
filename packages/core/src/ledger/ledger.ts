// The engine-facing ledger: append-only writes, the transactional outbox, unique intent keys,
// atomic exposure reservations and the reads restart recovery needs. It opens only ledger files;
// labels, trials and gate results live in the scoring store (./scoring), which this module never imports.

import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Fill, TradeIntent, TransactionAttempt } from '../domain/index.ts';
import { applyBookEvent, isIllegal, type Book, type BookConfig, type BookEvent, type Effect, type IntentStatus, type PositionStatus } from '../lifecycle/index.ts';
import { encodeBookDetail, rowEventName, stepRows, storedBookEvents } from './replay/index.ts';
import type { Lamports } from '../units/index.ts';
import { fromJson, toJson } from './codec.ts';
import { FEE_KINDS, INTENT_END_STATUSES, LEDGER_MIGRATIONS, OPERATOR_COMMANDS, type AUTH_LEVELS, type DECISION_MODES, type ISSUERS } from './migrations.ts';
import { amountOf, amountText, inTransaction, LedgerError, openReader, openWriter } from './sqlite.ts';

/** What the file is for. A backtest writes the same schema to its own file and can never open a live one. */
export type LedgerPurpose = 'live' | 'paper' | 'backtest';
export type FeeKind = (typeof FEE_KINDS)[number];
export type OperatorCommandName = (typeof OPERATOR_COMMANDS)[number];
export type AuthLevel = (typeof AUTH_LEVELS)[number];
export type Issuer = (typeof ISSUERS)[number];
export type DecisionMode = (typeof DECISION_MODES)[number];
/** Milliseconds from the caller's clock: the live clock, or the simulated clock in a backtest. */
export type Millis = number;

type Row = Record<string, SQLInputValue>;

export interface ObservationInput {
  readonly provider: string;
  readonly mint: string;
  readonly pool?: string | null;
  readonly kind: string;
  readonly slot?: bigint | null;
  readonly eventTs?: Millis | null;
  readonly receiptTs: Millis;
  readonly commitment?: 'processed' | 'confirmed' | 'finalized' | null;
  readonly payload: unknown;
  readonly qualityFlags?: readonly string[];
}

export interface FeatureSnapshotInput {
  readonly mint: string;
  readonly pool?: string | null;
  readonly venue: TradeIntent['venue'];
  readonly quoteMint: string;
  readonly decisionTs: Millis;
  readonly asOfSlot: bigint;
  readonly maxReceiptTs: Millis;
  readonly featuresetVer: string;
  readonly creatorCluster?: string | null;
  readonly features: Readonly<Record<string, unknown>>;
  readonly missing?: readonly string[];
  readonly regimeTags?: readonly string[];
}

export interface DecisionInput {
  readonly snapshotId: bigint;
  readonly decidedTs: Millis;
  readonly strategyVer: string;
  readonly modelVer?: string | null;
  readonly calibVer?: string | null;
  readonly pMeta?: number | null;
  readonly pSevere?: number | null;
  readonly conformalThr?: number | null;
  readonly action: 'enter' | 'reject' | 'abstain';
  readonly reasons: readonly string[];
  readonly mode: DecisionMode;
}

/** One status change, with the effects it asks for. Effects other than `persist` go to the outbox in the same transaction. */
export interface IntentTransition {
  readonly intentId: TradeIntent['id'];
  readonly status: IntentStatus;
  readonly event: string;
  readonly detail?: unknown;
  readonly effects?: readonly Effect[];
  readonly ts: Millis;
}

export interface ReservationLimits {
  /** Most lamports held across all open reservations, including this one. From configuration, never a constant. */
  readonly maxHeld: Lamports;
  /** Most reservations held at once, including this one. */
  readonly maxCount: number;
}

export type ReserveResult =
  | { readonly ok: true; readonly heldAfter: Lamports }
  | { readonly ok: false; readonly reason: 'stale_snapshot' | 'over_limit' | 'too_many' | 'already_reserved' | 'not_an_entry' | 'unknown_intent' };

export type RecordIntentResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'duplicate_key'; readonly existingIntentId: string };

export interface IntentRecord {
  readonly intent: TradeIntent;
  readonly decisionId: bigint | null;
  readonly status: IntentStatus;
  readonly statusTs: Millis;
}

export interface OutboxItem {
  readonly outboxId: bigint;
  readonly intentId: string | null;
  readonly effect: Effect;
  readonly createdTs: Millis;
}

export interface HeldReservation {
  readonly reservationId: string;
  readonly intentId: string;
  readonly amount: Lamports;
  readonly createdTs: Millis;
}

export interface PositionRecord {
  readonly positionId: string;
  readonly mint: string;
  readonly venue: string;
  readonly entryIntentId: string;
  readonly status: PositionStatus;
  readonly quantity: bigint;
  readonly cost: Lamports;
  readonly statusTs: Millis;
}

export interface StoredIntentEvent {
  readonly seq: bigint;
  readonly intentId: string;
  readonly status: IntentStatus;
  readonly event: string;
  readonly detail: unknown;
  readonly ts: Millis;
}

export interface StoredPosition {
  readonly positionId: string;
  readonly mint: string;
  readonly venue: string;
  readonly entryIntentId: string;
  readonly createdTs: Millis;
}

export interface StoredPositionEvent {
  readonly seq: bigint;
  readonly positionId: string;
  readonly status: PositionStatus;
  readonly quantity: bigint;
  readonly cost: Lamports;
  readonly event: string;
  readonly detail: unknown;
  readonly ts: Millis;
}

export interface StoredReservation {
  readonly reservationId: string;
  readonly intentId: string;
  readonly amount: Lamports;
  readonly ended: 'released' | 'kept' | null;
}

export interface OperatorCommandInput {
  readonly commandId: string;
  readonly command: OperatorCommandName;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly authLevel: AuthLevel;
  readonly issuedBy: Issuer;
  readonly issuedTs: Millis;
}

export interface PendingCommand extends Required<Omit<OperatorCommandInput, 'args'>> {
  readonly args: Readonly<Record<string, unknown>>;
}

const ms = (v: unknown): Millis => Number(v);
const optText = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const END_SQL = INTENT_END_STATUSES.map((v) => `'${v}'`).join(', ');

// The connection is held outside the objects, so no engine code can reach it (to run raw SQL or attach another file)
// through a property. Only this module and the ledger tests (via `connectionOf`) can.
const connections = new WeakMap<LedgerReads, DatabaseSync>();

/** For the ledger's own tests only; not exported from the ledger's entry point. */
export const connectionOf = (store: LedgerReads): DatabaseSync => {
  const db = connections.get(store);
  if (db === undefined) throw new LedgerError('not an open ledger');
  return db;
};

/** Reads shared by the writer and the read-only connection. Every query is fixed: no raw SQL is reachable from outside. */
class LedgerReads {
  constructor(db: DatabaseSync) {
    connections.set(this, db);
  }

  get #db(): DatabaseSync {
    return connectionOf(this);
  }

  purpose(): LedgerPurpose {
    const row = this.#db.prepare("SELECT value FROM ledger_meta WHERE key = 'purpose'").get();
    return String(row?.['value']) as LedgerPurpose;
  }

  intent(intentId: string): IntentRecord | null {
    const row = this.#db.prepare(`${INTENT_SELECT} WHERE i.intent_id = ?`).get(intentId);
    return row === undefined ? null : toIntentRecord(row);
  }

  intentByKey(key: string): IntentRecord | null {
    const row = this.#db.prepare(`${INTENT_SELECT} WHERE i.idem_key = ?`).get(key);
    return row === undefined ? null : toIntentRecord(row);
  }

  /** Intents not yet at an end status, oldest first. Restart recovery reconciles each before any entry. */
  unresolvedIntents(): IntentRecord[] {
    return this.#db.prepare(`${INTENT_SELECT} WHERE e.status NOT IN (${END_SQL}) ORDER BY i.created_ts, i.intent_id`).all().map(toIntentRecord);
  }

  attempts(intentId: string): TransactionAttempt[] {
    return this.#db.prepare('SELECT * FROM attempt WHERE intent_id = ? ORDER BY created_ts, rowid').all(intentId).map(toAttempt);
  }

  fills(intentId: string): Fill[] {
    return this.#db.prepare('SELECT * FROM fill WHERE intent_id = ? ORDER BY fill_id').all(intentId).map(toFill);
  }

  hasSnapshot(snapshotId: bigint): boolean {
    return this.#db.prepare('SELECT 1 FROM feature_snapshot WHERE snapshot_id = ?').get(snapshotId) !== undefined;
  }

  /**
   * The book events this ledger stores, in order, and the book they make: what a restarting worker feeds back to its
   * engine (WORKER-1). Read as the replay check reads them; throws a LedgerError on a row it cannot read.
   */
  storedBookEvents(config: BookConfig): { readonly events: BookEvent[]; readonly book: Book } {
    return storedBookEvents(this, config);
  }

  heldReservations(): HeldReservation[] {
    return this.#db.prepare(`SELECT r.* FROM reservation r
      WHERE NOT EXISTS (SELECT 1 FROM reservation_event e WHERE e.reservation_id = r.reservation_id)
      ORDER BY r.created_ts, r.reservation_id`).all().map((r) => ({
      reservationId: String(r['reservation_id']),
      intentId: String(r['intent_id']),
      amount: amountOf(r['amount']) as Lamports,
      createdTs: ms(r['created_ts']),
    }));
  }

  heldExposure(): Lamports {
    return this.heldReservations().reduce((t, r) => t + r.amount, 0n) as Lamports;
  }

  /**
   * The account version a risk snapshot is taken at (RISK-1 `AccountHistory.version`). Read it in the same read as
   * the snapshot; `reserveExposure` refuses a reservation made from an older version.
   */
  accountVersion(): bigint {
    return accountVersionIn(this.#db);
  }

  /** Effects written but not yet marked done, in the order they were written. */
  pendingOutbox(): OutboxItem[] {
    return this.#db.prepare(`SELECT o.* FROM outbox o
      WHERE NOT EXISTS (SELECT 1 FROM outbox_done d WHERE d.outbox_id = o.outbox_id) ORDER BY o.outbox_id`).all().map((r) => ({
      outboxId: BigInt(r['outbox_id'] as bigint),
      intentId: optText(r['intent_id']),
      effect: fromJson<Effect>(r['effect']),
      createdTs: ms(r['created_ts']),
    }));
  }

  positions(): PositionRecord[] {
    return this.#db.prepare(`SELECT p.*, e.status, e.quantity, e.cost, e.ts FROM position p
      JOIN position_event e ON e.seq = (SELECT MAX(seq) FROM position_event x WHERE x.position_id = p.position_id)
      ORDER BY p.created_ts, p.position_id`).all().map((r) => ({
      positionId: String(r['position_id']),
      mint: String(r['mint']),
      venue: String(r['venue']),
      entryIntentId: String(r['entry_intent_id']),
      status: String(r['status']) as PositionStatus,
      quantity: amountOf(r['quantity']),
      cost: amountOf(r['cost']) as Lamports,
      statusTs: ms(r['ts']),
    }));
  }

  /** Commands with no result yet, oldest first. */
  pendingCommands(): PendingCommand[] {
    return this.#db.prepare(`SELECT c.* FROM operator_command c
      WHERE NOT EXISTS (SELECT 1 FROM command_result r WHERE r.command_id = c.command_id) ORDER BY c.issued_ts, c.command_id`).all().map((r) => ({
      commandId: String(r['command_id']),
      command: String(r['command']) as OperatorCommandName,
      args: fromJson<Record<string, unknown>>(r['args']),
      authLevel: String(r['auth_level']) as AuthLevel,
      issuedBy: String(r['issued_by']) as Issuer,
      issuedTs: ms(r['issued_ts']),
    }));
  }

  feesFor(intentId: string): { readonly kind: FeeKind; readonly lamports: Lamports }[] {
    return this.#db.prepare('SELECT kind, lamports FROM fee WHERE intent_id = ? ORDER BY fee_id').all(intentId)
      .map((r) => ({ kind: String(r['kind']) as FeeKind, lamports: amountOf(r['lamports']) as Lamports }));
  }

  // Full-history reads for the ledger replay check (./replay). Read-only, in stored order.

  /** Every intent with its current status, in creation order. */
  allIntents(): IntentRecord[] {
    return this.#db.prepare(`${INTENT_SELECT} ORDER BY i.created_ts, i.intent_id`).all().map(toIntentRecord);
  }

  /** Every intent status row, in the order written (`seq` is global across intents). */
  intentEvents(): StoredIntentEvent[] {
    return this.#db.prepare('SELECT * FROM intent_event ORDER BY seq').all().map((r) => ({
      seq: BigInt(r['seq'] as bigint),
      intentId: String(r['intent_id']),
      status: String(r['status']) as IntentStatus,
      event: String(r['event']),
      detail: r['detail'] === null ? null : fromJson(r['detail']),
      ts: ms(r['ts']),
    }));
  }

  /** Every attempt, in the order `attempts` returns them per intent. One read: the replay never scans per intent. */
  allAttempts(): TransactionAttempt[] {
    return this.#db.prepare('SELECT * FROM attempt ORDER BY created_ts, rowid').all().map(toAttempt);
  }

  /** Every fill, in the order `fills` returns them per intent (`fill` has no index on `intent_id`). */
  allFills(): Fill[] {
    return this.#db.prepare('SELECT * FROM fill ORDER BY fill_id').all().map(toFill);
  }

  /** Every position as created (not its current state), in creation order. */
  allPositions(): StoredPosition[] {
    return this.#db.prepare('SELECT * FROM position ORDER BY created_ts, position_id').all().map((r) => ({
      positionId: String(r['position_id']),
      mint: String(r['mint']),
      venue: String(r['venue']),
      entryIntentId: String(r['entry_intent_id']),
      createdTs: ms(r['created_ts']),
    }));
  }

  /** Every position state row, in the order written (`seq` is global across positions). */
  positionEvents(): StoredPositionEvent[] {
    return this.#db.prepare('SELECT * FROM position_event ORDER BY seq').all().map((r) => ({
      seq: BigInt(r['seq'] as bigint),
      positionId: String(r['position_id']),
      status: String(r['status']) as PositionStatus,
      quantity: amountOf(r['quantity']),
      cost: amountOf(r['cost']) as Lamports,
      event: String(r['event']),
      detail: r['detail'] === null ? null : fromJson(r['detail']),
      ts: ms(r['ts']),
    }));
  }

  /** Every reservation with how it ended (null while held). */
  allReservations(): StoredReservation[] {
    return this.#db.prepare(`SELECT r.*, e.status AS ended FROM reservation r
      LEFT JOIN reservation_event e ON e.reservation_id = r.reservation_id ORDER BY r.created_ts, r.reservation_id`).all().map((r) => ({
      reservationId: String(r['reservation_id']),
      intentId: String(r['intent_id']),
      amount: amountOf(r['amount']) as Lamports,
      ended: r['ended'] === null ? null : (String(r['ended']) as 'released' | 'kept'),
    }));
  }

  /** Rows whose parent row is missing (`PRAGMA foreign_key_check`), in table and rowid order. Read-only. */
  foreignKeyViolations(): { readonly table: string; readonly rowid: bigint | null; readonly parent: string }[] {
    return this.#db.prepare('PRAGMA foreign_key_check').all()
      .map((r) => ({ table: String(r['table']), rowid: r['rowid'] === null ? null : BigInt(r['rowid'] as bigint), parent: String(r['parent']) }))
      .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : Number((a.rowid ?? 0n) - (b.rowid ?? 0n))));
  }

  /** Row totals of the tables the replay checks whole. */
  rowTotals(): Readonly<Record<'fill' | 'attempt' | 'reservation' | 'reservation_event', number>> {
    const count = (table: string) => Number(this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()?.['n']);
    return { fill: count('fill'), attempt: count('attempt'), reservation: count('reservation'), reservation_event: count('reservation_event') };
  }

  /** The distinct decision modes stored, sorted. */
  decisionModes(): DecisionMode[] {
    return this.#db.prepare('SELECT DISTINCT mode FROM decision ORDER BY mode').all().map((r) => String(r['mode']) as DecisionMode);
  }

  /** A consistent copy of the whole file (security.md §4.3: hourly VACUUM INTO, then encrypted off-host). */
  snapshotTo(destPath: string): void {
    this.#db.prepare('VACUUM INTO ?').run(destPath);
  }
}

const toAttempt = (r: Row): TransactionAttempt => ({
  id: String(r['attempt_id']),
  intentId: String(r['intent_id']),
  signedBytesRef: String(r['signed_bytes_ref']),
  signature: String(r['signature']),
  blockhash: String(r['blockhash']),
  lastValidBlockHeight: BigInt(r['last_valid_block_height'] as bigint),
  quote: fromJson(r['quote']),
}) as TransactionAttempt;

const toFill = (r: Row): Fill => ({
  intentId: String(r['intent_id']),
  signature: String(r['signature']),
  slot: BigInt(r['slot'] as bigint),
  commitment: String(r['commitment']),
  tokens: amountOf(r['tokens']),
  sol: amountOf(r['sol']),
  fees: amountOf(r['fees']),
}) as Fill;

const INTENT_SELECT = `SELECT i.*, e.status AS status, e.ts AS status_ts FROM intent i
  JOIN intent_event e ON e.seq = (SELECT MAX(seq) FROM intent_event x WHERE x.intent_id = i.intent_id)`;

const toIntentRecord = (r: Row): IntentRecord => {
  const base = {
    id: String(r['intent_id']),
    key: String(r['idem_key']),
    mint: String(r['mint']),
    venue: String(r['venue']),
    positionId: String(r['position_id']),
  };
  const intent = r['purpose'] === 'entry'
    ? { ...base, purpose: 'entry', side: 'buy', spend: amountOf(r['spend']) }
    : { ...base, purpose: 'exit', side: 'sell', quantity: amountOf(r['quantity']) };
  return {
    intent: intent as TradeIntent,
    decisionId: r['decision_id'] === null ? null : BigInt(r['decision_id'] as bigint),
    status: String(r['status']) as IntentStatus,
    statusTs: ms(r['status_ts']),
  };
};

/** A read-only view of a ledger file, for the API and backups. */
export class LedgerReader extends LedgerReads {
  close(): void {
    connectionOf(this).close();
  }
}

/** The single writer. Every write is one BEGIN IMMEDIATE transaction; `atomically` groups several into one. */
export class Ledger extends LedgerReads {
  readonly #release: () => void;

  /** The ledger's file name in the worker's state directory (docs/ARCHITECTURE.md §12.4). */
  static readonly FILE = 'ledger.sqlite';

  constructor(db: DatabaseSync, release: () => void) {
    super(db);
    this.#release = release;
  }

  get #db(): DatabaseSync {
    return connectionOf(this);
  }

  close(): void {
    try {
      this.#db.close();
    } finally {
      this.#release();
    }
  }

  /**
   * Applies one book event with the CORE-1 reducer and writes the rows it changed, in the format the ledger replay
   * check reads (./replay: stepRows decides the rows; the first intent row carries `encodeBookDetail(event)` and the
   * effects; a trigger_exit's position rows carry it too). Atomic: one transaction per call, or, when called inside
   * the caller's transaction (`atomically`), it joins that one, so a refusal or a failed write rolls back the
   * caller's whole batch. An event the reducer refuses throws a LedgerError and writes nothing. Returns the reducer's
   * step (the book after the event and its effects); the caller keeps the book for the next call.
   * The one writer the backtester and the worker share, so their ledgers cannot drift from the replay.
   */
  recordBookEvent(before: Book, event: BookEvent, o: { readonly ts: Millis; readonly limits: ReservationLimits; readonly accountVersion?: bigint }): { readonly book: Book; readonly effects: readonly Effect[] } {
    const step = applyBookEvent(before, event);
    if (isIllegal(step)) throw new LedgerError(`book event ${event.type} refused by the reducer: ${step.reason}`, { code: 'reducer_refused' });
    const book = step.state;
    const rows = stepRows(before, event, step.effects);
    if (rows === null) return { book, effects: step.effects };
    const name = rowEventName(event);
    const ts = o.ts;
    this.atomically(() => {
      rows.intents.forEach((id, k) => {
        const s = book.intents[id]!;
        const was = before.intents[id];
        if (was === undefined) {
          const r = this.recordIntent(s.intent, { status: s.status, ts });
          if (!r.ok) throw new LedgerError(`intent key ${s.intent.key} already used by ${r.existingIntentId}`);
        } else {
          this.appendIntentTransition({ intentId: s.intent.id, status: s.status, event: name, ts, ...(k === 0 ? { detail: encodeBookDetail(event), effects: step.effects } : {}) });
        }
        const known = new Set((was?.attempts ?? []).map((a) => a.signature));
        for (const a of s.attempts) if (!known.has(a.signature)) this.recordAttempt(a, ts);
        const booked = new Set((was?.fills ?? []).map((f) => f.signature));
        for (const f of s.fills) if (!booked.has(f.signature)) this.recordFill(f, ts);
        const r = s.reservation;
        if (r !== null && was?.reservation == null) {
          const res = this.reserveExposure({ reservationId: r.id, intentId: id, amount: r.amount, limits: o.limits, ts, ...(o.accountVersion === undefined ? {} : { accountVersion: o.accountVersion }) });
          if (!res.ok) throw new LedgerError(`reservation ${r.id} refused: ${res.reason}`);
        }
        if (r !== null && r.status !== 'held' && was?.reservation?.status !== r.status) this.endReservation(r.id, r.status, ts);
      });
      for (const pid of rows.positions) {
        const p = book.positions[pid]!;
        if (before.positions[pid] === undefined) {
          this.openPosition({ positionId: pid, mint: p.mint, venue: p.venue, entryIntentId: p.entryIntentId, ts });
          if (p.status === 'opening' && p.quantity === 0n && p.cost === 0n) continue;
        }
        this.appendPositionState({ positionId: pid, status: p.status, quantity: p.quantity, cost: p.cost, event: name, ts, ...(event.type === 'trigger_exit' ? { detail: encodeBookDetail(event) } : {}) });
      }
    });
    return { book, effects: step.effects };
  }

  /** Runs fn as one transaction: either every write inside it lands or none does. */
  atomically<T>(fn: () => T): T {
    return inTransaction(this.#db, fn);
  }

  recordObservation(o: ObservationInput): bigint {
    return this.#insert(`INSERT INTO observation (provider, mint, pool, kind, slot, event_ts, receipt_ts, commitment, payload, quality_flags)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    o.provider, o.mint, o.pool ?? null, o.kind, o.slot ?? null, o.eventTs ?? null, o.receiptTs, o.commitment ?? null,
    toJson(o.payload), JSON.stringify(o.qualityFlags ?? []));
  }

  recordFeatureSnapshot(s: FeatureSnapshotInput): bigint {
    return this.#insert(`INSERT INTO feature_snapshot (mint, pool, venue, quote_mint, decision_ts, as_of_slot, max_receipt_ts,
      featureset_ver, creator_cluster, features, missing, regime_tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    s.mint, s.pool ?? null, s.venue, s.quoteMint, s.decisionTs, s.asOfSlot, s.maxReceiptTs, s.featuresetVer,
    s.creatorCluster ?? null, toJson(s.features), JSON.stringify(s.missing ?? []), JSON.stringify(s.regimeTags ?? []));
  }

  recordDecision(d: DecisionInput): bigint {
    return this.#insert(`INSERT INTO decision (snapshot_id, decided_ts, strategy_ver, model_ver, calib_ver, p_meta, p_severe,
      conformal_thr, action, reasons, mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    d.snapshotId, d.decidedTs, d.strategyVer, d.modelVer ?? null, d.calibVer ?? null, d.pMeta ?? null, d.pSevere ?? null,
    d.conformalThr ?? null, d.action, JSON.stringify(d.reasons), d.mode);
  }

  /**
   * Records a new intent with its first status. A second intent with the same idempotency key is refused
   * and nothing is written.
   */
  recordIntent(intent: TradeIntent, first: { readonly status: IntentStatus; readonly decisionId?: bigint | null; readonly ts: Millis }): RecordIntentResult {
    return this.atomically(() => {
      const existing = this.#db.prepare('SELECT intent_id FROM intent WHERE idem_key = ?').get(intent.key);
      if (existing !== undefined) return { ok: false, reason: 'duplicate_key', existingIntentId: String(existing['intent_id']) };
      this.#db.prepare(`INSERT INTO intent (intent_id, idem_key, purpose, side, mint, venue, position_id, spend, quantity, decision_id, created_ts)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        intent.id, intent.key, intent.purpose, intent.side, intent.mint, intent.venue, intent.positionId,
        intent.purpose === 'entry' ? amountText(intent.spend) : null,
        intent.purpose === 'exit' ? amountText(intent.quantity) : null,
        first.decisionId ?? null, first.ts);
      this.appendIntentTransition({ intentId: intent.id, status: first.status, event: 'created', ts: first.ts });
      return { ok: true };
    });
  }

  /** Appends a status change and queues its effects in the outbox, in one transaction. */
  appendIntentTransition(t: IntentTransition): void {
    this.atomically(() => {
      this.#db.prepare('INSERT INTO intent_event (intent_id, status, event, detail, ts) VALUES (?, ?, ?, ?, ?)')
        .run(t.intentId, t.status, t.event, t.detail === undefined ? null : toJson(t.detail), t.ts);
      for (const effect of t.effects ?? []) {
        if (effect.type === 'persist') continue; // this write is the persist
        this.#db.prepare('INSERT INTO outbox (intent_id, effect_type, effect, created_ts) VALUES (?, ?, ?, ?)')
          .run(t.intentId, effect.type, toJson(effect), t.ts);
      }
    });
  }

  /**
   * Reserves exposure for an entry intent. The version check, the limit check and the insert run in one BEGIN
   * IMMEDIATE transaction, so concurrent attempts, or two decided from one snapshot, can never together exceed the
   * limits. An optional transition
   * (normally to `exposure_reserved`) is written in the same transaction.
   */
  reserveExposure(r: {
    readonly reservationId: string;
    readonly intentId: string;
    readonly amount: Lamports;
    readonly limits: ReservationLimits;
    readonly ts: Millis;
    /**
     * The account version of the risk snapshot this reservation was decided on (RISK-1 `ReservationRequest`). Refused
     * as `stale_snapshot` if the account changed since. Every risk-gated entry passes it; only a mirror of decisions
     * already made (the backtest sink) may leave it out.
     */
    readonly accountVersion?: bigint;
    readonly transition?: Omit<IntentTransition, 'intentId' | 'ts'>;
  }): ReserveResult {
    return this.atomically(() => {
      const result = reserveIn(this.#db, r);
      if (result.ok && r.transition !== undefined) this.appendIntentTransition({ ...r.transition, intentId: r.intentId as TradeIntent['id'], ts: r.ts });
      return result;
    });
  }

  /** Ends a held reservation: released (returned unused) or kept (became a position). Ending twice is refused. */
  endReservation(reservationId: string, status: 'released' | 'kept', ts: Millis): void {
    this.#insert('INSERT INTO reservation_event (reservation_id, status, ts) VALUES (?, ?, ?)', reservationId, status, ts);
  }

  /** Stores a signed attempt. Must commit before the first broadcast of these bytes. */
  recordAttempt(a: TransactionAttempt, ts: Millis): void {
    this.#insert(`INSERT INTO attempt (attempt_id, intent_id, signed_bytes_ref, signature, blockhash, last_valid_block_height, quote, created_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    a.id, a.intentId, a.signedBytesRef, a.signature, a.blockhash, a.lastValidBlockHeight, toJson(a.quote), ts);
  }

  recordFill(f: Fill, ts: Millis): void {
    this.#insert(`INSERT INTO fill (intent_id, signature, slot, commitment, tokens, sol, fees, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      f.intentId, f.signature, f.slot, f.commitment, amountText(f.tokens), amountText(f.sol), amountText(f.fees), ts);
  }

  recordFee(fee: { readonly intentId?: string | null; readonly signature?: string | null; readonly kind: FeeKind; readonly lamports: Lamports; readonly ts: Millis }): void {
    this.#insert('INSERT INTO fee (intent_id, signature, kind, lamports, ts) VALUES (?, ?, ?, ?, ?)',
      fee.intentId ?? null, fee.signature ?? null, fee.kind, amountText(fee.lamports), fee.ts);
  }

  openPosition(p: { readonly positionId: string; readonly mint: string; readonly venue: TradeIntent['venue']; readonly entryIntentId: string; readonly ts: Millis }): void {
    this.atomically(() => {
      this.#insert('INSERT INTO position (position_id, mint, venue, entry_intent_id, created_ts) VALUES (?, ?, ?, ?, ?)',
        p.positionId, p.mint, p.venue, p.entryIntentId, p.ts);
      this.appendPositionState({ positionId: p.positionId, status: 'opening', quantity: 0n, cost: 0n as Lamports, event: 'created', ts: p.ts });
    });
  }

  appendPositionState(s: { readonly positionId: string; readonly status: PositionStatus; readonly quantity: bigint; readonly cost: Lamports; readonly event: string; readonly detail?: unknown; readonly ts: Millis }): void {
    this.#insert('INSERT INTO position_event (position_id, status, quantity, cost, event, detail, ts) VALUES (?, ?, ?, ?, ?, ?, ?)',
      s.positionId, s.status, amountText(s.quantity), amountText(s.cost), s.event, s.detail === undefined ? null : toJson(s.detail), s.ts);
  }

  /** Marks an outbox item handled. Marking twice is refused, so an effect is never reported done twice. */
  completeOutbox(outboxId: bigint, result: 'done' | 'skipped', ts: Millis, detail?: unknown): void {
    this.#insert('INSERT INTO outbox_done (outbox_id, result, detail, ts) VALUES (?, ?, ?, ?)',
      outboxId, result, detail === undefined ? null : toJson(detail), ts);
  }

  /** Records an operator command with its auth level. The schema refuses anything but pause from Telegram. */
  recordCommand(c: OperatorCommandInput): void {
    this.#insert('INSERT INTO operator_command (command_id, command, args, auth_level, issued_by, issued_ts) VALUES (?, ?, ?, ?, ?, ?)',
      c.commandId, c.command, toJson(c.args ?? {}), c.authLevel, c.issuedBy, c.issuedTs);
  }

  recordCommandResult(commandId: string, accepted: boolean, reason: string, ts: Millis): void {
    this.#insert('INSERT INTO command_result (command_id, accepted, reason, ts) VALUES (?, ?, ?, ?)', commandId, accepted ? 1 : 0, reason, ts);
  }

  #insert(sql: string, ...params: SQLInputValue[]): bigint {
    return this.atomically(() => BigInt(this.#db.prepare(sql).run(...params).lastInsertRowid));
  }
}

/** Limits come from configuration at runtime; a missing or malformed limit must stop the trade, never let it through. */
const checkLimits = (limits: ReservationLimits): void => {
  const { maxHeld, maxCount } = limits ?? ({} as Partial<ReservationLimits>);
  if (typeof maxHeld !== 'bigint' || maxHeld < 0n) throw new LedgerError(`maxHeld must be a bigint >= 0, got ${String(maxHeld)}`);
  if (!Number.isSafeInteger(maxCount) || maxCount < 1) throw new LedgerError(`maxCount must be a safe integer >= 1, got ${String(maxCount)}`);
};

/**
 * Tables whose rows change a risk snapshot: reservations and their ends (held exposure, unresolved entries, entries
 * per day), fills and fees (closed trades and P&L), positions and their states (open positions), and operator
 * commands with their results (the owner's re-arms and reviews). All are append-only, so the sum of their row counts
 * only ever rises: it is the account version. Intents, intent events and attempts are left out: an entry writes them
 * itself between its decision and its reservation, and an unresolved entry is already counted by its reservation.
 * Market data (observations, marks) is not an account change; see docs/DECISIONS.md (LEDGER-1c) for why a mark
 * cannot change an allowed reservation.
 */
export const ACCOUNT_VERSION_TABLES = [
  'reservation', 'reservation_event', 'fill', 'fee', 'position', 'position_event', 'operator_command', 'command_result',
] as const;

const ACCOUNT_VERSION_SQL = `SELECT ${ACCOUNT_VERSION_TABLES.map((t) => `(SELECT count(*) FROM ${t})`).join(' + ')} AS v`;

export const accountVersionIn = (db: DatabaseSync): bigint => BigInt(db.prepare(ACCOUNT_VERSION_SQL).get()?.['v'] as number);

/**
 * The reservation check and insert. Must run inside BEGIN IMMEDIATE (the caller's transaction): the
 * write lock is taken before the version and the held total are read, so no other connection can change the
 * account or reserve in between.
 */
export const reserveIn = (db: DatabaseSync, r: { readonly reservationId: string; readonly intentId: string; readonly amount: Lamports; readonly limits: ReservationLimits; readonly ts: Millis; readonly accountVersion?: bigint }): ReserveResult => {
  if (!db.isTransaction) throw new LedgerError('reserveIn must run inside a transaction');
  checkLimits(r.limits);
  if (r.amount <= 0n) throw new LedgerError('a reservation must be positive');
  if (r.accountVersion !== undefined && accountVersionIn(db) !== r.accountVersion) return { ok: false, reason: 'stale_snapshot' };
  const intent = db.prepare('SELECT purpose FROM intent WHERE intent_id = ?').get(r.intentId);
  if (intent === undefined) return { ok: false, reason: 'unknown_intent' };
  if (intent['purpose'] !== 'entry') return { ok: false, reason: 'not_an_entry' };
  if (db.prepare('SELECT 1 FROM reservation WHERE intent_id = ?').get(r.intentId) !== undefined) return { ok: false, reason: 'already_reserved' };
  const held = db.prepare(`SELECT amount FROM reservation r
    WHERE NOT EXISTS (SELECT 1 FROM reservation_event e WHERE e.reservation_id = r.reservation_id)`).all().map((x) => amountOf(x['amount']));
  if (held.length + 1 > r.limits.maxCount) return { ok: false, reason: 'too_many' };
  const after = held.reduce((t, a) => t + a, 0n) + r.amount;
  if (after > r.limits.maxHeld) return { ok: false, reason: 'over_limit' };
  db.prepare('INSERT INTO reservation (reservation_id, intent_id, amount, created_ts) VALUES (?, ?, ?, ?)')
    .run(r.reservationId, r.intentId, amountText(r.amount), r.ts);
  return { ok: true, heldAfter: after as Lamports };
};

/**
 * Opens (or creates) a ledger file as its one writer. A new file is stamped with its purpose; an
 * existing file must match it, so a backtest can never write into the live ledger.
 */
export const openLedger = (path: string, purpose: LedgerPurpose): Ledger => {
  const { db, release } = openWriter(path, 'ledger', LEDGER_MIGRATIONS);
  const ledger = new Ledger(db, release);
  try {
    ledger.atomically(() => {
      const row = db.prepare("SELECT value FROM ledger_meta WHERE key = 'purpose'").get();
      if (row === undefined) db.prepare("INSERT INTO ledger_meta (key, value) VALUES ('purpose', ?)").run(purpose);
      else if (row['value'] !== purpose) throw new LedgerError(`${path} is a ${String(row['value'])} ledger, not ${purpose}`);
    });
    return ledger;
  } catch (err) {
    ledger.close();
    throw err;
  }
};

export const openLedgerReader = (path: string): LedgerReader => new LedgerReader(openReader(path, 'ledger', LEDGER_MIGRATIONS));
