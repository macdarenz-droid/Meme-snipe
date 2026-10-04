// The live inputs of TEST-2's dry run for one paper leg: the PumpSwap pool, the mint's token program, PumpSwap's
// GlobalConfig and the rent rate read from mainnet at or after the leg's slot, then `dryRunTrade` (read and simulate
// only; nothing can be sent). Any input that cannot be read or built becomes the record's failure, never a guess.
import { readFileSync } from 'node:fs';
import { type PoolFeeContext, type PoolState, poolBuyExactQuoteIn, poolSell } from '../../../core/src/amm/index.ts';
import { type Address, PUMP_AMM_GLOBAL_CONFIG, decodeGlobalConfig, decodeMint, decodePool, encodeBase58, toAddress } from '../../../core/src/chain/index.ts';
import { type CuCalibration, calibrate, type TxShape } from '../../../core/src/tx/calibration.ts';
import { HELIUS_SENDER_TIP_ACCOUNTS } from '../../../core/src/tx/programs.ts';
import type { ExecutionPolicy } from '../../../core/src/tx/trade.ts';
import { type Lamports, lamports } from '../../../core/src/units/index.ts';
import { type DryRunRecord, type DryRunRpc, dryRunTrade } from '../dryrun/index.ts';
import { P2 } from '../scheduler/scheduler.ts';
import type { SimLeg } from './paper-world.ts';

/** The Rent sysvar: lamports per byte-year (u64) and the exemption threshold (f64); their product is the per-byte rate. */
export const RENT_SYSVAR = 'SysvarRent111111111111111111111111111111111';

export const rentRateOf = (data: Uint8Array): bigint | null => {
  if (data.length < 16) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const perYear = v.getBigUint64(0, true);
  const threshold = v.getFloat64(8, true);
  if (!Number.isInteger(threshold) || threshold <= 0) return null;
  return perYear * BigInt(threshold);
};

/**
 * TX-1's provisional compute-unit table: p99 × 1.1 of 60 real mainnet swaps per kind (DECISIONS, TX-1), from the
 * samples file TX-1 recorded. TEST-2's own measurements replace it. Null when the file is missing: every build is then
 * refused and recorded as such.
 */
export const provisionalCalibration = (path: string): CuCalibration | null => {
  try {
    const samples = (JSON.parse(readFileSync(path, 'utf8')) as { samples: { kind: string; computeUnitsConsumed: number }[] }).samples;
    const of = (k: string) => samples.filter((s) => s.kind === k).map((s) => s.computeUnitsConsumed);
    return calibrate({
      'curve-buy': of('curve-buy'), 'curve-sell': of('curve-sell'), 'curve-sell-close': of('curve-sell'),
      'pool-buy': of('pool-buy'), 'pool-sell': of('pool-sell'), 'pool-sell-close': of('pool-sell'),
    } satisfies Partial<Record<TxShape, number[]>>);
  } catch {
    return null;
  }
};

export interface LiveSimOptions {
  readonly rpc: DryRunRpc;
  readonly wallet: string | null;
  readonly standIns: readonly string[];
  readonly calibration: CuCalibration | null;
  /** The pool address and the fee context the paper fill used (the latest gate pool fact). */
  readonly poolOf: (mint: string) => { readonly address: string; readonly state: PoolState; readonly ctx: PoolFeeContext } | null;
  readonly maxSlippageBps: number;
  readonly maxPriorityFee: bigint;
  readonly tip: bigint;
  readonly maxTip: bigint;
  readonly lamportsPerSignature: bigint;
}

const failed = (leg: SimLeg, error: string): DryRunRecord => ({
  id: `${leg.trade}|${leg.leg}`, side: leg.side, finalExit: leg.side === 'sell' && leg.closes, venue: 'pool', mint: leg.mint as Address, outcome: 'build-refused', success: false, error, standIn: null, policy: null,
  quotedOut: null, simulatedOut: null, amountErrorE4: null, readSlot: null, quoteAgeSlots: null, rentDeclared: null, rentPaid: null, balancesFrom: null,
  simulatedSlot: null, unitsConsumed: null, logsTail: [],
});

/**
 * The chain inputs of a PumpSwap build, read at or after `slot`: the pool, the mint and its token program, PumpSwap's
 * GlobalConfig and the rent rate. A string says what could not be read; it is never a guess.
 */
