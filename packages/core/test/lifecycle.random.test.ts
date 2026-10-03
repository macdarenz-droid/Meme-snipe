// Seeded randomised sequences over the whole book. The allowed-edge tables below are written from
// docs/ARCHITECTURE.md ("Durable order state and recovery"), independently of the implementation.
import { describe, expect, test } from 'vitest';
import { lamports, raw } from '../src/units/index.ts';
import { intentId } from '../src/domain/index.ts';
import {
  applyBookEvent, canOpenNewEntry, emptyBook, heldReservation, INTENT_STATUSES, isIllegal, isTerminal, POSITION_STATUSES,
  type Book, type BookEvent, type ExitReason, type IntentState, type IntentStatus, type PositionStatus, type SignatureResult,
} from '../src/lifecycle/index.ts';
import { attempt, entryIntent, fill, quote, reservation, sig, SPEND } from './fixtures.ts';

const INTENT_EDGES: Record<IntentStatus, readonly IntentStatus[]> = {
  candidate: ['eligible', 'rejected', 'cancelled'],
  eligible: ['risk_approved', 'rejected', 'cancelled'],
  risk_approved: ['exposure_reserved', 'rejected', 'cancelled'],
  exposure_reserved: ['prepared', 'cancelled'],
  prepared: ['signed', 'cancelled'],
  signed: ['submitted', 'cancelled', 'unknown'], // unknown: restart, the bytes may have left
  submitted: ['pending', 'unknown', 'confirmed_fill', 'failed', 'expired_unfilled'],
  pending: ['unknown', 'confirmed_fill', 'failed', 'expired_unfilled'],
  unknown: ['confirmed_fill', 'failed', 'expired_unfilled'],
  confirmed_fill: ['reconciled'],
  failed: ['reconciled', 'cancelled'], // cancelled: cancel was requested and balances show no fill
  expired_unfilled: ['reconciled', 'cancelled', 'confirmed_fill'], // confirmed_fill: late landing seen
  reconciled: ['signed', 'abandoned', 'cancelled'], // only when reconciled without a fill
  rejected: [],
  cancelled: [],
  abandoned: [],
};

const POSITION_EDGES: Record<PositionStatus, readonly PositionStatus[]> = {
  opening: ['open', 'closed'],
  open: ['exit_requested'],
  exit_requested: ['exit_pending', 'open', 'closed', 'exit_blocked'],
  exit_pending: ['open', 'closed', 'exit_blocked'],
  exit_blocked: ['exit_requested'],
  closed: [],
};

const GATED_ENTRY_EDGES = new Set(['candidate>eligible', 'eligible>risk_approved', 'risk_approved>exposure_reserved', 'exposure_reserved>prepared', 'prepared>signed', 'signed>submitted', 'reconciled>signed']);

/** mulberry32: small, seeded, deterministic. */
const rng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const REASONS: readonly ExitReason[] = ['stop', 'trailing_stop', 'take_profit', 'max_hold', 'thesis_lost', 'liquidity', 'emergency'];
const RESULTS: readonly SignatureResult[] = ['processed', 'confirmed', 'finalized', 'failed', 'not_found'];

interface World { book: Book; height: bigint; n: number }

