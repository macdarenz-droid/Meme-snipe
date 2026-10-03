// The outside world of a backtest: the EffectRunner that answers the engine's effects with the §11 paper fill model.
// Each broadcast attempt draws its latency and fate from the recorded world seed; when it reaches its landing slot
// (after every real transaction of that slot) it executes on the pool as our earlier trades left it, and later real
// swaps see its impact (market.ts). Results come back to the engine only as feed events, never as return values.
import type { Fill, IntentId, Signature } from '../../../core/src/domain/index.ts';
import { type EffectRunner, type Moment, OFF_CHAIN, type Rng } from '../../../core/src/engine/index.ts';
import { accountGetsDust, attemptFee, drawAttempt, closeSucceeds, NetworkState, providerDown, windowOf, executeBuy, executeSell, type ExecutionCosts, type FillNetwork, type FillScenario } from '../../../core/src/fills/index.ts';
import type { Book, BookEvent, Effect, IntentState } from '../../../core/src/lifecycle/index.ts';
import type { LadderStep } from '../../../core/src/config/index.ts';
import type { RawAmount, Lamports } from '../../../core/src/units/index.ts';
import { LANDING_TX, type Market } from './market.ts';
import type { StreamReplay } from './replay.ts';

export type AttemptOutcome = 'in_flight' | 'filled' | 'failed' | 'dropped' | 'expired';

export interface AttemptRecord {
  readonly intentId: string;
  readonly signature: string;
  readonly purpose: 'entry' | 'exit';
  readonly mint: string;
  readonly priorityFee: bigint;
  readonly lastValidBlockHeight: bigint;
  outcome: AttemptOutcome;
  /** Why a landed attempt failed (slippage, no-liquidity, ...), or the fate drawn. */
  reason: string;
  landedSlot: bigint | null;
  landedAt: number | null;
  fee: bigint;
  fill: Fill | null;
  /** Venue fees, impact and extra slippage of a filled attempt. */
  costs: ExecutionCosts | null;
  /** Broadcast while the shared network state was congested. */
  readonly congested: boolean;
  /** Why the attempt never reached a block regardless of its draw: the send path was down, or a failure burst. */
  readonly forcedDrop: 'provider' | 'burst' | null;
  /** Earlier exit attempts on the same position (0 for entries and first exits): the liquidity haircut's multiple. */
  readonly exitRetry: number;
  /** This filled sell emptied and closed the token account (atomic sell-and-close): its rent came back. */
  closedAccount: boolean;
}

export interface WorldDeps {
  readonly replay: StreamReplay<unknown>;
  readonly market: Market;
  readonly book: () => Book;
  readonly rng: Rng;
  /** Seed of the network and provider states (one draw per window, shared by every attempt in it). */
  readonly congestionSeed: string;
  /** Deterministic failure bursts (stress): `perDay` evenly spaced from each UTC midnight, each `durationMs` long. */
  readonly failureBursts?: { readonly perDay: number; readonly durationMs: number } | undefined;
  readonly scenario: FillScenario;
  readonly network: FillNetwork;
  readonly ladder: readonly LadderStep[];
  /** Pool of a mint (from the discovery the strategy entered on). */
  readonly poolOf: (mint: string) => string | undefined;
  /** Called once per attempt when its outcome is settled (filled, failed, dropped or expired). */
  readonly onSettled?: (a: AttemptRecord) => void;
}

const NORMAL = { mayhemMode: false, transferFee: false, transferHook: false } as const;
const SLOT_MS = 400;

export class World implements EffectRunner {
  readonly #d: WorldDeps;
  readonly attempts = new Map<string, AttemptRecord>();
  readonly alerts = new Map<string, number>();
  readonly #exitAttempts = new Map<string, number>();
  /** Our token balance per mint (one account per mint), from our own fills. */
  readonly #account = new Map<string, bigint>();
  /** Accounts that can no longer be closed in a sell (dust, an unsolicited token, a failed close): sell-only. */
  readonly #sellOnly = new Set<string>();
  #seq = 0;

  readonly #network: NetworkState;

  constructor(deps: WorldDeps) {
    this.#d = deps;
    this.#network = new NetworkState(`${deps.congestionSeed}:net`, deps.scenario, (win) => deps.market.volumeBefore(win));
    const b = deps.failureBursts;
    if (b !== undefined && (!Number.isSafeInteger(b.perDay) || b.perDay < 0 || !Number.isSafeInteger(b.durationMs) || b.durationMs < 0)) throw new RangeError('failure bursts need integers >= 0');
  }

