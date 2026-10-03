// S0, the random-entry control (docs/ARCHITECTURE.md §3.2): the same universe filters and exits as a strategy, with
// the entry moment drawn at random inside the universe's window. It runs inside the engine, so it reads only what
// the engine hands it (as-of lookups and its seeded rng) and acts only through decisions.
//
// Universe U2 (post-graduation reclaim): canonical PumpSwap pools with a SOL quote, not mayhem, aged 60–240 min after
// migration. GATE-1's hard rejects do not exist yet; BT-2 adds them to both S0 and the strategies. Exit: the policy's
// time stop (EXIT-1 replaces it). Every candidate, reject, entry and exit is a logged decision with its reasons.
import { createHash } from 'node:crypto';
import { type PoolState, poolBuyExactQuoteIn, poolSell } from '../../../core/src/amm/index.ts';
import { encodeBase58 } from '../../../core/src/chain/index.ts';
import type { LadderStep } from '../../../core/src/config/index.ts';
import {
  attemptId, blockhash, entryKey, type IntentId, intentId, mint as toMint, positionId, reservationId, signature, type TransactionAttempt,
  type QuoteContext,
} from '../../../core/src/domain/index.ts';
import type { Decision, MarketEvent, Strategy, StrategyContext } from '../../../core/src/engine/index.ts';
import { observedFeeContext } from '../../../core/src/fills/index.ts';
import { canOpenNewEntry, isTerminal, type IntentState } from '../../../core/src/lifecycle/index.ts';
import { type Bps, BPS_DENOMINATOR, type Lamports, type MicroUsd, bps, microUsdToLamports, mulDiv, solPriceMicroUsd } from '../../../core/src/units/index.ts';
import { type Discovery, NATIVE_MINTS, type PoolView } from '../sim/market.ts';

export interface S0Config {
  readonly universe: 'U2';
  /** Candidate window after migration, ms. */
  readonly windowFromMs: number;
  readonly windowToMs: number;
  /** Time stop after the entry fill (policy exits.tMaxMs). */
  readonly holdMs: number;
  /** Notional per entry (policy capital.minNotional). */
  readonly notional: MicroUsd;
  /** Least accepted entry output, below the local quote (§10: entry 2–3%). */
  readonly entryMinOutBelowBps: number;
  /** Exit escalation ladder (policy exits.ladder). */
  readonly ladder: { readonly steps: readonly LadderStep[]; readonly maxAttempts: number };
  readonly blockhashValidBlocks: bigint;
  /** No entry is planned to start after this (ms), so every trade can finish inside the data. */
  readonly stopEntriesAt: number;
  /** A blocked exit is tried again after this long, at most this many times. */
  readonly blockedRetryMs: number;
  readonly blockedRetries: number;
}

const NORMAL = { mayhemMode: false, transferFee: false, transferHook: false } as const;

/** A deterministic 64-byte paper signature: the attempt's id hashed twice. Never a real transaction. */
const paperSignature = (id: string) =>
  signature(encodeBase58(new Uint8Array([...createHash('sha256').update(`sig1:${id}`).digest(), ...createHash('sha256').update(`sig2:${id}`).digest()])));
const paperBlockhash = (id: string) => blockhash(encodeBase58(createHash('sha256').update(`bh:${id}`).digest()));

const poolState = (v: PoolView): PoolState => ({ baseReserve: v.baseReserve, quoteVault: v.quoteVault, virtualQuoteReserves: v.virtualQuoteReserves });

interface Plan {
  readonly d: Discovery;
  readonly enterAt: number;
  readonly windowEnd: number;
}

interface Held {
  readonly mint: string;
  readonly pool: string;
  openedAt: number | null;
  exits: number;
  blockedAt: number | null;
  blocked: number;
}

export class S0 implements Strategy {
  readonly #c: S0Config;
  readonly #plans = new Map<string, Plan>();
  readonly #live = new Set<IntentId>();
  readonly #held = new Map<string, Held>();

  constructor(config: S0Config) {
    if (config.windowToMs <= config.windowFromMs) throw new RangeError('the candidate window must be non-empty');
    this.#c = config;
  }

  onMarket(e: MarketEvent, ctx: StrategyContext): readonly Decision[] {
    const out: Decision[] = [];
    if (e.key.startsWith('disc:')) this.#discover(e.value as Discovery, ctx, out);
    this.#lifecycle(e, ctx, out);
    this.#exits(e, ctx, out);
    // ctx.book is the book before this call's decisions: an entry is judged on it only while nothing else acted,
    // and at most one entry is proposed per call (CORE-1 allows one entry in flight).
    if (!out.some((d) => d.action !== null)) this.#entries(e, ctx, out);
    return out;
  }

