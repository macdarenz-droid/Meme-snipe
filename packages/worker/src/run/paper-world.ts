// The paper world: the EffectRunner the live engine uses in paper mode. Nothing is signed or sent. Each paper attempt
// draws its latency and fate from a seed (BT-1's fill model), lands at its slot on the pool as the latest gate pool
// fact shows it, and reports back only as world frames on the live Feed (recorded like every other input). Before an
// attempt can land, TEST-2 simulates the real transaction against mainnet and its record is journaled as the
// `simulation` line that precedes the paper entry or exit (§15 item 4).
//
// The paper chain's block height is the latest released slot. Attempt records are saved after every change, so a
// restart answers status and balance reads for attempts made before it.
import { type PoolFeeContext, type PoolState, poolBuyExactQuoteIn, poolSell } from '../../../core/src/amm/index.ts';
import type { Fill, IntentId, Signature } from '../../../core/src/domain/index.ts';
import { createRng, type EffectRunner, type Moment } from '../../../core/src/engine/index.ts';
import { attemptFee, drawAttempt, type FillNetwork, type FillScenario, withSlippage } from '../../../core/src/fills/index.ts';
import type { Book, BookEvent, Effect, IntentState } from '../../../core/src/lifecycle/index.ts';
import type { Lamports, RawAmount } from '../../../core/src/units/index.ts';
import type { ExecStats } from '../../../core/src/facts/raw.ts';
import type { DryRunRecord } from '../dryrun/index.ts';
import type { StateFile } from './state.ts';

export interface PaperAttempt {
  readonly intentId: string;
  readonly signature: string;
  readonly purpose: 'entry' | 'exit';
  /** Position id: the `trade` of the journal lines. */
  readonly trade: string;
  readonly mint: string;
  readonly inAmount: bigint;
  readonly quotedOut: bigint;
  readonly minOut: bigint;
  readonly priorityFee: bigint;
  readonly lastValidBlockHeight: bigint;
  readonly fate: 'lands' | 'fails' | 'dropped';
  readonly landSlot: bigint;
  outcome: 'in_flight' | 'filled' | 'failed' | 'dropped' | 'expired';
  reason: string;
  landedSlot: bigint | null;
  fill: Fill | null;
  /** True once its simulation line is journaled (or simulation is off). */
  simulated: boolean;
  /** Lamport costs of a filled attempt, for the trade report: venue (LP + protocol), creator, extra slippage. */
  costs?: { readonly venueFee: bigint; readonly creatorFee: bigint; readonly slippage: bigint; readonly base: bigint; readonly priority: bigint; readonly tip: bigint };
  /** When it was broadcast and when it landed (ms). */
  sentAtMs?: number;
}

export interface PaperState {
  readonly attempts: Readonly<Record<string, PaperAttempt>>;
}

/** The pool an attempt executes against: the latest gate pool fact and its fee context. */
export interface PaperMarket {
  readonly pool: PoolState;
  readonly ctx: PoolFeeContext;
}

/** One leg to simulate (TEST-2). */
export interface SimLeg {
  readonly trade: string;
  readonly leg: 'entry' | 'exit';
  readonly intentId: string;
  readonly mint: string;
  readonly side: 'buy' | 'sell';
  readonly inAmount: bigint;
  readonly quotedOut: bigint;
  readonly minOut: bigint;
  readonly priorityFee: bigint;
  readonly lastValidBlockHeight: bigint;
  /** Sell legs that sell the whole holding close the token account. */
  readonly closes: boolean;
  /** The feed's head slot when the attempt was made: no read or simulation may use older state. */
  readonly minContextSlot: bigint;
  /** The signer policy's ceiling on SOL out: the entry's reservation (q + C), or one exit attempt's fee cap and rent. */
  readonly maxSolOut: bigint;
}

export interface PaperWorldDeps {
  /** Puts a world event on the live Feed (a `worker` world frame). */
  readonly report: (event: BookEvent) => void;
  readonly book: () => Book;
  readonly seed: string;
  readonly scenario: FillScenario;
  readonly network: FillNetwork;
  readonly ladderFees: readonly bigint[];
  readonly market: (mint: string) => PaperMarket | null;
  readonly maxSolOut: (i: IntentState) => bigint;
  /** TEST-2's dryRunTrade for one leg; null when simulation is off. Never throws (failures are records). */
  readonly simulate: ((leg: SimLeg) => Promise<DryRunRecord>) | null;
  readonly journal: (fields: Readonly<Record<string, unknown>>) => void;
  /** Wall time (ms), for the trade report's fill times. */
  readonly now: () => number;
  readonly file: StateFile<PaperState>;
  /** Called when an attempt changed (the worker refreshes open_intents). */
  readonly changed: () => void;
}

