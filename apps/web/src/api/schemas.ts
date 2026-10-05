import { ALERT_CODES, HALT_CODES, REGIME_REASON_CODES, STATUS_FLAGS, WAIVED_PARTS, type Mode } from './contract.ts';
import { arr, bool, day, dec, fail, int, iso, modeIs, nullable, obj, oneOf, optional, re, str, usd, type Check } from './schema.ts';

/**
 * Strict schemas for every worker endpoint, one per contract type in
 * contract.ts. checkEnvelope runs the endpoint's schema on `data` before any
 * screen sees it: a missing mode, unknown field, float money or malformed
 * decimal anywhere rejects the whole response.
 */

export type Endpoint = 'status' | 'funnel' | 'decisions' | 'position' | 'calendar' | 'trades' | 'charts' | 'stats' | 'discovered';

/** A token mint as the worker serves it: base58, 32 to 44 characters. TokenActions builds links only from a mint that passes it. */
export const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MINT = re(MINT_RE, 'a base58 address');
const SIGNATURE = re(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/, 'a base58 signature');
const MONTH = re(/^\d{4}-(0[1-9]|1[0-2])$/, 'a YYYY-MM month');
const VENUE = oneOf('pump-curve', 'pumpswap');
const UNIVERSE = oneOf('U1', 'U2', 'U3');
const GATES = Array.from({ length: 17 }, (_, i) => `H${i + 1}`);
const CHECK = oneOf(...GATES, 'cost', 'size', 'risk', 'regime', 'data', 'other');
const EXIT_RULE = oneOf('price-stop', 'thesis-stop', 'time-stop', 'take-profit', 'trail');
const EXIT_REASON = oneOf('price-stop', 'thesis-stop', 'time-stop', 'take-profit', 'trail', 'liquidity-drop', 'flow-stop', 'owner-close', 'blocked');
const COST_KIND = oneOf('venueFeeUsd', 'creatorFeeUsd', 'priorityFeeUsd', 'tipUsd', 'networkFeeUsd', 'slippageUsd', 'rentKeptUsd');

/** A whole number that may be negative (slippage better than quoted). */
const sint: Check = (v, p) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) fail(p, 'expected a whole number');
};

