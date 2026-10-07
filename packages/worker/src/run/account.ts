// The paper account (risk's AccountHistory, RISK-1): built from the ledger (reservations held, account version, read in
// one transaction) and the worker's record of its own paper trades (account.json: the paper wallet, each trade's
// notional, open and close times and net result). Only the bot's own paper trades: no personal data (CLAUDE.md ruling).
import type { Mint } from '../../../core/src/domain/index.ts';
import { type FillNetwork, type LegCosts, type TradeLamports, entryShare, feeParts, lateFillClaims, lateFillOf, tradeNet, tradeRent, tradeUsd } from '../../../core/src/fills/index.ts';
import type { Ledger } from '../../../core/src/ledger/index.ts';
import { type Book, isTerminal } from '../../../core/src/lifecycle/index.ts';
import { type AccountCost, type AccountHistory, type ClosedTrade, type Latches, type RiskSnapshot, melbourneDay, melbourneWeek } from '../../../core/src/risk/index.ts';
import { LAMPORTS_PER_SOL, type Lamports, type MicroUsd, lamportsToMicroUsd, microUsdToLamports } from '../../../core/src/units/index.ts';
import type { AccountFact } from '../engine/strategy.ts';
import type { PaperAttempt } from './paper-world.ts';
import type { FilledRecord } from './desk.ts';
import { StateFile } from './state.ts';

/** What a paper trade's settlement reads from the paper world (PAPER-1). */
export interface PaperLegs {
  readonly network: FillNetwork;
  /** Every paper attempt, by signature: each one's fee is counted once, whatever reports it. */
  readonly attempts: ReadonlyMap<string, PaperAttempt>;
  /** True when that filled sell closed its token account (its rent came back). */
  readonly closedAccount: (signature: string) => boolean;
}

/** One leg's costs from its paper attempts: fees by outcome (core's `feeParts`), venue, creator and slippage of fills. */
const legOf = (as: readonly PaperAttempt[], net: FillNetwork): LegCosts => {
  const l = { networkBase: 0n, priority: 0n, tip: 0n, venueFee: 0n, creatorFee: 0n, slippage: 0n };
  for (const a of as) {
    const f = feeParts(net, a.priorityFee, a.outcome);
    l.networkBase += f.base;
    l.priority += f.priority;
    l.tip += f.tip;
    if (a.outcome !== 'filled' || a.costs === undefined) continue;
    l.venueFee += a.costs.venueFee;
    l.creatorFee += a.costs.creatorFee;
    l.slippage += a.costs.slippage;
  }
  return l;
};

/**
 * A paper position's round trip in lamports, settled as the backtest settles its trades (backtest/src/trades.ts, the
 * same core functions): every attempt's fee, failed ones included, exactly once per signature; the entry's
 * token-account rent on its first trade, back only when one of its sells closed the account (RENT-1).
 */
export const paperTradeLamports = (book: Book, positionId: string, legs: PaperLegs): TradeLamports | null => {
  const p = book.positions[positionId];
  if (p === undefined) return null;
  const share = entryShare(book, p, lateFillClaims(book));
  const intents = Object.values(book.intents);
  const exitsOf = (pid: string) => intents.filter((i) => i.intent.purpose === 'exit' && i.intent.positionId === pid);
  // A fill counts once the book holds it (its reconcile), never on landing alone: until then the position still holds
  // the tokens and its mark values them. A landed failure's fee counts on landing (nothing else moves).
  const booked = new Set(intents.flatMap((i) => i.fills.map((f) => f.signature as string)));
  const counted = (a: PaperAttempt) => a.outcome !== 'filled' || booked.has(a.signature);
  const of = (ok: (a: PaperAttempt) => boolean) => [...legs.attempts.values()].filter((a) => counted(a) && ok(a)).sort((x, y) => (x.signature < y.signature ? -1 : 1));
  const mine = new Set(exitsOf(p.id).map((i) => i.intent.id as string));
  const entry = of((a) => a.intentId === p.entryIntentId && share.owns(a.signature));
  const exit = of((a) => mine.has(a.intentId));
  // One token account per entry: a sell of any of its positions can close it.
  const siblings = new Set(Object.values(book.positions).filter((x) => x.entryIntentId === p.entryIntentId).flatMap((x) => exitsOf(x.id).map((i) => i.intent.id as string)));
  const closed = of((a) => a.outcome === 'filled' && siblings.has(a.intentId)).some((a) => legs.closedAccount(a.signature));
  const { rentPaid, rentReturned } = tradeRent(legs.network, lateFillOf(p.id) === null, closed);
  return {
    entrySol: share.fills.reduce((t, f) => t + f.sol, 0n),
    exitSol: exitsOf(p.id).reduce((t, i) => t + i.fills.reduce((s, f) => s + f.sol, 0n), 0n),
    legs: { entry: legOf(entry, legs.network), exit: legOf(exit, legs.network) }, rentPaid, rentReturned,
  };
};

