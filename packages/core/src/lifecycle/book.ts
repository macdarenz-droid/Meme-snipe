// The book ties intents, positions and SOL reservations together and enforces the cross-entity rules:
// one live entry intent, one exit owner per position, entries blocked while paused or recovering,
// protective exits never blocked by a pause.

import type { Lamports, RawAmount } from '../units/index.ts';
import { exitKey, positionId, type Commitment, type EntryIntent, type Fill, type IntentId, type PositionId, type Signature } from '../domain/index.ts';
import {
  applyIntentEvent, filledSol, filledTokens, heldReservation, isTerminal, isUnresolved, newEntryIntent, newExitIntent,
  type IntentEvent, type IntentState,
} from './intent.ts';
import { applyPositionEvent, newPosition, type ExitReason, type PositionEvent, type PositionState } from './position.ts';
import { illegal, isIllegal, type Effect, type IllegalTransition, type Transition } from './types.ts';

export type PauseReason = 'daily_loss' | 'session_loss' | 'owner';

/** Owner configuration. Code never raises it; only the owner does (CLAUDE.md, "Capital and trade size scale"). */
export interface BookConfig {
  /** Positions not yet closed, counting an unresolved entry's opening position. */
  readonly maxOpenPositions: number;
}

export interface Book {
  readonly config: BookConfig;
  readonly intents: Readonly<Record<string, IntentState>>;
  readonly positions: Readonly<Record<string, PositionState>>;
  /** SOL held by entry reservations. Equals the sum of held reservations. */
  readonly reserved: Lamports;
  /** Entries are blocked while any pause is set. Exits are never blocked by a pause. */
  readonly paused: readonly PauseReason[];
  /** Set by a restart; clears once no intent is unresolved. */
  readonly recovering: boolean;
  /** Landings reported for ended intents, keyed by signature, waiting for a wallet reconciliation. Entries are blocked meanwhile. */
  readonly orphans: Readonly<Record<string, { readonly intentId: IntentId; readonly signature: Signature }>>;
}

export type BookEvent =
  | { readonly type: 'propose_entry'; readonly intent: EntryIntent }
  | { readonly type: 'intent'; readonly intentId: IntentId; readonly event: Exclude<IntentEvent, { type: 'restart' | 'tick' | 'book_orphan' }> }
  /** The wallet reconciliation for a late landing of an ended intent: book the tokens it moved. */
  | { readonly type: 'orphan_fill'; readonly fill: Fill }
  /** The reported landing was on a dropped fork: clear it, only with proof (see OrphanClearProof). */
  | { readonly type: 'orphan_cleared'; readonly signature: Signature; readonly proof: OrphanClearProof }
  | { readonly type: 'trigger_exit'; readonly positionId: PositionId; readonly reasons: readonly ExitReason[]; readonly intentId: IntentId; readonly quantity?: RawAmount }
  | { readonly type: 'exit_blocked'; readonly positionId: PositionId; readonly reason: string }
  | { readonly type: 'tick'; readonly blockHeight: bigint }
  | { readonly type: 'restart' }
  | { readonly type: 'pause_entries'; readonly reason: PauseReason }
  | { readonly type: 'resume_entries'; readonly reason: PauseReason };

/**
 * Proof that a reported landing never happened on the surviving chain. All must hold:
 * balances unchanged at finalized, and a finalized status read that either failed or, with a history search,
 * found nothing once the *finalized* block height is past the attempt's last valid height. The finalized
 * height matters: a landing just before expiry is not finalized yet, and a finalized read would miss it.
 */
export interface OrphanClearProof {
  /** The signature these reads were taken for; must match the landing being cleared. */
  readonly signature: Signature;
  readonly balances: 'unchanged' | 'changed';
  readonly commitment: Commitment;
  readonly status: 'not_found' | 'failed' | 'succeeded';
  readonly searchedHistory: boolean;
  /** The finalized block height when the reads were taken (not the confirmed height). */
  readonly finalizedBlockHeight: bigint;
}

export const isOrphanClearProven = (proof: OrphanClearProof, lastValidBlockHeight: bigint): boolean =>
  proof.commitment === 'finalized' && proof.balances === 'unchanged' &&
  (proof.status === 'failed' || (proof.status === 'not_found' && proof.searchedHistory && proof.finalizedBlockHeight > lastValidBlockHeight));

