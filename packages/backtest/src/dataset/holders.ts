// Holder balances rebuilt from the schema-3 dataset (docs/research/historical-data.md "Holder rebuild"), one place for
// the backtest and BT-2's facts (agreed between BT-1d and BT-2). Fed in chain order, it keeps every token account
// ({owner, amount, delegate, delegated}) of each mint, and answers "as of now" only: nothing later is ever read.
// - A swap credits or debits its `user_token_owner`'s account (`user_token_account`), never `user` or the signer; the
//   curve or pool takes the other side (kept apart as the venue's amount). A boost buy-and-burn credits nobody.
// - A movement debits `from_account` and credits `to_account` (a burn only debits, a mint only credits). A row with an
//   empty owner is left out; its transaction is marked unresolved in the coverage notes.
// - A mint's ownership becomes unresolved, from that transaction on, at: an empty swap owner, a coverage note of scope
//   `unresolved` (applied when the replay reaches it), activity during the lead-in without movements, a mint searched
//   only in its pump transactions, an account owner change, an owner that disagrees with the tracked one, or a balance
//   below zero at the end of a transaction (history incomplete). Its holder facts then abstain.
// Delegates come from raw token operations (approve, revoke, close, owner change) through `applyAccountOps`.
import type { AmmSwapRow, CoverageRow, CurveTradeRow, MovementRow } from './rows.ts';

/** Where an input sits on chain; inputs must arrive with non-decreasing (slot, txIdx). */
export interface ChainKey {
  readonly slot: bigint;
  readonly txIdx: number;
}

/** -1, 0 or 1 by (slot, txIdx): the order the book requires (within a transaction any order is accepted). */
export const compareChainKey = (a: ChainKey, b: ChainKey): number => (a.slot !== b.slot ? (a.slot < b.slot ? -1 : 1) : Math.sign(a.txIdx - b.txIdx));

/** GATE-1e's HolderAccount shape. */
export interface HolderAccount {
  readonly address: string;
  readonly mint: string;
  readonly owner: string;
  readonly ownerProgram: null;
  readonly amount: bigint;
  readonly delegate: string | null;
  readonly delegatedAmount: bigint;
}

export type HoldersAsOf =
  | { readonly unresolved: false; readonly accounts: readonly HolderAccount[]; readonly venueNetChange: bigint }
  | { readonly unresolved: true; readonly reason: string; readonly fromSlot: bigint };

/** A raw token operation on an account (from the raw records). */
export type AccountOp =
  | { readonly kind: 'approve'; readonly mint: string; readonly account: string; readonly delegate: string; readonly amount: bigint }
  | { readonly kind: 'revoke'; readonly mint: string; readonly account: string }
  | { readonly kind: 'close'; readonly mint: string; readonly account: string }
  | { readonly kind: 'owner'; readonly mint: string; readonly account: string; readonly newOwner: string };

interface Account {
  owner: string;
  amount: bigint;
  delegate: string | null;
  delegated: bigint;
}

interface MintState {
  readonly accounts: Map<string, Account>;
  /** Net change of the curve's or pool's holding since the book began (its starting balance is not in the data). */
  venue: bigint;
  unresolved: { readonly reason: string; readonly fromSlot: bigint } | null;
}

const BOOST = 'boost_buy_and_burn';

/** When a coverage note takes effect: its own transaction for `unresolved`, its range start otherwise. */
const effective = (c: CoverageRow): ChainKey => (c.scope === 'unresolved' && c.slot !== null ? { slot: c.slot, txIdx: c.txIdx ?? 0 } : { slot: c.fromSlot, txIdx: -1 });

export class HolderBook {
  readonly #mints = new Map<string, MintState>();
  readonly #coverage: readonly CoverageRow[];
  #nextCoverage = 0;
  #at: ChainKey = { slot: -1n, txIdx: -1 };
  /** Accounts touched in the current transaction: checked for a negative balance when it ends. */
  #touched: { mint: string; account: string }[] = [];
  /** Lead-in slots with no movements kept ([from, to]); a mint active in them has incomplete history. */
  readonly #leadIn: { from: bigint; to: bigint }[] = [];
  /** Mints searched only in their pump transactions: ownership outside those rows is unknown. */
  readonly #pumpOnly = new Set<string>();

  /** `coverage`: the dataset's notes; each is applied only when the replay reaches it. */
  constructor(coverage: readonly CoverageRow[] = []) {
    this.#coverage = [...coverage].filter((c) => c.scope !== 'empty_owner').sort((a, b) => compareChainKey(effective(a), effective(b)));
  }