export const readPoolMarket = async (rpc: DryRunRpc, poolAddress: string, mintAddress: string, slot: bigint, lamportsPerSignature: bigint) => {
  const read = await rpc.getMultipleAccounts([poolAddress, mintAddress, PUMP_AMM_GLOBAL_CONFIG, RENT_SYSVAR], slot, P2);
  const [poolAcc, mintAcc, configAcc, rentAcc] = read.accounts;
  if (poolAcc == null || mintAcc == null || configAcc == null || rentAcc == null) return 'pool, mint, GlobalConfig or Rent account missing on chain';
  const rate = rentRateOf(rentAcc.data);
  if (rate === null) return 'Rent sysvar unreadable';
  const pool = decodePool(poolAcc.data).value;
  const globalConfig = decodeGlobalConfig(configAcc.data).value;
  const market = { pool: toAddress(poolAddress), state: pool, accountBytes: poolAcc.data.length, baseTokenProgram: toAddress(mintAcc.owner), globalConfig };
  const mint = decodeMint(mintAcc.data, toAddress(mintAcc.owner));
  const rates = { rent: { lamportsPerByte: rate }, lamportsPerSignature: lamportsPerSignature as Lamports };
  return { market, mint, rates };
};

/** A deterministic choice per leg, so a replay builds the same bytes. */
export const choiceOf = (id: string): number => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

export const liveSimulator = (o: LiveSimOptions) => async (leg: SimLeg): Promise<DryRunRecord> => {
  if (o.wallet === null) return failed(leg, 'no bot wallet address (ZEROED_WALLET): the real build has no fee payer');
  if (o.calibration === null) return failed(leg, 'no compute-unit calibration table');
  const m = o.poolOf(leg.mint);
  if (m === null) return failed(leg, 'pool state unknown');
  try {
    const chain = await readPoolMarket(o.rpc, m.address, leg.mint, leg.minContextSlot, o.lamportsPerSignature);
    if (typeof chain === 'string') return failed(leg, chain);
    const { market, mint, rates } = chain;
    const request = leg.side === 'buy'
      ? (() => {
        const q = poolBuyExactQuoteIn(m.state, leg.inAmount, m.ctx);
        return q.ok ? { venue: 'pool' as const, side: 'buy' as const, market, mint, spend: leg.inAmount as Lamports, quote: { spend: leg.inAmount, base: q.trade.base, userQuote: q.trade.userQuote } } : q.reason;
      })()
      : (() => {
        const q = poolSell(m.state, leg.inAmount, m.ctx);
        return q.ok ? { venue: 'pool' as const, side: 'sell' as const, market, mint, quote: { base: leg.inAmount, userQuote: q.trade.userQuote }, closeTokenAccount: leg.closes } : q.reason;
      })();
    if (typeof request === 'string') return failed(leg, `no local quote: ${request}`);
    const policy: ExecutionPolicy = {
      maxSlippageBps: o.maxSlippageBps, maxPriorityFeeLamports: o.maxPriorityFee as Lamports, tipLamports: o.tip as Lamports, maxTipLamports: o.maxTip as Lamports,
      tipAccounts: HELIUS_SENDER_TIP_ACCOUNTS, jitoDontFront: true, calibration: o.calibration,
    };
    const c = choiceOf(leg.intentId);
    const wallet = toAddress(o.wallet);
    return await dryRunTrade({
      id: `${leg.trade}|${leg.leg}`,
      request,
      common: {
        wallet, recentBlockhash: toAddress(encodeBase58(new Uint8Array(32).fill(1))), lastValidBlockHeight: leg.lastValidBlockHeight,
        slippageBps: Number(leg.quotedOut > 0n ? ((leg.quotedOut - leg.minOut) * 10_000n) / leg.quotedOut : 0n) + 1,
        priorityFeeLamports: lamports(leg.priorityFee), choice: { feeRecipient: c % 8, buybackRecipient: (c >>> 3) % 8, tipAccount: c % HELIUS_SENDER_TIP_ACCOUNTS.length },
        rates, existing: new Set(), lookupTables: [], quotedAtSlot: leg.minContextSlot,
      },
      policy,
      signerPolicy: {
        wallet, kind: 'trade', maxSolOut: leg.maxSolOut, maxPriorityFeeLamports: o.maxPriorityFee, maxTipLamports: o.maxTip, tipAccounts: HELIUS_SENDER_TIP_ACCOUNTS,
        withdrawalAddress: null, lamportsPerSignature: o.lamportsPerSignature, rent: rates.rent,
      },
      minContextSlot: leg.minContextSlot,
    }, { rpc: o.rpc, priority: P2, buyStandIns: o.standIns.map((s) => toAddress(s)) });
  } catch (e) {
    return { ...failed(leg, e instanceof Error ? `${e.name}: ${e.message}` : 'error'), outcome: 'rpc-error' };
  }
};