export const emptyBook = (config: BookConfig): Book => {
  if (!Number.isSafeInteger(config.maxOpenPositions) || config.maxOpenPositions < 1) {
    throw new RangeError(`maxOpenPositions must be an integer >= 1, got ${config.maxOpenPositions}`);
  }
  return { config, intents: {}, positions: {}, reserved: 0n as Lamports, paused: [], recovering: false, orphans: {} };
};

export type EntryBlock = 'paused' | 'recovering' | 'unresolved_intent' | 'unbooked_landing' | 'entry_in_progress' | 'position_limit';

/**
 * May a new entry intent be created now? Blocked while paused, while recovering from a restart,
 * while any intent is unresolved, while a late landing waits to be booked, while another entry is live,
 * or at the configured open-position limit.
 */
export const canOpenNewEntry = (book: Book): { readonly ok: true } | { readonly ok: false; readonly reasons: readonly EntryBlock[] } => {
  const max = book.config.maxOpenPositions;
  const intents = Object.values(book.intents);
  const reasons: EntryBlock[] = [];
  if (book.paused.length > 0) reasons.push('paused');
  if (book.recovering) reasons.push('recovering');
  if (intents.some(isUnresolved)) reasons.push('unresolved_intent');
  if (Object.keys(book.orphans).length > 0) reasons.push('unbooked_landing');
  if (intents.some((i) => i.intent.purpose === 'entry' && !isTerminal(i))) reasons.push('entry_in_progress');
  if (Object.values(book.positions).filter((p) => p.status !== 'closed').length >= max) reasons.push('position_limit');
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
};

/** Live = not terminal. At most one live entry intent, and at most one live exit intent per position. */
export const liveIntents = (book: Book): IntentState[] => Object.values(book.intents).filter((i) => !isTerminal(i));

const ENTRY_GATED: ReadonlySet<IntentEvent['type']> = new Set(['mark_eligible', 'approve_risk', 'reserve_exposure', 'prepare', 'sign', 'submit', 'sign_replacement']);

const persistBook: Effect = { type: 'persist', entity: 'book', id: 'book' };

const settle = (book: Book): Book => (book.recovering && !Object.values(book.intents).some(isUnresolved) ? { ...book, recovering: false } : book);

/** Apply an intent result to the book: reservation totals and the linked position. */
const linkIntent = (book: Book, before: IntentState, after: IntentState, effects: Effect[]): Book | IllegalTransition => {
  const fail = (reason: string) => illegal(before.status, 'link', reason);
  const delta = (heldReservation(after) ?? 0n) - (heldReservation(before) ?? 0n);
  const reserved = book.reserved + delta;
  if (reserved < 0n) return fail('reserved exposure would go negative');
  let positions = book.positions;
  let orphans = book.orphans;
  for (const fx of [...effects]) {
    if (fx.type === 'reconcile_orphan' && orphans[fx.signature] === undefined) {
      orphans = { ...orphans, [fx.signature]: { intentId: fx.intentId, signature: fx.signature } };
      effects.push({ type: 'persist', entity: 'book', id: 'book' });
    }
  }
  const pid = after.intent.positionId;
  const movePosition = (event: PositionEvent): IllegalTransition | null => {
    const p = positions[pid];
    if (p === undefined) return fail('position missing');
    const r = applyPositionEvent(p, event);
    if (isIllegal(r)) return r;
    positions = { ...positions, [pid]: r.state };
    effects.push(...r.effects);
    return null;
  };
  const changed = after.status !== before.status;
  const ended = changed && (after.status === 'cancelled' || after.status === 'abandoned');
  const filled = changed && after.status === 'reconciled' && after.fills.length > 0;

  if (after.intent.purpose === 'entry') {
    // Supervise from the moment the entry may have landed.
    if (isUnresolved(after) && positions[pid] === undefined) {
      positions = { ...positions, [pid]: newPosition({ id: pid, mint: after.intent.mint, venue: after.intent.venue, entryIntentId: after.intent.id }) };
      effects.push({ type: 'persist', entity: 'position', id: pid });
    }
    if (filled) {
      const err = movePosition({ type: 'entry_filled', quantity: filledTokens(after) as RawAmount, cost: filledSol(after) as Lamports });
      if (err) return err;
    }
    if (ended && positions[pid]?.status === 'opening') {
      const err = movePosition({ type: 'entry_unfilled' });
      if (err) return err;
    }
  } else {
    if (changed && after.status === 'submitted' && positions[pid]?.status === 'exit_requested') {
      const err = movePosition({ type: 'exit_submitted' });
      if (err) return err;
    }
    if (filled) {
      const err = movePosition({ type: 'exit_filled', sold: filledTokens(after) as RawAmount });
      if (err) return err;
    }
    if (ended && positions[pid]?.exitOwner?.intentId === after.intent.id) {
      const err = movePosition({ type: 'exit_unfilled' });
      if (err) return err;
    }
  }
  return { ...book, reserved: reserved as Lamports, positions, orphans };
};

