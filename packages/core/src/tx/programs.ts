// Addresses the transaction builders and the signer policy use, beyond the venue addresses in chain/programs.ts.
import { type Address, PUMP_AMM_PROGRAM, PUMP_FEES_PROGRAM, PUMP_PROGRAM, addressBytes, findProgramAddress, toAddress } from '../chain/index.ts';

export const ASSOCIATED_TOKEN_PROGRAM = toAddress('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const COMPUTE_BUDGET_PROGRAM = toAddress('ComputeBudget111111111111111111111111111111');

/**
 * Jito's "don't front-run" marker: a read-only account whose key starts with `jitodontfront`. The block engine
 * refuses any bundle that puts a transaction carrying it anywhere but first (docs/research/execution.md §5, F10).
 * It is never written or owned by anything; it only has to appear in the account list.
 */
export const JITO_DONT_FRONT = toAddress('jitodontfront111111111111111111111111111111');

/**
 * Helius Sender tip accounts, read from the Sender docs on 2026-10-03 (docs/research/execution.md §4.3). The worker
 * re-reads them at startup; the signer policy takes the allowlist as an input, so a changed list is a config change,
 * never a code edit at signing time.
 */
export const HELIUS_SENDER_TIP_ACCOUNTS: readonly Address[] = [
  '4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE',
  'D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ',
  '9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta',
  '5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn',
  '2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD',
  '2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ',
  'wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF',
  '3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT',
  '4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey',
  '4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or',
].map(toAddress);

/** Associated token account: PDA([owner, token program, mint], associated token program). */
export const associatedTokenAddress = (owner: Address, mint: Address, tokenProgram: Address): Address =>
  findProgramAddress([addressBytes(owner), addressBytes(tokenProgram), addressBytes(mint)], ASSOCIATED_TOKEN_PROGRAM).address;

const pda = (program: Address, ...seeds: (string | Address)[]): Address =>
  findProgramAddress(seeds.map((s, i) => (i === 0 ? s : addressBytes(s as Address))), program).address;

/** Anchor `emit_cpi!` signer: PDA(["__event_authority"], program). */
export const eventAuthority = (program: Address): Address => findProgramAddress(['__event_authority'], program).address;
export const globalVolumeAccumulator = (program: Address): Address => findProgramAddress(['global_volume_accumulator'], program).address;
/** Per-wallet volume accumulator, one under pump and a separate one under PumpSwap (execution.md F3). */
export const userVolumeAccumulator = (program: Address, user: Address): Address => pda(program, 'user_volume_accumulator', user);

/** pump `creator_vault`: PDA(["creator-vault", bonding_curve.creator], pump). */
export const pumpCreatorVault = (creator: Address): Address => pda(PUMP_PROGRAM, 'creator-vault', creator);
/** PumpSwap `coin_creator_vault_authority`: PDA(["creator_vault", pool.coin_creator], pump_amm). */
export const poolCoinCreatorVaultAuthority = (coinCreator: Address): Address => pda(PUMP_AMM_PROGRAM, 'creator_vault', coinCreator);
/** PumpSwap `pool-v2` PDA, a remaining account on swaps of pools with a coin creator (pump-swap-sdk 1.20.0). */
export const poolV2Address = (baseMint: Address): Address => pda(PUMP_AMM_PROGRAM, 'pool-v2', baseMint);
/** pump-fees `sharing_config`: PDA(["sharing-config", base_mint], pump fees), mandatory on every v2 curve trade. */
export const sharingConfigAddress = (baseMint: Address): Address => pda(PUMP_FEES_PROGRAM, 'sharing-config', baseMint);
