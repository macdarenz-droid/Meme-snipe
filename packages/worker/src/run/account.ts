// The paper account (risk's AccountHistory, RISK-1): built from the ledger (reservations held, account version, read in
// one transaction) and the worker's record of its own paper trades (account.json: the paper wallet, each trade's
// notional, open and close times and net result). Only the bot's own paper trades: no personal data (CLAUDE.md ruling).
import type { Mint } from '../../../core/src/domain/index.ts';
import type { Ledger } from '../../../core/src/ledger/index.ts';
import { type Book, isTerminal } from '../../../core/src/lifecycle/index.ts';
import type { AccountHistory, ClosedTrade, Latches } from '../../../core/src/risk/index.ts';
import { type Lamports, type MicroUsd, lamportsToMicroUsd, microUsdToLamports } from '../../../core/src/units/index.ts';
import type { AccountFact } from '../engine/strategy.ts';
import { StateFile } from './state.ts';

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

  /** `oneTimeRent`: what a fresh wallet's first buy pays once for accounts it never closes (settings `oneTimeRent`). */
  constructor(file: StateFile<AccountState>, bankroll: MicroUsd, nowMs: number, oneTimeRent: bigint) {
    this.#file = file;
    this.#oneTimeRent = oneTimeRent;
    this.#s = file.read({ openedAtMs: nowMs, openingEquity: bankroll, walletLamports: null, trades: [], entries: [] });
    this.#setUp();
    file.write(this.#s);
  }

  get state(): Readonly<AccountState> {
    return this.#s;
  }

  /** Converts the bankroll into the paper wallet at the first known SOL price. */
  price(solPrice: MicroUsd | null): void {
    if (this.#s.walletLamports !== null || solPrice === null || solPrice <= 0n) return;
    this.#s.walletLamports = microUsdToLamports(this.#s.openingEquity, solPrice, 'floor');
    this.#setUp();
    this.#file.write(this.#s);
  }

  /**
   * The wallet's setup: its one-time accounts (the venue's volume accumulator) are made once, before the first trade,
   * and their rent leaves the wallet for good. Paid at setup rather than by the first buy, so no trade's cost carries
   * it: at the trial size the first trade would fail R14's cost gate for good and the accounts would never be made.
   */
  #setUp(): void {
    if (this.#s.walletLamports === null || this.#s.oneTimePaid === true) return;
    this.#s.walletLamports -= this.#oneTimeRent;
    this.#s.oneTimePaid = true;
  }

  reserved(mint: string, atMs: number): void {
    this.#s.entries.push({ mint, atMs });
    this.#file.write(this.#s);
  }

  /** A fill was booked: move the paper wallet, open or close the trade record. */
  filled(r: { readonly purpose: 'entry' | 'exit'; readonly positionId: string; readonly mint: string; readonly book: Book; readonly atMs: number; readonly reasons: readonly string[] }, solPrice: MicroUsd | null): void {
    const p = r.book.positions[r.positionId];
    const intents = Object.values(r.book.intents).filter((i) => i.intent.positionId === r.positionId);
    const sum = (purpose: 'entry' | 'exit', f: 'sol' | 'fees') => intents.filter((i) => i.intent.purpose === purpose).reduce((t, i) => t + i.fills.reduce((s, x) => s + x[f], 0n), 0n);
    if (r.purpose === 'entry') {
      const notionalReason = r.reasons.find((x) => /^notional \d+$/.test(x));
      const notional = (notionalReason === undefined ? 0n : BigInt(notionalReason.slice('notional '.length))) as MicroUsd;
      if (!this.#s.trades.some((t) => t.positionId === r.positionId)) {
        this.#s.trades.push({ positionId: r.positionId, mint: r.mint, openedAtMs: r.atMs, notional, closedAtMs: null, netLamports: null, netPnl: null, stoppedOut: false, booked: 0n, openSolPrice: solPrice });
      }
    }
    // The wallet follows every booked fill: entries pay SOL and fees, exits receive SOL and pay fees.
    const t = this.#s.trades.find((x) => x.positionId === r.positionId);
    const net = sum('exit', 'sol') - sum('entry', 'sol') - sum('entry', 'fees') - sum('exit', 'fees');
    if (this.#s.walletLamports !== null && t !== undefined) {
      this.#s.walletLamports += net - t.booked;
      t.booked = net;
    }
    if (t !== undefined && p !== undefined && p.status === 'closed' && t.closedAtMs === null) {
      t.closedAtMs = r.atMs;
      t.netLamports = net;
      // Valued at the close's SOL price; unknown price: valued as a total loss of the notional (the safe side).
      t.netPnl = solPrice === null ? (-t.notional as MicroUsd) : (net >= 0n ? lamportsToMicroUsd(net as Lamports, solPrice, 'floor') : (-lamportsToMicroUsd((-net) as Lamports, solPrice, 'ceil') as MicroUsd));
      t.stoppedOut = r.reasons.some((x) => STOPS.has(x));
      t.closeSolPrice = solPrice;
      t.exitReasons = r.reasons.filter((x) => EXIT_REASONS.has(x));
    }
    this.#file.write(this.#s);
  }

  /** The account snapshot risk reads, with the ledger's held reservations and version read in one transaction. */
  fact(ledger: Ledger, book: Book, latches: Latches, solPrice: MicroUsd | null, nowMs: number): AccountFact {
    const { version, value: held } = ledger.withSnapshot(() => ledger.heldExposure());
    const closedTrades: ClosedTrade[] = this.#s.trades.filter((t) => t.closedAtMs !== null && t.netPnl !== null).map((t) => ({
      mint: t.mint as Mint, openedAtMs: t.openedAtMs, closedAtMs: t.closedAtMs!, notional: t.notional, netPnl: t.netPnl!, stoppedOut: t.stoppedOut,
    }));
    const openPositions = Object.values(book.positions).filter((p) => p.status !== 'closed' && p.status !== 'opening').map((p) => {
      const t = this.#s.trades.find((x) => x.positionId === p.id);
      const fees = Object.values(book.intents).filter((i) => i.intent.positionId === p.id).reduce((s, i) => s + i.fills.reduce((a, f) => a + f.fees, 0n), 0n);
      const basis = (p.cost + fees) as Lamports;
      return { mint: p.mint, openedAtMs: t?.openedAtMs ?? nowMs, notional: solPrice === null ? (t?.notional ?? (0n as MicroUsd)) : lamportsToMicroUsd(basis, solPrice, 'ceil'), mark: null, markAtMs: null };
    });
    const history: AccountHistory = {
      openingEquity: this.#s.openingEquity, openedAtMs: this.#s.openedAtMs, flows: [], closedTrades, openPositions,
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
