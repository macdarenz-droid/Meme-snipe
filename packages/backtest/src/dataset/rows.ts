// Typed rows of the DATA-1 dataset (research/historical/scanner, schema 3). Columns are read by name; a missing one is
// refused.
// Amounts are raw integers (lamports, token base units) written as decimal strings; reserves in BuyEvent/SellEvent
// are pre-trade, in TradeEvent post-trade (DEC-1, CORE-2 golden tests).
import type { PoolState } from '../../../core/src/amm/index.ts';
import { type ObservedFees, realSwap } from '../../../core/src/fills/index.ts';
import { bps } from '../../../core/src/units/index.ts';
import { csvObjects } from './csv.ts';

/** Where a row sits on chain: the engine's order is (slot, txIdx, evIdx). */
export interface ChainPos {
  readonly slot: bigint;
  /** Unix seconds (one-second resolution). */
  readonly blockTime: number;
  readonly txIdx: number;
  readonly evIdx: number;
  readonly signature: string;
}

export interface AmmSwapRow extends ChainPos {
  readonly kind: 'amm';
  readonly pool: string;
  readonly baseMint: string;
  readonly quoteMint: string;
  readonly side: 'buy' | 'sell';
  readonly mode: 'exact-base' | 'exact-quote-in';
  /** Replay input: base out or in, or the spend limit of an exact-quote-in buy. */
  readonly amount: bigint;
  readonly baseAmount: bigint;
  /**
   * The event's quote_amount_in / quote_amount_out as logged. Their meaning differs by instruction (CORE-2 golden test):
   * on `buy` it is the net quote into the curve; on `buy_exact_quote_in(_v2)` it is the spend limit, which is why the
   * replay input of an exact-quote-in buy is this field.
   */
  readonly quoteAmount: bigint;
  /**
   * The event's user_quote_amount_in / _out as logged: on `buy` the total paid with fees, on `buy_exact_quote_in` the
   * net swap input, on sells the user's proceeds. Kept for audit only; the backtest takes amounts from the exact replay.
   */
  readonly userQuote: bigint;
  readonly pre: PoolState;
  readonly fees: ObservedFees;
  readonly baseSupply: bigint;
  readonly ixName: string;
  readonly user: string;
  /**
   * Schema 3: the user's base-token account of the emitting instruction and that account's owner, '' when there is
   * none (an empty owner marks the transaction swap_owner_unknown; a boost buy-and-burn has no account). A swap credits
   * or debits the owner, never `user` or the signer.
   */
  readonly userTokenAccount: string;
  readonly userTokenOwner: string;
}

export interface CurveTradeRow extends ChainPos {
  readonly kind: 'curve';
  readonly mint: string;
  readonly isBuy: boolean;
  readonly solAmount: bigint;
  readonly tokenAmount: bigint;
  readonly virtualSolReserves: bigint;
  readonly virtualTokenReserves: bigint;
  readonly realSolReserves: bigint;
  readonly realTokenReserves: bigint;
  readonly mayhem: boolean;
  readonly quoteMint: string;
  readonly user: string;
  /** Schema 3, as on AmmSwapRow. */
  readonly userTokenAccount: string;
  readonly userTokenOwner: string;
}

export interface BlockRow {
  readonly kind: 'block';
  readonly slot: bigint;
  readonly blockTime: number;
  readonly parentSlot: bigint;
}

/** Any other decoded event (creates, graduations, pools, liquidity, boosts, parameters, unknown layouts). */
export interface EventRow extends ChainPos {
  readonly kind: 'event';
  readonly program: string;
  readonly event: string;
  readonly fields: Readonly<Record<string, string>>;
}

export type DatasetRow = AmmSwapRow | CurveTradeRow | BlockRow | EventRow;

const int = (s: string, what: string): bigint => {
  if (!/^-?\d+$/.test(s)) throw new RangeError(`${what} must be an integer, got "${s}"`);
  return BigInt(s);
};
const opt = (s: string): bigint => (s === '' ? 0n : int(s, 'amount'));
const num = (s: string, what: string): number => {
  const v = Number(s);
  if (!Number.isSafeInteger(v)) throw new RangeError(`${what} must be a safe integer, got "${s}"`);
  return v;
};
const flag = (s: string): boolean => s === 'true' || s === '1';