  #discover(d: Discovery, ctx: StrategyContext, out: Decision[]): void {
    const u = this.#c.universe;
    const reject = (why: string) => out.push({ action: null, reasons: ['reject', u, d.mint, why] });
    if (d.canonical !== true) return void reject(d.canonical === null ? 'pool creation not seen: canonical unproven' : 'not a canonical pool');
    if (!NATIVE_MINTS.has(d.quoteMint)) return void reject('quote is not SOL');
    if (d.mayhem !== false) return void reject(d.mayhem === null ? 'mayhem flag unknown' : 'mayhem coin');
    const from = d.graduatedAt + this.#c.windowFromMs;
    const to = d.graduatedAt + this.#c.windowToMs;
    const enterAt = from + ctx.rng.int(to - from);
    if (enterAt > this.#c.stopEntriesAt) return void reject('entry moment after the run stops entries');
    if (this.#plans.has(d.mint) || this.#held.has(d.mint)) return void reject('already a candidate');
    this.#plans.set(d.mint, { d, enterAt, windowEnd: to });
    out.push({ action: null, reasons: ['candidate', u, d.mint, `enter ${enterAt - d.graduatedAt} ms after migration`] });
  }

  /**
   * The block height a transaction signed while handling `e` would take its blockhash from: carried on the event itself
   * (pool swaps, discoveries and slot events all carry it), so a heartbeat's older height is never used.
   */
  #blockHeight(e: MarketEvent, ctx: StrategyContext): bigint | null {
    const v = e.value as { blockHeight?: unknown } | null;
    if (v !== null && typeof v === 'object' && typeof v.blockHeight === 'bigint') return v.blockHeight;
    const s = ctx.lookup('slot');
    return s.ok ? (s.value as { blockHeight: bigint }).blockHeight : null;
  }

