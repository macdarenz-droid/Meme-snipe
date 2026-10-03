// H15 round-trip simulation (SIM-1): for a shortlisted candidate, a buy at the entry size then a sell of the quoted
// tokens in one unsigned transaction, built with the TX-1 builders, checked against TX-1b's supported shape, and
// passed to `simulateTransaction` exactly as TEST-2 does (stand-in fee payer, `sigVerify: false`, never sent). The
// answer becomes the raw `SimRead` that FACTS-1's `ingestSim` takes. Fail-safe: anything short of a clean, fully
// measured simulation gives no fact (H15 rejects the missing evidence) or a failed one (H15 rejects); never a pass.
//
// Loss is measured, not modelled: the node's own before/after balances of the stand-in's wallet, wrapped-SOL and
// base-token accounts, less the network fee the node reports and the rent the transaction paid into other
// accounts. `paid` is the buy leg's own figure from its venue event; `proceeds = paid − loss`, so any charge the
// model misses lowers proceeds and H15 sees it.
import {
  type Address, type Mint, NATIVE_MINT, PUMP_PROGRAM, SYSTEM_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM, bondingCurveAddress, decodeTokenAccount, logEvents,
} from '../../../core/src/chain/index.ts';
import type { RoundTrip } from '../../../core/src/costs/index.ts';
import type { SimRead } from '../../../core/src/facts/raw.ts';
import { compileV0, type LookupTableInput } from '../../../core/src/tx/compile.ts';
import { COMPUTE_BUDGET_PROGRAM, associatedTokenAddress, pumpCreatorVault } from '../../../core/src/tx/programs.ts';
import { setComputeUnitLimit, setComputeUnitPrice } from '../../../core/src/tx/native.ts';
import { rentExempt } from '../../../core/src/tx/rent.ts';
import { checkShape } from '../../../core/src/tx/shape.ts';
import { type BuildCommon, type BuiltTransaction, type ExecutionPolicy, type TradeRequest, buildTrade, requestShape } from '../../../core/src/tx/trade.ts';
import type { CurveMarket, PoolMarket } from '../../../core/src/tx/venues.ts';
import type { DryRunRpc, RawAccount } from '../dryrun/rpc.ts';
import { isPlainWallet, walletDerived } from '../dryrun/standin.ts';
import { ProviderError } from '../providers/http.ts';
import { P2, type Priority, ScheduleRefused } from '../scheduler/scheduler.ts';

export type RoundTripMarket = { readonly venue: 'curve'; readonly market: CurveMarket } | { readonly venue: 'pool'; readonly market: PoolMarket };

export interface RoundTripRequest {
  readonly mint: Mint;
  readonly venue: RoundTripMarket;
  /** The entry size, lamports: the gate request's `spend`. */
  readonly spend: bigint;
  /** The exact local round trip at that size (CORE-2), the same one H15 compares against. */
  readonly quote: RoundTrip;
  /** Build inputs as a live entry would use them; the wallet is replaced by the stand-in. */
  readonly common: BuildCommon;
  readonly policy: ExecutionPolicy;
  /** The feed's head slot: no simulation may run on older state. */
  readonly minContextSlot: bigint;
}

export interface RoundTripDeps {
  readonly rpc: DryRunRpc;
  /**
   * The "shortlisted" quota tier: P2 or P3 (below exits, reconciliation and open positions). P0 and P1 are refused
   * before any request. A scheduler refusal (budget spent, queue full) is "not evaluated": no fact.
   */
  readonly priority: Priority;
  /** A funded plain wallet (public address) that stands in as fee payer and buyer (TEST-2 ruling). */
  readonly standIn: Address;
  /** How long a funding check of the stand-in is trusted, ms. */
  readonly standInCheckMs: number;
  /** Wall clock for latency and the funding cache (the worker's timers). */
  readonly now: () => number;
}

