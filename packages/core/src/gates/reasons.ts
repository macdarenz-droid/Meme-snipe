// Typed reasons for the journal. Every reject names its gate, a code, the input it read and the values compared,
// so a decision can be rebuilt and counted without parsing text (docs/ARCHITECTURE.md §7, §6.3).

export const HARD_GATES = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'H7', 'H8', 'H9', 'H10', 'H11', 'H12', 'H13', 'H14', 'H15', 'H16'] as const;
export type HardGate = (typeof HARD_GATES)[number];

/** The facts the gates read, by name. Keys in the as-of store are built from these (facts.ts). */
export type FactName =
  | 'mint' | 'pool' | 'lp' | 'curve' | 'create' | 'migration' | 'candles' | 'holders' | 'insiders' | 'deployer'
  | 'stream' | 'coverage' | 'sim' | 'xcheck' | 'soft' | 'sol-usd' | 'curve-volume' | 'graduates' | 'exec-health';

/** Why an input could not be used. Each one rejects (H16): unknown, stale or degraded evidence means no trade. */
export type EvidenceCode =
  /** No value as of now. */
  | 'missing'
  /** The value is not in the expected shape. */
  | 'malformed'
  /** Dated after the decision moment. */
  | 'future'
  /** Older than the policy allows (2 slots for chain state, 2 s for off-chain reads). */
  | 'stale'
  /** Carries a quality flag that makes it unusable (fork-suspect, provider-degraded, partial, estimated, rate-limited). */
  | 'degraded'
  /** The stream that keeps the value current had a gap since the value was observed. */
  | 'gap'
  /** The source does not cover the window the rule needs (for example a deployer index younger than the look-back). */
  | 'not-covered'
  /** Two inputs that must agree do not (for example the LP mint in the pool and in the LP read). */
  | 'inconsistent';

export type RejectCode =
  | EvidenceCode
  | 'mint-program' | 'mint-authority' | 'freeze-authority' | 'extension-blocked'
  | 'venue' | 'pool-owner' | 'not-canonical' | 'mayhem' | 'quote-mint'
  | 'lp-withdrawable' | 'curve-stuck'
  | 'dust-at-migration' | 'below-liquidity-floor'
  | 'instant-graduation' | 'excluded-window' | 'chase-at-5m' | 'candle-spike'
  | 'hard-holder' | 'dev-holder' | 'single-holder' | 'top10' | 'no-circulating'
  | 'insider-supply' | 'dev-cluster'
  | 'serial-deployer' | 'prior-rug'
  | 'round-trip-failed' | 'sim-failed' | 'sim-loss'
  | 'xcheck-disagree'
  | 'policy-session-ended' | 'bad-request';

export interface GateReason {
  readonly gate: HardGate;
  readonly code: RejectCode;
  readonly detail: string;
  /** The fact the reason is about. */
  readonly input?: FactName;
  /** For evidence reasons (gate H16): the hard reject that needed the input. */
  readonly neededBy?: HardGate;
  /** The measured value and the limit it was compared with, as decimal strings. */
  readonly value?: string;
  readonly limit?: string;
}

/** A note that does not reject but belongs in the journal (an unknown program account kept as a holder, a veto not applied). */
export interface GateNote {
  readonly gate: HardGate;
  readonly code: 'live-only-not-applied' | 'unknown-program-holder' | 'locker-holder' | 'rug-labels-unavailable';
  readonly detail: string;
}
