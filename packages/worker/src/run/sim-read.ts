// H15 live (WORKER-1e): a candidate whose last evaluation asked for its round-trip simulation gets one, from SIM-1's
// simulator at the gate's own spend, on the pool the worker prices it from. The answer goes on the feed as the raw
// `read:sim:<mint>` (recorded, so a replay rebuilds the same fact), and FACTS-1's producer turns it into the fact
// H15 reads. Fail-safe: no answer (no pool, no local quote, a chain read or build refused) is no fact, so H15 keeps
// rejecting the missing evidence; a failed simulation is a failed fact, so it rejects. Never a pass by default.
import { type PoolFeeContext, type PoolState } from '../../../core/src/amm/index.ts';
import { encodeBase58, toAddress } from '../../../core/src/chain/index.ts';
import { pumpSwapRoundTrip } from '../../../core/src/costs/index.ts';
import type { SimRead } from '../../../core/src/facts/raw.ts';
import type { CuCalibration } from '../../../core/src/tx/calibration.ts';
import { HELIUS_SENDER_TIP_ACCOUNTS } from '../../../core/src/tx/programs.ts';
import type { ExecutionPolicy } from '../../../core/src/tx/trade.ts';
import { type Lamports, lamports } from '../../../core/src/units/index.ts';
import type { DryRunRpc } from '../dryrun/index.ts';
import type { RoundTripRequest, SimRecord, SimResult } from '../sim/roundtrip.ts';
import { choiceOf, readPoolMarket } from './live-sim.ts';

/**
 * Simulations started in any rolling hour (supervisor ruling 2026-10-04: P2 with an hourly cap). About 3 Helius
 * credits each (the market read, the simulation, the stand-in check amortised), so at most about 8,600 a day.
 */
export const SIM_READS_PER_HOUR = 120;
const HOUR_MS = 3_600_000;

export interface SimReadOptions {
  readonly rpc: DryRunRpc;
  readonly simulator: { simulate(req: RoundTripRequest): Promise<SimResult> };
  /** A stand-in address (the simulator replaces the wallet with its own stand-in); null: no simulation at all. */
  readonly wallet: string | null;
  readonly calibration: CuCalibration | null;
  readonly poolOf: (mint: string) => { readonly address: string; readonly state: PoolState; readonly ctx: PoolFeeContext } | null;
  /** The feed's newest slot: the simulation runs on state at or after it. */
  readonly head: () => bigint | null;
  readonly maxSlippageBps: number;
  readonly priorityFee: bigint;
  readonly maxPriorityFee: bigint;
  readonly tip: bigint;
  readonly maxTip: bigint;
  readonly lamportsPerSignature: bigint;
  /** Wall clock (the worker's timers) and the hourly cap (`SIM_READS_PER_HOUR`). */
  readonly now: () => number;
  readonly perHour: number;
  /** Every attempt, fact or not, for the log (G3 measures H15's bias from these); `credits` include the market read's 1. */
  readonly record: (r: SimRecord | { readonly mint: string; readonly spend: bigint; readonly outcome: 'not-run'; readonly reason: string; readonly credits: number }) => void;
}

/** One simulation for `mint` at `spend`: true when a fact (ok or failed) went on the feed. */
export const simReader = (o: SimReadOptions) => {
  const started: number[] = [];
  return async (mint: string, spend: bigint, ingest: (read: SimRead) => void): Promise<boolean> => {
    const skip = (reason: string, credits = 0): boolean => {
      o.record({ mint, spend, outcome: 'not-run', reason, credits });
      return false;
    };
    const now = o.now();
    while (started.length > 0 && started[0]! <= now - HOUR_MS) started.shift();
    if (started.length >= o.perHour) return skip(`hourly cap: ${o.perHour} simulations in the last hour`);
    if (o.wallet === null) return skip('no stand-in address (ZEROED_STANDINS)');
    if (o.calibration === null) return skip('no compute-unit calibration table');
    const m = o.poolOf(mint);
    if (m === null) return skip('pool state unknown');
    const slot = o.head();
    if (slot === null) return skip('no slot seen yet');
    const quote = pumpSwapRoundTrip(m.state, m.ctx)(spend);
    if (!quote.ok) return skip(`no local round trip: ${quote.reason}`);
    started.push(now);
    const chain = await readPoolMarket(o.rpc, m.address, mint, slot, o.lamportsPerSignature).catch((e: unknown) => (e instanceof Error ? e.message : 'chain read failed'));
    // The market read is one getMultipleAccounts (1 credit), counted whether or not it answered.
    if (typeof chain === 'string') return skip(chain, 1);
    const c = choiceOf(`sim:${mint}`);
    const policy: ExecutionPolicy = {
      maxSlippageBps: o.maxSlippageBps, maxPriorityFeeLamports: o.maxPriorityFee as Lamports, tipLamports: o.tip as Lamports, maxTipLamports: o.maxTip as Lamports,
      tipAccounts: HELIUS_SENDER_TIP_ACCOUNTS, jitoDontFront: true, calibration: o.calibration,
    };
    const req: RoundTripRequest = {
      mint: chain.mint, venue: { venue: 'pool', market: chain.market }, spend, quote: quote.trade, policy, minContextSlot: slot,
      common: {
        wallet: toAddress(o.wallet), recentBlockhash: toAddress(encodeBase58(new Uint8Array(32).fill(1))), lastValidBlockHeight: slot + 150n,
        slippageBps: o.maxSlippageBps, priorityFeeLamports: lamports(o.priorityFee),
        choice: { feeRecipient: c % 8, buybackRecipient: (c >>> 3) % 8, tipAccount: c % HELIUS_SENDER_TIP_ACCOUNTS.length },
        rates: chain.rates, existing: new Set(), lookupTables: [], quotedAtSlot: slot,
      },
    };
    const r = await o.simulator.simulate(req);
    o.record({ ...r.record, credits: r.record.credits + 1 });
    if (r.read === null) return false;
    ingest(r.read);
    return true;
  };
};