export type SimOutcome =
  | 'simulated' // ok fact
  | 'sim-failed' // the program refused the round trip: failed fact
  | 'flagged' // simulated but not fully measurable: failed fact
  | 'unsupported-shape' // TX-1b refuses the trade: no fact
  | 'build-refused' // the builders refuse it: no fact
  | 'not-evaluated' // the quota scheduler refused: no fact
  | 'stand-in-unfunded' // the stand-in cannot pay: no fact
  | 'rpc-error' // timeout, HTTP or RPC error: no fact
  | 'malformed'; // the answer did not parse: no fact

/** One simulation, for the worker's journal (H15 is a live-only veto: G3 measures its bias from these). */
export interface SimRecord {
  readonly mint: string;
  readonly spend: bigint;
  readonly outcome: SimOutcome;
  /** Why it is not a clean pass; null for 'simulated'. */
  readonly reason: string | null;
  /** Helius credits this simulation spent (1 per call that reached the provider). */
  readonly credits: number;
  readonly latencyMs: number;
  readonly slot: bigint | null;
  readonly standIn: Address;
  readonly paid: bigint | null;
  readonly proceeds: bigint | null;
  readonly loss: bigint | null;
  /** The local model's loss (`quote.paid − quote.proceeds`), for the record. */
  readonly modelLoss: bigint;
  readonly networkFee: bigint | null;
  readonly rentPaid: bigint | null;
  readonly unitsConsumed: bigint | null;
}

export interface SimResult {
  /** The raw read for `FactReaders.ingestSim`, or null: no fact, so H15 rejects. */
  readonly read: SimRead | null;
  readonly record: SimRecord;
}

const LOG_TAIL = 3;

/**
 * The buy, then the sell of the quoted tokens, as one instruction list with one compute budget. The tip transfer is
 * left out: it does not touch the venue, so it cannot change the loss H15 measures, and without it (and its
 * jitodontfront marker) a PumpSwap round trip fits in one packet with no lookup table (1,241 bytes with it).
 */
export const roundTripInstructions = (buy: BuiltTransaction, sell: BuiltTransaction) => {
  const body = (t: BuiltTransaction) => {
    const ixs = t.instructions;
    if (ixs[0]?.programId !== COMPUTE_BUDGET_PROGRAM || ixs[1]?.programId !== COMPUTE_BUDGET_PROGRAM || ixs.at(-1)?.programId !== SYSTEM_PROGRAM) {
      throw new Error('unexpected build layout: compute budget first, tip last');
    }
    return ixs.slice(2, -1);
  };
  const limit = buy.computeUnitLimit + sell.computeUnitLimit;
  return {
    instructions: [setComputeUnitLimit(limit), setComputeUnitPrice(buy.computeUnitPriceMicroLamports), ...body(buy), ...body(sell)],
    computeUnitLimit: limit,
  };
};

/** Every account key in message order: static keys, then each table's writable, then each table's read-only ones. */
const messageKeys = (compiled: BuiltTransaction['compiled'], tables: readonly LookupTableInput[]): string[] => {
  const pick = (table: string, idx: readonly number[]) => {
    const t = tables.find((x) => x.address === table);
    if (!t) throw new Error(`lookup table ${table} is missing`);
    return idx.map((i) => t.addresses[i]!);
  };
  return [...compiled.staticKeys, ...compiled.lookups.flatMap((l) => pick(l.table, l.writable)), ...compiled.lookups.flatMap((l) => pick(l.table, l.readonly))];
};

export interface RentContext {
  readonly lamportsPerByte: bigint;
  /** Creator fees the stand-in's own trade events say went into the pump creator vault in this transaction. */
  readonly creatorFees: bigint;
  /**
   * The curve's data length before the transaction, as read (null: not read, so growth is counted as none). Never the
   * decision-time length.
   */
  readonly curveBytesBefore: number | null;
}

/**
 * Rent the transaction paid into one other account, from the node's before/after lamports and the account read back.
 * Only rent counts; anything else that left the wallet stays in the loss (review of PR #59):
 * - a new account: at most the rent-exempt minimum for its size (a wrapped-SOL account's rent reserve likewise);
 * - the pump creator vault: what it gained beyond the creator fees paid into it, at most its shortfall to rent-exempt;
 * - the curve: added bytes × the rate, against its measured length before.
 */