const pos = (get: (c: string) => string): ChainPos => ({
  slot: int(get('slot'), 'slot'), blockTime: num(get('block_time'), 'block_time'), txIdx: num(get('tx_idx'), 'tx_idx'),
  evIdx: num(get('ev_idx'), 'ev_idx'), signature: get('signature'),
});

export const readAmm = (text: string, out: DatasetRow[]): void =>
  csvObjects(text, (get) => {
    const side = get('side');
    if (side !== 'buy' && side !== 'sell') throw new RangeError(`amm side must be buy or sell, got "${side}"`);
    const ixName = get('ix_name');
    const baseAmount = int(get('base_amount'), 'base_amount');
    const quoteAmount = int(get('quote_amount'), 'quote_amount');
    // The replay's input from the logged fields: one mapping with the live path (core fills realSwap).
    const r = realSwap({
      side, ixName, baseAmount, quoteAmount,
      pre: {
        baseReserve: int(get('pool_base_token_reserves'), 'pool_base_token_reserves'),
        quoteVault: int(get('pool_quote_token_reserves'), 'pool_quote_token_reserves'),
        virtualQuoteReserves: opt(get('virtual_quote_reserves')),
      },
      fees: {
        lp: bps(num(get('lp_fee_basis_points'), 'lp bps')),
        protocol: bps(num(get('protocol_fee_basis_points'), 'protocol bps')),
        creator: bps(get('coin_creator_fee_basis_points') === '' ? 0 : num(get('coin_creator_fee_basis_points'), 'creator bps')),
        buyback: bps(get('buyback_fee_basis_points') === '' ? 0 : num(get('buyback_fee_basis_points'), 'buyback bps')),
      },
      baseSupply: opt(get('base_supply')),
    });
    out.push({
      kind: 'amm', ...pos(get), pool: get('pool'), baseMint: get('base_mint'), quoteMint: get('quote_mint'), side, mode: r.mode,
      amount: r.amount, baseAmount, quoteAmount, userQuote: opt(get('user_quote_amount')), pre: r.pre, fees: r.fees, baseSupply: r.baseSupply,
      ixName,
      user: get('user'),
      userTokenAccount: get('user_token_account'),
      userTokenOwner: get('user_token_owner'),
    });
  });

export const readCurve = (text: string, out: DatasetRow[]): void =>
  csvObjects(text, (get) => {
    out.push({
      kind: 'curve', ...pos(get), mint: get('mint'), isBuy: flag(get('is_buy')),
      solAmount: int(get('sol_amount'), 'sol_amount'), tokenAmount: int(get('token_amount'), 'token_amount'),
      virtualSolReserves: int(get('virtual_sol_reserves'), 'virtual_sol_reserves'),
      virtualTokenReserves: int(get('virtual_token_reserves'), 'virtual_token_reserves'),
      realSolReserves: int(get('real_sol_reserves'), 'real_sol_reserves'),
      realTokenReserves: int(get('real_token_reserves'), 'real_token_reserves'),
      mayhem: flag(get('mayhem_mode')), quoteMint: get('quote_mint'), user: get('user'),
      userTokenAccount: get('user_token_account'), userTokenOwner: get('user_token_owner'),
    });
  });

export const readBlocks = (text: string, out: DatasetRow[]): void =>
  csvObjects(text, (get) => {
    out.push({ kind: 'block', slot: int(get('slot'), 'slot'), blockTime: num(get('block_time'), 'block_time'), parentSlot: opt(get('parent_slot')) });
  });

export const readEvents = (text: string, out: DatasetRow[]): void => {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const o = JSON.parse(line) as Record<string, unknown>;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries((o['fields'] ?? {}) as Record<string, unknown>)) fields[k] = String(v);
    out.push({
      kind: 'event', slot: BigInt(String(o['slot'])), blockTime: Number(o['block_time']), txIdx: Number(o['tx_idx']), evIdx: Number(o['ev_idx']),
      signature: String(o['signature']), program: String(o['program']), event: String(o['event']), fields,
    });
  }
};

