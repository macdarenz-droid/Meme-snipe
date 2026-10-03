// Holder balances rebuilt from the schema-3 dataset (docs/research/historical-data.md "Holder rebuild"), one place for
// the backtest and BT-2's facts (agreed between BT-1d and BT-2). Fed in chain order, it keeps every token account of
// each mint and answers "as of now" only: nothing later is ever read. Its answer has the shape of live's complete
// holder set (core facts checkHolders): every account with a balance, the venue accounts included, and the supply,
// refused (unresolved) when the balances do not sum to it.
// - Supply: the create's total supply, minus burns (burn movements, and boost buy-and-burn), plus mints.
// - The curve's token account: its balance is the curve's real token reserves after each trade plus the tokens the
//   curve holds back for migration (total supply minus the initial real reserves, from the create); owner = the
//   bonding-curve PDA. A migration moves `mint_amount` out of it.
// - A pool's base vault (the pool's associated token account): its balance is the pool's base reserve after each
//   swap (exact, from the event's pre-trade reserves) or the pool's base amount at creation; owner = the pool.
// - A swap credits or debits its `user_token_owner`'s account (`user_token_account`), never `user` or the signer. A
//   boost buy-and-burn credits nobody and burns what it bought.
// - A movement debits `from_account` and credits `to_account` (a burn only debits, a mint only credits). A row with an
//   empty owner on a side it moves is left out whole (its transaction is marked in the coverage notes).
// - Owner programs (GATE-1e's ownerProgram, which tells a locker from an unknown program) come from a hash-checked
//   supplement read once (owner-programs.ts): an off-curve owner it does not list leaves the mint unresolved.
// A mint's holders are unresolved, from that transaction on, at: no create seen, an empty swap owner, a coverage note
// of scope `unresolved` (applied when the replay reaches it), activity during the lead-in without movements, a mint
// searched only in its pump transactions, an account owner change, an owner that disagrees with the tracked one, a
// balance below zero at the end of a transaction, or (when asked) balances that do not sum to the supply.
import { addressBytes, bondingCurveAddress, findProgramAddress, pumpPoolAuthority, TOKEN_PROGRAM, type Address } from '../../../core/src/chain/index.ts';
import { offCurve } from '../../../core/src/gates/index.ts';
import { ASSOCIATED_TOKEN_PROGRAM } from '../../../core/src/tx/programs.ts';
import type { AmmSwapRow, CoverageRow, CurveTradeRow, EventRow, MovementRow } from './rows.ts';

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
  readonly ownerProgram: string | null;
  readonly amount: bigint;
  readonly delegate: string | null;
  readonly delegatedAmount: bigint;
}

export type HoldersAsOf =
  | { readonly unresolved: false; readonly supply: bigint; readonly accounts: readonly HolderAccount[] }
  | { readonly unresolved: true; readonly reason: string; readonly fromSlot: bigint };

/** A raw token operation on an account (from the raw records). */
export type AccountOp =
  | { readonly kind: 'approve'; readonly mint: string; readonly account: string; readonly delegate: string; readonly amount: bigint }
  | { readonly kind: 'revoke'; readonly mint: string; readonly account: string }
  | { readonly kind: 'close'; readonly mint: string; readonly account: string }
  | { readonly kind: 'owner'; readonly mint: string; readonly account: string; readonly newOwner: string };

export interface HolderBookOptions {
  /** The dataset's coverage notes; each is applied only when the replay reaches it. */
  readonly coverage?: readonly CoverageRow[];
  /** Program of each off-curve owner (the owner-program supplement); null for an owner account that does not exist. */
  readonly ownerPrograms?: ReadonlyMap<string, string | null>;
}

interface Account {
  owner: string;
  amount: bigint;
  delegate: string | null;
  delegated: bigint;
}

interface Venue {
  readonly address: string;
  readonly owner: string;
  amount: bigint;
}

interface MintState {
  readonly accounts: Map<string, Account>;
  /** From the create: total supply, initial real reserves and the token program. Null until a create is seen. */
  create: { readonly total: bigint; readonly initialReal: bigint; readonly program: string } | null;
  supply: bigint;
  curve: Venue | null;
  readonly pools: Map<string, Venue>;
  unresolved: { readonly reason: string; readonly fromSlot: bigint } | null;
}

const BOOST = 'boost_buy_and_burn';

