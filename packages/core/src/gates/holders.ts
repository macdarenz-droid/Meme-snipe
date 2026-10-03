// Holder concentration done correctly (docs/research/safety.md §4; docs/ARCHITECTURE.md H12, H13).
// Before measuring, remove the accounts that are not traders: the bonding-curve ATA, pool vaults, the mayhem vault,
// lockers, burns and accounts of known programs. Shares are of circulating supply = supply - excluded balances.
import { MEMORY_LIMITS } from '../config/memory.ts';
import { findProgramAddress, isOnCurve } from '../chain/address.ts';
import type { Address } from '../chain/bytes.ts';
import { bondingCurveAddress } from '../chain/pump.ts';
import { decodeBase58 } from '../chain/base58.ts';
import { BPS_DENOMINATOR } from '../units/index.ts';
import type { HolderAccount, HoldersFact } from './facts.ts';

/** pump's mayhem program. Its PDA ["sol-vault"] owns the mayhem agent's token vault (docs/research/safety.md §2, F3). */
export const MAYHEM_PROGRAM = 'MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e' as Address;
/** PDA(["sol-vault"], mayhem program): `BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s` (derived; checked in the tests). */
export const MAYHEM_VAULT_OWNER = findProgramAddress(['sol-vault'], MAYHEM_PROGRAM).address;
/** Tokens sent here are gone but still count in supply, so they are subtracted. */
export const INCINERATOR = '1nc1nerator11111111111111111111111111111111' as Address;
/**
 * Raydium Burn & Earn locker. It escrows LP tokens and position NFTs, not a coin's own tokens, and its immutability is
 * unproven, so an account it owns stays a holder and is noted (review round 2).
 */
export const RAYDIUM_LOCKER_PROGRAM = 'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE' as Address;

/**
 * Only named accounts are excluded: this mint's curve, the canonical pool's stored base vault, the mayhem vault and
 * burns. An account owned by any other PDA, even one of pump's own programs, stays a holder: a non-canonical
 * PumpSwap pool is a PumpSwap PDA whose LP owner can withdraw its tokens at any time. Lockers stay holders too.
 */
const LOCKER_PROGRAMS: ReadonlySet<string> = new Set([RAYDIUM_LOCKER_PROGRAM]);

export type HolderClass =
  | 'curve' | 'pool-vault' | 'mayhem-vault' | 'burn'
  /** Owned by a locker program: kept as a holder and noted, until a decision with evidence proves the lock. */
  | 'locker'
  /** Owned by a PDA of a program we do not know: kept as a holder (it may be the dev's), and noted. */
  | 'unknown-program'
  | 'wallet';

export const EXCLUDED: ReadonlySet<HolderClass> = new Set<HolderClass>(['curve', 'pool-vault', 'mayhem-vault', 'burn']);

/** The protocol accounts of this mint that hold tokens. `pool` is the pool the entry trades on, when there is one. */
export interface MintAccounts {
  readonly curve: string;
  readonly pool: { readonly address: string; readonly baseVault: string } | null;
}

export const mintAccounts = (mint: string, pool: MintAccounts['pool']): MintAccounts => ({ curve: bondingCurveAddress(mint as Address), pool });

/** True for a PDA. An owner that is not a 32-byte address counts as one too: it is kept as a holder and noted. */
const offCurveUncached = (address: string): boolean => {
  try {
    const bytes = decodeBase58(address);
    return bytes.length !== 32 || !isOnCurve(bytes);
  } catch {
    return true;
  }
};

/**
 * The curve check decompresses a point with big-integer powers (about 1 ms); the backtest asks it for every holder
 * at every check (BT-2 measured 84% of a run here). The answer depends on the address alone, so it is remembered;
 * the memory is bounded and emptied whole when full, which changes no answer.
 */
const offCurveCache = new Map<string, boolean>();
export const offCurve = (address: string): boolean => {
  const hit = offCurveCache.get(address);
  if (hit !== undefined) return hit;
  const v = offCurveUncached(address);
  if (offCurveCache.size >= MEMORY_LIMITS.offCurveCache) offCurveCache.clear();
  offCurveCache.set(address, v);
  return v;
};