  #state(mint: string): MintState {
    let s = this.#mints.get(mint);
    if (s === undefined) {
      s = { accounts: new Map(), venue: 0n, unresolved: null };
      this.#mints.set(mint, s);
    }
    return s;
  }

  #mark(mint: string, reason: string, slot: bigint): void {
    const s = this.#state(mint);
    if (s.unresolved === null) s.unresolved = { reason, fromSlot: slot };
  }

  /** Moves the book to `k`: refuses going back, closes the previous transaction, applies the coverage notes reached. */
  #advance(k: ChainKey, mint: string): void {
    const c = compareChainKey(k, this.#at);
    if (c < 0) throw new RangeError(`holder input at slot ${k.slot} tx ${k.txIdx} is before slot ${this.#at.slot} tx ${this.#at.txIdx}: inputs must be in chain order`);
    if (c > 0) {
      this.#endTx();
      this.#at = k;
    }
    while (this.#nextCoverage < this.#coverage.length && compareChainKey(effective(this.#coverage[this.#nextCoverage]!), k) <= 0) {
      const n = this.#coverage[this.#nextCoverage++]!;
      if (n.scope === 'unresolved') this.#mark(n.mint, n.reason, n.slot ?? n.fromSlot);
      else if (n.scope === 'no_movements') this.#leadIn.push({ from: n.fromSlot, to: n.toSlot });
      else if (n.scope === 'pump_transactions') this.#pumpOnly.add(n.mint);
    }
    if (this.#leadIn.some((w) => k.slot >= w.from && k.slot <= w.to)) this.#mark(mint, 'no_movements', k.slot);
    if (this.#pumpOnly.has(mint)) this.#mark(mint, 'pump_transactions', k.slot);
  }

  #endTx(): void {
    for (const t of this.#touched) {
      const a = this.#mints.get(t.mint)?.accounts.get(t.account);
      if (a !== undefined && a.amount < 0n) this.#mark(t.mint, 'negative_balance', this.#at.slot);
    }
    this.#touched = [];
  }

  #credit(mint: string, account: string, owner: string, delta: bigint, slot: bigint): void {
    const s = this.#state(mint);
    let a = s.accounts.get(account);
    if (a === undefined) {
      a = { owner, amount: 0n, delegate: null, delegated: 0n };
      s.accounts.set(account, a);
    } else if (a.owner !== owner) {
      // An owner the book does not know about changed hands: history is incomplete.
      this.#mark(mint, 'owner_mismatch', slot);
      a.owner = owner;
    }
    a.amount += delta;
    this.#touched.push({ mint, account });
  }

  /** A curve or PumpSwap trade row (schema 3). */
  swap(row: AmmSwapRow | CurveTradeRow): void {
    const mint = row.kind === 'amm' ? row.baseMint : row.mint;
    this.#advance(row, mint);
    const buy = row.kind === 'amm' ? row.side === 'buy' : row.isBuy;
    const tokens = row.kind === 'amm' ? row.baseAmount : row.tokenAmount;
    const s = this.#state(mint);
    s.venue += buy ? -tokens : tokens;
    // A boost buy-and-burn burns what it buys: nobody is credited.
    if (row.kind === 'amm' && row.ixName === BOOST) return;
    if (row.userTokenOwner === '' || row.userTokenAccount === '') {
      this.#mark(mint, 'swap_owner_unknown', row.slot);
      return;
    }
    this.#credit(mint, row.userTokenAccount, row.userTokenOwner, buy ? tokens : -tokens, row.slot);
  }

  /** A token movement outside the swaps (schema 3). */
  movement(m: MovementRow): void {
    this.#advance(m, m.mint);
    const from = m.kind !== 'mint';
    const to = m.kind !== 'burn';
    // A row with an empty owner on a side it moves is left out whole (its transaction is marked in the coverage notes).
    if ((from && (m.fromOwner === '' || m.fromAccount === '')) || (to && (m.toOwner === '' || m.toAccount === ''))) return;
    if (from) this.#credit(m.mint, m.fromAccount, m.fromOwner, -m.amount, m.slot);
    if (to) this.#credit(m.mint, m.toAccount, m.toOwner, m.amount, m.slot);
  }

  /** Raw token operations of one transaction at `k` (delegates, closes, owner changes). */
  applyAccountOps(k: ChainKey, ops: readonly AccountOp[]): void {
    for (const op of ops) {
      this.#advance(k, op.mint);
      const a = this.#mints.get(op.mint)?.accounts.get(op.account);
      if (op.kind === 'owner') {
        this.#mark(op.mint, 'owner_change', k.slot);
        if (a !== undefined) a.owner = op.newOwner;
      } else if (a === undefined) {
        continue;
      } else if (op.kind === 'approve') {
        a.delegate = op.delegate;
        a.delegated = op.amount;
      } else if (op.kind === 'revoke') {
        a.delegate = null;
        a.delegated = 0n;
      } else {
        this.#mints.get(op.mint)!.accounts.delete(op.account);
      }
    }
  }

  /** Every non-empty account of `mint` as of the last input, or why its ownership is unresolved. */
  holdersAsOf(mint: string): HoldersAsOf {
    this.#endTx();
    const s = this.#mints.get(mint);
    if (s === undefined) return { unresolved: false, accounts: [], venueNetChange: 0n };
    if (s.unresolved !== null) return { unresolved: true, ...s.unresolved };
    const accounts: HolderAccount[] = [];
    for (const [address, a] of s.accounts) {
      if (a.amount === 0n) continue;
      accounts.push({ address, mint, owner: a.owner, ownerProgram: null, amount: a.amount, delegate: a.delegate, delegatedAmount: a.delegated });
    }
    accounts.sort((x, y) => (x.amount !== y.amount ? (x.amount > y.amount ? -1 : 1) : x.address < y.address ? -1 : 1));
    return { unresolved: false, accounts, venueNetChange: s.venue };
  }
}