/** Every line carries these in full (null when unknown): finalExit, simulatedSlot and standIn too (#60 review). */
const SIMULATION_FIELDS = ['outcome', 'success', 'error', 'standIn', 'finalExit', 'simulatedSlot', 'quotedOut', 'simulatedOut', 'amountErrorE4', 'quoteAgeSlots', 'rentDeclared', 'rentPaid', 'balancesFrom'] as const;

/** The journal fields of a simulation record (bigints stay bigints here; the journal writes them as strings). */
export const simulationFields = (leg: SimLeg, r: DryRunRecord): Record<string, unknown> => {
  const out: Record<string, unknown> = { trade: leg.trade, leg: leg.leg, intent: leg.intentId, mint: leg.mint, venue: r.venue };
  for (const k of SIMULATION_FIELDS) out[k] = r[k] ?? null;
  return out;
};

/** The lower median (a whole number, as ExecStats needs), null when empty. */
const lowerMedian = (xs: readonly number[]): number | null => (xs.length === 0 ? null : [...xs].sort((a, b) => a - b)[(xs.length - 1) >> 1]!);

/** A paper attempt that was in flight when its process stopped: it never lands. */
const lostInRestart = (a: PaperAttempt): boolean => a.outcome === 'expired' && a.reason.startsWith('lost');

export class PaperWorld implements EffectRunner {
  readonly #d: PaperWorldDeps;
  readonly #attempts: Map<string, PaperAttempt>;
  #height: bigint | null = null;
  /** Simulations still running, by signature (a clean stop waits for them). */
  readonly pending = new Map<string, Promise<void>>();
  /** The process is going: state files belong to its successor from here on, so nothing more is written. */
  #stopped = false;
  /** The paper height each attempt was sent at, this process only (not saved: an older attempt has no landing delay). */
  readonly #sentHeight = new Map<string, bigint>();

