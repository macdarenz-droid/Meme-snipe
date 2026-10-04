// The paper account (risk's AccountHistory, RISK-1): built from the ledger (reservations held, account version, read in
// one transaction) and the worker's record of its own paper trades (account.json: the paper wallet, each trade's
// notional, open and close times and net result). Only the bot's own paper trades: no personal data (CLAUDE.md ruling).
import type { Mint } from '../../../core/src/domain/index.ts';
import { type FillNetwork, type LegCosts, type TradeLamports, entryShare, feeParts, lateFillClaims, lateFillOf, tradeNet, tradeRent, tradeUsd } from '../../../core/src/fills/index.ts';
import type { Ledger } from '../../../core/src/ledger/index.ts';
import { type Book, isTerminal } from '../../../core/src/lifecycle/index.ts';
import { type AccountCost, type AccountHistory, type ClosedTrade, type Latches, type RiskSnapshot, melbourneDay, melbourneWeek } from '../../../core/src/risk/index.ts';
import { type Lamports, type MicroUsd, lamportsToMicroUsd, microUsdToLamports } from '../../../core/src/units/index.ts';
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
   * RISK-PARTIAL: each partial sale's realized result (proceeds after its fees less its share of the basis), and the
   * tokens and net exit lamports those parts cover. Absent in files from before (no partial booked).
   */
  partials?: { readonly atMs: number; readonly lamports: bigint }[];
  partialSold?: bigint;
  partialNet?: bigint;
}

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
   * Fees of entries that never filled (the backtest's stray costs, PAPER-1), by signature: when the attempt was sent,
   * lamports (what risk counts, SOL-BOOKS), and micro-dollars at the SOL price when it was booked (rounded up, for
   * display). Supervisor-approved stored data.
   */
  strayFees?: Record<string, StrayFee>;
  /** Stray fees from before the current Melbourne week, folded into one total: every attempt sent at or before `atMs`. */
  strayFolded?: StrayFee;
}

export interface StrayFee {
  readonly atMs: number;
  readonly lamports: bigint;
  readonly cost: MicroUsd;
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
    if (opening) this.#open(solPrice);
    if (this.#s.walletLamports === null) this.#s.walletLamports = microUsdToLamports(this.#s.openingEquity, this.#s.openingSolPrice!, 'floor');
    this.#setUp(solPrice, nowMs);
    this.#file.write(this.#s);
  }

