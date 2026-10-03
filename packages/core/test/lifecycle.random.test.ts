// Seeded randomised sequences over the whole book, against a small chain model.
// Each broadcast attempt is given a ground truth when it first leaves (lands and succeeds, lands and fails,
// or never lands, always by its last valid block height). Status reads and balance reconciliations come
// from that truth; only `processed` reads may be wrong (fork noise). A few entry landings are hidden: an
// unhealthy RPC reports nothing (even at confirmed) for RPC_LAG blocks, so an intent can end before
// its landing shows up. Those must be booked as late landings, never lost. The allowed-edge tables are written
// from docs/ARCHITECTURE.md ("Durable order state and recovery"), independently of the implementation.
import { describe, expect, test } from 'vitest';
import { lamports, raw } from '../src/units/index.ts';
import { intentId, type Commitment, type Signature, type TransactionAttempt } from '../src/domain/index.ts';
import {
  applyBookEvent, canOpenNewEntry, emptyBook, filledTokens, heldReservation, INTENT_STATUSES, isIllegal, isTerminal, POSITION_STATUSES,
  type Book, type BookEvent, type Effect, type ExitReason, type IntentState, type IntentStatus, type PositionStatus,
} from '../src/lifecycle/index.ts';
import { attempt, entryIntent, fill, quote, reservation, sig, SPEND } from './fixtures.ts';

const INTENT_EDGES: Record<IntentStatus, readonly IntentStatus[]> = {
  candidate: ['eligible', 'rejected', 'cancelled'],
  eligible: ['risk_approved', 'rejected', 'cancelled'],
  risk_approved: ['exposure_reserved', 'rejected', 'cancelled'],
  exposure_reserved: ['prepared', 'cancelled'],
  prepared: ['signed', 'cancelled'],
  signed: ['submitted', 'cancelled', 'unknown', 'confirmed_fill'], // unknown: restart; confirmed_fill: an earlier attempt landed late
  submitted: ['pending', 'unknown', 'confirmed_fill', 'failed', 'expired_unfilled'],
  pending: ['unknown', 'confirmed_fill', 'failed', 'expired_unfilled'],
  unknown: ['confirmed_fill', 'failed', 'expired_unfilled'],
  confirmed_fill: ['reconciled'],
  failed: ['reconciled', 'cancelled', 'confirmed_fill'], // cancelled: cancel was requested and nothing filled
  expired_unfilled: ['reconciled', 'cancelled', 'confirmed_fill'], // confirmed_fill: late landing seen
  reconciled: ['signed', 'abandoned', 'cancelled', 'confirmed_fill'], // only when reconciled without a fill
  rejected: [],
  cancelled: [],
  abandoned: [],
};