  constructor(d: PaperWorldDeps) {
    this.#d = d;
    this.#attempts = new Map(Object.entries(d.file.read({ attempts: {} }).attempts).map(([k, v]) => [k, { ...v }]));
    // Paper attempts die with the process that made them: one still in flight at a restart never lands.
    let lost = 0;
    for (const a of this.#attempts.values()) {
      if (a.outcome !== 'in_flight') continue;
      a.outcome = 'expired';
      a.reason = 'lost in a restart (paper attempts die with the process)';
      lost++;
    }
    if (lost > 0) d.file.write({ attempts: Object.fromEntries(this.#attempts) });
  }

  /**
   * The paper block height a report about `sig` carries. An attempt the paper chain will never land (lost in a
   * restart, or signed but never broadcast before one) is reported past its last valid height, so the lifecycle can
   * settle it at once; the live height is not moved.
   */
  #heightFor(sig: string, lastValid: bigint): bigint | null {
    const a = this.#attempts.get(sig);
    if (a === undefined || lostInRestart(a)) return lastValid + 1n;
    return this.#height;
  }

  get attempts(): ReadonlyMap<string, PaperAttempt> {
    return this.#attempts;
  }

  /**
   * WORKER-1e: execution statistics of the settled paper attempts sent in the `windowMs` up to `now` (the S0
   * diagnostic's exec-health: measured from paper's own draws, never judged). Attempts lost in a restart are a process
   * event, not an execution result, and are left out. Landing delay counts from the paper height at send.
   */
  execStats(now: number, windowMs: number): ExecStats {
    const settled = [...this.#attempts.values()].filter((a) => a.outcome !== 'in_flight' && !(a.outcome === 'expired' && a.reason.startsWith('lost'))
      && a.sentAtMs !== undefined && a.sentAtMs > now - windowMs && a.sentAtMs <= now);
    const landing = settled.flatMap((a) => {
      const sent = this.#sentHeight.get(a.signature);
      return a.landedSlot !== null && sent !== undefined ? [Number(a.landedSlot - sent)] : [];
    });
    const quoteError = settled.flatMap((a) => {
      if (a.fill === null || a.quotedOut <= 0n) return [];
      const got: bigint = a.purpose === 'entry' ? a.fill.tokens : a.fill.sol;
      const diff = got > a.quotedOut ? got - a.quotedOut : a.quotedOut - got;
      return [Number((diff * 10_000n) / a.quotedOut)];
    });
    return { attempts: settled.length, failed: settled.filter((a) => a.outcome !== 'filled').length, landingSlotsP50: lowerMedian(landing), quoteErrorBpsP50: lowerMedian(quoteError) };
  }

  get height(): bigint | null {
    return this.#height;
  }

  /**
   * Stops the state writes. A simulation can answer after the worker was killed or stopped, and its save would write
   * `paper.json` and `open_intents` from a dead process, over what the next one (the host unit's `--reconcile`) wrote.
   */
  stop(): void {
    this.#stopped = true;
  }

  #save(): void {
    if (this.#stopped) return;
    this.#d.file.write({ attempts: Object.fromEntries(this.#attempts) });
    this.#d.changed();
  }

  #intent(id: IntentId): IntentState | undefined {
    return this.#d.book().intents[id];
  }

  run(effect: Effect, _now: Moment): void {
    switch (effect.type) {
      case 'broadcast':
        return this.#broadcast(effect.intentId, effect.signature);
      case 'check_status':
        for (const s of effect.signatures) this.#status(effect.intentId, s, effect.searchHistory);
        return;
      case 'reconcile_balances':
        return this.#reconcile(effect.intentId);
      case 'reconcile_orphan': {
        const a = this.#attempts.get(effect.signature);
        if (a?.fill) this.#d.report({ type: 'orphan_fill', fill: a.fill });
        return;
      }
      default:
        // persist, reservations, request_exit, alerts: the worker records them from the engine's log.
        return;
    }
  }

  #broadcast(intentId: IntentId, sig: Signature): void {
    // Rebroadcasts send the same bytes: the same signature lands at most once, so its fate was drawn already. One lost
    // in a restart is the exception (EXIT-KEEP B3): a kill after this world saved the attempt but before the ledger
    // booked it leaves the book without the intent, so the re-made intent gets the same id and the same paper
    // signature. It is a new send, made by this process (a real re-made exit is a new transaction); ignoring it left
    // the intent waiting out its blockhash (about 150 slots) and burned a ladder rung.
    const known = this.#attempts.get(sig);
    if (known !== undefined && !lostInRestart(known)) return;
    const i = this.#intent(intentId);
    const attempt = i?.attempts.find((a) => a.signature === sig);
    const height = this.#height;
    if (i === undefined || attempt === undefined || height === null) return;
    const draw = drawAttempt(createRng(`${this.#d.seed}:${sig}`), this.#d.scenario, i.intent.venue);
    const exit = i.intent.purpose === 'exit';
    const rung = Math.min(i.attempts.length - 1, this.#d.ladderFees.length - 1);
    const a: PaperAttempt = {
      intentId, signature: sig, purpose: i.intent.purpose, trade: i.intent.positionId, mint: i.intent.mint,
      inAmount: attempt.quote.inAmount, quotedOut: attempt.quote.quotedOut, minOut: attempt.quote.minOut,
      priorityFee: exit ? (this.#d.ladderFees[rung] ?? 0n) : this.#d.network.entryPriorityFee,
      lastValidBlockHeight: attempt.lastValidBlockHeight, fate: draw.fate, landSlot: height + BigInt(Math.max(1, draw.landingSlots)),
      outcome: 'in_flight', reason: draw.fate, landedSlot: null, fill: null, simulated: this.#d.simulate === null, sentAtMs: this.#d.now(),
    };
    this.#attempts.set(sig, a);
    this.#sentHeight.set(sig, height);
    this.#save();
    this.#d.report({ type: 'intent', intentId, event: { type: 'send_accepted' } });
    const sim = this.#d.simulate;
    if (sim === null) return;
    const holding = exit ? Object.values(this.#d.book().positions).find((p) => p.id === i.intent.positionId) : undefined;
    const leg: SimLeg = {
      trade: a.trade, leg: exit ? 'exit' : 'entry', intentId, mint: a.mint, side: exit ? 'sell' : 'buy', inAmount: a.inAmount,
      quotedOut: a.quotedOut, minOut: a.minOut, priorityFee: a.priorityFee, lastValidBlockHeight: a.lastValidBlockHeight,
      closes: exit && holding !== undefined && a.inAmount >= holding.quantity, minContextSlot: height, maxSolOut: this.#d.maxSolOut(i),
    };
    const p = sim(leg).then((r) => {
      this.#d.journal(simulationFields(leg, r));
      const cur = this.#attempts.get(sig);
      if (cur !== undefined) {
        cur.simulated = true;
        this.#save();
      }
    }).finally(() => this.pending.delete(sig));
    this.pending.set(sig, p);
  }

  /** A new paper block height (the latest released slot): attempts due at it land, in signature order. */
  onSlot(slot: bigint): void {
    if (this.#height !== null && slot <= this.#height) return;
    this.#height = slot;
    const due = [...this.#attempts.values()].filter((a) => a.outcome === 'in_flight' && a.simulated && a.landSlot <= slot).sort((x, y) => (x.signature < y.signature ? -1 : 1));
    for (const a of due) this.#land(a, slot);
  }

  #land(a: PaperAttempt, slot: bigint): void {
    const done = (outcome: PaperAttempt['outcome'], reason: string): void => {
      a.outcome = outcome;
      a.reason = reason;
      this.#save();
    };
    if (slot > a.lastValidBlockHeight) return done('expired', 'blockhash expired before landing');
    if (a.fate === 'dropped') return done('dropped', 'never reached a block (drawn)');
    a.landedSlot = slot;
    const failed = (reason: string): void => {
      done('failed', reason);
      this.#d.report({ type: 'intent', intentId: a.intentId as IntentId, event: { type: 'status', signature: a.signature as Signature, result: 'failed', commitment: 'finalized', blockHeight: slot, searchedHistory: false } });
    };
    if (a.fate === 'fails') return failed('landed failed (drawn)');
    const m = this.#d.market(a.mint);
    if (m === null) return failed('pool state unknown');
    const q = a.purpose === 'entry' ? poolBuyExactQuoteIn(m.pool, a.inAmount, m.ctx) : poolSell(m.pool, a.inAmount, m.ctx);
    if (!q.ok) return failed(`no execution: ${q.reason}`);
    const executed = a.purpose === 'entry' ? q.trade.base : q.trade.userQuote;
    const out = withSlippage(executed, a.quotedOut, this.#d.scenario.slippagePpm);
    if (out < a.minOut) return failed(`slippage: ${out} below min-out ${a.minOut}`);
    const fee = attemptFee(this.#d.network, a.priorityFee, 'filled');
    const net = this.#d.network;
    // Extra slippage in lamports: on a sell the shortfall itself; on a buy the tokens lost, valued at the fill's price.
    const lost = executed - out;
    const slipLamports = a.purpose === 'entry' ? (out > 0n ? (lost * q.trade.userQuote) / executed : 0n) : lost;
    a.costs = {
      venueFee: q.trade.lpFee + q.trade.protocolFee, creatorFee: q.trade.creatorFee, slippage: slipLamports,
      base: net.signaturesPerTx * net.baseFeePerSignature, priority: a.priorityFee, tip: net.tip,
    };
    a.fill = {
      intentId: a.intentId as IntentId, signature: a.signature as Signature, slot, commitment: 'confirmed',
      tokens: (a.purpose === 'entry' ? out : a.inAmount) as RawAmount,
      sol: (a.purpose === 'entry' ? q.trade.userQuote : out) as Lamports,
      fees: fee as Lamports,
    };
    done('filled', 'filled');
    this.#d.report({ type: 'intent', intentId: a.intentId as IntentId, event: { type: 'status', signature: a.signature as Signature, result: 'succeeded', commitment: 'confirmed', blockHeight: slot, searchedHistory: false } });
  }

  #status(intentId: IntentId, sig: Signature, searchHistory: boolean): void {
    const att = this.#intent(intentId)?.attempts.find((x) => x.signature === sig);
    if (att === undefined) return;
    const a = this.#attempts.get(sig);
    // A landed attempt's reports can be dated by its landing slot when no slot was seen yet (a reconcile at start).
    const height = this.#heightFor(sig, att.lastValidBlockHeight) ?? a?.landedSlot ?? null;
    if (height === null) return;
    const base = { type: 'status' as const, signature: sig, blockHeight: height, searchedHistory: searchHistory || a === undefined };
    if (a === undefined || (a.outcome !== 'filled' && a.outcome !== 'failed')) {
      this.#d.report({ type: 'intent', intentId, event: { ...base, result: 'not_found', commitment: null } });
      return;
    }
    this.#d.report({ type: 'intent', intentId, event: { ...base, result: a.outcome === 'filled' ? 'succeeded' : 'failed', commitment: a.outcome === 'filled' ? 'confirmed' : 'finalized' } });
  }

  #reconcile(intentId: IntentId): void {
    const i = this.#intent(intentId);
    if (i === undefined) return;
    const fills: Fill[] = [];
    let at: bigint | null = this.#height;
    for (const att of i.attempts) {
      const a = this.#attempts.get(att.signature);
      if (a?.outcome === 'filled' && a.fill !== null) {
        fills.push(a.fill);
        continue;
      }
      const h = this.#heightFor(att.signature, att.lastValidBlockHeight) ?? (a?.outcome === 'failed' ? a.landedSlot : null);
      const dead = a?.outcome === 'failed' || (h !== null && h > att.lastValidBlockHeight);
      // Balances are read only once no attempt can still land; the next tick asks again.
      if (!dead || h === null) return;
      if (at === null || h > at) at = h;
    }
    // Every attempt filled and no slot seen yet (a reconcile at start): the fills' own slots date the read.
    for (const f of fills) if (at === null || f.slot > at) at = f.slot;
    if (at === null) return;
    this.#d.report({ type: 'intent', intentId, event: { type: 'reconcile', fills, blockHeight: at } });
  }

  /** Signatures of attempts still in flight. */
  inFlight(): number {
    return [...this.#attempts.values()].filter((a) => a.outcome === 'in_flight').length;
  }
}
