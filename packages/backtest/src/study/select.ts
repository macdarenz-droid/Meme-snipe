// RES-4's family on the practice days (supervisor ruling): one joint SPA test (STATS-1c) over every pre-registered
// hypothesis, each against zero and against its own universe's S0, on one calendar of daily net P&L from the
// capacity-constrained deployment replay. The SPA family is all hypotheses (k = 6); the Holm family of the holdout stays
// the two universes. The pick, fixed before any data (01FHfb): per universe, among the hypotheses that pass and can
// fill the holdout, the highest min(zVsZero, zVsS0), ties broken by file order; none, that universe gets no holdout
// configuration (p = 1 in Holm, "not proven").
import { createRng, SPA_MIN_ACTIVE_DAYS, SPA_STUDENTISATION, type SpaResult, spaTest } from '../../../core/src/stats/index.ts';
import { type HoldoutPlan, LATER_ATTEMPT_ENTRY_DAYS } from '../holdout.ts';
import type { ClusteredReturn, DayReturn } from '../../../core/src/stats/index.ts';
import { powerOf } from './gates.ts';
import { HOLDOUT_FAMILY_SIZE } from './plan.ts';
import type { SpaVariant } from './spa.ts';

export interface SpaSettings {
  /** Floor on every ω, in daily P&L as a share of the capital base (frozen in the registered plan). */
  readonly seFloor: number;
  readonly replicates: number;
  readonly alpha: number;
}

export interface Selection {
  /** Per universe: the picked hypothesis's tag, or null. */
  readonly byUniverse: Readonly<Record<string, string | null>>;
  readonly why: Readonly<Record<string, string>>;
  readonly spa: SpaResult | null;
}

/** A hypothesis's practice entries per calendar day, and the holdout requirement it would freeze (null: cannot be sized). */
export interface Capacity {
  readonly entriesPerDay: number;
  readonly required: number | null;
}

/**
 * The SPA settings the selection uses (01FHfb): a stored plan's, frozen with it; a stored plan without them gives none
 * (no selection). Without a stored plan only a diagnostic run (which registers nothing) uses the configuration.
 */
export const spaSettingsOf = (plan: HoldoutPlan | null | undefined, diagnostic: boolean, config: SpaSettings): SpaSettings | null => {
  if (plan !== null && plan !== undefined) return plan.spa === undefined ? null : { seFloor: plan.spa.seFloorOfBase, replicates: plan.spa.replicates, alpha: plan.spa.alpha };
  return diagnostic ? config : null;
};

/**
 * One hypothesis's capacity for the fill filter (01FHfb): its practice entries per calendar day (every day of the
 * calendar, active or not) and the requirement it would freeze, sized over the Holm family of 2 at the attempt's α.
 */
export const capacityOf = (
  trades: readonly ClusteredReturn[], control: readonly DayReturn[], calendarDays: number, alpha: number, seed: number, power: typeof powerOf = powerOf,
): Capacity => {
  if (!(calendarDays > 0)) throw new RangeError('the practice calendar has no days');
  const p = power(trades, control, HOLDOUT_FAMILY_SIZE, seed, alpha);
  return { entriesPerDay: trades.length / calendarDays, required: p.ok ? p.required : null };
};

/** Entry days of a holdout attempt: a hypothesis must be able to fill its requirement in them (01FHfb). */
export const HOLDOUT_ENTRY_DAYS = LATER_ATTEMPT_ENTRY_DAYS;

/**
 * The pick per universe from an SPA result (01FHfb's binding rule, 2026-10-04). Among the hypotheses of the universe
 * that pass, any whose practice entries per day × 28 fall short of the holdout requirement it would freeze
 * (max(300, n_power, closed form) at the plan's α; none when it cannot be sized) is dropped first; the rest rank by
 * min(zVsZero, zVsS0), ties by file order. A universe without a pick is "no configuration": p = 1 in Holm.
 */
