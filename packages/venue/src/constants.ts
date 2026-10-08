// @bot/venue/constants (A-M01-01; ARCH M01 "Constants (verified)"): the one reviewed file holding every program ID,
// mint and fixed account the system uses, each with its fact ID. No other source file may contain a program ID
// literal (lint rule bot/no-program-id-literal). A change here is a reviewed commit, and deriveAndCheckAll() re-derives
// every PDA from its seeds at startup.
// Ported from Snipe-solana card C03 (#6 @ 6ae4d62), with the async signatures of supervisor ruling d0f97ba (C03-R1-7).
//
// VERIFY results (2026-10-07):
// - U-A02: @solana/kit 8.3.0 (exact pin) re-exports @solana/addresses, whose
//   `getProgramDerivedAddress({ programAddress: Address, seeds: Array<ReadonlyUint8Array | string> }):
//   Promise<readonly [Address, ProgramDerivedAddressBump]>` hashes with WebCrypto, so derivation is asynchronous
//   (node_modules/@solana/addresses/dist/types/program-derived-address.d.ts; the kit README names it). 8.4.0 is newer
//   than the 14-day adoption rule allows.
// - U-A01: the pump pool-authority PDA is ["pool-authority", base_mint] under the pump program: the `pool_authority`
//   account of `migrate` in the pinned idl/pump.json and docs/PUMP_SWAP_CREATOR_FEE_README.md, both at
//   pump-fun/pump-public-docs commit cb188ce08b5069196eef1f3e4a0c43b70099793b.
import { getProgramDerivedAddress, type Address } from '@solana/kit';
import { decodePubkey } from '@bot/decoders';
import type { Pubkey, Result } from '@bot/types';

export const PROGRAMS = Object.freeze({
  pumpCurve: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',          // [EX-01]
  pumpSwap: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',           // [EX-01]
  pumpFees: 'pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ',           // [EX-01]
  raydiumAmmV4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',      // [DA-17]
  raydiumCpmm: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',       // [DA-17]
  raydiumClmm: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',       // [DA-17]
  raydiumLaunchLab: 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj',   // [DA-17]
  meteoraDbc: 'dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN',         // [EX-19]
  meteoraDammV2: 'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',      // [EX-21]
  meteoraDlmm: 'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',        // [EX-21]
  orcaWhirlpools: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',     // [EX-23]
  splToken: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',           // [LD-V05]
  token2022: 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',          // [DA-12]
  computeBudget: 'ComputeBudget111111111111111111111111111111',       // [LD-03]
} as const satisfies Record<string, Pubkey>);

export const MINTS = Object.freeze({
  wsol: 'So11111111111111111111111111111111111111112',               // [DA-V01]
} as const satisfies Record<string, Pubkey>);

export const ACCOUNTS = Object.freeze({
  pumpGlobal: '4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf',           // ["global"] under pumpCurve [EX-01]
  pumpSwapGlobalConfig: 'ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw', // ["global_config"] under pumpSwap [EX-01]
  feeConfigCurve: '8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt',       // ["fee_config", pumpCurve] under pumpFees [EX-01]
  feeConfigPumpSwap: '5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx',    // ["fee_config", pumpSwap] under pumpFees [EX-01]
  migrationWithdrawAuthority: '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg', // [EX-03]
} as const satisfies Record<string, Pubkey>);

type Seed = string | Uint8Array;
const key = (p: Pubkey): Uint8Array => decodePubkey(p);

/** The four PDAs and their seeds [EX-01]; `bump` is the expected bump (asserted in tests, not used at run time). */
export const PDAS: ReadonlyArray<{ name: keyof typeof ACCOUNTS; program: Pubkey; seeds: () => Seed[]; bump: number }> = [
  { name: 'pumpGlobal', program: PROGRAMS.pumpCurve, seeds: () => ['global'], bump: 255 },
  { name: 'pumpSwapGlobalConfig', program: PROGRAMS.pumpSwap, seeds: () => ['global_config'], bump: 255 },
  { name: 'feeConfigCurve', program: PROGRAMS.pumpFees, seeds: () => ['fee_config', key(PROGRAMS.pumpCurve)], bump: 253 },
  { name: 'feeConfigPumpSwap', program: PROGRAMS.pumpFees, seeds: () => ['fee_config', key(PROGRAMS.pumpSwap)], bump: 255 },
];

/** Derives a PDA with @solana/kit (on-curve check included). */
export async function derivePda(program: Pubkey, seeds: readonly Seed[]): Promise<{ address: Pubkey; bump: number }> {
  const [address, bump] = await getProgramDerivedAddress({ programAddress: program as Address, seeds: [...seeds] });
  return { address, bump };
}

export interface ConstantMismatch { code: 'E_CONSTANT_MISMATCH'; name: string; expected: Pubkey; derived: Pubkey }
/** M01 log codes for the engine's M27 logger (B-M27-01; plain data, merged with mergeLogCodes). */
export const M01_LOG_CODES = {
  'm01.constants_checked': { fields: { result: 'symbol', name: 'name' } },
} as const;

export interface ConstantsLog { event(level: 'info' | 'critical', code: string, fields: Readonly<Record<string, unknown>>): void }

/**
 * Re-derives every PDA and compares it with its literal. The engine calls this at startup and refuses to trade on a
 * mismatch (same handling as an IDL hash mismatch, A-M02-01); the log line `m01.constants_checked` is critical then.
 */
export async function deriveAndCheckAll(log?: ConstantsLog, pdas = PDAS): Promise<Result<true, ConstantMismatch>> {
  for (const p of pdas) {
    const { address } = await derivePda(p.program, p.seeds());
    const expected = ACCOUNTS[p.name];
    if (address !== expected) {
      log?.event('critical', 'm01.constants_checked', { result: 'mismatch', name: p.name });
      return { ok: false, error: { code: 'E_CONSTANT_MISMATCH', name: p.name, expected, derived: address } };
    }
  }
  log?.event('info', 'm01.constants_checked', { result: 'ok', name: 'all' });
  return { ok: true, value: true };
}

/** The pump pool-authority PDA: a PumpSwap pool is canonical when `pool.creator` equals it [EX-08]. Seeds: U-A01 above. */
export async function pumpPoolAuthorityPda(baseMint: Pubkey): Promise<Pubkey> {
  return (await derivePda(PROGRAMS.pumpCurve, ['pool-authority', key(baseMint)])).address;
}
