// G0, G1 and G2 for the study (docs/ARCHITECTURE.md §14), from STATS-1's pure gate functions. Inputs come from the
// scoring stage only; nothing here runs the engine.
import {
  type ClusteredReturn, createRng, G2_DEFAULTS, gateG0, gateG1, gateG2, nPower, sd, type DayReturn, type G0Input, type G2PowerResult, type GateResult, type HoldoutRegistry, MIN_DAYS,
  sharpeRatio, simulateG2Power, type TradeOutcome, type TrialRecord,
} from '../../../core/src/stats/index.ts';

export interface G1Universe {
  readonly universe: string;
  readonly configId: string;
  readonly trades: readonly TradeOutcome[];
  readonly control: readonly DayReturn[];
}

/** Every trial's per-day mean return over the same days (0 on a day without trades), for PBO. */
export const pboMatrix = (byTrial: Readonly<Record<string, readonly DayReturn[]>>, days: readonly string[]): Record<string, number[]> =>
  Object.fromEntries(Object.entries(byTrial).map(([id, ts]) => [id, days.map((d) => {
    const xs = ts.filter((t) => t.day === d).map((t) => t.rNet);
    return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  })]));

export const trialOf = (configId: string, trades: readonly DayReturn[]): TrialRecord => {
  const s = trades.length >= 2 ? sharpeRatio(trades.map((t) => t.rNet)) : Number.NaN;
  return { trialId: configId, sharpe: Number.isFinite(s) ? s : 0, nTrades: trades.length };
};

/**
 * G1 for one universe. `holdoutRegistry` is the registry as read from the holdout store (readHoldoutStore), never a
 * constructed object: its stored G1 test decides which multiple-testing check gates (STATS-1f).
 */
export const g1 = (u: G1Universe, registry: readonly TrialRecord[], matrix: Readonly<Record<string, readonly number[]>>, seed: number, registeredBeforeHoldout: boolean, holdoutRegistry: HoldoutRegistry): GateResult =>
  gateG1({
    scenario: 'conservative', rulesRegisteredBeforeHoldout: registeredBeforeHoldout, trades: u.trades, control: u.control, selectedTrialId: u.configId,
    registry, pboMatrix: matrix, modelUsed: false, calibrationSlope: null, rng: createRng(seed), holdoutRegistry,
  });

/** G1 not evaluated (a diagnostic run before any registry exists): never a pass. */
export const g1NotEvaluated = (why: string): GateResult => ({ gate: 'G1', passed: false, status: 'not-proven', checks: [{ name: 'G1 test', passed: false, detail: why }], reasons: [why], notes: [], metrics: {} });

export const g0 = (input: G0Input): GateResult => gateG0(input);

/** Bootstrap replicates in each simulated G2: G2's own minimum at the strictest Holm level, ceil(20 / (α/m)). */
export const g2PowerReplicates = (familySize: number, alpha: number): number => Math.ceil(20 / (alpha / familySize));

/** n_power for a universe from its walk-forward, or why it cannot be sized (then the holdout cannot be proven). */
/**
 * The holdout's size requirement at the attempt's family α: max(300, n_power simulated at α/m, closed form at α/m),
 * exactly what G2 checks with the same α.
 */
export const powerOf = (walkForward: readonly ClusteredReturn[], control: readonly DayReturn[], familySize: number, seed: number, alpha: number): { ok: true; power: G2PowerResult; required: number } | { ok: false; why: string } => {
  const days = new Set(walkForward.map((t) => t.day)).size;
  if (walkForward.length < 2 || days < 2) return { ok: false, why: `walk-forward has ${walkForward.length} trades on ${days} days: too few to size the holdout` };
  if (control.length === 0) return { ok: false, why: 'no S0 trades on the walk-forward days' };
  try {
    // G2 accepts only an n_power simulated with at least 20 / (α/m) bootstrap replicates (STATS-1g's pinned settings).
    const power = simulateG2Power({ walkForward, control, seed, familySize, alpha, replicates: g2PowerReplicates(familySize, alpha) });
    const wf = walkForward.map((t) => t.rNet);
    const closed = sd(wf) > 0 ? nPower(sd(wf), 0.05, { alpha: alpha / familySize }) : 0;
    return { ok: true, power, required: Math.max(G2_DEFAULTS.minTradesFloor, power.nPower, closed) };
  } catch (e) {
    return { ok: false, why: e instanceof Error ? e.message : String(e) };
  }
};

export interface G2Short {
  readonly universe: string;
  readonly holdoutId: string;
  readonly entries: number;
  readonly entryDays: number;
  readonly required: number | null;
  readonly why: string;
}

/**
 * G2 when no universe passes the size check: "not proven yet", from the sealed counts alone. The seals stay closed;
 * nothing is read from the sealed files (§14: if n is short the answer is "not proven yet", n is never lowered).
 */
export const g2NotProven = (shorts: readonly G2Short[]): GateResult => ({
  gate: 'G2', passed: false, status: 'not-proven',
  checks: shorts.map((s) => ({ name: `sample ${s.universe}`, passed: false, detail: `${s.entries} sealed entries on ${s.entryDays} days; need ${s.required ?? 'an n_power that cannot be computed'} on >= ${MIN_DAYS} days (${s.why})` })),
  reasons: shorts.map((s) => `sample ${s.universe}: ${s.entries} sealed entries on ${s.entryDays} days (${s.why})`),
  notes: ['The holdout seals stay closed: the sample is short, so nothing was opened or scored.'],
  metrics: Object.fromEntries(shorts.map((s) => [`entries ${s.universe}`, s.entries])),
});

export { gateG2, type HoldoutRegistry };
