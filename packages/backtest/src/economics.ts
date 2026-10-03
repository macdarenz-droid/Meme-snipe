// What a run's results mean in money, built after the run from its trades (the scoring side; the engine never reads
// this). BT-1c items 5-7:
// - The conditional mean is per filled trade; the all-in figures also carry every failed attempt's fees, and the
//   daily returns for G1/G2 include them on the day they were paid.
// - SOL results (the strategy, in lamports) are reported apart from USD cash flows, which are converted at each
//   flow's own time; the bankroll and the ops reserve, held as SOL, are marked to market over the window.
// - Hosting is its own line, against the bankroll and the trade count, with the net per trade that breaks even.
// AUD figures need an AUD/USD series, which the dataset does not have yet; everything here is USD.
import type { Policy, ResearchConfig } from '../../core/src/config/index.ts';
import type { DayReturn } from '../../core/src/stats/index.ts';
import { type Lamports, microUsdToLamports } from '../../core/src/units/index.ts';
import type { OffchainSeries } from './dataset/offchain.ts';
import { melbourneDay, micro, priceAt, toUsd, tradeInUsd } from './report.ts';
import type { StrayCost, TradeRecord } from './trades.ts';

/** An average month (365.25 / 12 days), ms. */
const MONTH_MS = 2_629_800_000;
const PPM = 1_000_000n;
const HOUR_MS = 3_600_000;

export interface EconomicsInput {
  readonly trades: readonly TradeRecord[];
  readonly stray: readonly StrayCost[];
  /** Entry decisions (entry intents), filled or not: the all-in expectancy's denominator. */
  readonly entryDecisions: number;
  readonly solUsd: OffchainSeries;
  readonly window: { readonly from: number; readonly to: number };
  readonly policy: Policy;
  readonly research: ResearchConfig;
}

export interface Economics {
  readonly filledTrades: number;
  readonly entryDecisions: number;
  /** The strategy in SOL: no exchange rate involved. */
  readonly sol: {
    readonly tradeNetLamports: bigint;
    readonly strayLamports: bigint;
    readonly allInLamports: bigint;
    /** Mean of each filled trade's net over its entry, ppm (null without trades). */
    readonly meanTradeReturnPpm: bigint | null;
  };
  /** USD cash flows, each converted at its own time. */
  readonly usd: {
    readonly tradeNetMicro: bigint;
    readonly strayMicro: bigint;
    readonly allInMicro: bigint;
    readonly conditionalMeanPerTradeMicro: bigint | null;
    readonly allInPerFilledTradeMicro: bigint | null;
    readonly allInPerEntryDecisionMicro: bigint | null;
    /** The all-in result if no rent ever came back (the no-recovery line). */
    readonly allInNoRentRecoveryMicro: bigint;
  };
  /** The bankroll (bought as SOL at the start price) and the ops reserve, revalued at the end price. */
  readonly markToMarket: {
    readonly startPriceMicro: bigint;
    readonly endPriceMicro: bigint;
    readonly bankrollLamports: bigint;
    readonly opsReserveLamports: bigint;
    readonly idleRevaluationMicro: bigint;
  };
  readonly operating: {
    readonly hostingUsdPerMonthMicro: bigint;
    readonly windowDays: number;
    readonly hostingMicro: bigint;
    readonly hostingPerTradeMicro: bigint | null;
    /** Mean net per filled trade that covers hosting and the failed attempts' fees at this trade rate. */
    readonly breakEvenNetPerTradeMicro: bigint | null;
    readonly hostingShareOfBankrollPerMonthBps: number;
    readonly netAfterHostingMicro: bigint;
  };
  /** Every Melbourne day of the window, failed attempts included, as a share of the bankroll. */
  readonly dailyReturns: readonly DayReturn[];
  /**
   * The operating-cost line at each projection bankroll (research config), with the policy's trade sizes kept at their
   * share of the bankroll, and this run's trade count. A projection: per-trade nets at a larger size need a run at it.
   */
  readonly atBankrolls: readonly {
    readonly bankrollMicro: bigint;
    readonly minNotionalMicro: bigint;
    readonly maxNotionalMicro: bigint;
    readonly hostingShareOfBankrollPerMonthBps: number;
    readonly breakEvenNetPerTradeMicro: bigint | null;
    /** Break-even net per trade as a return on the minimum trade size, bps (null without trades). */
    readonly breakEvenBpsOfMinTrade: number | null;
  }[];
}

