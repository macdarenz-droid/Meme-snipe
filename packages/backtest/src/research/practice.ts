// The holdout wall for signal research (RES-3, docs/research/signals.md §1). Research reads practice days only: every
// day on or after the wall (the embargo day before the holdout, and the holdout itself) is refused before a file is
// opened, and any row at or after the wall that still reaches the analysis throws.
//
// Day convention: every day here is a Melbourne day (AEST/AEDT), as in the STATS-1 registry and the reports. Dataset
// files are UTC days; a UTC day file is opened only when it ends at or before the wall's instant.
import { readFileSync } from 'node:fs';
import type { HoldoutRegistry } from '../../../core/src/stats/index.ts';
import type { ManifestDay } from '../dataset/dataset.ts';
import type { DatasetRow } from '../dataset/rows.ts';

export interface Regime {
  readonly label: string;
  /** The boundary instant (UPG-1b, ARCHITECTURE.md §6.5), ISO UTC. */
  readonly from: string;
}

export interface PracticeWindow {
  /** First and last decision day of the whole window (Melbourne days, "YYYY-MM-DD"). */
  readonly decisionFrom: string;
  readonly decisionTo: string;
  /** First holdout day (Melbourne), from the STATS-1 registry once BT-2 registers it. */
  readonly holdoutFrom: string;
  /** Whole days left out between the practice days and the holdout. */
  readonly embargoDays: number;
  /** The registry commit or BT-2 note that fixed holdoutFrom, or null while the conservative default holds. */
  readonly confirmedBy: string | null;
  /** Platform regimes in force from each boundary instant. Before the first: 'pre'. */
  readonly regimes?: readonly Regime[];
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HOUR = 3_600_000;
const DAY_MS = 24 * HOUR;

const utcMidnight = (day: string): number => {
  if (!DAY.test(day)) throw new RangeError(`not a YYYY-MM-DD day: ${day}`);
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new RangeError(`not a calendar day: ${day}`);
  return ms;
};

// One formatter for every call: building an Intl.DateTimeFormat costs about 1 ms (measured: 31,000 calls took 33 s).
const MELBOURNE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' });
/** YYYY-MM-DD in Melbourne (AEST/AEDT); the same output as report.ts's melbourneDay. */
export const melbourneDay = (ms: number): string => MELBOURNE.format(ms);

/** The instant a Melbourne day starts (UTC+10 or UTC+11). */
export const melbourneStart = (day: string): number => {
  const utc = utcMidnight(day);
  for (const off of [11, 10]) {
    const ms = utc - off * HOUR;
    if (melbourneDay(ms) === day && melbourneDay(ms - 1) !== day) return ms;
  }
  throw new RangeError(`no Melbourne midnight found for ${day}`);
};
export const addDays = (day: string, n: number): string => new Date(utcMidnight(day) + n * DAY_MS).toISOString().slice(0, 10);

export class HoldoutWallError extends Error {
  override readonly name = 'HoldoutWallError';
}

/** The first Melbourne day research may never read: the first embargo day. */
export const wallDay = (w: PracticeWindow): string => addDays(w.holdoutFrom, -w.embargoDays);
export const wallMs = (w: PracticeWindow): number => melbourneStart(wallDay(w));

export const checkWindow = (w: PracticeWindow): PracticeWindow => {
  for (const d of [w.decisionFrom, w.decisionTo, w.holdoutFrom]) utcMidnight(d);
  if (!Number.isInteger(w.embargoDays) || w.embargoDays < 1) throw new RangeError('embargoDays must be an integer >= 1');
  if (!(w.decisionFrom < w.holdoutFrom && w.holdoutFrom <= w.decisionTo)) throw new RangeError('holdoutFrom must fall inside the decision window, after its first day');
  if (wallDay(w) <= w.decisionFrom) throw new RangeError('the wall leaves no practice day');
  for (const r of w.regimes ?? []) if (!Number.isFinite(Date.parse(r.from)) || typeof r.label !== 'string') throw new RangeError(`bad regime ${JSON.stringify(r)}`);
  return w;
};

export const parseWindow = (j: Record<string, unknown>, what: string): PracticeWindow => {
  const str = (k: string): string => {
    const v = j[k];
    if (typeof v !== 'string') throw new RangeError(`${what}: ${k} must be a string`);
    return v;
  };
  const c = j['confirmedBy'];
  const regimes = Array.isArray(j['regimes']) ? (j['regimes'] as Record<string, unknown>[]).map((r) => ({ label: String(r['label']), from: String(r['from']) })) : undefined;
  return checkWindow({
    decisionFrom: str('decisionFrom'), decisionTo: str('decisionTo'), holdoutFrom: str('holdoutFrom'),
    embargoDays: j['embargoDays'] as number, confirmedBy: typeof c === 'string' ? c : null, ...(regimes === undefined ? {} : { regimes }),
  });
};

export const loadWindow = (path: string): PracticeWindow => parseWindow(JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>, path);

/** A holdout start the wall must agree with: a UTC data day and where it came from. */
export interface HoldoutStart {
  readonly what: string;
  readonly fromDay: string;
}

/** The parts of BT-2's holdout store (`HoldoutStore`, packages/backtest/src/holdout.ts) that fix holdout starts. */
export interface HoldoutStoreStarts {
  readonly plan: { readonly fromDay: string } | null;
  readonly registry: HoldoutRegistry;
}

/**
 * Every holdout start the wall must agree with: the research config's sealed holdout (always), and when BT-2's holdout
 * store exists, its plan's boundary and each registered entry's fromDay. All are UTC data days.
 */
export const holdoutStarts = (config: { readonly fromDay: string }, store: HoldoutStoreStarts | null): HoldoutStart[] => [
  { what: 'the research config (RESEARCH_CONFIG.holdout.fromDay)', fromDay: config.fromDay },
  ...(store?.plan === null || store?.plan === undefined ? [] : [{ what: 'the holdout store plan', fromDay: store.plan.fromDay }]),
  ...(store?.registry.entries ?? []).map((e) => ({ what: `registered holdout ${e.holdoutId}`, fromDay: e.fromDay })),
];

/**
 * The window a run may use: never a wall later than the committed one. The committed window, and a given window with a
 * recorded ruling (confirmedBy), must agree with every holdout start: the wall is the Melbourne day with the date of
 * the holdout's first UTC day, which starts 10–11 h before it (conservative, supervisor). A given window without a
 * ruling may only move the wall earlier.
 */
export const resolveWindow = (committed: PracticeWindow, given: PracticeWindow, starts: readonly HoldoutStart[]): PracticeWindow => {
  if (wallMs(given) > wallMs(committed)) {
    throw new HoldoutWallError(`the given wall ${wallDay(given)} is later than the committed wall ${wallDay(committed)} (research/signals/window.json)`);
  }
  for (const w of given.confirmedBy === null ? [committed] : [committed, given]) {
    for (const e of starts) {
      if (wallDay(w) !== e.fromDay || wallMs(w) > utcMidnight(e.fromDay)) {
        throw new HoldoutWallError(`${e.what} starts on UTC day ${e.fromDay}; the window's wall must be Melbourne day ${e.fromDay} (holdoutFrom ${addDays(e.fromDay, w.embargoDays)}), it is ${wallDay(w)}: they must be equal`);
      }
    }
  }
  return given;
};

/** A decision day (Melbourne) of the practice set. */
export const isPracticeDay = (w: PracticeWindow, day: string): boolean => day >= w.decisionFrom && day < wallDay(w);

/** Throws for any Melbourne day at or after the wall. Lead-in days before the window are history and may be read. */
export const assertReadable = (w: PracticeWindow, day: string): void => {
  utcMidnight(day);
  if (day >= wallDay(w)) throw new HoldoutWallError(`day ${day} is at or after the holdout wall ${wallDay(w)}: research never reads it`);
};

/**
 * The dataset day files (UTC days) research may open, in order: only those that end at or before the wall's instant.
 * Holdout and embargo hours are never in an opened file; a UTC day that straddles the wall is left unread.
 */
export const readableDays = (w: PracticeWindow, days: readonly ManifestDay[]): ManifestDay[] =>
  days.filter((d) => utcMidnight(d.day) + DAY_MS <= wallMs(w)).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

/** Passes rows through and throws on the first row whose block time is at or after the wall. */
export function* guardRows(w: PracticeWindow, rows: Iterable<DatasetRow>): Generator<DatasetRow> {
  const wall = wallMs(w);
  for (const r of rows) {
    if (r.blockTime * 1000 >= wall) throw new HoldoutWallError(`row at ${new Date(r.blockTime * 1000).toISOString()} (slot ${r.slot}) is at or after the holdout wall ${wallDay(w)} (Melbourne)`);
    yield r;
  }
}

/** The regime in force at an instant: the last boundary at or before it. */
export const regimeAt = (w: PracticeWindow, ms: number): string => {
  let label = 'pre';
  let at = -Infinity;
  for (const r of w.regimes ?? []) {
    const t = Date.parse(r.from);
    if (t <= ms && t >= at) {
      label = r.label;
      at = t;
    }
  }
  return label;
};

/**
 * The latest regime of the decision window: the last boundary before the window's last day ends (B4; B5 falls after
 * 2026-10-01 and governs no decision day). Its economics match the holdout's.
 */
export const latestRegime = (w: PracticeWindow): string => regimeAt(w, melbourneStart(addDays(w.decisionTo, 1)) - 1);