export const classifyHolder = (a: HolderAccount, known: MintAccounts): HolderClass => {
  if (a.owner === known.curve) return 'curve';
  if (known.pool !== null && a.address === known.pool.baseVault) return 'pool-vault';
  if (a.owner === MAYHEM_VAULT_OWNER) return 'mayhem-vault';
  if (a.owner === INCINERATOR) return 'burn';
  if (a.ownerProgram !== null && LOCKER_PROGRAMS.has(a.ownerProgram)) return 'locker';
  if (offCurve(a.owner)) return 'unknown-program';
  return 'wallet';
};

export interface OwnerShare {
  readonly owner: string;
  readonly amount: bigint;
}

export interface Concentration {
  readonly supply: bigint;
  readonly excluded: bigint;
  readonly circulating: bigint;
  /**
   * Non-excluded balances grouped by owner, largest first (ties by owner, code-unit order). A delegate is listed too,
   * with min(delegated amount, balance) of each account it may move, excluded accounts included (GATE-1e).
   */
  readonly owners: readonly OwnerShare[];
  readonly top1: OwnerShare | null;
  readonly top10: bigint;
  readonly classes: readonly { readonly address: string; readonly owner: string; readonly cls: HolderClass; readonly amount: bigint }[];
  /**
   * Supply that no listed account holds: supply - every listed balance (excluded ones included). On a largest-accounts
   * view it is held by accounts not shown, any number of them, so all of it could belong to any one owner, listed or
   * not (GATE-1d). A complete view must have none.
   */
  readonly unaccounted: bigint;
  readonly coverage: HoldersFact['coverage'];
}

export const concentration = (h: HoldersFact, known: MintAccounts): Concentration => {
  // Sorted by address, so the input order of accounts never changes the result.
  const classes = h.accounts.map((a) => ({ address: a.address, owner: a.owner, cls: classifyHolder(a, known), amount: a.amount }))
    .sort((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  let excluded = 0n;
  const byOwner = new Map<string, bigint>();
  for (const c of classes) {
    if (EXCLUDED.has(c.cls)) excluded += c.amount;
    else byOwner.set(c.owner, (byOwner.get(c.owner) ?? 0n) + c.amount);
  }
  // GATE-1e: a delegate can move up to its delegated amount, so it also counts as holding min(delegated, balance).
  // This only raises concentration (the owner keeps its balance too); it never enters the supply sum.
  for (const a of [...h.accounts].sort((x, y) => (x.address < y.address ? -1 : x.address > y.address ? 1 : 0))) {
    if (a.delegate === null || a.delegate === a.owner) continue;
    const moved = a.delegatedAmount < a.amount ? a.delegatedAmount : a.amount;
    if (moved > 0n) byOwner.set(a.delegate, (byOwner.get(a.delegate) ?? 0n) + moved);
  }
  const owners = [...byOwner].map(([owner, amount]) => ({ owner, amount }))
    .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  const top10 = owners.slice(0, 10).reduce((s, o) => s + o.amount, 0n);
  const listed = h.accounts.reduce((s, a) => s + a.amount, 0n);
  return {
    supply: h.supply,
    excluded,
    circulating: h.supply - excluded,
    owners,
    top1: owners[0] ?? null,
    top10,
    classes,
    unaccounted: h.supply - listed,
    coverage: h.coverage,
  };
};

/** amount / circulating in basis points, rounded up (a share at the limit is not under it). */
export const shareBps = (amount: bigint, circulating: bigint): bigint => {
  if (circulating <= 0n) throw new RangeError('circulating supply must be > 0');
  const n = amount * BPS_DENOMINATOR;
  return n / circulating + (n % circulating === 0n ? 0n : 1n);
};

/**
 * What an owner holds in the listed, non-excluded accounts. On a largest-accounts view this is a lower bound only:
 * the owner may also hold any part of `unaccounted` (callers bound that worst case).
 */
export const ownerBalance = (c: Concentration, owner: string): bigint => c.owners.find((x) => x.owner === owner)?.amount ?? 0n;