const generator = (seed: number) => {
  const r = rng(seed);
  const int = (max: number) => Math.floor(r() * max);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  const chance = (p: number) => r() < p;

  const sigOf = (i: IntentState) => (i.attempts.length > 0 && chance(0.95) ? pick(i.attempts).signature : sig(900_000 + int(5)));
  const newAttempt = (w: World, i: IntentState) => {
    if (i.attempts.length > 0 && chance(0.05)) return i.attempts[0]!; // a known signature must be refused
    return attempt(chance(0.97) ? i.intent.id : intentId('e999'), ++w.n, w.height + BigInt(int(150)));
  };
  const tokensFor = (w: World, i: IntentState): bigint => {
    if (i.intent.purpose === 'exit') {
      const q = i.intent.quantity;
      return chance(0.8) ? q - BigInt(int(Number(q > 3n ? 3n : q))) : q + BigInt(1 + int(5)); // sometimes oversell
    }
    return BigInt(1 + int(10_000));
  };

  const intentEvent = (w: World, i: IntentState): Extract<BookEvent, { type: 'intent' }>['event'] => {
    const natural = chance(0.7);
    const s = i.status;
    if (natural) {
      switch (s) {
        case 'candidate': return chance(0.9) ? { type: 'mark_eligible' } : { type: 'reject', reason: 'gate' };
        case 'eligible': return { type: 'approve_risk' };
        case 'risk_approved': return { type: 'reserve_exposure', reservation: reservation(i.intent.id, chance(0.9) ? SPEND : lamports(int(2))) };
        case 'exposure_reserved': return { type: 'prepare', quote };
        case 'prepared': return { type: 'sign', attempt: newAttempt(w, i) };
        case 'signed': return { type: 'submit' };
        case 'submitted': return pick([{ type: 'send_accepted' }, { type: 'send_timeout' }, { type: 'send_error', message: 'x' }] as const);
        case 'pending':
        case 'unknown':
          return { type: 'status', signature: sigOf(i), result: pick(RESULTS), blockHeight: w.height, searchedHistory: chance(0.7) };
        case 'confirmed_fill': return { type: 'reconcile', fill: chance(0.9) ? fill(i.intent.id, 0, 1n) : null }; // fill patched by realFill
        case 'failed':
        case 'expired_unfilled':
          return { type: 'reconcile', fill: chance(0.85) ? null : fill(i.intent.id, 0, 1n) };
        case 'reconciled': return chance(0.6) ? { type: 'sign_replacement', attempt: newAttempt(w, i) } : { type: 'abandon' };
        default: return { type: 'cancel' };
      }
    }
    return pick([
      { type: 'mark_eligible' }, { type: 'reject', reason: 'r' }, { type: 'approve_risk' },
      { type: 'reserve_exposure', reservation: reservation(i.intent.id) }, { type: 'prepare', quote },
      { type: 'sign', attempt: newAttempt(w, i) }, { type: 'submit' }, { type: 'send_accepted' }, { type: 'send_timeout' },
      { type: 'status', signature: sigOf(i), result: pick(RESULTS), blockHeight: w.height, searchedHistory: chance(0.5) },
      { type: 'reconcile', fill: null }, { type: 'sign_replacement', attempt: newAttempt(w, i) }, { type: 'abandon' }, { type: 'cancel' },
    ] as const);
  };

  /** Fill fixtures need a real attempt signature; patch them here with the intent's own attempts. */
  const realFill = (w: World, i: IntentState, e: Extract<BookEvent, { type: 'intent' }>['event']) => {
    if (e.type !== 'reconcile' || e.fill === null) return e;
    const a = i.attempts.length > 0 ? pick(i.attempts) : undefined;
    const n = a ? Number(a.id.slice(1)) : 777_777;
    return { type: 'reconcile' as const, fill: fill(chance(0.97) ? i.intent.id : intentId('e999'), n, tokensFor(w, i)) };
  };

  const next = (w: World): BookEvent => {
    const intents = Object.values(w.book.intents);
    const positions = Object.values(w.book.positions);
    const roll = r();
    if (roll < 0.08) {
      const k = ++w.n;
      const intent = entryIntent(k, chance(0.03) && intents.length > 0 ? 'd1' : `d${k}`);
      return { type: 'propose_entry', intent };
    }
    if (roll < 0.62 && intents.length > 0) {
      const live = intents.filter((i) => !isTerminal(i));
      const i = live.length > 0 && chance(0.9) ? pick(live) : pick(intents);
      return { type: 'intent', intentId: i.intent.id, event: realFill(w, i, intentEvent(w, i)) };
    }
    if (roll < 0.74 && positions.length > 0) {
      const p = pick(positions);
      const reasons = REASONS.filter(() => chance(0.3));
      const base = { type: 'trigger_exit' as const, positionId: p.id, reasons: reasons.length > 0 ? reasons : ['stop' as const], intentId: intentId(`x${++w.n}`) };
      return chance(0.3) ? { ...base, quantity: raw(BigInt(1 + int(12_000))) } : base;
    }
    if (roll < 0.78 && positions.length > 0) return { type: 'exit_blocked', positionId: pick(positions).id, reason: 'no liquidity' };
    if (roll < 0.9) {
      w.height += BigInt(int(80));
      return { type: 'tick', blockHeight: w.height };
    }
    if (roll < 0.93) return { type: 'restart' };
    if (roll < 0.965) return { type: 'pause_entries', reason: 'daily_loss' };
    return { type: 'resume_entries', reason: 'daily_loss' };
  };
  return next;
};