export const pickOf = (spa: SpaResult, order: readonly string[], universeOf: Readonly<Record<string, string>>, capacity: Readonly<Record<string, Capacity>>): { byUniverse: Record<string, string | null>; why: Record<string, string> } => {
  const universes = [...new Set(order.map((t) => universeOf[t]!))];
  const fills = (id: string) => {
    const c = capacity[id];
    return c !== undefined && c.required !== null && c.entriesPerDay * HOLDOUT_ENTRY_DAYS >= c.required;
  };
  const z = (v: SpaResult['variants'][number]) => Math.min(v.zVsZero, v.zVsS0);
  const byUniverse: Record<string, string | null> = {};
  const why: Record<string, string> = {};
  for (const u of universes) {
    const passed = spa.variants.filter((v) => v.passed && universeOf[v.id] === u);
    const ranked = passed.filter((v) => fills(v.id)).sort((a, b) => z(b) - z(a) || order.indexOf(a.id) - order.indexOf(b.id));
    const short = passed.filter((v) => !fills(v.id)).map((v) => `${v.id} (${capacity[v.id] === undefined ? 'no entry count' : `${capacity[v.id]!.entriesPerDay.toFixed(2)} a day x ${HOLDOUT_ENTRY_DAYS} vs ${capacity[v.id]!.required ?? 'no requirement'}`})`);
    byUniverse[u] = ranked[0]?.id ?? null;
    why[u] = ranked[0] !== undefined
      ? `picked by the SPA step-down (min z ${z(ranked[0]).toFixed(3)}: vs zero ${ranked[0].zVsZero.toFixed(3)}, vs S0 ${ranked[0].zVsS0.toFixed(3)})${short.length > 0 ? `; dropped, cannot fill the holdout: ${short.join(', ')}` : ''}`
      : passed.length > 0 ? `the ${u} hypotheses that pass cannot fill the holdout: ${short.join(', ')}`
        : `no ${u} hypothesis passes the SPA test against zero and S0 (global p ${spa.pValue.toFixed(4)})`;
  }
  return { byUniverse, why };
};

export const selectHypotheses = (
  variants: readonly SpaVariant[], order: readonly string[], universeOf: Readonly<Record<string, string>>, s0Daily: Readonly<Record<string, readonly number[]>>,
  settings: SpaSettings, regimes: readonly { readonly from: number; readonly to: number }[], seed: number, capacity: Readonly<Record<string, Capacity>> = {},
): Selection => {
  const universes = [...new Set(order.map((t) => universeOf[t]!))];
  const none = (why: string): Selection => ({ byUniverse: Object.fromEntries(universes.map((u) => [u, null])), why: Object.fromEntries(universes.map((u) => [u, why])), spa: null });
  const T = variants[0]?.daily.length ?? 0;
  if (T < SPA_MIN_ACTIVE_DAYS) return none(`${T} practice days on the calendar: the SPA test needs at least ${SPA_MIN_ACTIVE_DAYS}`);
  // s0Of is required (01FHfb): every hypothesis against its own universe's S0, never another universe's.
  const missing = universes.filter((u) => s0Daily[u] === undefined);
  if (missing.length > 0) return none(`no S0 series for ${missing.join(', ')}: every hypothesis needs its own universe's S0`);
  const spa = spaTest({
    variants: Object.fromEntries(variants.map((v) => [v.variant, v.daily])), s0: s0Daily[universes[0]!]!,
    s0Of: Object.fromEntries(variants.map((v) => [v.variant, s0Daily[universeOf[v.variant]!]!])),
    activeDays: Object.fromEntries(variants.map((v) => [v.variant, v.activeDays])),
    registration: { seFloor: settings.seFloor, studentisation: SPA_STUDENTISATION, ...(regimes.length > 0 ? { regimes } : {}) },
  }, { rng: createRng(seed), replicates: settings.replicates, alpha: settings.alpha });
  const { byUniverse, why } = pickOf(spa, order, universeOf, capacity);
  return { byUniverse, why, spa };
};
