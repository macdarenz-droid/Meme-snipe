// Fixtures for the TX-1 tests: real mainnet swaps (fixtures/golden.json, from fetch-golden.ts) and the markets they
// traded, decoded with the DEC-1 decoders.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Address,
  type DecodedTransaction,
  type LoadedAddresses,
  type Mint,
  PUMP_AMM_GLOBAL_CONFIG,
  PUMP_GLOBAL,
  accountKeys,
  decodeBondingCurve,
  decodeGlobal,
  decodeGlobalConfig,
  decodeMint,
  decodePool,
  decodeTransaction,
  fromBase64,
  isSigner,
  isWritable,
} from '../../src/chain/index.ts';
import type { AccountMeta, CurveMarket, Instruction, PoolMarket } from '../../src/tx/index.ts';

export type Kind = 'curve-buy' | 'curve-sell' | 'pool-buy' | 'pool-sell';
export interface AccountFixture { label: string; address: string; slot: number; owner: string; lamports: number; dataBase64: string }
export interface GoldenTx {
  kind: Kind;
  signature: string;
  slot: number;
  transaction: string;
  loadedAddresses: { writable: string[]; readonly: string[] };
  computeUnitsConsumed: number | null;
  fee: number;
  swapIndex: number;
  market: string;
  mint: string;
}
export interface Sample { kind: Kind; signature: string; slot: number; computeUnitsConsumed: number; computeUnitLimit: number | null; topLevel: string[] }
export interface GoldenFile { source: string; fetchedAt: string; accounts: AccountFixture[]; golden: GoldenTx[]; samples: Sample[] }

export const GOLDEN = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'golden.json'), 'utf8')) as GoldenFile;
const CHAIN = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'chain', 'fixtures', 'accounts.json'), 'utf8')) as { accounts: AccountFixture[] };
const CHAIN_TXS = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'chain', 'fixtures', 'transactions.json'), 'utf8')) as {
  transactions: { label: string; signature: string; base64: { transaction: [string, string]; meta: { loadedAddresses: { writable: string[]; readonly: string[] } } } }[];
};

const accountIn = (list: readonly AccountFixture[], address: string): AccountFixture => {
  const a = list.find((x) => x.address === address);
  if (!a) throw new Error(`fixture account ${address} missing`);
  return a;
};
export const goldenAccount = (address: string) => accountIn(GOLDEN.accounts, address);
export const chainAccount = (address: string) => accountIn(CHAIN.accounts, address);
export const chainTransaction = (signature: string) => {
  const t = CHAIN_TXS.transactions.find((x) => x.signature === signature);
  if (!t) throw new Error(`chain fixture transaction ${signature} missing`);
  return { tx: decodeTransaction(fromBase64(t.base64.transaction[0])), loaded: t.base64.meta.loadedAddresses as unknown as LoadedAddresses };
};

export const GLOBAL = decodeGlobal(fromBase64(goldenAccount(PUMP_GLOBAL).dataBase64)).value;
export const GLOBAL_CONFIG = decodeGlobalConfig(fromBase64(goldenAccount(PUMP_AMM_GLOBAL_CONFIG).dataBase64)).value;

export const mintOf = (a: AccountFixture): { mint: Mint; program: Address } => ({
  mint: decodeMint(fromBase64(a.dataBase64), a.owner as Address),
  program: a.owner as Address,
});

export const curveMarket = (g: GoldenTx): CurveMarket => {
  const c = goldenAccount(g.market);
  const data = fromBase64(c.dataBase64);
  return { mint: g.mint as Address, baseTokenProgram: goldenAccount(g.mint).owner as Address, curve: decodeBondingCurve(data).value, accountBytes: data.length, pumpGlobal: GLOBAL };
};

export const poolMarketFrom = (pool: AccountFixture, baseTokenProgram: Address, globalConfig = GLOBAL_CONFIG): PoolMarket => {
  const data = fromBase64(pool.dataBase64);
  return { pool: pool.address as Address, state: decodePool(data).value, accountBytes: data.length, baseTokenProgram, globalConfig };
};
export const poolMarket = (g: GoldenTx): PoolMarket => poolMarketFrom(goldenAccount(g.market), goldenAccount(g.mint).owner as Address);

export interface RealTx {
  readonly tx: DecodedTransaction;
  readonly loaded: LoadedAddresses;
  readonly keys: Address[];
}
export const realTx = (g: GoldenTx): RealTx => {
  const tx = decodeTransaction(fromBase64(g.transaction));
  const loaded = g.loadedAddresses as unknown as LoadedAddresses;
  return { tx, loaded, keys: accountKeys(tx, loaded) };
};

/** A real instruction as metas: tx-level writable and signer flags (the message keeps no per-instruction flags). */
export const realInstruction = (r: RealTx, index: number): Instruction => {
  const ix = r.tx.instructions[index]!;
  return {
    programId: r.keys[ix.programIdIndex]!,
    accounts: ix.accounts.map((a): AccountMeta => ({ address: r.keys[a]!, signer: isSigner(r.tx, a), writable: isWritable(r.tx, a, r.loaded) })),
    data: ix.data,
  };
};

export const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
export const metasText = (ms: readonly AccountMeta[]) => ms.map((m) => `${m.address}${m.writable ? ' w' : ''}${m.signer ? ' s' : ''}`);
export const u64le = (b: Uint8Array, offset: number) => Buffer.from(b.buffer, b.byteOffset, b.byteLength).readBigUInt64LE(offset);