const POSITION_EDGES: Record<PositionStatus, readonly PositionStatus[]> = {
  opening: ['open', 'closed'],
  open: ['exit_requested', 'closed'], // closed: a late sale took the rest
  exit_requested: ['exit_pending', 'open', 'closed', 'exit_blocked'],
  exit_pending: ['open', 'closed', 'exit_blocked'],
  exit_blocked: ['exit_requested', 'closed'],
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
const FINALITY = 32n; // blocks from landing to finalized in this model
const RPC_LAG = 200n; // blocks an unhealthy RPC hides a landing for

interface Truth { readonly outcome: 'success' | 'fail' | 'none'; readonly landAt: bigint; readonly tokens: bigint; readonly hidden: boolean }
interface World { book: Book; height: bigint; n: number; truth: Map<Signature, Truth>; revealed: Set<Signature> }
type IntentEvt = Extract<BookEvent, { type: 'intent' }>['event'];

const landed = (t: Truth | undefined, h: bigint): boolean => t !== undefined && t.outcome !== 'none' && h >= t.landAt;
/** What a (possibly unhealthy) RPC can see: hidden landings appear only once finalized. */
const visible = (t: Truth | undefined, h: bigint): boolean => landed(t, h) && (!t!.hidden || h >= t!.landAt + RPC_LAG);
const hasHidden = (w: World, i: IntentState): boolean => i.attempts.some((a) => w.truth.get(a.signature)?.hidden === true);

/** Can this attempt still move tokens, according to the chain? */
const canStillLand = (w: World, a: TransactionAttempt): boolean => {
  const t = w.truth.get(a.signature);
  if (t === undefined) return false; // never left this process
  if (t.outcome === 'success') return true; // landed or will land: never "dead" for a second trade
  if (t.outcome === 'fail') return !landed(t, w.height);
  return w.height <= a.lastValidBlockHeight;
};

const generator = (seed: number) => {
  const r = rng(seed);
  const int = (max: number) => Math.floor(r() * max);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  const chance = (p: number) => r() < p;

  /** Give an attempt its ground truth the first time it may have left this process. */
  const release = (w: World, i: IntentState, a: TransactionAttempt) => {
    if (w.truth.has(a.signature)) return;
    const window = a.lastValidBlockHeight - w.height;
    if (window < 0n) return void w.truth.set(a.signature, { outcome: 'none', landAt: 0n, tokens: 0n, hidden: false });
    const landAt = w.height + BigInt(int(Number(window < 40n ? window : 40n) + 1));
    const tokens = i.intent.purpose === 'exit' ? i.intent.quantity : BigInt(1 + int(10_000));
    const roll = r();
    const hidden = i.intent.purpose === 'entry' && chance(0.15);
    w.truth.set(a.signature, { outcome: hidden || roll < 0.45 ? 'success' : roll < 0.65 ? 'fail' : 'none', landAt, tokens, hidden });
  };

  const read = (w: World, i: IntentState): IntentEvt => {
    if (i.attempts.length === 0 || chance(0.03)) {
      return { type: 'status', signature: sig(900_000 + int(5)), result: 'succeeded', commitment: 'finalized', blockHeight: w.height, searchedHistory: true };
    }
    const a = chance(0.7) ? i.attempts[i.attempts.length - 1]! : pick(i.attempts);
    const t = w.truth.get(a.signature);
    if (chance(0.15)) {
      // Fork noise: a processed read may say anything.
      return { type: 'status', signature: a.signature, result: pick(['succeeded', 'failed'] as const), commitment: 'processed', blockHeight: w.height, searchedHistory: false };
    }
    if (t !== undefined && visible(t, w.height)) {
      const commitment: Commitment = w.height >= t.landAt + FINALITY ? 'finalized' : w.height > t.landAt ? 'confirmed' : 'processed';
      return { type: 'status', signature: a.signature, result: t.outcome === 'success' ? 'succeeded' : 'failed', commitment, blockHeight: w.height, searchedHistory: chance(0.5) };
    }
    return { type: 'status', signature: a.signature, result: 'not_found', commitment: null, blockHeight: w.height, searchedHistory: chance(0.7) };
  };

  /** Balances as the chain shows them at confirmed commitment. */
  const reconcile = (w: World, i: IntentState): IntentEvt => {
    const fills = i.attempts.flatMap((a) => {
      const t = w.truth.get(a.signature);
      return t?.outcome === 'success' && w.height > t.landAt && visible(t, w.height) ? [fill(i.intent.id, Number(a.id.slice(1)), t.tokens)] : [];
    });
    if (chance(0.03)) return { type: 'reconcile', fills: [fill(intentId('e999'), 1, 1n)], blockHeight: w.height };
    return { type: 'reconcile', fills, blockHeight: w.height };
  };

  const newAttempt = (w: World, i: IntentState) => {
    if (i.attempts.length > 0 && chance(0.05)) return i.attempts[0]!; // a known signature must be refused
    return attempt(chance(0.97) ? i.intent.id : intentId('e999'), ++w.n, w.height + BigInt(int(150)));
  };

  const intentEvent = (w: World, i: IntentState): IntentEvt => {
    if (chance(0.7)) {
      switch (i.status) {
        case 'candidate': return chance(0.9) ? { type: 'mark_eligible' } : { type: 'reject', reason: 'gate' };
        case 'eligible': return { type: 'approve_risk' };
        case 'risk_approved': return { type: 'reserve_exposure', reservation: reservation(i.intent.id, chance(0.9) ? SPEND : lamports(int(2))) };
        case 'exposure_reserved': return { type: 'prepare', quote };
        case 'prepared': return { type: 'sign', attempt: newAttempt(w, i) };
        case 'signed': return { type: 'submit' };
        case 'submitted': return pick([{ type: 'send_accepted' }, { type: 'send_timeout' }, { type: 'send_error', message: 'x' }] as const);
        case 'pending':
        case 'unknown': return read(w, i);
        case 'confirmed_fill':
        case 'failed':
        case 'expired_unfilled': return chance(0.8) ? reconcile(w, i) : read(w, i);
        case 'reconciled':
          return chance(0.6) ? { type: 'sign_replacement', attempt: newAttempt(w, i), blockHeight: w.height } : { type: 'abandon' };
        default: return i.attempts.length > 0 && chance(0.6) ? read(w, i) : { type: 'cancel' };
      }
    }
    return pick<() => IntentEvt>([
      () => ({ type: 'mark_eligible' }), () => ({ type: 'reject', reason: 'r' }), () => ({ type: 'approve_risk' }),
      () => ({ type: 'reserve_exposure', reservation: reservation(i.intent.id) }), () => ({ type: 'prepare', quote }),
      () => ({ type: 'sign', attempt: newAttempt(w, i) }), () => ({ type: 'submit' }), () => ({ type: 'send_accepted' }),
      () => ({ type: 'send_timeout' }), () => read(w, i), () => reconcile(w, i),
      () => ({ type: 'sign_replacement', attempt: newAttempt(w, i), blockHeight: w.height }), () => ({ type: 'abandon' }), () => ({ type: 'cancel' }),
    ])();
  };

  /** The wallet reconciliation: book a visible landing of an ended intent that is not booked yet. */
  const sweep = (w: World): BookEvent | null => {
    const pending = Object.values(w.book.orphans);
    const ended = Object.values(w.book.intents).filter(isTerminal);
    const candidates = pending.length > 0 && chance(0.8)
      ? pending.map((o) => ({ i: w.book.intents[o.intentId]!, s: o.signature }))
      : ended.flatMap((i) => i.attempts.map((a) => ({ i, s: a.signature })));
    const ok = candidates.filter(({ i, s }) => {
      const t = w.truth.get(s);
      return t?.outcome === 'success' && visible(t, w.height) && !i.fills.some((f) => f.signature === s);
    });
    if (ok.length === 0) return null;
    const { i, s } = pick(ok);
    const a = i.attempts.find((x) => x.signature === s)!;
    return { type: 'orphan_fill', fill: fill(i.intent.id, Number(a.id.slice(1)), w.truth.get(s)!.tokens) };
  };

  const next = (w: World): BookEvent => {
    const intents = Object.values(w.book.intents);
    const positions = Object.values(w.book.positions);
    const roll = r();
    if (roll < 0.06) {
      const swept = sweep(w);
      if (swept) return swept;
    }
    if (roll < 0.08) {
      const k = ++w.n;
      return { type: 'propose_entry', intent: entryIntent(k, chance(0.03) && intents.length > 0 ? 'd1' : `d${k}`) };
    }
    if (roll < 0.62 && intents.length > 0) {
      const live = intents.filter((i) => !isTerminal(i));
      const i = live.length > 0 && chance(0.9) ? pick(live) : pick(intents);
      return { type: 'intent', intentId: i.intent.id, event: intentEvent(w, i) };
    }
    if (roll < 0.74 && positions.length > 0) {
      const p = pick(positions);
      const reasons = REASONS.filter(() => chance(0.3));
      const base = { type: 'trigger_exit' as const, positionId: p.id, reasons: reasons.length > 0 ? reasons : ['stop' as const], intentId: intentId(`x${++w.n}`) };
      return chance(0.3) ? { ...base, quantity: raw(BigInt(1 + int(12_000))) } : base;
    }
    if (roll < 0.78 && positions.length > 0) return { type: 'exit_blocked', positionId: pick(positions).id, reason: 'no liquidity' };
    if (roll < 0.9) {
      w.height += BigInt(int(60));
      return { type: 'tick', blockHeight: w.height };
    }
    if (roll < 0.93) return { type: 'restart' };
    if (roll < 0.965) return { type: 'pause_entries', reason: 'daily_loss' };
    return { type: 'resume_entries', reason: 'daily_loss' };
  };
  return { next, release, chance };
};

const check = (w: World, before: Book, e: BookEvent, after: Book, effects: readonly Effect[]) => {
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
    }
    // Once revealed, a landing is booked or waiting for its wallet reconciliation: never lost.
    if (isTerminal(a)) {
      for (const x of a.attempts) {
        if (w.revealed.has(x.signature) && !a.fills.some((f) => f.signature === x.signature) && after.orphans[x.signature] === undefined) {
          fail(`landing ${x.signature.slice(0, 8)} of ended ${id} is neither booked nor under reconciliation`);
        }
      }
    }
    // With a healthy RPC (no hidden landing) the rules hold exactly:
    if (hasHidden(w, a)) continue;
    // a new attempt may be signed only when the chain says every earlier attempt can no longer land;
    if (a.attempts.length > b.attempts.length && b.attempts.some((x) => canStillLand(w, x))) fail(`replacement signed while an earlier attempt of ${id} can still land`);
    // never two trades for one intent on chain;
    const successes = a.attempts.filter((x) => w.truth.get(x.signature)?.outcome === 'success');
    if (successes.length > 1) fail(`two attempts of ${id} land`);
    // booked equals landed once the books close;
    const landedTokens = successes.reduce((t, x) => t + (landed(w.truth.get(x.signature), w.height) ? w.truth.get(x.signature)!.tokens : 0n), 0n);
    if (a.status === 'reconciled' && filledTokens(a) !== landedTokens) fail(`${id} booked ${filledTokens(a)} but ${landedTokens} landed`);
    // and an intent that ended unfilled never trades.
    if ((a.status === 'abandoned' || a.status === 'cancelled') && successes.length > 0) fail(`${id} ended unfilled but an attempt succeeds on chain`);
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
    // Positions open as `opening` when an entry may land, or as `open` when a late landing is booked.
    if (b === undefined && p.status !== (e.type === 'orphan_fill' ? 'open' : 'opening')) fail(`position created in ${p.status}`);
    if (b !== undefined && b.status !== p.status && !POSITION_EDGES[b.status].includes(p.status)) fail(`illegal position edge ${b.status} -> ${p.status}`);
    const exits = live.filter((i) => i.intent.purpose === 'exit' && i.intent.positionId === p.id);
    if (exits.length > 1) fail(`two live exit intents on ${id}`);
    const owning = p.status === 'exit_requested' || p.status === 'exit_pending';
    if (owning !== (p.exitOwner !== null)) fail(`exit owner ${p.exitOwner ? 'set' : 'missing'} in ${p.status}`);
    if (p.exitOwner !== null) {
      const o = after.intents[p.exitOwner.intentId];
      if (o === undefined || isTerminal(o) || exits[0] !== o) fail('exit owner is not the single live exit intent');
      if (p.exitOwner.quantity > p.bought || p.exitOwner.quantity <= 0n) fail('exit owner quantity outside holdings');
    } else if (exits.length > 0) fail('live exit intent without an owner');
    if (p.quantity < 0n || p.sold < 0n) fail('negative quantity');
    const expected = p.bought > p.sold ? p.bought - p.sold : 0n;
    if (p.quantity !== expected) fail(`quantity ${p.quantity} != max(0, bought ${p.bought} - sold ${p.sold})`);
  }
  // Booked bought tokens per entry equal its fills; on chain, never more sold than bought per entry.
  for (const entry of Object.values(after.intents)) {
    if (entry.intent.purpose !== 'entry') continue;
    const mine = Object.values(after.positions).filter((p) => p.entryIntentId === entry.intent.id);
    const booked = mine.reduce((t, p) => t + p.bought, 0n);
    if (booked !== filledTokens(entry)) fail(`entry ${entry.intent.id} fills ${filledTokens(entry)} but positions bought ${booked}`);
    const ids = new Set(mine.map((p) => p.id));
    let soldOnChain = 0n;
    for (const i of Object.values(after.intents)) {
      if (i.intent.purpose !== 'exit' || !ids.has(i.intent.positionId)) continue;
      for (const x of i.attempts) if (w.truth.get(x.signature)?.outcome === 'success') soldOnChain += w.truth.get(x.signature)!.tokens;
    }
    let boughtOnChain = 0n;
    for (const x of entry.attempts) if (w.truth.get(x.signature)?.outcome === 'success') boughtOnChain += w.truth.get(x.signature)!.tokens;
    if (soldOnChain > boughtOnChain) fail(`entry ${entry.intent.id} sells ${soldOnChain} on chain but bought ${boughtOnChain}`);
  }

  for (const f of effects) {
    if (f.type !== 'broadcast') continue;
    const i = after.intents[f.intentId];
    const cur = i?.attempts[i.attempts.length - 1];
    if (!i || !cur || cur.id !== f.attemptId || cur.signature !== f.signature || cur.signedBytesRef !== f.signedBytesRef) fail('broadcast of bytes other than the current attempt');
    if (e.type === 'tick' && cur!.lastValidBlockHeight < e.blockHeight) fail('rebroadcast after expiry');
    if (i!.intent.purpose === 'entry' && e.type !== 'tick' && before.paused.length > 0) fail('entry sent while paused');
    if (!hasHidden(w, i!) && i!.attempts.slice(0, -1).some((x) => canStillLand(w, x))) fail('broadcast while an earlier attempt can still land');
  }
};