export const rentInto = (pre: bigint, post: bigint, after: RawAccount | null, kind: 'vault' | 'curve' | 'other', ctx: RentContext): bigint => {
  const rate = { lamportsPerByte: ctx.lamportsPerByte };
  if (kind === 'vault') {
    const need = rentExempt(0, rate);
    const topUp = post - pre - ctx.creatorFees;
    const shortfall = need - pre;
    return topUp <= 0n || shortfall <= 0n ? 0n : topUp < shortfall ? topUp : shortfall;
  }
  if (kind === 'curve') {
    return after !== null && ctx.curveBytesBefore !== null && after.data.length > ctx.curveBytesBefore ? BigInt(after.data.length - ctx.curveBytesBefore) * ctx.lamportsPerByte : 0n;
  }
  if (pre !== 0n || post === 0n || after === null) return 0n;
  const cap = rentExempt(after.data.length, rate);
  let rent = post;
  if (after.owner === TOKEN_PROGRAM || after.owner === TOKEN_2022_PROGRAM) {
    const native = decodeTokenAccount(after.data, after.owner as Address).isNative;
    if (native !== null) rent = native;
  }
  return rent < cap ? rent : cap;
};

/** The payer could not pay at all: the stand-in's funding, not the coin. */
export const isFundingError = (err: unknown): boolean => {
  if (err === 'InsufficientFundsForFee' || err === 'AccountNotFound') return true;
  if (typeof err !== 'object' || err === null) return false;
  const r = (err as Record<string, unknown>)['InsufficientFundsForRent'];
  return typeof r === 'object' && r !== null && (r as Record<string, unknown>)['account_index'] === 0;
};

export class RoundTripSimulator {
  readonly #d: RoundTripDeps;
  #funded: { readonly at: number; readonly lamports: bigint } | null = null;

  constructor(d: RoundTripDeps) {
    if (d.priority < P2) throw new RangeError(`round-trip simulation: priority P${d.priority} is reserved for exits and open positions; use P2 or P3`);
    this.#d = d;
  }