export interface PaperTrade {
  readonly positionId: string;
  readonly mint: string;
  readonly openedAtMs: number;
  /** SOL-BOOKS: q, the SOL the entry spent (the decision's `notional`), in lamports. */
  notional: Lamports;
  closedAtMs: number | null;
  /** The whole trade's net result in lamports: what risk counts (SOL-BOOKS). */
  netLamports: bigint | null;
  /** The same in micro-dollars at the close's SOL price, for display only (null without a price). */
  netPnl: MicroUsd | null;
  stoppedOut: boolean;
  /** Net lamports of this trade already applied to the paper wallet. */
  booked: bigint;
  /** SOL/USD (micro-dollars) when it opened and closed: the report values lamports at these. */
  openSolPrice?: MicroUsd | null;
  closeSolPrice?: MicroUsd | null;
  /** The book's exit reasons of the closing exit. */
  exitReasons?: readonly string[];
  /**
   * ACCOUNT-RATE: the legs booked while no SOL price was known, valued at the first price at or after their fill
   * (`priceLate`) instead of a fill-time rate. Absent when every leg had its own rate.
   */
  pricedLate?: readonly ('open' | 'close')[];
  /**
   * What landed after the trade closed (PAPER-2): each change to its net, in lamports and in micro-dollars (negative: a
   * loss), dated when it was booked. The close's own `netLamports`/`netPnl` stay as they were, so a day already checked
   * is never rewritten; a late loss counts toward the day it is booked (risk's `late_settlement` cost).
   */
  late?: { readonly atMs: number; readonly lamports: bigint; readonly usd: MicroUsd | null }[];
  /**
   * RISK-PARTIAL: each partial sale's realized result (proceeds after its fees less its share of the basis), and the
   * tokens and net exit lamports those parts cover. Absent in files from before (no partial booked).
   */
  partials?: { readonly atMs: number; readonly lamports: bigint }[];
  partialSold?: bigint;
  partialNet?: bigint;
  /**
   * ACCOUNT-RATE: the failed exit attempts (signatures) whose fees a partial sale has realized (in `partialNet`): not
   * counted again as open-trade costs. Absent before any part.
   */
  partialFailedExits?: readonly string[];
}

/** A trade's whole SOL result: at its close, and what landed after (PAPER-2). Null while open. */
export const tradeSol = (t: PaperTrade): bigint | null =>
  t.netLamports === null ? null : (t.late ?? []).reduce((s, x) => s + x.lamports, t.netLamports);

/** A trade's whole dollar result: at its close, and what landed after (PAPER-2). Null while open or unvalued. */
export const tradePnl = (t: PaperTrade): MicroUsd | null =>
  t.netPnl === null ? null : ((t.late ?? []).reduce((s, x) => s + (x.usd ?? 0n), t.netPnl as bigint) as MicroUsd);

export interface AccountState {
  readonly openedAtMs: number;
  /** The bankroll B in micro-dollars, as configured. */
  readonly openingEquity: MicroUsd;
  /**
   * SOL-BOOKS: the SOL/USD price fixed at the first price the account saw. It converts B (and the policy's other dollar
   * amounts, in risk) into lamports once; no later price moves a figure or a limit. Absent until that first price.
   */
  openingSolPrice?: MicroUsd;
  /** 'sol' once every amount below is in lamports; absent in a file from before SOL-BOOKS (converted at the opening). */
  books?: 'sol';
  /** The paper wallet in lamports: null until the first SOL/USD price converts the bankroll. */
  walletLamports: bigint | null;
  readonly trades: PaperTrade[];
  readonly entries: { readonly mint: string; readonly atMs: number }[];
  /** The paper wallet's one-time accounts were paid at its setup; absent in files from before (paid at the next start). */
  oneTimePaid?: boolean;
  /** That setup as a realised cost: when, in lamports (risk counts these), and in micro-dollars at the setup SOL price. */
  setup?: { readonly atMs: number; readonly lamports: bigint; readonly cost: MicroUsd };
  /**
   * Marked equity at the start of the Melbourne day and week (WORKER-1c): the first equity the worker saw at or after
   * the boundary `startMs`, taken at `atMs` (later than the boundary when the worker was down then).
   */
  dayMark?: BoundaryMark;
  weekMark?: BoundaryMark;
  /** The highest economic NAV seen since the last kill-switch re-arm (R10's NAV high-water mark reads it), in lamports. */
  navPeak?: { readonly atMs: number; readonly nav: Lamports };
  /**
   * Fees of entries that never filled (the backtest's stray costs, PAPER-1), by signature: when booked (never before the
   * send, ACCOUNT-RATE F3), lamports (what risk counts, SOL-BOOKS), and micro-dollars at the SOL price when it was booked
   * (rounded up, for display). Supervisor-approved stored data.
   */
  strayFees?: Record<string, StrayFee>;
  /**
   * ACCOUNT-RATE F1: when the account first saw each failed attempt of a trade still open (`settle`), by signature:
   * its open-trade cost is dated max(sent, first seen), and a restart keeps that date. Dropped once the trade closes.
   */
  openFeesSeen?: Record<string, number>;
  /** Stray fees from before the current Melbourne week, folded into one total: every attempt sent at or before `atMs`. */
  strayFolded?: StrayFee;
}

export interface StrayFee {
  readonly atMs: number;
  readonly lamports: bigint;
  /** Display only: micro-dollars at the first SOL price at or after its booking, rounded up; null until then (SOL-BOOKS). */
  readonly cost: MicroUsd | null;
}

export interface BoundaryMark {
  readonly startMs: number;
  readonly atMs: number;
  readonly equity: Lamports;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const accountFile = (dir: string) =>
  new StateFile<AccountState>(dir, 'account.json', (v) => (isObj(v) && typeof v['openedAtMs'] === 'number' && typeof v['openingEquity'] === 'bigint' && Array.isArray(v['trades']) && Array.isArray(v['entries']) ? (v as unknown as AccountState) : null));

/**
 * The share of the basis (entry SOL and fees) that `sold` of `bought` tokens carries: the rest keeps its share rounded
 * up, so what is still held is never under-costed.
 */
const soldBasis = (basis: bigint, bought: bigint, sold: bigint): bigint => {
  if (bought <= 0n) return 0n;
  const left = sold >= bought ? 0n : bought - sold;
  return basis - (basis * left + bought - 1n) / bought;
};

/** Lamports in micro-dollars for display, a loss rounded up. */
const usdOf = (l: bigint, price: MicroUsd): MicroUsd =>
  (l >= 0n ? lamportsToMicroUsd(l as Lamports, price, 'floor') : -lamportsToMicroUsd((-l) as Lamports, price, 'ceil')) as MicroUsd;

const STOPS = new Set(['stop', 'trailing_stop', 'thesis_lost', 'liquidity']);
const EXIT_REASONS = new Set(['stop', 'trailing_stop', 'take_profit', 'max_hold', 'thesis_lost', 'liquidity', 'emergency']);

/** An account cost with its lamports; an open trade's cost also says which part it is (ACCOUNT-RATE, for the app). */
/** An account cost for the app: risk's lamports (`amount`, = `lamports`) and its dollar value for display (`usd`). */
export type CostRecord = AccountCost & { readonly lamports: bigint; readonly usd: MicroUsd; readonly part?: 'fee' | 'rent' };

export class PaperAccount {
  readonly #file: StateFile<AccountState>;
  readonly #s: AccountState;

