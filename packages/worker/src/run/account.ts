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
  readonly notional: MicroUsd;
  closedAtMs: number | null;
  netLamports: bigint | null;
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
}

export interface AccountState {
  readonly openedAtMs: number;
  readonly openingEquity: MicroUsd;
  /** The paper wallet in lamports: null until the first SOL/USD price converts the bankroll. */
  walletLamports: bigint | null;
  readonly trades: PaperTrade[];
  readonly entries: { readonly mint: string; readonly atMs: number }[];
  /** The paper wallet's one-time accounts were paid at its setup; absent in files from before (paid at the next start). */
  oneTimePaid?: boolean;
  /** That setup as a realised cost: when, in lamports, and in micro-dollars at the setup SOL price (rounded up). */
  setup?: { readonly atMs: number; readonly lamports: bigint; readonly cost: MicroUsd };
  /**
   * Marked equity at the start of the Melbourne day and week (WORKER-1c): the first equity the worker saw at or after
   * the boundary `startMs`, taken at `atMs` (later than the boundary when the worker was down then).
   */
  dayMark?: BoundaryMark;
  weekMark?: BoundaryMark;
  /** The highest economic NAV seen since the last kill-switch re-arm (R10's NAV high-water mark reads it). */
  navPeak?: { readonly atMs: number; readonly nav: MicroUsd };
  /**
   * Fees of entries that never filled (the backtest's stray costs, PAPER-1), by signature: when the attempt was sent,
   * lamports, and micro-dollars at the SOL price when it was booked (rounded up). Supervisor-approved stored data.
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
  readonly equity: MicroUsd;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const accountFile = (dir: string) =>
  new StateFile<AccountState>(dir, 'account.json', (v) => (isObj(v) && typeof v['openedAtMs'] === 'number' && typeof v['openingEquity'] === 'bigint' && Array.isArray(v['trades']) && Array.isArray(v['entries']) ? (v as unknown as AccountState) : null));

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
    this.#s = file.read({ openedAtMs: nowMs, openingEquity: bankroll, walletLamports: null, trades: [], entries: [] });
    this.#now = nowMs;
    file.write(this.#s);
  }

  get state(): Readonly<AccountState> {
    return this.#s;
  }

  /** Converts the bankroll into the paper wallet at the first known SOL price. */
  price(solPrice: MicroUsd | null, nowMs: number = this.#now): void {
    if (solPrice === null || solPrice <= 0n) return;
    if (this.#s.walletLamports !== null && this.#s.oneTimePaid === true) return;
    if (this.#s.walletLamports === null) this.#s.walletLamports = microUsdToLamports(this.#s.openingEquity, solPrice, 'floor');
    this.#setUp(solPrice, nowMs);
    this.#file.write(this.#s);
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
      const notional = (notionalReason === undefined ? 0n : BigInt(notionalReason.slice('notional '.length))) as MicroUsd;
      if (!this.#s.trades.some((t) => t.positionId === r.positionId)) {
        this.#s.trades.push({ positionId: r.positionId, mint: r.mint, openedAtMs: r.atMs, notional, closedAtMs: null, netLamports: null, netPnl: null, stoppedOut: false, booked: 0n, openSolPrice: solPrice });
      }
    }
    const t = this.#s.trades.find((x) => x.positionId === r.positionId);
    const l = this.#book(t, r.book, legs);
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
        t.pricedLate = [...(t.pricedLate ?? []), 'close'];
        changed = true;
      }
    }
    if (changed) this.#file.write(this.#s);
    return changed;
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
   * still unresolved holds the fold back to before its first attempt.
   */
  #fold(book: Book, legs: PaperLegs, nowMs: number): boolean {
    const records = this.#s.strayFees;
    if (records === undefined) return false;
    let before = melbourneWeek(nowMs).start;
    for (const i of Object.values(book.intents)) {
      if (i.intent.purpose !== 'entry' || isTerminal(i)) continue;
      for (const att of i.attempts) {
        const sent = legs.attempts.get(att.signature)?.sentAtMs;
        if (sent !== undefined && sent <= before) before = sent - 1;
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

  /** The account snapshot risk reads, with the ledger's held reservations and version read in one transaction. */
  fact(ledger: Ledger, book: Book, latches: Latches, solPrice: MicroUsd | null, nowMs: number): AccountFact {
    const { version, value: held } = ledger.withSnapshot(() => ledger.heldExposure());
    const closedTrades: ClosedTrade[] = this.#s.trades.filter((t) => t.closedAtMs !== null && t.netPnl !== null).map((t) => ({
      mint: t.mint as Mint, openedAtMs: t.openedAtMs, closedAtMs: t.closedAtMs!, notional: t.notional, netPnl: t.netPnl!, stoppedOut: t.stoppedOut,
    }));
    // The wallet's setup rent is an account cost (RISK-1b `costs`): it lowers equity and counts toward the day's and
    // week's loss, and it is never a trade (R8, R11, R15 and statistics do not see it).
    const su = this.#s.setup;
    const costs: AccountCost[] = su === undefined ? [] : [{ atMs: su.atMs, amount: su.cost, kind: 'wallet_setup' }];
    // Fees of entries that never filled (PAPER-1): account costs too, never trades.
    const sf = this.#s.strayFolded;
    if (sf !== undefined) costs.push({ atMs: sf.atMs, amount: sf.cost, kind: 'failed_entry' });
    for (const r of Object.values(this.#s.strayFees ?? {})) costs.push({ atMs: r.atMs, amount: r.cost, kind: 'failed_entry' });
    const openPositions = Object.values(book.positions).filter((p) => p.status !== 'closed' && p.status !== 'opening').map((p) => {
      const t = this.#s.trades.find((x) => x.positionId === p.id);
      const fees = Object.values(book.intents).filter((i) => i.intent.positionId === p.id).reduce((s, i) => s + i.fills.reduce((a, f) => a + f.fees, 0n), 0n);
      const basis = (p.cost + fees) as Lamports;
      return { mint: p.mint, openedAtMs: t?.openedAtMs ?? nowMs, notional: solPrice === null ? (t?.notional ?? (0n as MicroUsd)) : lamportsToMicroUsd(basis, solPrice, 'ceil'), mark: null, markAtMs: null };
    });
    const history: AccountHistory = {
      openingEquity: this.#s.openingEquity, openedAtMs: this.#s.openedAtMs, flows: [], closedTrades, costs, openPositions,
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
