// Settlement shared by the backtest and paper mode (PAPER-1): the token account each entry opens and its rent, each
// attempt's fee, a round trip's net in lamports, and its value in US dollars with each flow at its own time. The
// backtest's world and trade records and the paper world and account call these same functions, so a paper trade
// settles exactly as the historical backtest scores it.
import type { Fill } from '../domain/index.ts';
import type { Book, PositionState } from '../lifecycle/index.ts';
import { type Lamports, type MicroUsd, lamportsToMicroUsd } from '../units/index.ts';
import { type FillNetwork, type FillScenario, accountGetsDust, closeSucceeds } from './model.ts';

/** The fee parts an attempt paid: a landed success base, priority and tip; a landed failure base and priority; else nothing. */
export const feeParts = (net: FillNetwork, priorityFee: bigint, outcome: string): { readonly base: bigint; readonly priority: bigint; readonly tip: bigint } => {
  if (outcome !== 'filled' && outcome !== 'failed') return { base: 0n, priority: 0n, tip: 0n };
  return { base: net.signaturesPerTx * net.baseFeePerSignature, priority: priorityFee, tip: outcome === 'filled' ? net.tip : 0n };
};

/** One leg of a sell or buy that landed and executed, as the token account sees it. */
export interface AccountLeg {
  readonly purpose: 'entry' | 'exit';
  readonly mint: string;
  /** Tokens bought (entry) or sold (exit). */
  readonly tokens: bigint;
  /** Seed of the close draw (per attempt) and of the dust draw (per new account). */
  readonly closeSeed: string;
  readonly dustSeed: string;
}

export type AccountSettlement = { readonly ok: false; readonly reason: 'close failed' | 'sell beyond balance' } | { readonly ok: true; readonly closedAccount: boolean };

/**
 * Our token accounts, one per mint, from our own fills (§11, RENT-1). A sell of the whole balance closes the account in
 * the same transaction (atomic sell-and-close), unless the account is sell-only. A failed close fails the transaction
 * (the sell rolls back, the fee is still paid) and leaves the account sell-only; a new account may pick up dust or an
 * unsolicited token and is then sell-only too. A sell-only account emptied by a sell stays open, its rent locked.
 */
export class TokenAccounts {
  readonly #held = new Map<string, bigint>();
  readonly #sellOnly = new Set<string>();

  held(mint: string): bigint {
    return this.#held.get(mint) ?? 0n;
  }

  /** True when a sell of `tokens` would close the account (the whole balance, and not sell-only). */
  closes(mint: string, tokens: bigint): boolean {
    return tokens === this.held(mint) && !this.#sellOnly.has(mint);
  }

  /** A landed attempt whose swap executed: the close is drawn here; a failed close fails the attempt. */
  settle(l: AccountLeg, s: FillScenario): AccountSettlement {
    // The token program refuses a transfer beyond the balance: the swap fails on chain, its fee paid (PAPER-2).
    if (l.purpose === 'exit' && l.tokens > this.held(l.mint)) return { ok: false, reason: 'sell beyond balance' };
    const closes = l.purpose === 'exit' && this.closes(l.mint, l.tokens);
    if (closes && !closeSucceeds(l.closeSeed, s)) {
      this.#sellOnly.add(l.mint);
      return { ok: false, reason: 'close failed' };
    }
    return { ok: true, closedAccount: this.#apply(l, s, closes) };
  }

  /**
   * Rebuilds the state from attempts already settled (a restart), in landing order: a filled one is applied again
   * (its close already succeeded, so none is drawn), a failed close leaves the account sell-only.
   */
  restore(l: AccountLeg, s: FillScenario, outcome: 'filled' | 'close failed'): boolean {
    if (outcome === 'close failed') {
      this.#sellOnly.add(l.mint);
      return false;
    }
    return this.#apply(l, s, l.purpose === 'exit' && this.closes(l.mint, l.tokens));
  }

  #apply(l: AccountLeg, s: FillScenario, closes: boolean): boolean {
    const held = this.held(l.mint);
    if (l.purpose === 'entry') {
      if (held === 0n && accountGetsDust(l.dustSeed, s)) this.#sellOnly.add(l.mint);
      this.#held.set(l.mint, held + l.tokens);
      return false;
    }
    this.#held.set(l.mint, held - l.tokens);
    if (closes) this.#sellOnly.delete(l.mint);
    return closes;
  }
}

/** The late-fill index of a position id (LEDGER-1b `<position>.o<n>`: the entry intent's n-th fill), or null. */
export const lateFillOf = (positionId: string): number | null => {
  const m = /\.o(\d+)$/.exec(positionId);
  return m === null ? null : Number(m[1]) - 1;
};

/** Signatures of the entry fills late-fill positions own, by entry intent (LEDGER-1b). */
export const lateFillClaims = (book: Book): ReadonlyMap<string, ReadonlySet<string>> => {
  const claimed = new Map<string, Set<string>>();
  for (const p of Object.values(book.positions)) {
    const k = lateFillOf(p.id);
    const f = k === null ? undefined : book.intents[p.entryIntentId]?.fills[k];
    if (f !== undefined) claimed.set(p.entryIntentId, (claimed.get(p.entryIntentId) ?? new Set<string>()).add(f.signature));
  }
  return claimed;
};

/**
 * A position's share of its entry intent (LEDGER-1b): a late buy landing books `<position>.o<n>`, which owns the
 * intent's n-th fill and that fill's attempt; the main position owns every other fill and attempt, failed ones included.
 */