describe('randomised lifecycle sequences', () => {
  test('10,000 seeded sequences against a chain model: no illegal state, no double trade, landed tokens always booked or under reconciliation', () => {
    const SEQUENCES = 10_000;
    const STEPS = 80;
    const seenIntent = new Set<IntentStatus>();
    const seenPosition = new Set<PositionStatus>();
    let accepted = 0;
    let replacements = 0;
    let lateLandings = 0;
    let orphansBooked = 0;
    for (let seed = 1; seed <= SEQUENCES; seed++) {
      const { next, release, chance } = generator(seed);
      const w: World = { book: emptyBook({ maxOpenPositions: 1 + (seed % 3) }), height: 100n, n: 0, truth: new Map(), revealed: new Set() };
      for (let s = 0; s < STEPS; s++) {
        const e = next(w);
        const r = applyBookEvent(w.book, e);
        // A truthful landing read for one of the intent's own signatures is never refused, whatever its state.
        const landingRead = e.type === 'intent' && e.event.type === 'status' && e.event.result === 'succeeded'
          && (e.event.commitment === 'confirmed' || e.event.commitment === 'finalized')
          && w.book.intents[e.intentId]!.attempts.some((a) => e.event.type === 'status' && a.signature === e.event.signature);
        if (isIllegal(r)) {
          if (landingRead) throw new Error(`landing read refused: ${r.reason} (from ${r.from})`);
          continue;
        }
        if (landingRead && e.event.type === 'status') w.revealed.add(e.event.signature);
        if (e.type === 'orphan_fill') orphansBooked++;
        // After any late landing, new entries stay blocked until it is booked.
        if (r.effects.some((f) => f.type === 'reconcile_orphan') && canOpenNewEntry(r.state).ok) throw new Error('entries open with an unbooked landing');
        if (e.type === 'propose_entry' && Object.keys(w.book.orphans).length > 0) throw new Error('entry accepted with an unbooked landing');
        if (e.type === 'propose_entry' && !canOpenNewEntry(w.book).ok) throw new Error('entry accepted while the guard said no');
        // Bytes leave the process on broadcast; a restart while signed may have leaked them too.
        for (const f of r.effects) {
          if (f.type !== 'broadcast') continue;
          const i = r.state.intents[f.intentId]!;
          release(w, i, i.attempts.find((a) => a.id === f.attemptId)!);
        }
        if (e.type === 'restart') {
          for (const i of Object.values(w.book.intents)) {
            const cur = i.attempts[i.attempts.length - 1];
            if (i.status === 'signed' && cur && chance(0.5)) release(w, i, cur);
          }
        }
        check(w, w.book, e, r.state, r.effects);
        for (const f of r.effects) if (f.type === 'alert' && f.code === 'late_landing') lateLandings++;
        if (e.type === 'intent' && e.event.type === 'sign_replacement') replacements++;
        w.book = r.state;
        accepted++;
        for (const i of Object.values(w.book.intents)) seenIntent.add(i.status);
        for (const p of Object.values(w.book.positions)) seenPosition.add(p.status);
      }
    }
    // The generator must reach every state and the risky paths, or the invariants above prove little.
    expect([...seenIntent].sort()).toEqual([...INTENT_STATUSES].sort());
    expect([...seenPosition].sort()).toEqual([...POSITION_STATUSES].sort());
    expect(accepted).toBeGreaterThan(SEQUENCES * 10);
    expect(replacements).toBeGreaterThan(100);
    expect(lateLandings).toBeGreaterThan(0); // hidden landings exercise the late-landing paths
    expect(orphansBooked).toBeGreaterThan(50);
  }, 120_000);
});
