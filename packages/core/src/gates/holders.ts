// Holder concentration done correctly (docs/research/safety.md §4; docs/ARCHITECTURE.md H12, H13).
// Before measuring, remove the accounts that are not traders: the bonding-curve ATA, pool vaults, the mayhem vault,
// lockers, burns and accounts of known programs. Shares are of circulating supply = supply - excluded balances.
import { findProgramAddress, isOnCurve } from '../chain/address.ts';
import type { Address } from '../chain/bytes.ts';
import { PUMP_AMM_PROGRAM, PUMP_PROGRAM } from '../chain/programs.ts';
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
/** Raydium Burn & Earn locker: an escrow with no withdraw instruction (docs/research/safety.md §2.3). */
export const RAYDIUM_LOCKER_PROGRAM = 'LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE' as Address;

/** Programs whose accounts hold tokens for the protocol, not for a trader. */
const KNOWN_PROGRAMS: ReadonlySet<string> = new Set([PUMP_PROGRAM, PUMP_AMM_PROGRAM, MAYHEM_PROGRAM]);
const LOCKER_PROGRAMS: ReadonlySet<string> = new Set([RAYDIUM_LOCKER_PROGRAM]);

export type HolderClass =
  | 'curve' | 'pool-vault' | 'mayhem-vault' | 'locker' | 'burn' | 'program'
  /** Owned by a PDA of a program we do not know: kept as a holder (it may be the dev's), and noted. */
  | 'unknown-program'
  | 'wallet';

export const EXCLUDED: ReadonlySet<HolderClass> = new Set<HolderClass>(['curve', 'pool-vault', 'mayhem-vault', 'locker', 'burn', 'program']);

/** The protocol accounts of this mint that hold tokens. `pool` is the pool the entry trades on, when there is one. */
export interface MintAccounts {
  readonly curve: string;
  readonly pool: { readonly address: string; readonly baseVault: string } | null;
}

export const mintAccounts = (mint: string, pool: MintAccounts['pool']): MintAccounts => ({ curve: bondingCurveAddress(mint as Address), pool });

/** True for a PDA. An owner that is not a 32-byte address counts as one too: it is kept as a holder and noted. */
const offCurve = (address: string): boolean => {
  try {
    const bytes = decodeBase58(address);
    return bytes.length !== 32 || !isOnCurve(bytes);
  } catch {
    return true;
  }
};

export const classifyHolder = (a: HolderAccount, known: MintAccounts): HolderClass => {
  if (a.owner === known.curve) return 'curve';
  if (known.pool !== null && (a.address === known.pool.baseVault || a.owner === known.pool.address)) return 'pool-vault';
  if (a.owner === MAYHEM_VAULT_OWNER) return 'mayhem-vault';
  if (a.owner === INCINERATOR) return 'burn';
  if (a.ownerProgram !== null && LOCKER_PROGRAMS.has(a.ownerProgram)) return 'locker';
  if (a.ownerProgram !== null && KNOWN_PROGRAMS.has(a.ownerProgram)) return 'program';
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
  /** Non-excluded balances grouped by owner, largest first (ties by owner, code-unit order). */
  readonly owners: readonly OwnerShare[];
  readonly top1: OwnerShare | null;
  readonly top10: bigint;
  readonly classes: readonly { readonly address: string; readonly owner: string; readonly cls: HolderClass; readonly amount: bigint }[];
  /** Balance of an owner not in the list is at most this (0 when every account is listed). */
  readonly unlistedBound: bigint;
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
  const owners = [...byOwner].map(([owner, amount]) => ({ owner, amount }))
    .sort((a, b) => (a.amount > b.amount ? -1 : a.amount < b.amount ? 1 : a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0));
  const top10 = owners.slice(0, 10).reduce((s, o) => s + o.amount, 0n);
  const smallest = h.accounts.reduce<bigint | null>((m, a) => (m === null || a.amount < m ? a.amount : m), null);
  return {
    supply: h.supply,
    excluded,
    circulating: h.supply - excluded,
    owners,
    top1: owners[0] ?? null,
    top10,
    classes,
    unlistedBound: h.coverage === 'all' ? 0n : (smallest ?? h.supply),
    coverage: h.coverage,
  };
};

/** amount / circulating in basis points, rounded up (a share at the limit is not under it). */
export const shareBps = (amount: bigint, circulating: bigint): bigint => {
  if (circulating <= 0n) throw new RangeError('circulating supply must be > 0');
  const n = amount * BPS_DENOMINATOR;
  return n / circulating + (n % circulating === 0n ? 0n : 1n);
};

/** An owner's balance; for an owner missing from a 'largest' list, its upper bound. */
export const ownerBalance = (c: Concentration, owner: string): { readonly amount: bigint; readonly listed: boolean } => {
  const o = c.owners.find((x) => x.owner === owner);
  if (o) return { amount: o.amount, listed: true };
  if (c.classes.some((x) => x.owner === owner)) return { amount: 0n, listed: true }; // only excluded accounts
  return { amount: c.unlistedBound, listed: c.coverage === 'all' };
};
