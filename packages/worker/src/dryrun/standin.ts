// Stand-in accounts (supervisor ruling, TEST-2): the bot wallet stays unfunded until the gate passes, so each trade is
// also built for a stand-in that can pay for it on chain today. Buys use a funded plain wallet; sells use a current
// holder of at least the position's tokens. With `sigVerify: false` the simulation is read-only. The stand-in build
// must equal the real build except for the wallet's own keys and accounts (proved per trade by `sameStructure`).
import { type Address, NATIVE_MINT, PUMP_AMM_PROGRAM, PUMP_PROGRAM, SYSTEM_PROGRAM, TOKEN_PROGRAM, decodeTokenAccount } from '../../../core/src/chain/index.ts';
import type { Instruction } from '../../../core/src/tx/instruction.ts';
import { TOKEN_CLOSE_ACCOUNT } from '../../../core/src/tx/native.ts';
import { associatedTokenAddress, userVolumeAccumulator } from '../../../core/src/tx/programs.ts';
import type { RawAccount } from './rpc.ts';

/** Every account derived from a wallet that a TX-1 build can name, mapped to the same derivation for another wallet. */
export const walletDerived = (wallet: Address, mint: Address, baseTokenProgram: Address): Address[] => {
  const uvaCurve = userVolumeAccumulator(PUMP_PROGRAM, wallet);
  const uvaPool = userVolumeAccumulator(PUMP_AMM_PROGRAM, wallet);
  return [
    wallet,
    associatedTokenAddress(wallet, mint, baseTokenProgram),
    associatedTokenAddress(wallet, NATIVE_MINT, TOKEN_PROGRAM),
    uvaCurve,
    uvaPool,
    associatedTokenAddress(uvaCurve, NATIVE_MINT, TOKEN_PROGRAM),
    associatedTokenAddress(uvaPool, NATIVE_MINT, TOKEN_PROGRAM),
  ];
};

export const substitution = (real: Address, standIn: Address, mint: Address, baseTokenProgram: Address): ReadonlyMap<Address, Address> => {
  const from = walletDerived(real, mint, baseTokenProgram);
  const to = walletDerived(standIn, mint, baseTokenProgram);
  return new Map(from.map((k, i) => [k, to[i]!] as const));
};

/** True for the instruction that closes the wallet's base-token account (the sell's optional close). */
export const isBaseClose = (ix: Instruction, baseAta: Address, baseTokenProgram: Address): boolean =>
  ix.programId === baseTokenProgram && ix.data.length === 1 && ix.data[0] === TOKEN_CLOSE_ACCOUNT && ix.accounts[0]?.address === baseAta;

export type Structure = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * The stand-in build equals the real one: same programs, same instruction data (amounts, limits, fees, tip) and the
 * same account metas, after the real wallet's derived accounts are replaced by the stand-in's. `closeOmitted`
 * allows exactly one difference: the real build's close of its base-token account is absent (a holder with more
 * tokens than the position cannot close its account, so the close is left out of the stand-in build).
 */
export const sameStructure = (
  real: readonly Instruction[],
  standIn: readonly Instruction[],
  map: ReadonlyMap<Address, Address>,
  closeOmitted: { readonly baseAta: Address; readonly baseTokenProgram: Address } | null,
): Structure => {
  let expected = real;
  if (closeOmitted) {
    const closes = real.filter((ix) => isBaseClose(ix, closeOmitted.baseAta, closeOmitted.baseTokenProgram));
    if (closes.length !== 1) return { ok: false, reason: 'the real build has no base-account close to omit' };
    expected = real.filter((ix) => ix !== closes[0]);
  }
  if (expected.length !== standIn.length) return { ok: false, reason: `instruction count ${standIn.length}, expected ${expected.length}` };
  const reverse = new Set(map.values());
  for (let i = 0; i < expected.length; i++) {
    const a = expected[i]!;
    const b = standIn[i]!;
    if (a.programId !== b.programId) return { ok: false, reason: `instruction ${i}: program differs` };
    if (a.data.length !== b.data.length || a.data.some((x, j) => x !== b.data[j])) return { ok: false, reason: `instruction ${i}: data differs` };
    if (a.accounts.length !== b.accounts.length) return { ok: false, reason: `instruction ${i}: account count differs` };
    for (let j = 0; j < a.accounts.length; j++) {
      const x = a.accounts[j]!;
      const y = b.accounts[j]!;
      const want = map.get(x.address) ?? x.address;
      // A key that is not wallet-derived must be identical, and must not collide with a stand-in-derived key.
      if (y.address !== want || (!map.has(x.address) && reverse.has(y.address))) return { ok: false, reason: `instruction ${i} account ${j}: ${y.address} is not ${want}` };
      if (x.signer !== y.signer || x.writable !== y.writable) return { ok: false, reason: `instruction ${i} account ${j}: flags differ` };
    }
  }
  return { ok: true };
};

/** A plain wallet that can sign and pay: owned by the System program, no data, not executable. */
export const isPlainWallet = (a: RawAccount | null): a is RawAccount => a !== null && a.owner === SYSTEM_PROGRAM && a.data.length === 0 && !a.executable;

export interface HolderCandidate {
  readonly owner: Address;
  readonly tokenAccount: Address;
  readonly amount: bigint;
}

/**
 * A token account usable as the stand-in's base account: initialized (not frozen), for this mint, and the owner's
 * associated token account (the builder names the ATA). Returns null otherwise or when the bytes do not decode.
 */
export const holderOf = (address: Address, account: RawAccount | null, mint: Address, baseTokenProgram: Address): HolderCandidate | null => {
  if (account === null || account.owner !== baseTokenProgram) return null;
  let t;
  try {
    t = decodeTokenAccount(account.data, account.owner as Address);
  } catch {
    return null;
  }
  if (t.mint !== mint || t.state !== 'initialized') return null;
  if (associatedTokenAddress(t.owner, mint, baseTokenProgram) !== address) return null;
  return { owner: t.owner, tokenAccount: address, amount: t.amount };
};