/** The associated token account of `owner` for `mint` under `program`. */
export const associatedTokenAddress = (owner: string, mint: string, program: string): string =>
  findProgramAddress([addressBytes(owner as Address), addressBytes(program as Address), addressBytes(mint as Address)], ASSOCIATED_TOKEN_PROGRAM).address;

/** When a coverage note takes effect: its own transaction for `unresolved`, its range start otherwise. */
const effective = (c: CoverageRow): ChainKey => (c.scope === 'unresolved' && c.slot !== null ? { slot: c.slot, txIdx: c.txIdx ?? 0 } : { slot: c.fromSlot, txIdx: -1 });

const big = (s: string | undefined, what: string): bigint => {
  if (s === undefined || !/^\d+$/.test(s)) throw new RangeError(`${what} must be an integer, got "${String(s)}"`);
  return BigInt(s);
};

export class HolderBook {
  readonly #mints = new Map<string, MintState>();
  readonly #coverage: readonly CoverageRow[];
  readonly #ownerPrograms: ReadonlyMap<string, string | null>;
  #nextCoverage = 0;
  #at: ChainKey = { slot: -1n, txIdx: -1 };
  /** Accounts touched in the current transaction: checked for a negative balance when it ends. */
  #touched: { mint: string; account: string }[] = [];
  /** Lead-in slots with no movements kept ([from, to]); a mint active in them has incomplete history. */
  readonly #leadIn: { from: bigint; to: bigint }[] = [];
  /** Mints searched only in their pump transactions: ownership outside those rows is unknown. */
  readonly #pumpOnly = new Set<string>();

  constructor(options: HolderBookOptions = {}) {
    this.#coverage = [...(options.coverage ?? [])].filter((c) => c.scope !== 'empty_owner').sort((a, b) => compareChainKey(effective(a), effective(b)));
    this.#ownerPrograms = options.ownerPrograms ?? new Map();
  }

  #state(mint: string): MintState {
    let s = this.#mints.get(mint);
    if (s === undefined) {
      s = { accounts: new Map(), create: null, supply: 0n, curve: null, pools: new Map(), unresolved: null };
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
      const s = this.#mints.get(t.mint);
      const a = s?.accounts.get(t.account);
      if (a !== undefined && a.amount < 0n) this.#mark(t.mint, 'negative_balance', this.#at.slot);
      if (s?.curve && s.curve.amount < 0n) this.#mark(t.mint, 'negative_balance', this.#at.slot);
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

  #pool(s: MintState, mint: string, pool: string): Venue {
    let v = s.pools.get(pool);
    if (v === undefined) {
      // The canonical pool's base vault is its associated token account under the mint's program.
      v = { address: associatedTokenAddress(pool, mint, s.create?.program ?? TOKEN_PROGRAM), owner: pool, amount: 0n };
      s.pools.set(pool, v);
    }
    return v;
  }

  /** A lifecycle event: the create (supply, curve), a migration (tokens out of the curve), a pool creation (its vault). */
  event(row: EventRow): void {
    const f = row.fields;
    const mint = f['mint'] ?? f['base_mint'];
    if (mint === undefined) return;
    if (row.event !== 'CreateEvent' && row.event !== 'CompletePumpAmmMigrationEvent' && row.event !== 'CreatePoolEvent') return;
    this.#advance(row, mint);
    const s = this.#state(mint);
    if (row.event === 'CreateEvent') {
      const total = big(f['token_total_supply'], 'token_total_supply');
      const program = f['token_program'] || TOKEN_PROGRAM;
      const curveOwner = f['bonding_curve'] || bondingCurveAddress(mint as Address);
      s.create = { total, initialReal: big(f['real_token_reserves'], 'real_token_reserves'), program };
      s.supply = total;
      s.curve = { address: associatedTokenAddress(curveOwner, mint, program), owner: curveOwner, amount: total };
    } else if (row.event === 'CompletePumpAmmMigrationEvent') {
      if (s.curve !== null) s.curve.amount -= big(f['mint_amount'], 'mint_amount');
      this.#touched.push({ mint, account: '' });
    } else {
      const pool = f['pool'] ?? '';
      const baseIn = big(f['base_amount_in'], 'base_amount_in');
      this.#pool(s, mint, pool).amount = big(f['pool_base_amount'], 'pool_base_amount');
      // A migration's pool is funded from the curve (moved inside pump, counted at the migration event); any other pool
      // creator pays the base from its own token account.
      const creator = f['creator'] ?? '';
      if (creator !== pumpPoolAuthority(mint as Address)) {
        const from = f['user_base_token_account'] ?? '';
        if (from === '' || creator === '') this.#mark(mint, 'swap_owner_unknown', row.slot);
        else this.#credit(mint, from, creator, -baseIn, row.slot);
      }
    }
  }

