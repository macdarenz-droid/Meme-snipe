// The study's split of the decision days (docs/ARCHITECTURE.md §13.2, §14): walk-forward folds first, then one
// untouched later holdout, an embargo of at least the longest hold between them and after every fold boundary.
// Rules are fixed in advance (strategy/config.ts), so the folds measure how stable the result is over time; a trade
// whose hold crosses a fold's end is purged and the first embargo after each boundary is dropped.
import { DAY_MS } from '../../../core/src/config/index.ts';
import type { DayReturn } from '../../../core/src/stats/index.ts';
import type { StudyConfig } from '../strategy/config.ts';

export interface Fold {
  readonly index: number;
  readonly fromMs: number;
  readonly toMs: number;
  readonly days: readonly string[];
}

export interface StudyPlan {
  readonly decisionDays: readonly string[];
  readonly walkForward: { readonly days: readonly string[]; readonly entriesFrom: number; readonly entriesTo: number; readonly folds: readonly Fold[] };
  readonly holdout: { readonly days: readonly string[]; readonly fromDay: string; readonly toDay: string; readonly entriesFrom: number; readonly entriesTo: number };
}

export const dayStart = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/** Every day of the configured decision window, in order. */
export const windowDays = (c: StudyConfig): string[] => {
  const out: string[] = [];
  for (let t = dayStart(c.window.decisionFrom); t <= dayStart(c.window.decisionTo); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

/**
 * The regime a moment falls in: the label of the last boundary at or before it ('B0' before the first). Market
 * boundaries only by default (B2–B4: purging and G1 regimes); with `all`, decoder boundaries too (B5: reporting lines).
 */
export const regimeOf = (c: StudyConfig, ms: number, all = false): string => {
  let label = 'B0';
  for (const b of c.regimes) if (b.atMs <= ms && (all || b.market)) label = b.label;
  return label;
};

const dayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/**
 * Every day of the sealed holdout: from its first day through the day of the entry cutoff E and the tail days after
 * it (all fixed by configuration, never by what was downloaded). These days are never practice days.
 */
export const holdoutDaysOf = (c: StudyConfig): string[] => {
  const cutoff = Date.parse(c.holdout.entryCutoff);
  const lastEntryDay = dayStart(dayKey(cutoff - 1));
  const out: string[] = [];
  for (let t = dayStart(c.holdout.fromDay); t <= lastEntryDay + c.holdout.tailDays * DAY_MS; t += DAY_MS) out.push(dayKey(t));
  return out;
};

/** Practice days: decision days before the holdout. */
export const practiceDays = (c: StudyConfig): string[] => windowDays(c).filter((d) => d < c.holdout.fromDay);

/**
 * `holdTailMs`: how long before a window's end the last entry may start so every trade can finish inside it
 * (the policy's hard time stop plus a margin). Throws when the days cannot hold the folds and the holdout.
 */
export const studyPlan = (c: StudyConfig, holdTailMs: number): StudyPlan => {
  const days = windowDays(c);
  const wf = practiceDays(c);
  const hold = holdoutDaysOf(c);
  if (wf.length < c.folds) throw new RangeError(`${wf.length} practice days cannot hold ${c.folds} folds`);
  const per = Math.floor(wf.length / c.folds);
  const folds: Fold[] = [];
  for (let k = 0; k < c.folds; k++) {
    const fd = wf.slice(k * per, k === c.folds - 1 ? wf.length : (k + 1) * per);
    folds.push({ index: k, fromMs: dayStart(fd[0]!), toMs: dayStart(fd[fd.length - 1]!) + DAY_MS, days: fd });
  }
  const wfEnd = dayStart(wf[wf.length - 1]!) + DAY_MS;
  const holdStart = dayStart(c.holdout.fromDay);
  const cutoff = Date.parse(c.holdout.entryCutoff);
  const dataEnd = dayStart(hold[hold.length - 1]!) + DAY_MS;
  if (holdStart !== wfEnd) throw new RangeError('the holdout must start the day after the last practice day');
  if (!(cutoff > holdStart + c.embargoMs) || cutoff + holdTailMs > dataEnd) throw new RangeError('the entry cutoff must leave the embargo before it and the hold time before the data ends');
  const after = c.regimes.find((b) => b.label === c.holdoutAfter);
  if (after === undefined) throw new RangeError(`no regime boundary ${c.holdoutAfter}`);
  if (holdStart + c.embargoMs < after.atMs) throw new RangeError(`the holdout must lie entirely after ${after.label} (${new Date(after.atMs).toISOString()})`);
  // A market boundary inside the holdout is refused; a decoder boundary (B5) is reported before and after, not purged.
  const inside = c.regimes.find((b) => b.market && b.atMs > holdStart && b.atMs < dataEnd);
  if (inside !== undefined) throw new RangeError(`market regime boundary ${inside.label} falls inside the holdout`);
  return {
    decisionDays: days,
    walkForward: { days: wf, entriesFrom: dayStart(wf[0]!), entriesTo: wfEnd - holdTailMs, folds },
    // The holdout's first entry waits out the embargo, so no walk-forward trade's hold overlaps it; entries stop at the
    // registered cutoff E and the data runs on through the tail so every hold finishes (an observation-only tail).
    holdout: { days: hold, fromDay: hold[0]!, toDay: hold[hold.length - 1]!, entriesFrom: holdStart + c.embargoMs, entriesTo: cutoff },
  };
};

export interface Timed {
  readonly openedAt: number;
  readonly closedAt: number;
}

/**
 * Walk-forward trades kept for scoring, each with its fold and regime: a trade whose hold crosses its fold's end or
 * a regime boundary is purged, and one opened inside the embargo after a fold boundary (every fold but the first) is
 * dropped.
 */
export const purge = <T extends Timed>(trades: readonly T[], plan: StudyPlan, embargoMs: number, regime: (ms: number) => string = () => ''): { kept: (T & { fold: number; regime: string })[]; purged: number; embargoed: number } => {
  const kept: (T & { fold: number; regime: string })[] = [];
  let purged = 0;
  let embargoed = 0;
  for (const t of trades) {
    const f = plan.walkForward.folds.find((x) => t.openedAt >= x.fromMs && t.openedAt < x.toMs);
    if (f === undefined) {
      purged++;
      continue;
    }
    // A hold that crosses its fold's end, or a regime boundary, belongs to neither side.
    if (t.closedAt >= f.toMs || regime(t.openedAt) !== regime(t.closedAt)) purged++;
    else if (f.index > 0 && t.openedAt < f.fromMs + embargoMs) embargoed++;
    else kept.push({ ...t, fold: f.index, regime: regime(t.openedAt) });
  }
  return { kept, purged, embargoed };
};

/** Per-fold count and mean, for the report. */
export const foldSummary = (trades: readonly (DayReturn & { fold: number })[], folds: readonly Fold[]) =>
  folds.map((f) => {
    const xs = trades.filter((t) => t.fold === f.index).map((t) => t.rNet);
    return { fold: f.index, from: f.days[0]!, to: f.days[f.days.length - 1]!, trades: xs.length, mean: xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length };
  });