export const entryShare = (book: Book, p: PositionState, claims: ReadonlyMap<string, ReadonlySet<string>>): { readonly fills: readonly Fill[]; readonly owns: (signature: string) => boolean } => {
  const intent = book.intents[p.entryIntentId];
  const k = lateFillOf(p.id);
  const late = claims.get(p.entryIntentId) ?? new Set<string>();
  const fills = k === null ? (intent?.fills ?? []).filter((f) => !late.has(f.signature)) : [intent?.fills[k]].filter((f) => f !== undefined);
  const own = new Set<string>(fills.map((f) => f.signature));
  return { fills, owns: (sig) => (k === null ? !late.has(sig) : own.has(sig)) };
};

/**
 * One entry's token-account rent (RENT-1): charged to the first trade of the entry, and back exactly when a sell of
 * one of its positions landed as an atomic sell-and-close. The no-recovery line is a reported sensitivity, not this.
 */
export const tradeRent = (net: FillNetwork, firstOfEntry: boolean, closed: boolean): { readonly rentPaid: bigint; readonly rentReturned: bigint } => {
  const rentPaid = firstOfEntry ? net.tokenAccountRent : 0n;
  return { rentPaid, rentReturned: closed ? rentPaid : 0n };
};

/** One leg's costs, lamports: converted to USD at that leg's own time (entry at the entry, exit at the exit). */
export interface LegCosts {
  readonly networkBase: bigint;
  readonly priority: bigint;
  readonly tip: bigint;
  readonly venueFee: bigint;
  readonly creatorFee: bigint;
  readonly slippage: bigint;
}

/** A round trip in lamports: what both settlement sides hand to `tradeNet` and `tradeUsd`. */
export interface TradeLamports {
  /** Lamports paid for the tokens, venue fees included. */
  readonly entrySol: bigint;
  /** Lamports received, venue fees taken. */
  readonly exitSol: bigint;
  readonly legs: { readonly entry: LegCosts; readonly exit: LegCosts };
  readonly rentPaid: bigint;
  readonly rentReturned: bigint;
}

/** Network fees and rent are paid on top of the swap amounts; venue fees and slippage are inside them. */
export const tradeNet = (t: TradeLamports): bigint =>
  t.exitSol - t.entrySol - t.legs.entry.networkBase - t.legs.exit.networkBase - t.legs.entry.priority - t.legs.exit.priority
  - t.legs.entry.tip - t.legs.exit.tip - t.rentPaid + t.rentReturned;

/**
 * Signed lamports in micro-dollars, rounded against us (AUDIT-RM1 F5): `up` (toward +∞) for what we pay, `down` (toward
 * −∞) for what we receive and for results, so a cost is never understated and a gain never overstated.
 */
export const toUsd = (lamports: bigint, px: MicroUsd, dir: 'up' | 'down'): bigint =>
  lamports < 0n
    ? -lamportsToMicroUsd(-lamports as Lamports, px, dir === 'up' ? 'floor' : 'ceil')
    : lamportsToMicroUsd(lamports as Lamports, px, dir === 'up' ? 'ceil' : 'floor');

export interface TradeUsd {
  /** The entry and the proceeds, micro-dollars. */
  readonly size: bigint;
  readonly proceeds: bigint;
  readonly costs: {
    readonly venue: bigint; readonly creator: bigint; readonly priority: bigint; readonly tip: bigint; readonly network: bigint;
    readonly slippage: bigint; readonly rentPaid: bigint; readonly rentReturned: bigint;
  };
  readonly total: bigint;
  /** The dollar result: each cash flow at its own time. */
  readonly net: bigint;
  /** The SOL result (lamports, no exchange rate) and its value at the exit's price: the trading part of `net`. */
  readonly netLamports: bigint;
  readonly trading: bigint;
  /** The rest of `net`: SOL's own move between entry and exit on what the trade held in SOL terms. */
  readonly solMove: bigint;
}

/**
 * A trade in USD, each flow at its own time (item 6 of BT-1c): the entry, the entry leg's costs and the rent at the
 * entry-time price; the proceeds, the exit leg's costs and any rent returned at the exit-time price. SOL moving in
 * between therefore shows in the dollar result, and is split out: `trading` is the SOL result at the exit price,
 * `solMove` the remainder (`net = trading + solMove` exactly).
 */
export const tradeUsd = (t: TradeLamports, pxIn: MicroUsd, pxOut: MicroUsd): TradeUsd => {
  const both = (k: keyof LegCosts) => toUsd(t.legs.entry[k], pxIn, 'up') + toUsd(t.legs.exit[k], pxOut, 'up');
  const c = {
    venue: both('venueFee'), creator: both('creatorFee'), priority: both('priority'), tip: both('tip'), network: both('networkBase'),
    slippage: both('slippage'), rentPaid: toUsd(t.rentPaid, pxIn, 'up'), rentReturned: toUsd(t.rentReturned, pxOut, 'down'),
  };
  const total = c.venue + c.creator + c.priority + c.tip + c.network + c.slippage + c.rentPaid - c.rentReturned;
  const size = toUsd(t.entrySol, pxIn, 'up');
  const proceeds = toUsd(t.exitSol, pxOut, 'down');
  const net = proceeds - size - c.network - c.priority - c.tip - c.rentPaid + c.rentReturned;
  const netLamports = tradeNet(t);
  const trading = toUsd(netLamports, pxOut, 'down');
  return { size, proceeds, costs: c, total, net, netLamports, trading, solMove: net - trading };
};