  #attempt(id: IntentId, n: number, quote: QuoteContext, height: bigint): TransactionAttempt {
    const a = `${id}.a${n}`;
    return {
      id: attemptId(a), intentId: id, signedBytesRef: `paper:${a}`, signature: paperSignature(a), blockhash: paperBlockhash(a),
      lastValidBlockHeight: height + this.#c.blockhashValidBlocks, quote,
    };
  }

  #entries(e: MarketEvent, ctx: StrategyContext, out: Decision[]): void {
    const now = ctx.now.receivedAt;
    for (const [mint, p] of this.#plans) {
      if (p.enterAt > now) continue;
      const drop = (why: string) => {
        this.#plans.delete(mint);
        out.push({ action: null, reasons: ['no entry', this.#c.universe, mint, why] });
      };
      if (now >= p.windowEnd) {
        drop('window ended before an entry was possible');
        continue;
      }
      if (!canOpenNewEntry(ctx.book).ok) continue;
      const height = this.#blockHeight(e, ctx);
      if (height === null) continue;
      const px = ctx.lookup('sol-usd');
      if (!px.ok) {
        drop('SOL/USD unknown');
        continue;
      }
      const pool = ctx.lookup(`pool:${p.d.pool}`);
      if (!pool.ok) {
        drop('pool state unknown');
        continue;
      }
      const view = pool.value as PoolView;
      const spend = microUsdToLamports(this.#c.notional, solPriceMicroUsd((px.value as { close: string }).close), 'floor');
      if (spend <= 1n) {
        drop('notional is below one lamport');
        continue;
      }
      const q = poolBuyExactQuoteIn(poolState(view), spend, observedFeeContext(view.fees, view.baseSupply, NORMAL));
      if (!q.ok) {
        drop(`no quote: ${q.reason}`);
        continue;
      }
      const id = intentId(`en:${mint}`);
      const tm = toMint(mint);
      const slip = bps(this.#c.entryMinOutBelowBps);
      const quote: QuoteContext = {
        provider: 'pumpswap-local', requestId: null, inAmount: spend, quotedOut: q.trade.base,
        minOut: mulDiv(q.trade.base, BPS_DENOMINATOR - BigInt(slip), BPS_DENOMINATOR, 'floor'), slippage: slip, quotedAtSlot: null,
      };
      this.#plans.delete(mint);
      this.#live.add(id);
      this.#held.set(mint, { mint, pool: p.d.pool, openedAt: null, exits: 0, blockedAt: null, blocked: 0 });
      const u = this.#c.universe;
      const intent = { id, key: entryKey(tm, 's0'), purpose: 'entry' as const, side: 'buy' as const, mint: tm, venue: 'pumpswap' as const, positionId: positionId(`p:${mint}`), spend: spend as Lamports };
      const act = (event: Exclude<Decision['action'], null>, why: string) => out.push({ action: event, reasons: [why, u, mint] });
      act({ type: 'propose_entry', intent }, 'enter');
      act({ type: 'intent', intentId: id, event: { type: 'mark_eligible' } }, 'eligible');
      act({ type: 'intent', intentId: id, event: { type: 'approve_risk' } }, 'risk approved');
      act({ type: 'intent', intentId: id, event: { type: 'reserve_exposure', reservation: { id: reservationId(`r:${mint}`), intentId: id, amount: spend as Lamports, status: 'held' } } }, 'reserve');
      act({ type: 'intent', intentId: id, event: { type: 'prepare', quote } }, 'prepare');
      act({ type: 'intent', intentId: id, event: { type: 'sign', attempt: this.#attempt(id, 1, quote, height) } }, 'sign');
      act({ type: 'intent', intentId: id, event: { type: 'submit' } }, 'submit');
      return;
    }
  }

  /** Local sell quote at the rung's floor, or the CORE-2 reason it cannot be quoted. */
  #sellQuote(ctx: StrategyContext, h: Held, tokens: bigint, rung: LadderStep): QuoteContext | string {
    const pool = ctx.lookup(`pool:${h.pool}`);
    if (!pool.ok) return 'pool state unknown';
    const view = pool.value as PoolView;
    const q = poolSell(poolState(view), tokens, observedFeeContext(view.fees, view.baseSupply, NORMAL));
    if (!q.ok) return `no quote: ${q.reason}`;
    const below = BigInt(rung.minOutBelowTriggerBps);
    return {
      provider: 'pumpswap-local', requestId: null, inAmount: tokens, quotedOut: q.trade.userQuote,
      minOut: mulDiv(q.trade.userQuote, BPS_DENOMINATOR - below, BPS_DENOMINATOR, 'floor'), slippage: rung.minOutBelowTriggerBps as Bps, quotedAtSlot: null,
    };
  }

  #exits(e: MarketEvent, ctx: StrategyContext, out: Decision[]): void {
    const now = ctx.now.receivedAt;
    for (const h of this.#held.values()) {
      const p = ctx.book.positions[`p:${h.mint}`];
      if (p === undefined) continue;
      if (p.status === 'closed') {
        this.#held.delete(h.mint);
        continue;
      }
      if (p.status === 'open' && h.openedAt === null) h.openedAt = now;
      const due = p.status === 'open' && h.openedAt !== null && now >= h.openedAt + this.#c.holdMs;
      const retry = p.status === 'exit_blocked' && h.blockedAt !== null && h.blocked <= this.#c.blockedRetries && now >= h.blockedAt + this.#c.blockedRetryMs;
      if (!due && !retry) continue;
      const height = this.#blockHeight(e, ctx);
      if (height === null) continue;
      const rung = this.#c.ladder.steps[0]!;
      const id = intentId(`ex:${h.mint}:${++h.exits}`);
      const q = this.#sellQuote(ctx, h, p.quantity, rung);
      const why = retry ? 'retry blocked exit' : 'time stop';
      out.push({ action: { type: 'trigger_exit', positionId: p.id, reasons: ['max_hold'], intentId: id }, reasons: [why, this.#c.universe, h.mint] });
      if (typeof q === 'string') {
        h.blockedAt = now;
        h.blocked++;
        out.push({ action: { type: 'exit_blocked', positionId: p.id, reason: q }, reasons: ['exit blocked', this.#c.universe, h.mint, q] });
        continue;
      }
      this.#live.add(id);
      out.push({ action: { type: 'intent', intentId: id, event: { type: 'prepare', quote: q } }, reasons: ['prepare exit', h.mint] });
      out.push({ action: { type: 'intent', intentId: id, event: { type: 'sign', attempt: this.#attempt(id, 1, q, height) } }, reasons: ['sign exit', h.mint] });
      out.push({ action: { type: 'intent', intentId: id, event: { type: 'submit' } }, reasons: ['submit exit', h.mint] });
    }
  }

  /** Ends or replaces intents whose attempt resolved without a fill. */
  #lifecycle(e: MarketEvent, ctx: StrategyContext, out: Decision[]): void {
    for (const id of this.#live) {
      const i: IntentState | undefined = ctx.book.intents[id];
      if (i === undefined) {
        this.#live.delete(id);
        continue;
      }
      if (isTerminal(i)) {
        this.#live.delete(id);
        continue;
      }
      if (i.status !== 'reconciled' || i.fills.length > 0) continue;
      const mint = i.intent.mint;
      if (i.intent.purpose === 'entry') {
        out.push({ action: { type: 'intent', intentId: id, event: { type: 'abandon' } }, reasons: ['entry not filled', mint] });
        continue;
      }
      const h = this.#held.get(mint);
      const height = this.#blockHeight(e, ctx);
      if (h === undefined || height === null) continue;
      const n = i.attempts.length + 1;
      const steps = this.#c.ladder.steps;
      const rung = steps[Math.min(n - 1, steps.length - 1)]!;
      const q = n > this.#c.ladder.maxAttempts ? 'exit ladder exhausted' : this.#sellQuote(ctx, h, i.intent.purpose === 'exit' ? i.intent.quantity : 0n, rung);
      if (typeof q === 'string') {
        h.blockedAt = ctx.now.receivedAt;
        h.blocked++;
        out.push({ action: { type: 'exit_blocked', positionId: i.intent.positionId, reason: q }, reasons: ['exit blocked', mint, q] });
        continue;
      }
      out.push({ action: { type: 'intent', intentId: id, event: { type: 'sign_replacement', attempt: this.#attempt(id, n, q, height), blockHeight: height } }, reasons: [`exit attempt ${n}`, mint] });
      out.push({ action: { type: 'intent', intentId: id, event: { type: 'submit' } }, reasons: ['submit exit', mint] });
    }
  }
}