const ORDER = { amm: 0, curve: 0, event: 0, block: 1 } as const;

/** The dataset's chain order: slot, transaction, event; a slot's block row after its transactions. */
export const compareRows = (a: DatasetRow, b: DatasetRow): number => {
  if (a.slot !== b.slot) return a.slot < b.slot ? -1 : 1;
  const ka = ORDER[a.kind];
  const kb = ORDER[b.kind];
  if (ka !== kb) return ka - kb;
  if (a.kind === 'block' || b.kind === 'block') return 0;
  return a.txIdx - b.txIdx || a.evIdx - b.evIdx;
};

/** A token movement outside pump and PumpSwap swaps (schema 3 `movements`): '' marks an owner that was not resolved. */
export interface MovementRow {
  readonly slot: bigint;
  readonly blockTime: number;
  readonly txIdx: number;
  readonly outerIx: number;
  /** null for a top-level instruction. */
  readonly innerIx: number | null;
  readonly mint: string;
  readonly kind: 'transfer' | 'burn' | 'mint';
  readonly fromOwner: string;
  readonly toOwner: string;
  readonly amount: bigint;
  readonly fromAccount: string;
  readonly toAccount: string;
}

export const readMovements = (text: string, out: MovementRow[]): void =>
  csvObjects(text, (get) => {
    const kind = get('kind');
    if (kind !== 'transfer' && kind !== 'burn' && kind !== 'mint') throw new RangeError(`movement kind must be transfer, burn or mint, got "${kind}"`);
    const inner = get('inner_ix');
    out.push({
      slot: int(get('slot'), 'slot'), blockTime: num(get('block_time'), 'block_time'), txIdx: num(get('tx_idx'), 'tx_idx'),
      outerIx: num(get('outer_ix'), 'outer_ix'), innerIx: inner === '' ? null : num(inner, 'inner_ix'), mint: get('mint'), kind,
      fromOwner: get('from_owner'), toOwner: get('to_owner'), amount: int(get('amount'), 'amount'), fromAccount: get('from_account'), toAccount: get('to_account'),
    });
  });

/**
 * A coverage note of the dataset's `movement_coverage` (schema 3). Each is dated: a consumer applies it only when the
 * replay reaches its slot (or the unit's slot range), never earlier.
 * - pump_transactions: a mint not ending in "pump", searched only in its pump transactions over [fromSlot, toSlot];
 * - unresolved: ownership unknown from (slot, txIdx) on, for `reason`;
 * - empty_owner: movements left out for an unresolved owner, with their count;
 * - no_movements: the lead-in (mint "*"), where no movement was kept.
 */
export interface CoverageRow {
  readonly mint: string;
  readonly scope: 'pump_transactions' | 'unresolved' | 'empty_owner' | 'no_movements';
  readonly slot: bigint | null;
  readonly reason: string;
  readonly count: number | null;
  readonly txIdx: number | null;
  readonly fromSlot: bigint;
  readonly toSlot: bigint;
}

const SCOPES = ['pump_transactions', 'unresolved', 'empty_owner', 'no_movements'] as const;

export const readCoverage = (text: string, out: CoverageRow[]): void =>
  csvObjects(text, (get) => {
    const scope = get('scope') as CoverageRow['scope'];
    if (!SCOPES.includes(scope)) throw new RangeError(`movement_coverage scope "${scope}" is not known`);
    const slot = get('slot');
    const count = get('count');
    const tx = get('tx_idx');
    out.push({
      mint: get('mint'), scope, slot: slot === '' ? null : int(slot, 'slot'), reason: get('reason'), count: count === '' ? null : num(count, 'count'),
      txIdx: tx === '' ? null : num(tx, 'tx_idx'), fromSlot: int(get('from_slot'), 'from_slot'), toSlot: int(get('to_slot'), 'to_slot'),
    });
  });