  readonly #oneTimeRent: bigint;
  #now: number;

  /** `oneTimeRent`: what a fresh wallet pays once for accounts it never closes (settings `oneTimeRent`). */
  constructor(file: StateFile<AccountState>, bankroll: MicroUsd, nowMs: number, oneTimeRent: bigint) {
    this.#file = file;
    this.#oneTimeRent = oneTimeRent;
    this.#s = file.read({ openedAtMs: nowMs, openingEquity: bankroll, books: 'sol', walletLamports: null, trades: [], entries: [] });
    this.#now = nowMs;
    file.write(this.#s);
  }

  get state(): Readonly<AccountState> {
    return this.#s;
  }

  /**
   * At the first known SOL price: fixes it as the opening SOL price (SOL-BOOKS) and converts the bankroll into the paper
   * wallet at it. Later prices change nothing here.
   */
  price(solPrice: MicroUsd | null, nowMs: number = this.#now): void {
    if (solPrice === null || solPrice <= 0n) return;
    const opening = this.#s.openingSolPrice === undefined;
    if (!opening && this.#s.walletLamports !== null && this.#s.oneTimePaid === true) return;
    if (opening && !this.#open(solPrice)) return;
    if (this.#s.walletLamports === null) this.#s.walletLamports = microUsdToLamports(this.#s.openingEquity, this.#s.openingSolPrice!, 'floor');
    this.#setUp(solPrice, nowMs);
    this.#file.write(this.#s);
  }

  /**
   * SOL-BOOKS: fixes the opening SOL price. A new account opens at this price: the bankroll becomes its wallet here.
   *
   * An account whose wallet is already in lamports (a file from before SOL-BOOKS, or one in SOL that lost its opening
   * price) was funded at another price: its first price, not this one. Opening at this price would make the bankroll
   * B / this price while the wallet is still B / that one, so a SOL/USD fall since then alone would read as a drawdown
   * (31% latches R10; risk review F1). Its opening price is read from the wallet instead: the SOL it was funded with
   * (the wallet less what the account itself has booked since: the setup rent, stray fees and each trade's net), and
   * the price at which B is that SOL, rounded up, so B in lamports (rounded down) is never more than the wallet held.
   * One stored price keeps every limit (B, q_min, q_max, the floors) converted at the same rate the wallet was. With no
   * positive funded SOL the opening stays unset (risk refuses entries, R1) and false is returned.
   *
   * A file from before also kept its day and week marks and trade sizes in micro-dollars: converted once at the opening
   * price, each rounded the tighter way (marks up, sizes down). Trade results are already in lamports. Its NAV peak is
   * dropped, not converted: with the wallet's SOL unchanged it is the highest SOL/USD price seen, and converting it
   * would turn a past SOL/USD fall into a SOL drawdown (R10; owner's rule: a SOL/USD move alone never trips a limit). It
   * is recorded again in lamports at the next fully marked valuation; R10's ledger line is unchanged.
   */
  #open(price: MicroUsd): boolean {
    const funded = this.#fundedLamports();
    if (funded !== null && funded <= 0n) return false;
    const B = this.#s.openingEquity as bigint;
    const opening = (funded === null ? price : (B * LAMPORTS_PER_SOL + funded - 1n) / funded) as MicroUsd;
    if (opening <= 0n) return false;
    this.#s.openingSolPrice = opening;
    if (this.#s.books !== 'sol') {
      const up = (v: bigint): Lamports => (v <= 0n ? (v as Lamports) : microUsdToLamports(v as MicroUsd, opening, 'ceil'));
      if (this.#s.dayMark !== undefined) this.#s.dayMark = { ...this.#s.dayMark, equity: up(this.#s.dayMark.equity) };
      if (this.#s.weekMark !== undefined) this.#s.weekMark = { ...this.#s.weekMark, equity: up(this.#s.weekMark.equity) };
      delete this.#s.navPeak;
      for (const t of this.#s.trades) t.notional = (t.notional <= 0n ? t.notional : microUsdToLamports(t.notional as unknown as MicroUsd, opening, 'floor'));
      this.#s.books = 'sol';
    }
    return true;
  }

  /** The SOL the wallet was funded with, when it is already in lamports: the wallet less what the account has booked. */
  #fundedLamports(): bigint | null {
    const w = this.#s.walletLamports;
    if (w === null) return null;
    const strays = Object.values(this.#s.strayFees ?? {}).reduce((t, r) => t + r.lamports, this.#s.strayFolded?.lamports ?? 0n);
    return w + (this.#s.setup?.lamports ?? 0n) + strays - this.#s.trades.reduce((t, x) => t + x.booked, 0n);
  }

  /**
   * The wallet's setup: its one-time accounts (the venue's volume accumulator) are made once, before the first trade,
   * and their rent leaves the wallet for good. Paid at setup rather than by the first buy, so no trade's cost carries
   * it: at the trial size the first trade would fail R14's cost gate for good and the accounts would never be made.
   */
  #setUp(solPrice: MicroUsd, nowMs: number): void {
    if (this.#s.walletLamports === null || this.#s.oneTimePaid === true) return;
    this.#s.walletLamports -= this.#oneTimeRent;
    this.#s.oneTimePaid = true;
    // A realised cost, so equity, the high-water mark and the day and week losses all include it (risk review of #48).
    this.#s.setup = { atMs: nowMs, lamports: this.#oneTimeRent, cost: lamportsToMicroUsd(this.#oneTimeRent as Lamports, solPrice, 'ceil') };
  }

  /**
   * Records the boundary marks and the NAV peak from the figures risk would use now, on the marked account (WORKER-1c,
   * RISK-MARK). A day or week mark is taken once, at the first look at or after its boundary when every open position
   * has a fresh mark (`marked`; none open counts): an unmarked position is a total loss to equity, and recording that
   * would show a phantom gain once it is marked again. The NAV peak only rises, and restarts after a re-arm (R10
   * restarts its high-water mark there); risk gives a NAV only when every mark is fresh. With no deposits or
   * withdrawals in paper, keeping the peak alone gives R10 the same high-water mark as keeping every observation. True
   * when anything changed (the account fact must be put again).
   */
  mark(s: Pick<RiskSnapshot, 'dayStartMs' | 'weekStartMs' | 'equity' | 'nav'>, marked: boolean, rearmAtMs: number | null, nowMs: number): boolean {
    // SOL-BOOKS: nothing is marked before the opening SOL price. Risk's equity is zero then (no bankroll in lamports
    // yet), so a day or week mark would hold 0 and drop the marked loss measure for that day and week; and a file from
    // before keeps its marks in micro-dollars until the opening converts them, so a NAV peak written in lamports now
    // would be converted again (about 6.7x at $150) and trip R10 at once.
    if (this.#s.openingSolPrice === undefined) return false;
    let changed = false;
    if (marked && this.#s.dayMark?.startMs !== s.dayStartMs) {
      this.#s.dayMark = { startMs: s.dayStartMs, atMs: nowMs, equity: s.equity };
      changed = true;
    }
    if (marked && this.#s.weekMark?.startMs !== s.weekStartMs) {
      this.#s.weekMark = { startMs: s.weekStartMs, atMs: nowMs, equity: s.equity };
      changed = true;
    }
    const peak = this.#s.navPeak;
    const stale = peak !== undefined && rearmAtMs !== null && peak.atMs < rearmAtMs;
    if (s.nav !== null && s.nav > 0n && (peak === undefined || stale || s.nav > peak.nav)) {
      this.#s.navPeak = { atMs: nowMs, nav: s.nav };
      changed = true;
    }
    if (changed) this.#file.write(this.#s);
    return changed;
  }

  reserved(mint: string, atMs: number): void {
    this.#s.entries.push({ mint, atMs });
    this.#file.write(this.#s);
  }

  /** A fill was booked: move the paper wallet, open or close the trade record. */
  filled(r: FilledRecord, solPrice: MicroUsd | null, legs: PaperLegs): void {
    const p = r.book.positions[r.positionId];
    if (r.purpose === 'entry') {
      const notionalReason = r.reasons.find((x) => /^notional \d+$/.test(x));
      // SOL-BOOKS: the decision's notional is q in lamports.
      const notional = (notionalReason === undefined ? 0n : BigInt(notionalReason.slice('notional '.length))) as Lamports;
      if (!this.#s.trades.some((t) => t.positionId === r.positionId)) {
        this.#s.trades.push({ positionId: r.positionId, mint: r.mint, openedAtMs: r.atMs, notional, closedAtMs: null, netLamports: null, netPnl: null, stoppedOut: false, booked: 0n, openSolPrice: solPrice });
      }
    }
    const t = this.#s.trades.find((x) => x.positionId === r.positionId);
    const l = this.#book(t, r.book, legs);
    // RISK-PARTIAL: a sale that leaves tokens held realizes its share now; the close books the whole trade below. Its SOL
    // and fees are the trade's paper legs so far (PAPER-1: every attempt's fee), so the parts and the close agree.
    if (r.purpose === 'exit' && t !== undefined && l !== null && p !== undefined && p.status !== 'closed' && t.closedAtMs === null) {
      const exitNet = l.exitSol - l.legs.exit.networkBase - l.legs.exit.priority - l.legs.exit.tip;
      const basis = l.entrySol + l.legs.entry.networkBase + l.legs.entry.priority + l.legs.entry.tip;
      const before = t.partialSold ?? 0n;
      const lamports = (exitNet - (t.partialNet ?? 0n)) - (soldBasis(basis, p.bought, p.sold) - soldBasis(basis, p.bought, before));
      if (p.sold !== before || exitNet !== (t.partialNet ?? 0n)) {
        // SOL-BOOKS: the part is its lamports (proceeds after fees less its share of the basis, entry fees included);
        // no SOL/USD price is needed, so there is no no-price path.
        (t.partials ??= []).push({ atMs: r.atMs, lamports });
        t.partialSold = p.sold;
        t.partialNet = exitNet;
        // Every failed sell known now is in that net (the paper legs count each attempt's fee), so realized with the part.
        t.partialFailedExits = Object.values(r.book.intents).filter((i) => i.intent.positionId === p.id && i.intent.purpose === 'exit')
          .flatMap((i) => i.attempts.map((a) => a.signature as string)).filter((sig) => legs.attempts.get(sig)?.outcome === 'failed');
      }
    }
    if (t !== undefined && l !== null && p !== undefined && (p.status === 'closed' || r.closes === true) && t.closedAtMs === null) {
      t.closedAtMs = r.atMs;
      t.netLamports = tradeNet(l);
      t.stoppedOut = r.reasons.some((x) => STOPS.has(x));
      t.exitReasons = r.reasons.filter((x) => EXIT_REASONS.has(x));
      // Each cash flow at its own SOL price, as the backtest report values a trade (core's `tradeUsd`): the entry leg at
      // the entry's price, the exit leg at the close's. A close booked with no price known stays unvalued (netPnl null)
      // until `priceLate` values it at the first price after it (ACCOUNT-RATE): never a made-up loss or gain.
      t.closeSolPrice = solPrice;
      if (solPrice !== null) this.#value(t, l, solPrice);
    }
    // A sale booked late can change trades already closed: its own (a late sell) and its entry's others (a sell that
    // closed the shared account returns the rent to the entry's first trade).
    if (p !== undefined) this.#resettleClosed(r.book, p.entryIntentId, legs, r.atMs);
    this.#file.write(this.#s);
  }

  /** A closed trade's dollar P&L from its legs, at its open price (set at the close's when the open had none). */
  #value(t: PaperTrade, l: TradeLamports, closePrice: MicroUsd): void {
    if (t.openSolPrice === null || t.openSolPrice === undefined) {
      t.openSolPrice = closePrice;
      t.pricedLate = [...(t.pricedLate ?? []), 'open'];
    }
    t.netPnl = tradeUsd(l, t.openSolPrice, closePrice).net as MicroUsd;
  }

  /**
   * ACCOUNT-RATE: legs booked while no SOL price was known (a fill reconciled at start, or caught up from a line with
   * `sol_usd` null) are valued at the first price at or after their fill, flagged in `pricedLate`. Risk refuses every
   * entry while it has no SOL price, so no entry is judged on an unvalued trade. True when anything changed.
   */
  priceLate(book: Book, legs: PaperLegs, solPrice: MicroUsd | null, nowMs: number): boolean {
    if (solPrice === null || solPrice <= 0n) return false;
    let changed = false;
    // Stray fees booked by their lamports with no price (risk review F2): their dollar figure at this price, rounded up.
    const priced = (r: StrayFee): StrayFee => ({ ...r, cost: lamportsToMicroUsd(r.lamports as Lamports, solPrice, 'ceil') });
    for (const [sig, r] of Object.entries(this.#s.strayFees ?? {})) {
      if (r.cost === null && nowMs >= r.atMs) {
        this.#s.strayFees![sig] = priced(r);
        changed = true;
      }
    }
    if (this.#s.strayFolded !== undefined && this.#s.strayFolded.cost === null) {
      this.#s.strayFolded = priced(this.#s.strayFolded);
      changed = true;
    }
    for (const t of this.#s.trades) {
      if ((t.openSolPrice === null || t.openSolPrice === undefined) && nowMs >= t.openedAtMs && t.closedAtMs === null) {
        t.openSolPrice = solPrice;
        t.pricedLate = [...(t.pricedLate ?? []), 'open'];
        changed = true;
      }
      if (t.closedAtMs !== null && t.netPnl === null && nowMs >= t.closedAtMs) {
        const l = paperTradeLamports(book, t.positionId, legs);
        if (l === null) continue;
        t.closeSolPrice = solPrice;
        this.#value(t, l, solPrice);
        // The legs now hold what landed after the close too (PAPER-2): each such change, unvalued until now, is valued
        // at this price (a loss rounded up) and keeps the day it was booked; the close's own result leaves it out.
        if (t.late?.some((x) => x.usd === null) === true) {
          t.late = t.late.map((x) => {
            if (x.usd !== null) return x;
            const usd = (x.lamports < 0n ? -lamportsToMicroUsd(-x.lamports as Lamports, solPrice, 'ceil') : lamportsToMicroUsd(x.lamports as Lamports, solPrice, 'floor')) as MicroUsd;
            t.netPnl = (t.netPnl! - usd) as MicroUsd;
            return { ...x, usd };
          });
        }
        t.pricedLate = [...(t.pricedLate ?? []), 'close'];
        changed = true;
      }
    }
    if (changed) this.#file.write(this.#s);
    return changed;
  }

  /**
   * Re-settles the closed trades of the entry `positionId` belongs to, after something landed late (PAPER-2): a fee of
   * an attempt that landed after its trade closed, or a sale or account close booked after it. The wallet moves by the
   * change, and the trade's net is valued again at its own open and close prices. True when anything moved.
   */
  resettle(book: Book, positionId: string, legs: PaperLegs, nowMs: number): boolean {
    const p = book.positions[positionId];
    if (p === undefined) return false;
    const moved = this.#resettleClosed(book, p.entryIntentId, legs, nowMs);
    if (moved) this.#file.write(this.#s);
    return moved;
  }

  #resettleClosed(book: Book, entryIntentId: string, legs: PaperLegs, nowMs: number): boolean {
    let moved = false;
    for (const t of this.#s.trades) {
      if (t.closedAtMs === null || book.positions[t.positionId]?.entryIntentId !== entryIntentId) continue;
      const before = t.booked;
      const l = this.#book(t, book, legs);
      if (l === null) continue;
      // The wallet may have moved already (`filled` books its own position first); the trade's results follow it here.
      if (t.booked !== before) moved = true;
      const sol = tradeSol(t)!;
      const now = tradeNet(l);
      if (now === sol) continue;
      // The change is dated now, as a late entry: the close's results, and the day they counted toward, stay as they were.
      const pxIn = t.openSolPrice ?? null;
      const pxOut = t.closeSolPrice ?? null;
      const was = tradePnl(t);
      const usd = was === null || pxIn === null || pxOut === null ? null : ((tradeUsd(l, pxIn, pxOut).net - was) as MicroUsd);
      (t.late ??= []).push({ atMs: nowMs, lamports: now - sol, usd });
      moved = true;
    }
    return moved;
  }

  /**
   * Settles fees paid outside fills (PAPER-1, M4), each signature once: a trade's failed attempts are in its net (the
   * wallet moves by the change), and an entry that ended with no fill books its fees as a stray cost (the backtest's
   * `StrayCost`; risk's `failed_entry`). True when the wallet moved.
   */
  settle(book: Book, legs: PaperLegs, solPrice: MicroUsd | null, nowMs: number): boolean {
    let moved = false;
    const seen = this.#noteOpenFees(book, legs, nowMs);
    for (const t of this.#s.trades) {
      if (t.closedAtMs !== null) continue;
      const before = t.booked;
      this.#book(t, book, legs);
      moved ||= t.booked !== before;
    }
    // SOL-BOOKS (risk review F2): booked by its lamports at once, priced or not, as risk counts it; its dollar figure is
    // display only and waits for a SOL price when none is known (`priceLate`).
    if (this.#s.walletLamports !== null) {
      for (const { signature, atMs, lamports } of this.#unbookedStrays(book, legs)) {
        // Dated when booked if that is later than its send (ACCOUNT-RATE F3): a fee found after midnight counts in the day it
        // is booked, never only in a day already past. Booking is never before the send, so the fold's rule still holds.
        (this.#s.strayFees ??= {})[signature] = { atMs: Math.max(atMs, nowMs), lamports, cost: solPrice === null ? null : lamportsToMicroUsd(lamports as Lamports, solPrice, 'ceil') };
        this.#s.walletLamports -= lamports;
        moved = true;
      }
    }
    const folded = this.#fold(book, legs, nowMs);
    if (moved || folded || seen) this.#file.write(this.#s);
    return moved;
  }

  /**
   * Fees of entries that ended with no fill and are not booked yet (nor folded): what `settle` books as stray costs once
   * a fresh SOL price is known. Each with its send time (an older file's attempt without one: when the account opened).
   */
  #unbookedStrays(book: Book, legs: PaperLegs): { readonly signature: string; readonly atMs: number; readonly lamports: bigint }[] {
    const out: { signature: string; atMs: number; lamports: bigint }[] = [];
    const folded = this.#s.strayFolded;
    for (const i of Object.values(book.intents)) {
      if (i.intent.purpose !== 'entry' || !isTerminal(i) || i.fills.length > 0) continue;
      for (const att of i.attempts) {
        const a = legs.attempts.get(att.signature);
        if (a === undefined) continue;
        const f = feeParts(legs.network, a.priorityFee, a.outcome);
        const lamports = f.base + f.priority + f.tip;
        const atMs = a.sentAtMs ?? this.#s.openedAtMs;
        if (lamports === 0n || this.#s.strayFees?.[a.signature] !== undefined || (folded !== undefined && atMs <= folded.atMs)) continue;
        out.push({ signature: a.signature, atMs, lamports });
      }
    }
    return out;
  }

  /**
   * ACCOUNT-RATE F1: notes when each failed attempt of an open trade was first seen (max of its send and now), and drops
   * the notes of trades no longer open. True when the notes changed.
   */
  #noteOpenFees(book: Book, legs: PaperLegs, nowMs: number): boolean {
    const now = new Set<string>();
    let changed = false;
    const notes = this.#s.openFeesSeen ?? {};
    for (const p of Object.values(book.positions)) {
      if (p.status === 'closed' || lateFillOf(p.id) !== null) continue;
      const t = this.#s.trades.find((x) => x.positionId === p.id);
      for (const i of Object.values(book.intents)) {
        if (i.intent.positionId !== p.id || (i.intent.purpose === 'entry' && isTerminal(i) && i.fills.length === 0)) continue;
        for (const att of i.attempts) {
          const a = legs.attempts.get(att.signature);
          if (a === undefined || a.outcome !== 'failed') continue;
          now.add(att.signature);
          if (notes[att.signature] === undefined) {
            notes[att.signature] = Math.max(a.sentAtMs ?? t?.openedAtMs ?? nowMs, nowMs);
            changed = true;
          }
        }
      }
    }
    for (const sig of Object.keys(notes)) {
      if (!now.has(sig)) {
        delete notes[sig];
        changed = true;
      }
    }
    if (changed) this.#s.openFeesSeen = notes;
    return changed;
  }

  /**
   * Folds stray fees from before the current Melbourne week into one total (supervisor ruling: account.json stays
   * bounded). Risk's day and week windows never reach them; the total keeps their effect on equity, dated at the latest
   * folded record, which only moves those costs later and so can only lower equity in between (the safe side). Every
   * attempt sent at or before that moment is in the total, so a signature seen again is never charged twice; an entry
   * still unresolved, or an ended one with a fee not yet booked (no SOL price), holds the fold back to before it.
   */
  #fold(book: Book, legs: PaperLegs, nowMs: number): boolean {
    const records = this.#s.strayFees;
    if (records === undefined) return false;
    let before = melbourneWeek(nowMs).start;
    const folded = this.#s.strayFolded;
    for (const i of Object.values(book.intents)) {
      if (i.intent.purpose !== 'entry' || i.fills.length > 0) continue;
      const ended = isTerminal(i);
      for (const att of i.attempts) {
        const a = legs.attempts.get(att.signature);
        const sent = a?.sentAtMs;
        if (a === undefined || sent === undefined || sent > before) continue;
        // An entry still running, or an ended one whose fee is not booked yet (no SOL price then; risk review of #133):
        // the fold stays before it, so the booking that comes later is never taken for one already folded.
        const f = feeParts(legs.network, a.priorityFee, a.outcome);
        const unbooked = ended && records[att.signature] === undefined && (folded === undefined || sent > folded.atMs) && f.base + f.priority + f.tip > 0n;
        if (!ended || unbooked) before = sent - 1;
      }
    }
    const old = Object.entries(records).filter(([, r]) => r.atMs < before);
    if (old.length === 0) return false;
    let total: StrayFee = this.#s.strayFolded ?? { atMs: this.#s.openedAtMs, lamports: 0n, cost: 0n as MicroUsd };
    for (const [sig, r] of old) {
      // A dollar figure not known yet leaves the total's unknown too (display only; the lamports are exact).
      total = { atMs: Math.max(total.atMs, r.atMs), lamports: total.lamports + r.lamports, cost: total.cost === null || r.cost === null ? null : ((total.cost + r.cost) as MicroUsd) };
      delete records[sig];
    }
    this.#s.strayFolded = total;
    return true;
  }

  /** The wallet follows the trade's settled net (fills, every attempt's fee, rent): applied by its change, so once. */
  #book(t: PaperTrade | undefined, book: Book, legs: PaperLegs): TradeLamports | null {
    if (t === undefined) return null;
    const l = paperTradeLamports(book, t.positionId, legs);
    if (l === null) return null;
    const net = tradeNet(l);
    if (this.#s.walletLamports !== null) {
      this.#s.walletLamports += net - t.booked;
      t.booked = net;
    }
    return l;
  }

  /**
   * Positions whose fills the ledger holds but this record does not (WORKER-ORDER): a kill after the ledger commit and
   * before this file was written. An entry with no trade record, or a closed position whose trade is still open.
   */
  behind(book: Book): { readonly positionId: string; readonly purpose: 'entry' | 'exit' }[] {
    const out: { positionId: string; purpose: 'entry' | 'exit' }[] = [];
    const claims = lateFillClaims(book);
    for (const p of Object.values(book.positions)) {
      // A late buy's position is no paper trade (it halts entries instead), and its fill is not its parent's (PAPER-1).
      if (lateFillOf(p.id) !== null || entryShare(book, p, claims).fills.length === 0) continue;
      const t = this.#s.trades.find((x) => x.positionId === p.id);
      if (t === undefined) out.push({ positionId: p.id, purpose: 'entry' });
      if (p.status === 'closed' && (t === undefined || t.closedAtMs === null)) out.push({ positionId: p.id, purpose: 'exit' });
    }
    return out;
  }

  /**
   * ACCOUNT-RATE F1: what each open trade has already paid outside its basis (risk's open-position notional is the entry
   * SOL and every entry attempt's fees, less the share partial sales realized): every failed exit attempt's fees, an
   * opening entry's failed fees (not an open position yet), each dated when first seen, and the token-account rent not
   * yet returned, dated at the entry. They have left the paper wallet, so risk's equity and the day's and week's loss
   * count them as costs now; when the trade closes they are in its net P&L instead. A late buy's position is no paper
   * trade, and an entry that ended unfilled is a stray cost (`settle`): neither is counted here. Valued at the SOL price
   * now (the trade's open price when none is known), rounded up; with their lamports and which part they are (a fee or
   * rent) for the app's cost kinds.
   */
  #openTradeCosts(book: Book, legs: PaperLegs, solPrice: MicroUsd | null, nowMs: number): CostRecord[] {
    const out: CostRecord[] = [];
    for (const p of Object.values(book.positions)) {
      if (p.status === 'closed' || lateFillOf(p.id) !== null) continue;
      const t = this.#s.trades.find((x) => x.positionId === p.id);
      // SOL-BOOKS: risk counts the lamports, whatever the price; the dollar value is display only (0 with no price at all).
      const px = solPrice ?? t?.openSolPrice ?? null;
      const cost = (lamports: bigint, atMs: number, part: 'fee' | 'rent') => {
        if (lamports > 0n) out.push({ atMs: Math.min(atMs, nowMs), amount: lamports as Lamports, lamports, usd: px === null ? (0n as MicroUsd) : lamportsToMicroUsd(lamports as Lamports, px, 'ceil'), kind: 'open_trade', part });
      };
      for (const i of Object.values(book.intents)) {
        // An entry's failed fees are in the open position's basis once it holds tokens (with RISK-PARTIAL's parts): here
        // only while it is still opening (not yet an open position risk values), so each fee counts once.
        if (i.intent.positionId !== p.id || (i.intent.purpose === 'entry' && ((isTerminal(i) && i.fills.length === 0) || p.status !== 'opening'))) continue;
        for (const att of i.attempts) {
          const a = legs.attempts.get(att.signature);
          if (a === undefined || a.outcome !== 'failed') continue;
          // A failed sell a partial sale has already realized (its fee is in that part): counted once, there.
          if (t?.partialFailedExits?.includes(att.signature) === true) continue;
          const f = feeParts(legs.network, a.priorityFee, a.outcome);
          // Dated when the account first saw it (never before its send), so a fee sent before midnight and found after
          // counts in the day it was found; not yet noted by `settle`: now.
          cost(f.base + f.priority + f.tip, this.#s.openFeesSeen?.[att.signature] ?? Math.max(a.sentAtMs ?? t?.openedAtMs ?? nowMs, nowMs), 'fee');
        }
      }
      if (t === undefined) continue;
      const l = paperTradeLamports(book, p.id, legs);
      if (l !== null) cost(l.rentPaid - l.rentReturned, t.openedAtMs, 'rent');
    }
    return out;
  }

  /**
   * The account's costs that are no trade's (RISK-1b `costs`), dated and in micro-dollars: the one list risk reads (in
   * `fact`) and the app's money totals add to the trades (APP-MONEY). The wallet's setup rent is one: it lowers equity and
   * counts toward the day's and week's loss, and it is never a trade (R8, R11, R15 and trade statistics do not see it).
   * An open trade's costs outside its basis are others (ACCOUNT-RATE), until it closes.
   */
  /** The account costs risk counts, in lamports (SOL-BOOKS). */
  costs(book: Book, legs: PaperLegs, nowMs: number): AccountCost[] {
    return this.costRecords(book, legs, null, nowMs).map(({ atMs, amount, kind }) => ({ atMs, amount, kind }));
  }

  /**
   * The same costs with their dollar value (`usd`, display only: at booking for the setup and stray fees, at `solPrice`
   * or the trade's open price for an open trade's) and an open trade's part (a fee or rent), for the app (APP-MONEY).
   */
  costRecords(book: Book, legs: PaperLegs, solPrice: MicroUsd | null, nowMs: number): CostRecord[] {
    const su = this.#s.setup;
    const lam = (v: bigint): Lamports => v as Lamports;
    const costs: CostRecord[] = su === undefined ? [] : [{ atMs: su.atMs, amount: lam(su.lamports), lamports: su.lamports, usd: su.cost, kind: 'wallet_setup' }];
    // Fees of entries that never filled (PAPER-1): account costs too, never trades.
    const sf = this.#s.strayFolded;
    // A stray's dollars not known yet (no price at its booking): at `solPrice` for display, rounded up; 0 with none.
    const usdOf = (r: StrayFee): MicroUsd => (r.cost ?? (solPrice === null ? 0n : lamportsToMicroUsd(r.lamports as Lamports, solPrice, 'ceil'))) as MicroUsd;
    if (sf !== undefined) costs.push({ atMs: sf.atMs, amount: lam(sf.lamports), lamports: sf.lamports, usd: usdOf(sf), kind: 'failed_entry' });
    for (const r of Object.values(this.#s.strayFees ?? {})) costs.push({ atMs: r.atMs, amount: lam(r.lamports), lamports: r.lamports, usd: usdOf(r), kind: 'failed_entry' });
    costs.push(...this.#openTradeCosts(book, legs, solPrice, nowMs));
    // A loss that landed after its trade closed counts on the day it was booked (PAPER-2); a late gain is not counted
    // (the safe side: a day's loss is never lowered after the fact).
    // SOL-BOOKS: counted by its lamports, priced or not; its dollar figure is display only.
    for (const t of this.#s.trades) {
      const px = t.closeSolPrice ?? t.openSolPrice ?? solPrice;
      for (const x of t.late ?? []) {
        if (x.lamports >= 0n) continue;
        const usd = x.usd !== null ? -x.usd : px === null ? 0n : lamportsToMicroUsd(-x.lamports as Lamports, px, 'ceil');
        costs.push({ atMs: x.atMs, amount: -x.lamports as Lamports, lamports: -x.lamports, usd: usd as MicroUsd, kind: 'late_settlement' });
      }
    }
    return costs;
  }

  /** The account snapshot risk reads, with the ledger's held reservations and version read in one transaction. */
  fact(ledger: Ledger, book: Book, latches: Latches, nowMs: number, legs: PaperLegs): AccountFact {
    const { version, value: held } = ledger.withSnapshot(() => ledger.heldExposure());
    // SOL-BOOKS: every amount in lamports. Before the opening SOL price the history has none (0), which risk refuses (R1).
    const openingSolPrice = this.#s.openingSolPrice ?? (0n as MicroUsd);
    const closedTrades: ClosedTrade[] = this.#s.trades.filter((t) => t.closedAtMs !== null && t.netLamports !== null).map((t) => ({
      mint: t.mint as Mint, openedAtMs: t.openedAtMs, closedAtMs: t.closedAtMs!, notional: t.notional, netPnl: t.netLamports! as Lamports, stoppedOut: t.stoppedOut,
      partials: (t.partials ?? []).map((x) => ({ atMs: x.atMs, pnl: x.lamports as Lamports })),
    }));
    const costs = this.costs(book, legs, nowMs);
    const openPositions = Object.values(book.positions).filter((p) => p.status !== 'closed' && p.status !== 'opening').map((p) => {
      const t = this.#s.trades.find((x) => x.positionId === p.id);
      // The basis (entry SOL and every entry attempt's fees, failed ones included: the same basis RISK-PARTIAL's parts
      // take, from the paper legs), less the share its partial sales realized, so each fee counts once across the parts
      // and what is still held (ACCOUNT-RATE). Tokens gone without a booked sale keep their basis here, so their loss shows
      // in the mark. Without the legs (no trade record): the tokens' cost and the entry fills' fees.
      const l = paperTradeLamports(book, p.id, legs);
      const fillFees = Object.values(book.intents).filter((i) => i.intent.positionId === p.id && i.intent.purpose === 'entry').reduce((s, i) => s + i.fills.reduce((a, f) => a + f.fees, 0n), 0n);
      const full = l === null ? p.cost + fillFees : l.entrySol + l.legs.entry.networkBase + l.legs.entry.priority + l.legs.entry.tip;
      const sold = t?.partialSold ?? 0n;
      const basis = (full - soldBasis(full, p.bought, sold)) as Lamports;
      return {
        mint: p.mint, openedAtMs: t?.openedAtMs ?? nowMs, notional: basis, mark: null, markAtMs: null,
        partials: (t?.partials ?? []).map((x) => ({ atMs: x.atMs, pnl: x.lamports as Lamports })),
      };
    });
    const history: AccountHistory = {
      openingEquity: (openingSolPrice > 0n ? microUsdToLamports(this.#s.openingEquity, openingSolPrice, 'floor') : 0n) as Lamports,
      openingSolPrice, openedAtMs: this.#s.openedAtMs, flows: [], closedTrades, costs, openPositions,
      // WORKER-1c: the boundary marks of this day and week (none recorded for them: null, and risk uses the realized
      // loss only), and the NAV peak since the last re-arm.
      markedAtDayStart: this.#s.dayMark !== undefined && this.#s.dayMark.startMs === melbourneDay(nowMs).start ? this.#s.dayMark.equity : null,
      markedAtWeekStart: this.#s.weekMark !== undefined && this.#s.weekMark.startMs === melbourneWeek(nowMs).start ? this.#s.weekMark.equity : null,
      // A peak dated after now (the clock stepped back) is still the peak: dated now, never dropped (red team C M2,
      // supervisor ruling: a clock step back never lowers a risk mark or peak; it fails closed).
      navMarks: this.#s.navPeak === undefined ? [] : [{ atMs: Math.min(this.#s.navPeak.atMs, nowMs), nav: this.#s.navPeak.nav }],
      entries: this.#s.entries.map((e) => ({ mint: e.mint as Mint, atMs: e.atMs })),
      unresolvedEntries: Object.values(book.intents).filter((i) => i.intent.purpose === 'entry' && !isTerminal(i) && i.reservation?.status === 'held').map((i) => ({ mint: i.intent.mint })),
      heldReservations: held, version,
    };
    return {
      history, latches, solBalance: this.#s.walletLamports === null ? null : { value: this.#s.walletLamports as Lamports, atMs: nowMs }, paper: true,
      oneTimeRent: this.#s.oneTimePaid === true ? 0n : this.#oneTimeRent,
      // A stray fee is out of `costs` until `settle` books it (by its lamports, priced or not): risk is told, and refuses
      // entries until it is in.
      // SOL-BOOKS: a close is in `closedTrades` by its lamports at once; only its dollar figure (display) waits for a price.
      unvalued: this.#unbookedStrays(book, legs).length,
    };
  }
}
