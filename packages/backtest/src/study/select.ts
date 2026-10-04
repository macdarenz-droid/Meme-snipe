// RES-4's family on the practice days (supervisor ruling): one joint SPA test (STATS-1c) over every pre-registered
// hypothesis, each against zero and against its own universe's S0, on one calendar of daily net P&L from the
// capacity-constrained deployment replay. The SPA family is all hypotheses (k = 6); the Holm family of the holdout stays
// the universes. The pick, fixed before any data: per universe, among the hypotheses that pass, the highest statistic
// against S0, ties broken by file order; none passing, that universe gets no holdout configuration.
import { createRng, SPA_MIN_ACTIVE_DAYS, SPA_STUDENTISATION, type SpaResult, spaTest } from '../../../core/src/stats/index.ts';
import type { SpaVariant } from './spa.ts';

export interface SpaSettings {
  /** Floor on every ω, in daily P&L as a share of the capital base. */
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

export const selectHypotheses = (
  variants: readonly SpaVariant[], order: readonly string[], universeOf: Readonly<Record<string, string>>, s0Daily: Readonly<Record<string, readonly number[]>>,
  settings: SpaSettings, regimes: readonly { readonly from: number; readonly to: number }[], seed: number,
): Selection => {
  const universes = [...new Set(order.map((t) => universeOf[t]!))];
  const none = (why: string): Selection => ({ byUniverse: Object.fromEntries(universes.map((u) => [u, null])), why: Object.fromEntries(universes.map((u) => [u, why])), spa: null });
  const T = variants[0]?.daily.length ?? 0;
  if (T < SPA_MIN_ACTIVE_DAYS) return none(`${T} practice days on the calendar: the SPA test needs at least ${SPA_MIN_ACTIVE_DAYS}`);
  const first = s0Daily[universes[0]!];
  if (first === undefined) return none('no S0 series');
  const spa = spaTest({
    variants: Object.fromEntries(variants.map((v) => [v.variant, v.daily])), s0: first,
    s0Of: Object.fromEntries(variants.map((v) => [v.variant, s0Daily[universeOf[v.variant]!] ?? first])),
    activeDays: Object.fromEntries(variants.map((v) => [v.variant, v.activeDays])),
    registration: { seFloor: settings.seFloor, studentisation: SPA_STUDENTISATION, ...(regimes.length > 0 ? { regimes } : {}) },
  }, { rng: createRng(seed), replicates: settings.replicates, alpha: settings.alpha });
  const byUniverse: Record<string, string | null> = {};
  const why: Record<string, string> = {};
  for (const u of universes) {
    const passing = spa.variants.filter((v) => v.passed && universeOf[v.id] === u)
      .sort((a, b) => b.zVsS0 - a.zVsS0 || order.indexOf(a.id) - order.indexOf(b.id));
    byUniverse[u] = passing[0]?.id ?? null;
    why[u] = passing[0] === undefined ? `no ${u} hypothesis passes the SPA test against zero and S0 (global p ${spa.pValue.toFixed(4)})` : `picked by the SPA step-down (z vs S0 ${passing[0].zVsS0.toFixed(3)})`;
  }
  return { byUniverse, why, spa };
};