  /** A curve or PumpSwap trade row (schema 3). */
  swap(row: AmmSwapRow | CurveTradeRow): void {
    const mint = row.kind === 'amm' ? row.baseMint : row.mint;
    this.#advance(row, mint);
    const s = this.#state(mint);
    const buy = row.kind === 'amm' ? row.side === 'buy' : row.isBuy;
    const tokens = row.kind === 'amm' ? row.baseAmount : row.tokenAmount;
    if (row.kind === 'amm') {
      // The vault after the swap, from the event's pre-trade reserves: exact, whatever the book saw before.
      this.#pool(s, mint, row.pool).amount = buy ? row.pre.baseReserve - tokens : row.pre.baseReserve + tokens;
    } else if (s.create !== null && s.curve !== null) {
      // Real reserves after the trade, plus the tokens the curve holds back for migration.
      s.curve.amount = row.realTokenReserves + (s.create.total - s.create.initialReal);
    }
    // A boost buy-and-burn burns what it buys: nobody is credited and the supply falls.
    if (row.kind === 'amm' && row.ixName === BOOST) {
      s.supply -= tokens;
      return;
    }
    if (row.userTokenOwner === '' || row.userTokenAccount === '') {
      this.#mark(mint, 'swap_owner_unknown', row.slot);
      return;
    }
    this.#credit(mint, row.userTokenAccount, row.userTokenOwner, buy ? tokens : -tokens, row.slot);
  }

  /** A token movement outside the swaps (schema 3). */
  movement(m: MovementRow): void {
    this.#advance(m, m.mint);
    const s = this.#state(m.mint);
    // Supply changes whatever the owners: a burn always lowers it, a mint raises it.
    if (m.kind === 'burn') s.supply -= m.amount;
    else if (m.kind === 'mint') s.supply += m.amount;
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

  /**
   * Every account of `mint` with a balance (the curve and pool vaults included) and the supply, as of the last input,
   * or why its ownership is unresolved: an unresolved mark, no create seen, an off-curve owner without a program in the
   * supplement, or balances that do not sum to the supply.
   */
  holdersAsOf(mint: string): HoldersAsOf {
    this.#endTx();
    const s = this.#mints.get(mint);
    if (s === undefined) return { unresolved: true, reason: 'no_create', fromSlot: this.#at.slot };
    if (s.unresolved !== null) return { unresolved: true, ...s.unresolved };
    if (s.create === null) return { unresolved: true, reason: 'no_create', fromSlot: this.#at.slot };
    const venues = new Set<string>([...(s.curve === null ? [] : [s.curve.owner]), ...s.pools.keys()]);
    const accounts: HolderAccount[] = [];
    const venue = (v: Venue | null) => {
      if (v !== null && v.amount !== 0n) accounts.push({ address: v.address, mint, owner: v.owner, ownerProgram: null, amount: v.amount, delegate: null, delegatedAmount: 0n });
    };
    venue(s.curve);
    for (const v of s.pools.values()) venue(v);
    for (const [address, a] of s.accounts) {
      if (a.amount === 0n) continue;
      let ownerProgram: string | null = null;
      if (!venues.has(a.owner) && offCurve(a.owner)) {
        if (!this.#ownerPrograms.has(a.owner)) return { unresolved: true, reason: 'owner_program_unknown', fromSlot: this.#at.slot };
        ownerProgram = this.#ownerPrograms.get(a.owner) ?? null;
      }
      accounts.push({ address, mint, owner: a.owner, ownerProgram, amount: a.amount, delegate: a.delegate, delegatedAmount: a.delegated });
    }
    const sum = accounts.reduce((t, a) => t + a.amount, 0n);
    if (sum !== s.supply) return { unresolved: true, reason: 'sum_mismatch', fromSlot: this.#at.slot };
    // Sorted by address, like live's complete set.
    accounts.sort((x, y) => (x.address < y.address ? -1 : x.address > y.address ? 1 : 0));
    return { unresolved: false, supply: s.supply, accounts };
  }
}