  /** True when `ms` falls inside a deterministic failure burst. */
  #inBurst(ms: number): boolean {
    const b = this.#d.failureBursts;
    if (b === undefined || b.perDay === 0 || b.durationMs === 0) return false;
    const day = 86_400_000;
    const spacing = Math.floor(day / b.perDay);
    return ((ms % day) % spacing) < b.durationMs && Math.floor((ms % day) / spacing) < b.perDay;
  }

  #id(): string {
    return `w:${String(this.#seq++).padStart(12, '0')}`;
  }

  /** The first moment after `now` at which an off-chain report can arrive. */
  #after(now: Moment): Moment {
    return now.txIndex < OFF_CHAIN ? { slot: now.slot, txIndex: OFF_CHAIN, ixIndex: 0, receivedAt: now.receivedAt } : { slot: now.slot + 1n, txIndex: OFF_CHAIN, ixIndex: 0, receivedAt: now.receivedAt + SLOT_MS };
  }

  #report(at: Moment, event: BookEvent): void {
    this.#d.replay.schedule({ kind: 'world', id: this.#id(), moment: at, event });
  }

  #intent(id: IntentId): IntentState {
    const i = this.#d.book().intents[id];
    if (i === undefined) throw new RangeError(`world: unknown intent ${id}`);
    return i;
  }

  run(effect: Effect, now: Moment): void {
    switch (effect.type) {
      case 'broadcast':
        return this.#broadcast(effect.intentId, effect.signature, now);
      case 'check_status':
        for (const s of effect.signatures) this.#status(effect.intentId, s, effect.searchHistory, now);
        return;
      case 'reconcile_balances':
        return this.#reconcile(effect.intentId, now);
      case 'reconcile_orphan': {
        const a = this.attempts.get(effect.signature);
        if (a?.fill) this.#report(this.#after(now), { type: 'orphan_fill', fill: a.fill });
        return;
      }
      case 'alert':
        this.alerts.set(effect.code, (this.alerts.get(effect.code) ?? 0) + 1);
        return;
      default:
        // persist, reservations: the ledger sink records them from the log.
        return;
    }
  }

  #priorityFee(i: IntentState): bigint {
    if (i.intent.purpose === 'entry') return this.#d.network.entryPriorityFee;
    const steps = this.#d.ladder;
    const rung = steps[Math.min(i.attempts.length - 1, steps.length - 1)];
    if (rung === undefined) throw new RangeError('the exit ladder is empty');
    return rung.priorityFeeLamports;
  }

  #broadcast(intentId: IntentId, signature: Signature, now: Moment): void {
    // Rebroadcasts send the same bytes: the same signature lands at most once, so its fate was drawn already.
    if (this.attempts.has(signature)) return;
    const i = this.#intent(intentId);
    const attempt = i.attempts.find((a) => a.signature === signature);
    if (attempt === undefined) throw new RangeError(`world: ${signature} is not an attempt of ${intentId}`);
    const win = windowOf(now.slot, this.#d.scenario);
    // One shared state: every open position and every provider sees the same congestion in a window.
    const congested = this.#network.congested(win);
    const drawn = drawAttempt(this.#d.rng, this.#d.scenario, i.intent.venue, congested);
    // Provider failures and stress bursts sit on top: the attempt never reaches a block, so it can only expire. The
    // lifecycle then waits for its last valid height before any replacement (never an unsafe one).
    const forcedDrop = providerDown(this.#d.congestionSeed, win, this.#d.scenario) ? 'provider' as const : this.#inBurst(now.receivedAt) ? 'burst' as const : null;
    const draw = forcedDrop === null ? drawn : { ...drawn, fate: 'dropped' as const };
    let exitRetry = 0;
    if (i.intent.purpose === 'exit') {
      const position = i.intent.positionId;
      exitRetry = this.#exitAttempts.get(position) ?? 0;
      this.#exitAttempts.set(position, exitRetry + 1);
    }
    const rec: AttemptRecord = {
      intentId, signature, purpose: i.intent.purpose, mint: i.intent.mint, priorityFee: this.#priorityFee(i),
      lastValidBlockHeight: attempt.lastValidBlockHeight, outcome: 'in_flight', reason: draw.fate,
      landedSlot: null, landedAt: null, fee: 0n, fill: null, costs: null, congested, forcedDrop, exitRetry, closedAccount: false,
    };
    this.attempts.set(signature, rec);
    this.#report(this.#after(now), { type: 'intent', intentId, event: { type: 'send_accepted' } });
    if (draw.fate === 'dropped') {
      rec.outcome = 'dropped';
      if (forcedDrop !== null) rec.reason = forcedDrop;
      this.#d.onSettled?.(rec);
      return;
    }
    const slots = Math.max(1, draw.landingSlots);
    this.#landAt(rec, draw.fate === 'lands', attempt.quote, now.slot + BigInt(slots), now.receivedAt + slots * SLOT_MS);
  }

  /**
   * A landing at `slot`, after every transaction and the block row of that slot. A skipped slot has no block, so the
   * landing moves to the next slot until one has a block; past the last block of the data it never lands.
   */
  #landAt(rec: AttemptRecord, executes: boolean, quote: { readonly inAmount: bigint; readonly quotedOut: bigint; readonly minOut: bigint }, slot: bigint, receivedAt: number): void {
    this.#d.replay.hook({
      id: `land:${rec.signature}:${slot}`,
      moment: { slot, txIndex: LANDING_TX, ixIndex: 0, receivedAt },
      run: () => {
        if (this.#d.market.slot === slot) return this.#land(rec, executes, quote);
        if (!this.#d.replay.hasRows()) {
          rec.outcome = 'dropped';
          rec.reason = 'no block after the landing slot in the data';
          this.#d.onSettled?.(rec);
          return;
        }
        this.#landAt(rec, executes, quote, slot + 1n, receivedAt + SLOT_MS);
      },
    });
  }

  #land(rec: AttemptRecord, executes: boolean, quote: { readonly inAmount: bigint; readonly quotedOut: bigint; readonly minOut: bigint }): void {
    const { market, scenario, network } = this.#d;
    const now: Moment = { slot: market.slot, txIndex: LANDING_TX, ixIndex: 0, receivedAt: market.blockTime * 1000 };
    if (market.blockHeight > rec.lastValidBlockHeight) {
      // The blockhash expired before the attempt reached a block: it never lands and costs nothing.
      rec.outcome = 'expired';
      rec.reason = 'blockhash expired before landing';
      this.#d.onSettled?.(rec);
      return;
    }
    const landedSlot = this.#d.replay.clock.now().slot;
    rec.landedSlot = landedSlot;
    rec.landedAt = now.receivedAt;
    const fail = (reason: string): void => {
      rec.outcome = 'failed';
      rec.reason = reason;
      rec.fee = attemptFee(network, rec.priorityFee, 'failed');
      this.#d.onSettled?.(rec);
      // A finalized failure is terminal; the subscription reports it once finalized.
      this.#push(rec, landedSlot + BigInt(scenario.finalizeSlots), { result: 'failed', commitment: 'finalized' });
    };
    if (!executes) return fail('landed failed (drawn)');
    const pool = this.#d.poolOf(rec.mint);
    const track = pool === undefined ? undefined : market.track(pool);
    const state = track?.shifted.state ?? null;
    if (track === undefined || state === null || track.fees === null) return fail('pool state unknown');
    const t = { pool: state, fees: track.fees, baseSupply: track.baseSupply, coin: NORMAL, quotedOut: quote.quotedOut, minOut: quote.minOut, slippagePpm: scenario.slippagePpm };
    const x = rec.purpose === 'entry' ? executeBuy(t, quote.inAmount) : executeSell(t, quote.inAmount, BigInt(rec.exitRetry) * scenario.exitRetryHaircutPpm);
    if (!x.ok) return fail(x.reason);
    const held = this.#account.get(rec.mint) ?? 0n;
    // A sell of the whole balance closes the account in the same transaction, unless the account is sell-only. Tokens
    // only: venue accounts and the SOL proceeds are never part of the refund.
    const closes = rec.purpose === 'exit' && x.paid === held && !this.#sellOnly.has(rec.mint);
    if (closes && !closeSucceeds(`${this.#d.congestionSeed}:${rec.signature}`, scenario)) {
      // The close fails the transaction: the sell rolls back and the fee is still paid. Later sells are sell-only.
      this.#sellOnly.add(rec.mint);
      return fail('close failed');
    }
    track.shifted.applyOurs(x.after);
    if (rec.purpose === 'entry') {
      // A new account may pick up dust or an unsolicited token: it can then never be closed by a sell.
      if (held === 0n && accountGetsDust(`${this.#d.congestionSeed}:${rec.mint}:${rec.signature}`, scenario)) this.#sellOnly.add(rec.mint);
      this.#account.set(rec.mint, held + x.out);
    } else {
      this.#account.set(rec.mint, held - x.paid);
      rec.closedAccount = closes;
      // Emptied without a close: the account stays open (its rent locked) until a later sell-and-close, never here.
      if (closes) this.#sellOnly.delete(rec.mint);
    }
    rec.outcome = 'filled';
    rec.reason = 'filled';
    rec.costs = x.costs;
    rec.fee = attemptFee(network, rec.priorityFee, 'filled');
    rec.fill = {
      intentId: rec.intentId as IntentId, signature: rec.signature as Signature, slot: landedSlot, commitment: 'confirmed',
      tokens: (rec.purpose === 'entry' ? x.out : x.paid) as RawAmount,
      sol: (rec.purpose === 'entry' ? x.paid : x.out) as Lamports,
      fees: rec.fee as Lamports,
    };
    this.#d.onSettled?.(rec);
    this.#push(rec, landedSlot + BigInt(scenario.confirmSlots), { result: 'succeeded', commitment: 'confirmed' });
  }

  /** A signature subscription's notification at `slot`. */
  #push(rec: AttemptRecord, slot: bigint, s: { result: 'succeeded' | 'failed'; commitment: 'confirmed' | 'finalized' }): void {
    const now = this.#d.replay.clock.now();
    const at: Moment = { slot, txIndex: OFF_CHAIN, ixIndex: 0, receivedAt: now.receivedAt + Number(slot - now.slot) * SLOT_MS };
    const d = this.#d;
    // The block height is read when the report is delivered: a hook schedules a finalizer.
    d.replay.hook({
      id: `push:${rec.signature}:${s.commitment}`,
      moment: { ...at, txIndex: LANDING_TX, ixIndex: 1 },
      run: () => this.#report(at, {
        type: 'intent', intentId: rec.intentId as IntentId,
        event: { type: 'status', signature: rec.signature as Signature, result: s.result, commitment: s.commitment, blockHeight: d.market.blockHeight, searchedHistory: false },
      }),
    });
  }

  #status(intentId: IntentId, signature: Signature, searchHistory: boolean, now: Moment): void {
    const { scenario, market } = this.#d;
    const a = this.attempts.get(signature);
    const at = this.#after(now);
    const blockHeight = market.blockHeight;
    const base = { type: 'status' as const, signature, blockHeight, searchedHistory: searchHistory };
    const landed = a?.landedSlot ?? null;
    if (a === undefined || landed === null || landed > now.slot || (a.outcome !== 'filled' && a.outcome !== 'failed')) {
      this.#report(at, { type: 'intent', intentId, event: { ...base, result: 'not_found', commitment: null } });
      return;
    }
    const age = now.slot - landed;
    const commitment = age >= BigInt(scenario.finalizeSlots) ? 'finalized' : age >= BigInt(scenario.confirmSlots) ? 'confirmed' : 'processed';
    this.#report(at, { type: 'intent', intentId, event: { ...base, result: a.outcome === 'filled' ? 'succeeded' : 'failed', commitment } });
  }

  #reconcile(intentId: IntentId, now: Moment): void {
    const i = this.#intent(intentId);
    const height = this.#d.market.blockHeight;
    const fills: Fill[] = [];
    for (const att of i.attempts) {
      const a = this.attempts.get(att.signature);
      const landed = a?.landedSlot !== null && a?.landedSlot !== undefined && a.landedSlot <= now.slot;
      if (a?.outcome === 'filled' && landed) {
        fills.push(a.fill!);
        continue;
      }
      const dead = i.failedSignatures.includes(att.signature) || height > att.lastValidBlockHeight;
      // Balances are read only once no attempt can still land; the next tick asks again.
      if (!dead) return;
    }
    this.#report(this.#after(now), { type: 'intent', intentId, event: { type: 'reconcile', fills, blockHeight: height } });
  }
}