/** The policy's capital sizes at another bankroll, each kept at its share of the configured bankroll. */
export const sizesAtBankroll = (policy: Policy, bankroll: bigint): { readonly minNotional: bigint; readonly maxNotional: bigint } => {
  const b = policy.capital.bankroll as bigint;
  return { minNotional: ((policy.capital.minNotional as bigint) * bankroll) / b, maxNotional: ((policy.capital.maxNotional as bigint) * bankroll) / b };
};

const per = (total: bigint, n: number): bigint | null => (n === 0 ? null : total / BigInt(n));

export const economics = (i: EconomicsInput): Economics => {
  const n = i.trades.length;
  const tradeUsd = i.trades.map((t) => ({ at: t.closedAt, net: micro(tradeInUsd(t, 'S0', i.solUsd).netUsd) }));
  const strayUsd = i.stray.map((s) => ({ at: s.at, net: -toUsd(s.lamports, priceAt(i.solUsd, s.at)) }));
  const tradeNetMicro = tradeUsd.reduce((a, x) => a + x.net, 0n);
  const strayMicro = strayUsd.reduce((a, x) => a + x.net, 0n);
  const allInMicro = tradeNetMicro + strayMicro;
  const tradeNetLamports = i.trades.reduce((a, t) => a + t.net, 0n);
  const strayLamports = -i.stray.reduce((a, s) => a + s.lamports, 0n);

  const startPx = priceAt(i.solUsd, i.window.from);
  const endPx = priceAt(i.solUsd, i.window.to);
  const bankroll = i.policy.capital.bankroll;
  const bankrollLamports = microUsdToLamports(bankroll, startPx, 'floor');
  const ops = i.policy.reserve.opsFloor as bigint;
  const held = bankrollLamports + ops;

  const windowMs = i.window.to - i.window.from;
  const perMonth = i.research.operating.hostingUsdPerMonth as bigint;
  const hostingMicro = (perMonth * BigInt(windowMs)) / BigInt(MONTH_MS);

  const byDay = new Map<string, bigint>();
  for (let t = i.window.from; t < i.window.to; t += HOUR_MS) byDay.set(melbourneDay(t), 0n);
  byDay.set(melbourneDay(i.window.to - 1), 0n);
  for (const e of [...tradeUsd, ...strayUsd]) {
    const d = melbourneDay(e.at);
    byDay.set(d, (byDay.get(d) ?? 0n) + e.net);
  }

  const breakEven = per(hostingMicro - strayMicro, n);
  const atBankrolls = i.research.operating.projectionBankrolls.map((bk) => {
    const b = bk as bigint;
    const sizes = sizesAtBankroll(i.policy, b);
    return {
      bankrollMicro: b, minNotionalMicro: sizes.minNotional, maxNotionalMicro: sizes.maxNotional,
      hostingShareOfBankrollPerMonthBps: Number((perMonth * 10_000n) / b),
      breakEvenNetPerTradeMicro: breakEven,
      breakEvenBpsOfMinTrade: breakEven === null || sizes.minNotional === 0n ? null : Number((breakEven * 10_000n) / sizes.minNotional),
    };
  });

  return {
    filledTrades: n,
    entryDecisions: i.entryDecisions,
    sol: {
      tradeNetLamports, strayLamports, allInLamports: tradeNetLamports + strayLamports,
      meanTradeReturnPpm: per(i.trades.reduce((a, t) => a + (t.entrySol === 0n ? 0n : (t.net * PPM) / t.entrySol), 0n), n),
    },
    usd: {
      tradeNetMicro, strayMicro, allInMicro,
      conditionalMeanPerTradeMicro: per(tradeNetMicro, n),
      allInPerFilledTradeMicro: per(allInMicro, n),
      allInPerEntryDecisionMicro: per(allInMicro, i.entryDecisions),
      allInNoRentRecoveryMicro: allInMicro - i.trades.reduce((a, t) => a + toUsd(t.rentReturned, priceAt(i.solUsd, t.closedAt)), 0n),
    },
    markToMarket: {
      startPriceMicro: startPx, endPriceMicro: endPx, bankrollLamports, opsReserveLamports: ops,
      idleRevaluationMicro: toUsd(held as Lamports, endPx) - toUsd(held as Lamports, startPx),
    },
    operating: {
      hostingUsdPerMonthMicro: perMonth,
      windowDays: windowMs / 86_400_000,
      hostingMicro,
      hostingPerTradeMicro: per(hostingMicro, n),
      breakEvenNetPerTradeMicro: breakEven,
      hostingShareOfBankrollPerMonthBps: Number((perMonth * 10_000n) / (bankroll as bigint)),
      netAfterHostingMicro: allInMicro - hostingMicro,
    },
    atBankrolls,
    dailyReturns: [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([day, v]) => ({ day, rNet: Number(v) / Number(bankroll) })),
  };
};
