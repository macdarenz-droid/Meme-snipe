// Shared build inputs for the TX-1 tests: an execution policy, chain rates and a request per kind on the golden
// markets. Test values only; the worker loads real ones from the session's configuration.
import type { Address } from '../../src/chain/index.ts';
import { type BuildCommon, type CuCalibration, type ExecutionPolicy, HELIUS_SENDER_TIP_ACCOUNTS, type TradeRequest, type TxShape, calibrate } from '../../src/tx/index.ts';
import { lamports } from '../../src/units/index.ts';
import { GOLDEN, type GoldenTx, type Kind, curveMarket, goldenAccount, mintOf, poolMarket, realInstruction, realTx } from './helpers.ts';

const samplesOf = (kind: Kind) => GOLDEN.samples.filter((s) => s.kind === kind).map((s) => s.computeUnitsConsumed);
/** Provisional calibration from real swaps of the same shape (a close adds one Token instruction; TEST-2 re-measures). */
export const CALIBRATION: CuCalibration = calibrate({
  'curve-buy': samplesOf('curve-buy'),
  'curve-sell': samplesOf('curve-sell'),
  'curve-sell-close': samplesOf('curve-sell'),
  'pool-buy': samplesOf('pool-buy'),
  'pool-sell': samplesOf('pool-sell'),
  'pool-sell-close': samplesOf('pool-sell'),
} satisfies Partial<Record<TxShape, number[]>>);

export const POLICY: ExecutionPolicy = {
  maxSlippageBps: 300,
  maxPriorityFeeLamports: lamports(50_000n),
  tipLamports: lamports(5_000n),
  maxTipLamports: lamports(10_000n),
  tipAccounts: HELIUS_SENDER_TIP_ACCOUNTS,
  jitoDontFront: true,
  calibration: CALIBRATION,
};

export const RATES = { rent: { lamportsPerByte: 5_080n }, lamportsPerSignature: lamports(5_000n) };

export const goldenOf = (kind: Kind): GoldenTx => GOLDEN.golden.find((g) => g.kind === kind)!;

/** The real swap's signer: a funded mainnet wallet, so builds exercise real derived accounts. */
export const walletOf = (g: GoldenTx): Address => {
  const real = realInstruction(realTx(g), g.swapIndex);
  return real.accounts[g.kind.startsWith('curve') ? 13 : 1]!.address;
};

export const common = (g: GoldenTx, over: Partial<BuildCommon> = {}): BuildCommon => ({
  wallet: walletOf(g),
  recentBlockhash: realTx(g).tx.recentBlockhash,
  lastValidBlockHeight: 400_000_000n,
  slippageBps: 250,
  priorityFeeLamports: lamports(20_000n),
  choice: { feeRecipient: 3, buybackRecipient: 5, tipAccount: 2 },
  rates: RATES,
  existing: new Set(),
  lookupTables: [],
  quotedAtSlot: BigInt(g.slot),
  ...over,
});

export const SPEND = lamports(40_000_000n);

export const request = (kind: Kind, closeTokenAccount = true): TradeRequest => {
  const g = goldenOf(kind);
  const mint = mintOf(goldenAccount(g.mint)).mint;
  switch (kind) {
    case 'curve-buy':
      return { venue: 'curve', side: 'buy', market: curveMarket(g), mint, spend: SPEND, quote: { spend: SPEND, tokens: 1_234_567_890n, userQuote: SPEND } };
    case 'curve-sell':
      return { venue: 'curve', side: 'sell', market: curveMarket(g), mint, quote: { tokens: 1_234_567_890n, userQuote: 38_000_000n }, closeTokenAccount };
    case 'pool-buy':
      return { venue: 'pool', side: 'buy', market: poolMarket(g), mint, spend: SPEND, quote: { spend: SPEND, base: 987_654_321n, userQuote: SPEND - 2n } };
    case 'pool-sell':
      return { venue: 'pool', side: 'sell', market: poolMarket(g), mint, quote: { base: 987_654_321n, userQuote: 37_000_000n }, closeTokenAccount };
  }
};