  async simulate(req: RoundTripRequest): Promise<SimResult> {
    const d = this.#d;
    const t0 = d.now();
    const mint = req.venue.venue === 'curve' ? req.venue.market.mint : req.venue.market.state.baseMint;
    let credits = 0;
    let rec: SimRecord = {
      mint, spend: req.spend, outcome: 'malformed', reason: null, credits: 0, latencyMs: 0, slot: null, standIn: d.standIn,
      paid: null, proceeds: null, loss: null, modelLoss: req.quote.paid - req.quote.proceeds, networkFee: null, rentPaid: null, unitsConsumed: null,
    };
    const done = (outcome: SimOutcome, reason: string | null, read: SimRead | null, more: Partial<SimRecord> = {}): SimResult => ({
      read,
      record: { ...rec, ...more, outcome, reason, credits, latencyMs: d.now() - t0 },
    });
    const failedRead = (slot: bigint, error: string): SimRead => ({ mint, slot, spend: req.spend, ok: false, paid: 0n, proceeds: 0n, error });

    // 1. The trade, as the builders would make it, inside TX-1b's supported shape.
    if (req.quote.spend !== req.spend) return done('build-refused', `the local round trip is for ${req.quote.spend}, not ${req.spend}`, null);
    const S = d.standIn;
    const c: BuildCommon = { ...req.common, wallet: S };
    const base = { mint: req.mint, ...req.venue } as const;
    const buyReq = (req.venue.venue === 'curve'
      ? { ...base, side: 'buy', spend: req.spend, quote: { spend: req.spend, tokens: req.quote.tokens, userQuote: req.quote.paid } }
      : { ...base, side: 'buy', spend: req.spend, quote: { spend: req.spend, base: req.quote.tokens, userQuote: req.quote.paid } }) as TradeRequest;
    const sellReq = (req.venue.venue === 'curve'
      ? { ...base, side: 'sell', quote: { tokens: req.quote.tokens, userQuote: req.quote.proceeds }, closeTokenAccount: false }
      : { ...base, side: 'sell', quote: { base: req.quote.tokens, userQuote: req.quote.proceeds }, closeTokenAccount: false }) as TradeRequest;
    const shape = checkShape(requestShape(buyReq));
    if (!shape.ok) return done('unsupported-shape', `${shape.reason}: ${shape.detail}`, null);
    const buy = buildTrade(buyReq, c, req.policy);
    if (!buy.ok) return done('build-refused', `buy: ${buy.reason} (${buy.detail})`, null);
    const sell = buildTrade(sellReq, c, req.policy);
    if (!sell.ok) return done('build-refused', `sell: ${sell.reason} (${sell.detail})`, null);
    const baseAta = associatedTokenAddress(S, mint, req.venue.market.baseTokenProgram);
    const wsolAta = associatedTokenAddress(S, NATIVE_MINT, TOKEN_PROGRAM);
    let wire: Uint8Array;
    let keys: string[];
    let writes: string[];
    try {
      const rt = roundTripInstructions(buy.tx, sell.tx);
      // Wallet-owned accounts stay static keys, as in every TX-1 build.
      const fixed = new Set<string>(walletDerived(S, mint, req.venue.market.baseTokenProgram));
      const compiled = compileV0(S, rt.instructions, c.recentBlockhash, c.lookupTables, (k) => !fixed.has(k));
      wire = compiled.wire;
      keys = messageKeys(compiled, c.lookupTables);
      writes = [...new Set(rt.instructions.flatMap((ix) => ix.accounts.filter((m) => m.writable && !m.signer).map((m) => m.address)))];
    } catch (e) {
      return done('build-refused', `round trip does not compile: ${(e as Error).message}`, null);
    }

    // One credit per call that reached the provider; a call the scheduler refused never left.
    const call = async <T>(f: () => Promise<T>): Promise<T> => {
      try {
        const r = await f();
        credits++;
        return r;
      } catch (e) {
        if (!(e instanceof ScheduleRefused)) credits++;
        throw e;
      }
    };
    try {
      // 2. The stand-in can pay: checked at most once per `standInCheckMs` (one credit).
      // Worst case of both legs (their tips included, so it is an upper bound) and the stand-in staying rent-exempt.
      const need = buy.tx.solOut.total + sell.tx.solOut.total + rentExempt(0, c.rates.rent);
      if (this.#funded === null || d.now() - this.#funded.at >= d.standInCheckMs) {
        const r = await call(() => d.rpc.getMultipleAccounts([S], req.minContextSlot, d.priority));
        const a = r.accounts[0] ?? null;
        this.#funded = { at: d.now(), lamports: isPlainWallet(a) ? a.lamports : -1n };
      }
      if (this.#funded.lamports < need) return done('stand-in-unfunded', `the stand-in needs ${need} lamports and holds ${this.#funded.lamports < 0n ? 'no plain wallet' : this.#funded.lamports}`, null);

      // 3. Simulate (one credit). The stand-in's own accounts first, then every other account the round trip writes.
      const readBack = [S, wsolAta, baseAta, ...writes.filter((w) => w !== S && w !== wsolAta && w !== baseAta)];
      const sim = await call(() => d.rpc.simulate(wire, readBack, req.minContextSlot, d.priority));
      const v = sim.value;
      rec = { ...rec, slot: sim.slot, unitsConsumed: v.unitsConsumed };
      if (v.err !== null && isFundingError(v.err)) {
        // Not evidence about the coin: no fact (so it neither vetoes nor enters G3's veto-bias count); check again next time.
        this.#funded = null;
        return done('stand-in-unfunded', `the stand-in could not pay: ${JSON.stringify(v.err)}`, null);
      }
      if (v.err !== null) {
        const error = `${JSON.stringify(v.err)}${v.logs.length > 0 ? ` (${v.logs.slice(-LOG_TAIL).join(' | ')})` : ''}`;
        return done('sim-failed', error, failedRead(sim.slot, error));
      }

      // 4. Measure. Missing fee data or balances: a failed fact, never a pass.
      const flag = (why: string, more: Partial<SimRecord> = {}) => done('flagged', why, failedRead(sim.slot, why), more);
      if (v.fee === null) return flag('the simulation reported no fee');
      if (v.preBalances === null || v.postBalances === null || v.preBalances.length !== keys.length || v.postBalances.length !== keys.length) {
        return flag('the simulation reported no before/after balances for every account');
      }
      const at = (a: string) => keys.indexOf(a);
      for (let i = 0; i < readBack.length; i++) {
        const k = at(readBack[i]!);
        if (k < 0 || v.postBalances[k] !== (v.accounts[i]?.lamports ?? 0n)) return flag('the simulation\'s balances disagree with the accounts it read back');
      }
      // The buy leg's own payment, from its venue event (inner `emit!` log line, DEC-1's reader).
      const events = logEvents(v.logs, null);
      if (events.truncated) return flag('the simulation log was truncated before the buy event');
      let paid: bigint | null = null;
      // Creator fees the stand-in's own trades paid into the creator vault (buy and sell): not rent.
      let creatorFees = 0n;
      for (const e of events.events) {
        if (req.venue.venue === 'curve' && e.name === 'TradeEvent' && e.data.user === S && e.data.mint === mint) {
          if (e.data.fee === undefined || e.data.creatorFee === undefined) return flag('a trade event has no fee fields');
          creatorFees += e.data.creatorFee;
          if (e.data.isBuy && paid === null) paid = e.data.solAmount + e.data.fee + e.data.creatorFee;
        }
        if (req.venue.venue === 'pool' && e.name === 'BuyEvent' && e.data.user === S && paid === null) paid = e.data.userQuoteAmountIn;
      }
      if (paid === null) return flag('no buy event from the stand-in in the simulation log');

      const own = [S, wsolAta, baseAta].map(at);
      const delta = own.reduce((s, k) => s + v.postBalances![k]! - v.preBalances![k]!, 0n);
      const vault = req.venue.venue === 'curve' && req.venue.market.curve.creator !== undefined ? pumpCreatorVault(req.venue.market.curve.creator) : null;
      const curve = req.venue.venue === 'curve' ? bondingCurveAddress(mint) : null;
      // Curve growth is counted only against the curve's measured length. A curve longer after the simulation than
      // the length the decision saw may have grown in this transaction, so it is read now (1 credit); a length that
      // grew in between makes the counted growth smaller, never larger (sizes only grow), so the loss errs high.
      let curveBytesBefore: number | null = null;
      const curveIdx = curve === null ? -1 : readBack.indexOf(curve);
      const curveAfter = curveIdx < 0 ? null : (v.accounts[curveIdx] ?? null);
      if (req.venue.venue === 'curve' && curve !== null && curveAfter !== null && curveAfter.data.length > req.venue.market.accountBytes) {
        const now = await call(() => d.rpc.getMultipleAccounts([curve], sim.slot, d.priority));
        curveBytesBefore = now.accounts[0]?.data.length ?? null;
      }
      const ctx: RentContext = { lamportsPerByte: c.rates.rent.lamportsPerByte, creatorFees, curveBytesBefore };
      let rentPaid = 0n;
      for (let i = 3; i < readBack.length; i++) {
        const a = readBack[i]!;
        const k = at(a);
        const kind = a === vault ? 'vault' : a === curve ? 'curve' : 'other';
        rentPaid += rentInto(v.preBalances[k]!, v.postBalances[k]!, v.accounts[i] ?? null, kind, ctx);
      }
      const loss = -delta - v.fee - rentPaid;
      rec = { ...rec, networkFee: v.fee, rentPaid, loss };

      if (paid > req.spend) return flag(`the buy paid ${paid}, more than the spend ${req.spend}`, { paid });
      const proceeds = paid - loss;
      if (proceeds < 0n) return flag(`the round trip lost ${loss}, more than the ${paid} paid`, { paid });
      const read: SimRead = { mint, slot: sim.slot, spend: req.spend, ok: true, paid, proceeds, error: null };
      return done('simulated', null, read, { paid, proceeds });
    } catch (e) {
      if (e instanceof ScheduleRefused) return done('not-evaluated', e.message, null);
      if (e instanceof ProviderError) return done(e.kind === 'shape' ? 'malformed' : 'rpc-error', e.message, null);
      return done('malformed', (e as Error).message, null);
    }
  }
}
