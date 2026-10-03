// The study's pre-registered configurations (docs/ARCHITECTURE.md §3.2, §13.1, §14): one per universe, fixed and
// written down before any data was looked at, each identified by the hash of its whole content. The holdout accepts
// exactly these; changing any value is a new configuration, a new trial in the registry, and needs a new window.
//
// U3 (smart-money confluence) does not enter: RES-2 found it not usable (about −11% a trade, 0 of 120 variants
// positive; docs/DECISIONS.md). The Holm family is U1 and U2.
import { createHash } from 'node:crypto';
import { canonical } from '../../../core/src/engine/index.ts';
import type { CheckWindow } from '../sim/facts.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** U2, post-graduation reclaim (§3.2): flush, higher low, reclaim of the volume-weighted price, positive net flow. */
export interface U2Rules {
  readonly kind: 'U2';
  /** The lowest price since migration is at least this far below the migration price. */
  readonly flushBps: number;
  /** The low of the last `recentMs` is above that flush low by at least this, and the flush low is older than `recentMs`. */
  readonly higherLowBps: number;
  readonly recentMs: number;
  /** Net SOL flow from wallets other than the deployer over `recentMs` is above zero; the price is above the VWAP since migration. */
  /** The stop sits this far below the recent low (structure stop). */
  readonly stopBelowLowBps: number;
}

/** U1, survivors (§3.2): range breakout with volume and holder growth, on pools of size. */
export interface U1Rules {
  readonly kind: 'U1';
  /** The range is the high of the bars from `rangeMs` ago until `recentMs` ago; the price now is above it. */
  readonly rangeMs: number;
  readonly recentMs: number;
  /** SOL traded in the last `recentMs` is at least this many tenths of the range's average per `recentMs`. */
  readonly volumeTenths: number;
  /** Wallet holders (excluded accounts left out) grew by at least this since `rangeMs` ago. */
  readonly holderGrowthBps: number;
  /** Market cap at the spot price, lamports (§3.2: >= 1,470 SOL). */
  readonly minMarketCapLamports: bigint;
  /** The stop sits this far below the low of the last `stopLowMs`. */
  readonly stopLowMs: number;
  readonly stopBelowLowBps: number;
}

export interface UniverseConfig {
  readonly universe: 'U1' | 'U2';
  readonly window: CheckWindow;
  readonly rules: U1Rules | U2Rules;
  /** §5.2 conservative gross edge used by sizing (ppm of notional): the smallest edge worth trading (§14: +5%). */
  readonly edgePpm: bigint;
  /** R14: the strategy's median target, bps. */
  readonly medianTargetBps: number;
}

export interface StudyConfig {
  readonly version: string;
  readonly universes: readonly UniverseConfig[];
  /** Least accepted entry output below the local quote (§10). */
  readonly entryMinOutBelowBps: number;
  /** Bars kept per pool: the first after migration and a rolling tail. */
  readonly headBars: number;
  readonly tailBars: number;
  /** Walk-forward: folds and the embargo after each boundary (at least the longest hold, §13.2). */
  readonly folds: number;
  readonly embargoMs: number;
  /** Holdout: the last this many decision days, after the embargo. */
  readonly holdoutDays: number;
  /** S0 seeds for G1 (walk-forward) and G2 (holdout, §14: >= 200). */
  readonly s0SeedsWalkForward: number;
  readonly s0SeedsHoldout: number;
}

const VALUES: StudyConfig = {
  version: 'study-1',
  universes: [
    {
      universe: 'U1',
      window: { universe: 'U1', fromMs: DAY, toMs: 14 * DAY, everyMs: 5 * MIN, minQuoteLamports: 100_000_000_000n },
      rules: {
        kind: 'U1', rangeMs: 6 * HOUR, recentMs: 15 * MIN, volumeTenths: 20, holderGrowthBps: 500,
        minMarketCapLamports: 1_470_000_000_000n, stopLowMs: 60 * MIN, stopBelowLowBps: 100,
      },
      edgePpm: 50_000n,
      medianTargetBps: 2_000,
    },
    {
      universe: 'U2',
      window: { universe: 'U2', fromMs: 60 * MIN, toMs: 240 * MIN, everyMs: MIN, minQuoteLamports: 0n },
      rules: { kind: 'U2', flushBps: 3_000, higherLowBps: 500, recentMs: 15 * MIN, stopBelowLowBps: 100 },
      edgePpm: 50_000n,
      medianTargetBps: 3_000,
    },
  ],
  entryMinOutBelowBps: 300,
  headBars: 300,
  tailBars: 7 * 60,
  folds: 4,
  embargoMs: 2 * HOUR,
  holdoutDays: 10,
  s0SeedsWalkForward: 20,
  s0SeedsHoldout: 200,
};

const freeze = <T>(v: T): T => {
  if (typeof v === 'object' && v !== null) {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
};

export const STUDY_CONFIG: StudyConfig = freeze(structuredClone(VALUES));

/** The configuration id of a universe: sha256 of its canonical content and the shared study values. */
export const configId = (c: StudyConfig, universe: string): string => {
  const u = c.universes.find((x) => x.universe === universe);
  if (u === undefined) throw new RangeError(`no configuration for ${universe}`);
  const { universes: _, ...shared } = c;
  return `${universe}-${createHash('sha256').update(canonical({ shared, universe: u })).digest('hex').slice(0, 16)}`;
};

/** The study's hash, recorded with every report. */
export const studyHash = (c: StudyConfig): string => createHash('sha256').update(canonical(c)).digest('hex');