const check = (w: World, before: Book, e: BookEvent, after: Book, effects: readonly { type: string }[]) => {
  const fail = (msg: string) => { throw new Error(`${msg} after ${JSON.stringify(e, (_, v) => (typeof v === 'bigint' ? `${v}n` : v))}`); };

  for (const [id, a] of Object.entries(after.intents)) {
    if (!INTENT_STATUSES.includes(a.status)) fail(`invalid intent status ${a.status}`);
    const b = before.intents[id];
    if (b === undefined) {
      const ok = (a.intent.purpose === 'entry' && a.status === 'candidate') || (a.intent.purpose === 'exit' && a.status === 'exposure_reserved');
      if (!ok) fail(`intent ${id} created in ${a.status}`);
      if (a.intent.purpose === 'entry' && before.paused.length > 0) fail('entry created while paused');
      continue;
    }
    if (b.status !== a.status) {
      if (!INTENT_EDGES[b.status].includes(a.status)) fail(`illegal intent edge ${b.status} -> ${a.status}`);
      const edge = `${b.status}>${a.status}`;
      if (a.intent.purpose === 'entry' && GATED_ENTRY_EDGES.has(edge) && (before.paused.length > 0 || before.recovering)) fail(`entry advanced ${edge} while paused or recovering`);
      if (edge.startsWith('reconciled>') && (b.fill !== null || (edge === 'reconciled>signed' && b.outcome !== 'expired' && b.outcome !== 'failed'))) fail(`left reconciled with fill or without expiry/failure: ${edge}`);
    }
  }

  const live = Object.values(after.intents).filter((i) => !isTerminal(i));
  if (live.filter((i) => i.intent.purpose === 'entry').length > 1) fail('two live entry intents');

  let held = 0n;
  for (const i of Object.values(after.intents)) held += heldReservation(i) ?? 0n;
  if (after.reserved < 0n) fail('negative reserved exposure');
  if (after.reserved !== held) fail(`reserved ${after.reserved} != held ${held}`);

  for (const [id, p] of Object.entries(after.positions)) {
    if (!POSITION_STATUSES.includes(p.status)) fail(`invalid position status ${p.status}`);
    const b = before.positions[id];
    if (b === undefined && p.status !== 'opening') fail(`position created in ${p.status}`);
    if (b !== undefined && b.status !== p.status && !POSITION_EDGES[b.status].includes(p.status)) fail(`illegal position edge ${b.status} -> ${p.status}`);
    const exits = live.filter((i) => i.intent.purpose === 'exit' && i.intent.positionId === p.id);
    if (exits.length > 1) fail(`two live exit intents on ${id}`);
    const owning = p.status === 'exit_requested' || p.status === 'exit_pending';
    if (owning !== (p.exitOwner !== null)) fail(`exit owner ${p.exitOwner ? 'set' : 'missing'} in ${p.status}`);
    if (p.exitOwner !== null) {
      const o = after.intents[p.exitOwner.intentId];
      if (o === undefined || isTerminal(o) || exits[0] !== o) fail('exit owner is not the single live exit intent');
      if (p.exitOwner.quantity > p.quantity || p.exitOwner.quantity <= 0n) fail('exit owner quantity outside holdings');
    } else if (exits.length > 0) fail('live exit intent without an owner');
    if (p.quantity < 0n || p.sold < 0n) fail('negative quantity');
    // Conservation: held + sold equals what the entry bought.
    const entry = after.intents[p.entryIntentId];
    const bought = entry?.fill?.tokens ?? 0n;
    if (p.status !== 'opening' && p.quantity + p.sold !== bought) fail(`quantity ${p.quantity} + sold ${p.sold} != bought ${bought}`);
  }

  for (const f of effects as readonly ({ type: string } & Record<string, unknown>)[]) {
    if (f.type !== 'broadcast') continue;
    const i = after.intents[f.intentId as string];
    const cur = i?.attempts[i.attempts.length - 1];
    if (!i || !cur || cur.id !== f.attemptId || cur.signature !== f.signature || cur.signedBytesRef !== f.signedBytesRef) fail('broadcast of bytes other than the current attempt');
    if (e.type === 'tick' && cur!.lastValidBlockHeight < e.blockHeight) fail('rebroadcast after expiry');
    if (i!.intent.purpose === 'entry' && e.type !== 'tick' && before.paused.length > 0) fail('entry sent while paused');
  }
};

describe('randomised lifecycle sequences', () => {
  test('10,000 seeded sequences: no illegal state, one live entry, one live exit per position, reserved never negative', () => {
    const SEQUENCES = 10_000;
    const STEPS = 60;
    const seenIntent = new Set<IntentStatus>();
    const seenPosition = new Set<PositionStatus>();
    let accepted = 0;
    for (let seed = 1; seed <= SEQUENCES; seed++) {
      const next = generator(seed);
      const w: World = { book: emptyBook(), height: 100n, n: 0 };
      for (let s = 0; s < STEPS; s++) {
        const e = next(w);
        const r = applyBookEvent(w.book, e);
        if (isIllegal(r)) continue;
        if (e.type === 'propose_entry' && !canOpenNewEntry(w.book).ok) throw new Error('entry accepted while the guard said no');
        check(w, w.book, e, r.state, r.effects);
        w.book = r.state;
        accepted++;
        for (const i of Object.values(w.book.intents)) seenIntent.add(i.status);
        for (const p of Object.values(w.book.positions)) seenPosition.add(p.status);
      }
    }
    // The generator must reach every state, or the invariants above prove little.
    expect([...seenIntent].sort()).toEqual([...INTENT_STATUSES].sort());
    expect([...seenPosition].sort()).toEqual([...POSITION_STATUSES].sort());
    expect(accepted).toBeGreaterThan(SEQUENCES * 10);
  }, 120_000);
});