  /**
   * SOL-BOOKS: fixes the opening SOL price. A file from before kept its marks, NAV peak and trade sizes in micro-dollars;
   * they are converted once at this price, each rounded the tighter way (marks and the peak up, sizes down), so no
   * line or cap loosens. Trade results are already in lamports (`netLamports`, each part's `lamports`).
   */
  #open(price: MicroUsd): void {
    this.#s.openingSolPrice = price;
    if (this.#s.books !== 'sol') {
      const up = (v: bigint): Lamports => (v <= 0n ? (v as Lamports) : microUsdToLamports(v as MicroUsd, price, 'ceil'));
      if (this.#s.dayMark !== undefined) this.#s.dayMark = { ...this.#s.dayMark, equity: up(this.#s.dayMark.equity) };
      if (this.#s.weekMark !== undefined) this.#s.weekMark = { ...this.#s.weekMark, equity: up(this.#s.weekMark.equity) };
      if (this.#s.navPeak !== undefined) this.#s.navPeak = { ...this.#s.navPeak, nav: up(this.#s.navPeak.nav) };
      for (const t of this.#s.trades) t.notional = (t.notional <= 0n ? t.notional : microUsdToLamports(t.notional as unknown as MicroUsd, price, 'floor'));
      this.#s.books = 'sol';
    }
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
      }
    }
    if (t !== undefined && l !== null && p !== undefined && (p.status === 'closed' || r.closes === true) && t.closedAtMs === null) {
      t.closedAtMs = r.atMs;
      t.netLamports = tradeNet(l);
      // Risk counts `netLamports` (SOL-BOOKS). The dollar figure is for display only: each cash flow at its own SOL price,
      // as the backtest report values a trade (core's `tradeUsd`); null without both prices.
      const pxIn = t.openSolPrice ?? null;
      t.netPnl = solPrice === null || pxIn === null ? null : (tradeUsd(l, pxIn, solPrice).net as MicroUsd);
      t.stoppedOut = r.reasons.some((x) => STOPS.has(x));
      t.closeSolPrice = solPrice;
      t.exitReasons = r.reasons.filter((x) => EXIT_REASONS.has(x));
    }
    this.#file.write(this.#s);
  }

  /**
   * Settles fees paid outside fills (PAPER-1, M4), each signature once: a trade's failed attempts are in its net (the
   * wallet moves by the change), and an entry that ended with no fill books its fees as a stray cost (the backtest's
   * `StrayCost`; risk's `failed_entry`). True when the wallet moved.
   */
  settle(book: Book, legs: PaperLegs, solPrice: MicroUsd | null, nowMs: number): boolean {
    let moved = false;
    for (const t of this.#s.trades) {
      if (t.closedAtMs !== null) continue;
      const before = t.booked;
      this.#book(t, book, legs);
      moved ||= t.booked !== before;
    }
    if (solPrice !== null && this.#s.walletLamports !== null) {
      const folded = this.#s.strayFolded;
      for (const i of Object.values(book.intents)) {
        if (i.intent.purpose !== 'entry' || !isTerminal(i) || i.fills.length > 0) continue;
        for (const att of i.attempts) {
          const a = legs.attempts.get(att.signature);
          if (a === undefined) continue;
          const f = feeParts(legs.network, a.priorityFee, a.outcome);
          const lamports = f.base + f.priority + f.tip;
          // Paper attempts carry their send time; one from an older file without it counts as sent when the account opened.
          const atMs = a.sentAtMs ?? this.#s.openedAtMs;
          if (lamports === 0n || this.#s.strayFees?.[a.signature] !== undefined || (folded !== undefined && atMs <= folded.atMs)) continue;
          (this.#s.strayFees ??= {})[a.signature] = { atMs, lamports, cost: lamportsToMicroUsd(lamports as Lamports, solPrice, 'ceil') };
          this.#s.walletLamports -= lamports;
          moved = true;
        }
      }
    }
    const folded = this.#fold(book, legs, nowMs);
    if (moved || folded) this.#file.write(this.#s);
    return moved;
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
    let total = this.#s.strayFolded ?? { atMs: this.#s.openedAtMs, lamports: 0n, cost: 0n as MicroUsd };
    for (const [sig, r] of old) {
      total = { atMs: Math.max(total.atMs, r.atMs), lamports: total.lamports + r.lamports, cost: (total.cost + r.cost) as MicroUsd };
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
   * The account's costs that are no trade's (RISK-1b `costs`), dated and in micro-dollars: the one list risk reads (in
   * `fact`) and the app's money totals add to the trades (APP-MONEY). The wallet's setup rent is one: it lowers equity and
   * counts toward the day's and week's loss, and it is never a trade (R8, R11, R15 and trade statistics do not see it).
   */
  /** The account costs risk counts, in lamports (SOL-BOOKS). */
  costs(): AccountCost[] {
    return this.costRecords().map(({ atMs, amount, kind }) => ({ atMs, amount, kind }));
  }

  /** The same costs with their dollar value at booking (`usd`, display only), for the app's totals (APP-MONEY). */
  costRecords(): (AccountCost & { readonly lamports: bigint; readonly usd: MicroUsd })[] {
    const su = this.#s.setup;
    const lam = (v: bigint): Lamports => v as Lamports;
    const costs: (AccountCost & { readonly lamports: bigint; readonly usd: MicroUsd })[] = su === undefined ? [] : [{ atMs: su.atMs, amount: lam(su.lamports), lamports: su.lamports, usd: su.cost, kind: 'wallet_setup' }];
    // Fees of entries that never filled (PAPER-1): account costs too, never trades.
    const sf = this.#s.strayFolded;
    if (sf !== undefined) costs.push({ atMs: sf.atMs, amount: lam(sf.lamports), lamports: sf.lamports, usd: sf.cost, kind: 'failed_entry' });
    for (const r of Object.values(this.#s.strayFees ?? {})) costs.push({ atMs: r.atMs, amount: lam(r.lamports), lamports: r.lamports, usd: r.cost, kind: 'failed_entry' });
    return costs;
  }

  /** The account snapshot risk reads, with the ledger's held reservations and version read in one transaction. */
  fact(ledger: Ledger, book: Book, latches: Latches, nowMs: number): AccountFact {
    const { version, value: held } = ledger.withSnapshot(() => ledger.heldExposure());
    // SOL-BOOKS: every amount in lamports. Before the opening SOL price the history has none (0), which risk refuses (R1).
    const openingSolPrice = this.#s.openingSolPrice ?? (0n as MicroUsd);
    const closedTrades: ClosedTrade[] = this.#s.trades.filter((t) => t.closedAtMs !== null && t.netLamports !== null).map((t) => ({
      mint: t.mint as Mint, openedAtMs: t.openedAtMs, closedAtMs: t.closedAtMs!, notional: t.notional, netPnl: t.netLamports! as Lamports, stoppedOut: t.stoppedOut,
      partials: (t.partials ?? []).map((x) => ({ atMs: x.atMs, pnl: x.lamports as Lamports })),
    }));
    const costs = this.costs();
    const openPositions = Object.values(book.positions).filter((p) => p.status !== 'closed' && p.status !== 'opening').map((p) => {
      const t = this.#s.trades.find((x) => x.positionId === p.id);
      const fees = Object.values(book.intents).filter((i) => i.intent.positionId === p.id && i.intent.purpose === 'entry').reduce((s, i) => s + i.fills.reduce((a, f) => a + f.fees, 0n), 0n);
      // What is still held carries the basis less the share its partial sales realized (RISK-PARTIAL). Tokens gone
      // without a booked sale keep their basis here, so their loss shows in the mark.
      const sold = t?.partialSold ?? 0n;
      const full = p.cost + fees;
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
      navMarks: this.#s.navPeak === undefined || this.#s.navPeak.atMs > nowMs ? [] : [{ atMs: this.#s.navPeak.atMs, nav: this.#s.navPeak.nav }],
      entries: this.#s.entries.map((e) => ({ mint: e.mint as Mint, atMs: e.atMs })),
      unresolvedEntries: Object.values(book.intents).filter((i) => i.intent.purpose === 'entry' && !isTerminal(i) && i.reservation?.status === 'held').map((i) => ({ mint: i.intent.mint })),
      heldReservations: held, version,
    };
    return {
      history, latches, solBalance: this.#s.walletLamports === null ? null : { value: this.#s.walletLamports as Lamports, atMs: nowMs }, paper: true,
      oneTimeRent: this.#s.oneTimePaid === true ? 0n : this.#oneTimeRent,
    };
  }
}