const applyToIntent = (book: Book, id: IntentId, event: IntentEvent): Transition<Book> => {
  const before = book.intents[id];
  if (before === undefined) return illegal('none', event.type, 'unknown intent');
  const r = applyIntentEvent(before, event);
  if (isIllegal(r)) return r;
  const effects = [...r.effects];
  const linked = linkIntent({ ...book, intents: { ...book.intents, [id]: r.state } }, before, r.state, effects);
  if ('illegal' in linked) return linked;
  return { state: linked, effects };
};

export const applyBookEvent = (book: Book, e: BookEvent): Transition<Book> => {
  const result = step(book, e);
  return isIllegal(result) ? result : { state: settle(result.state), effects: result.effects };
};

const step = (book: Book, e: BookEvent): Transition<Book> => {
  switch (e.type) {
    case 'propose_entry': {
      const gate = canOpenNewEntry(book);
      if (!gate.ok) return illegal('book', e.type, `entry blocked: ${gate.reasons.join(', ')}`);
      const i = e.intent;
      if (book.intents[i.id] !== undefined) return illegal('book', e.type, 'intent id already used');
      if (Object.values(book.intents).some((x) => x.intent.key === i.key)) return illegal('book', e.type, 'idempotency key already used');
      if (book.positions[i.positionId] !== undefined) return illegal('book', e.type, 'position id already used');
      if (i.spend <= 0n) return illegal('book', e.type, 'spend must be positive');
      return { state: { ...book, intents: { ...book.intents, [i.id]: newEntryIntent(i) } }, effects: [{ type: 'persist', entity: 'intent', id: i.id }] };
    }

    case 'intent': {
      const current = book.intents[e.intentId];
      if (current?.intent.purpose === 'entry' && ENTRY_GATED.has(e.event.type)) {
        if (book.paused.length > 0) return illegal(current.status, e.event.type, 'entries paused');
        if (book.recovering) return illegal(current.status, e.event.type, 'recovering after restart');
      }
      return applyToIntent(book, e.intentId, e.event);
    }

    case 'trigger_exit': {
      const p = book.positions[e.positionId];
      if (p === undefined) return illegal('none', e.type, 'unknown position');
      const r = applyPositionEvent(p, e.quantity === undefined
        ? { type: 'exit_triggered', reasons: e.reasons, intentId: e.intentId }
        : { type: 'exit_triggered', reasons: e.reasons, intentId: e.intentId, quantity: e.quantity });
      if (isIllegal(r)) return r;
      let intents = book.intents;
      const effects: Effect[] = [];
      for (const fx of r.effects) {
        if (fx.type !== 'request_exit') {
          effects.push(fx);
          continue;
        }
        if (intents[fx.intentId] !== undefined) return illegal(p.status, e.type, 'intent id already used');
        intents = {
          ...intents,
          [fx.intentId]: newExitIntent({
            id: fx.intentId, key: exitKey(p.id, r.state.exitSeq), purpose: 'exit', side: 'sell',
            mint: p.mint, venue: p.venue, positionId: p.id, quantity: fx.quantity,
          }),
        };
        effects.push({ type: 'persist', entity: 'intent', id: fx.intentId });
      }
      return { state: { ...book, intents, positions: { ...book.positions, [p.id]: r.state } }, effects };
    }

    case 'exit_blocked': {
      const p = book.positions[e.positionId];
      if (p === undefined) return illegal('none', e.type, 'unknown position');
      const owner = p.exitOwner;
      let intents = book.intents;
      const effects: Effect[] = [];
      if (owner !== null) {
        const i = intents[owner.intentId];
        if (i === undefined) return illegal(p.status, e.type, 'exit owner intent missing');
        // Blocked is only honest when no transaction of this exit can still land.
        const end = i.status === 'reconciled' && i.fills.length === 0 ? 'abandon' : 'cancel';
        if (isUnresolved(i) || (i.status === 'reconciled' && i.fills.length > 0)) return illegal(p.status, e.type, 'exit transaction may still land or already filled; resolve it first');
        const r = applyIntentEvent(i, { type: end });
        if (isIllegal(r)) return r;
        intents = { ...intents, [i.intent.id]: r.state };
        effects.push(...r.effects);
      }
      const r = applyPositionEvent(p, { type: 'exit_blocked', reason: e.reason });
      if (isIllegal(r)) return r;
      return { state: { ...book, intents, positions: { ...book.positions, [p.id]: r.state } }, effects: [...effects, ...r.effects] };
    }

    case 'tick': {
      const effects: Effect[] = [];
      for (const i of Object.values(book.intents)) {
        const r = applyIntentEvent(i, e);
        if (!isIllegal(r)) effects.push(...r.effects);
      }
      for (const o of Object.values(book.orphans)) effects.push({ type: 'reconcile_orphan', intentId: o.intentId, signature: o.signature });
      return { state: book, effects };
    }

    case 'orphan_cleared': {
      const o = book.orphans[e.signature];
      if (o === undefined) return illegal('book', e.type, 'no unbooked landing for this signature');
      const a = book.intents[o.intentId]?.attempts.find((x) => x.signature === e.signature);
      if (a === undefined) return illegal('book', e.type, 'attempt missing');
      if (e.proof.signature !== e.signature) return illegal('book', e.type, 'proof was read for another signature');
      if (!isOrphanClearProven(e.proof, a.lastValidBlockHeight)) {
        return illegal('book', e.type, 'needs unchanged balances and a failed or expired not-found status, all at finalized');
      }
      const { [e.signature]: _cleared, ...orphans } = book.orphans;
      return {
        state: { ...book, orphans },
        effects: [persistBook, { type: 'alert', level: 'warn', code: 'orphan_cleared', subject: o.intentId }],
      };
    }

    case 'orphan_fill': {
      // Accepted whether or not a status read reported the landing first (a wallet sweep may find it).
      const i = book.intents[e.fill.intentId];
      if (i === undefined) return illegal('none', e.type, 'unknown intent');
      const r = applyIntentEvent(i, { type: 'book_orphan', fill: e.fill });
      if (isIllegal(r)) return r;
      const effects: Effect[] = [...r.effects];
      let positions = book.positions;
      if (i.intent.purpose === 'entry') {
        // Bought tokens get their own open position, so exits can protect them at once.
        const id = positionId(`${i.intent.positionId}.o${r.state.fills.length}`);
        if (positions[id] !== undefined) return illegal(i.status, e.type, 'late-landing position id already used');
        const opened = applyPositionEvent(newPosition({ id, mint: i.intent.mint, venue: i.intent.venue, entryIntentId: i.intent.id }), {
          type: 'entry_filled', quantity: e.fill.tokens, cost: e.fill.sol,
        });
        if (isIllegal(opened)) return opened;
        positions = { ...positions, [id]: opened.state };
        effects.push(...opened.effects);
      } else {
        const p = positions[i.intent.positionId];
        if (p === undefined) return illegal(i.status, e.type, 'position missing');
        const sold = applyPositionEvent(p, { type: 'external_sale', sold: e.fill.tokens });
        if (isIllegal(sold)) return sold;
        positions = { ...positions, [p.id]: sold.state };
        effects.push(...sold.effects);
      }
      const { [e.fill.signature]: _booked, ...orphans } = book.orphans;
      return {
        state: { ...book, intents: { ...book.intents, [i.intent.id]: r.state }, positions, orphans },
        effects: [...effects, persistBook],
      };
    }

    case 'restart': {
      let next: Book = book;
      const effects: Effect[] = [];
      for (const i of Object.values(book.intents)) {
        const r = applyToIntent(next, i.intent.id, { type: 'restart' });
        if (isIllegal(r)) return r;
        next = r.state;
        effects.push(...r.effects);
      }
      const recovering = Object.values(next.intents).some(isUnresolved);
      if (recovering) effects.push({ type: 'alert', level: 'warn', code: 'restart_recovery', subject: 'book' });
      return { state: { ...next, recovering }, effects: [persistBook, ...effects] };
    }

    case 'pause_entries':
      return book.paused.includes(e.reason)
        ? { state: book, effects: [] }
        : { state: { ...book, paused: [...book.paused, e.reason] }, effects: [persistBook] };

    case 'resume_entries':
      return book.paused.includes(e.reason)
        ? { state: { ...book, paused: book.paused.filter((r) => r !== e.reason) }, effects: [persistBook] }
        : { state: book, effects: [] };
  }
};
