// The study's pre-registered configurations (docs/ARCHITECTURE.md §3.2, §13.1, §14): one per universe, fixed and
// written down before any data was looked at, each identified by the hash of its whole content. The holdout accepts
// exactly these; changing any value is a new configuration, a new trial in the registry, and needs a new window.
//
// U3 (smart-money confluence) does not enter: RES-2 found it not usable (about −11% a trade, 0 of 120 variants
// positive; docs/DECISIONS.md). The Holm family is U1 and U2.
import { createHash } from 'node:crypto';
import { canonical } from '../../../core/src/engine/index.ts';
import type { FeatureId } from '../research/tracker.ts';
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

/**
 * A feature rule (RES-3's handoff, RES-4's pre-registered hypotheses): conditions `feature >= t` / `feature <= t`, all of
 * them required (RES-4 registers five or six), over the
 * as-of tracker features (src/research/tracker.ts), mapped one to one. Thresholds are kept as the exact decimal text
 * handed over, so the configuration hash never depends on float formatting. A feature that is unknown at the check
 * fails the condition. The stop is a fixed distance below the entry spot (the handed-over barrier's stop loss).
 */
export interface FeatureRules {
  readonly kind: 'features';
  readonly conds: readonly { readonly f: FeatureId; readonly dir: 'ge' | 'le'; readonly t: string }[];
  readonly stopBelowBps: number;
}

export interface UniverseConfig {
  /**
   * The hypothesis id (RES-4: `H4-U2-reclaim`), when several configurations share a universe: it tags the positions,
   * the funnel, the trial and the configuration id. Absent, the universe is the tag.
   */
  readonly id?: string;
  readonly universe: 'U1' | 'U2';
  readonly window: CheckWindow;
  readonly rules: U1Rules | U2Rules | FeatureRules;
  /** §5.2 conservative gross edge used by sizing (ppm of notional): the smallest edge worth trading (§14: +5%). */
  readonly edgePpm: bigint;
  /** R14: the strategy's median target, bps. */
  readonly medianTargetBps: number;
}

/** A regime boundary (docs/ARCHITECTURE.md §6.5): results are reported per regime, never pooled silently. */
export interface RegimeBoundary {
  readonly label: string;
  readonly atMs: number;
  readonly what: string;
  /** A market boundary (B2–B4) splits regimes; a decoder boundary (B5) only adds a per-regime reporting line. */
  readonly market: boolean;
}

export interface StudyConfig {
  readonly version: string;
  /**
   * True once the configurations are frozen for the holdout (RES-3's proposals, recorded in DECISIONS). Until then the
   * study runs the walk-forward only: no holdout is registered or run, so a placeholder can never enter it.
   */
  readonly frozen: boolean;
  /**
   * The decision window, fixed in advance (§6.5): practice days are its days before `holdout.fromDay`, whatever data
   * has been downloaded, so a partial download can never move the holdout onto days already looked at.
   */
  readonly window: { readonly decisionFrom: string; readonly decisionTo: string; readonly leadInDays: number };
  readonly regimes: readonly RegimeBoundary[];
  /** The holdout lies entirely after this boundary (supervisor, 2026-10-04: B4). */
  readonly holdoutAfter: string;
  readonly universes: readonly UniverseConfig[];
  /** Least accepted entry output below the local quote (§10). */
  readonly entryMinOutBelowBps: number;
  /** Bars kept per pool: the first after migration and a rolling tail. */
  readonly headBars: number;
  readonly tailBars: number;
  /** Walk-forward: folds and the embargo after each boundary (at least the longest hold, §13.2). */
  readonly folds: number;
  readonly embargoMs: number;
  /**
   * The sealed holdout (consensus of the three reviews, 2026-10-04): from `fromDay` (entries after the embargo) to the
   * fixed UTC entry cutoff E, registered before any count is known, then `tailDays` of observation only so every hold
   * finishes. One endpoint for every universe; opened once, after a G1 pass, and mandatory once the counts are met.
   */
  readonly holdout: { readonly fromDay: string; readonly entryCutoff: string; readonly tailDays: number };
  /** Which holdout attempt this configuration registers (1 for the first window); its family α comes from the holdout registry (src/holdout.ts `attemptAlpha`). */
  readonly holdoutAttempt: number;
  /** Salt of the hash that breaks true ties between simultaneous signals, fixed before any replay. */
  readonly tieSalt: string;
  /**
   * RES-4's pre-registered family: its file (repository-relative) and the sha256 it is bound by; null until the family
   * is merged and pinned. The study reads only a file with this hash.
   */
  readonly preregistration: { readonly path: string; readonly sha256: string | null };
  /** S0 seeds for G1 (walk-forward) and G2 (holdout, §14: >= 200). */
  readonly s0SeedsWalkForward: number;
  readonly s0SeedsHoldout: number;
}

const VALUES: StudyConfig = {
  version: 'study-1',
  // The U1/U2 rules below are placeholders written before any data; RES-3 proposes the configurations to freeze.
  frozen: false,
  window: { decisionFrom: '2026-08-03', decisionTo: '2026-10-01', leadInDays: 14 },
  regimes: [
    { label: 'B2', atMs: Date.parse('2026-07-21T14:23:00Z'), what: 'BOOST on', market: true },
    { label: 'B3', atMs: Date.parse('2026-09-09T19:30:00Z'), what: 'fee and creator-fee configuration changed', market: true },
    { label: 'B4', atMs: Date.parse('2026-09-12T15:24:00Z'), what: 'holder rewards; trade events grew 16 bytes', market: true },
    { label: 'B5', atMs: Date.parse('2026-10-02T15:47:00Z'), what: 'unpublished upgrade with an 8-byte event tail (decoder boundary: SOL-market fields, quotes, fees and rent unchanged, UPG-1)', market: false },
  ],
  holdoutAfter: 'B4',
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
  holdout: { fromDay: '2026-09-22', entryCutoff: '2026-10-20T00:00:00Z', tailDays: 1 },
  holdoutAttempt: 1,
  tieSalt: 'study-1-ties-2026-10-04',
  preregistration: { path: 'research/edge/preregistration.json', sha256: null },
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
/** A configuration's tag: its hypothesis id, else its universe. */
export const configTag = (u: UniverseConfig): string => u.id ?? u.universe;

/** The configuration id of the configuration tagged `tag` (its hypothesis id, else its universe). */
export const configId = (c: StudyConfig, tag: string): string => {
  const u = c.universes.find((x) => configTag(x) === tag);
  if (u === undefined) throw new RangeError(`no configuration for ${tag}`);
  const { universes: _, ...shared } = c;
  return `${tag}-${createHash('sha256').update(canonical({ shared, universe: u })).digest('hex').slice(0, 16)}`;
};

/** The study's hash, recorded with every report. */
export const studyHash = (c: StudyConfig): string => createHash('sha256').update(canonical(c)).digest('hex');