function build(m: Mode): Record<Endpoint, Check> {
  const mode = modeIs(m);
  const check = obj({ mode, check: CHECK, result: oneOf('pass', 'fail', 'unknown'), value: nullable(str), limit: nullable(str) });
  const costs = obj({
    venueFeeUsd: usd,
    creatorFeeUsd: usd,
    priorityFeeUsd: usd,
    tipUsd: usd,
    networkFeeUsd: usd,
    slippageUsd: usd,
    rentPaidUsd: usd,
    rentReturnedUsd: usd,
    totalUsd: usd,
  });
  return {
    status: obj({
      mode,
      connected: bool,
      flags: arr(oneOf(...STATUS_FLAGS), STATUS_FLAGS.length),
      risk: arr(obj({ mode, kind: oneOf('open-exposure', 'daily-loss', 'weekly-loss', 'session-loss'), usedUsd: usd, limitUsd: nullable(usd) }), 10),
      haltReasons: optional(arr(obj({ mode, code: oneOf(...HALT_CODES), source: nullable(str) }), 50)),
      exitCapable: optional(bool),
      session: optional(obj({
        state: oneOf('running', 'paused', 'ended'), bankrollUsd: usd, entryUsd: usd, maxEntryUsd: usd, maxOpenPositions: int,
        dailyLossLimitUsd: usd, weeklyLossLimitUsd: usd, sessionLossLimitUsd: nullable(usd), startable: bool,
      })),
      alerts: optional(arr(obj({ mode, code: oneOf(...ALERT_CODES), subject: str, at: iso }), 50)),
      regime: optional(nullable(obj({ state: oneOf('on', 'off'), at: iso, current: bool, reasons: arr(obj({ mode, code: oneOf(...REGIME_REASON_CODES), input: nullable(str) }), 20), waived: arr(oneOf(...WAIVED_PARTS), 4) }))),
    }),
    funnel: obj({
      mode,
      from: iso,
      to: iso,
      stages: arr(obj({ mode, stage: oneOf('seen', 'hard-rejects', 'costs', 'risk', 'entered'), count: int }), 10),
      rejects: arr(obj({ mode, check: CHECK, count: int }), 40),
      perDay: arr(obj({ mode, date: day, seen: int, entered: int }), 5000),
    }),
    decisions: arr(
      obj({
        mode,
        id: str,
        at: iso,
        mint: MINT,
        symbol: str,
        venue: VENUE,
        outcome: oneOf('entered', 'rejected', 'no-trade'),
        checks: arr(check, 40),
        ruleScore: nullable(dec),
        reasons: arr(str, 40),
        tradeId: nullable(str),
      }),
    ),
    position: nullable(
      obj({
        mode,
        id: str,
        mint: MINT,
        symbol: str,
        venue: VENUE,
        openedAt: iso,
        entryPriceUsd: dec,
        sizeUsd: usd,
        liquidationValueUsd: usd,
        unrealizedUsd: usd,
        costsSoFarUsd: usd,
        // APP-TRADE: optional() so a worker from before them still loads.
        pnlUsd: optional(nullable(usd)),
        markPriceUsd: optional(nullable(dec)),
        markedAt: optional(nullable(iso)),
        exitRules: arr(obj({ mode, rule: EXIT_RULE, trigger: str, state: oneOf('armed', 'triggered') }), 20),
        exit: oneOf('none', 'pending', 'blocked'),
        worker: oneOf('watching', 'exiting', 'reconciling'),
      }),
    ),
    calendar: obj({
      mode,
      month: MONTH,
      timeZone: oneOf('Australia/Melbourne'),
      days: arr(obj({ mode, date: day, netUsd: usd, trades: int, pauses: int, tradeIds: arr(str, 10_000) }), 31),
    }),
    trades: arr(
      obj({
        mode,
        id: str,
        mint: MINT,
        symbol: str,
        venue: VENUE,
        universe: UNIVERSE,
        strategyVersion: str,
        policyVersion: str,
        openedAt: iso,
        closedAt: iso,
        holdSeconds: int,
        entryPriceUsd: dec,
        exitPriceUsd: dec,
        sizeUsd: usd,
        grossUsd: usd,
        costs,
        netUsd: usd,
        netSol: dec,
        tradingUsd: usd,
        solMoveUsd: usd,
        plannedR: nullable(dec),
        realizedR: nullable(dec),
        mfeR: nullable(dec),
        maeR: nullable(dec),
        exitReason: EXIT_REASON,
        reasons: arr(str, 40),
        checks: arr(check, 40),
        fills: arr(
          obj({
            mode,
            side: oneOf('buy', 'sell'),
            at: iso,
            slot: nullable(int),
            signature: nullable(SIGNATURE),
            priceUsd: dec,
            quotedUsd: usd,
            filledUsd: usd,
            slippageBps: sint,
            attempts: int,
          }),
          20,
        ),
      }),
    ),
    charts: obj({
      mode,
      cumulative: arr(obj({ mode, at: iso, cumNetUsd: usd })),
      daily: arr(obj({ mode, date: day, netUsd: usd }), 5000),
      rBuckets: arr(obj({ mode, fromR: dec, toR: dec, count: int }), 100),
      costsDaily: arr(obj({ mode, date: day, totalUsd: usd }), 5000),
      costsByKind: arr(obj({ mode, kind: COST_KIND, amountUsd: usd }), 10),
    }),
    stats: obj({
      mode,
      trades: int,
      requiredTrades: nullable(int),
      netUsd: usd,
      netSol: dec,
      solMoveUsd: usd,
      maxDrawdownUsd: usd,
      winRate: nullable(dec),
      meanNetUsd: nullable(usd),
      meanR: nullable(dec),
      ci95: nullable(obj({ lowUsd: usd, highUsd: usd })),
    }),
    discovered: obj({
      mode,
      tokens: arr(obj({
        mode, mint: MINT, symbol: nullable(str), migratedAt: iso, venue: oneOf('PumpSwap'), liquidityUsd: nullable(usd),
        checks: oneOf('passed', 'failed', 'missing'), checkedAt: nullable(iso),
      }), 200),
    }),
  };
}

const BY_MODE = new Map<Mode, Record<Endpoint, Check>>();

/** The schema for one endpoint's `data` in one mode. */
export function schemaFor(endpoint: Endpoint, m: Mode): Check {
  let s = BY_MODE.get(m);
  if (!s) BY_MODE.set(m, (s = build(m)));
  return s[endpoint];
}
