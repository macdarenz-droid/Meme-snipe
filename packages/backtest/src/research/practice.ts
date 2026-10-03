// The holdout wall for signal research (RES-3, docs/research/signals.md §1). Research reads practice days only: every
// decision day on or after the wall (the embargo day before the holdout, and the holdout itself) is refused before a
// file is opened, and any row at or after the wall that still reaches the analysis throws.
import { readFileSync } from 'node:fs';
import type { ManifestDay } from '../dataset/dataset.ts';
import type { DatasetRow } from '../dataset/rows.ts';

export interface PracticeWindow {
  /** First and last decision day of the whole window (UTC days, "YYYY-MM-DD"). */
  readonly decisionFrom: string;
  readonly decisionTo: string;
  /** First holdout day (from BT-2 and the STATS-1 registry). */
  readonly holdoutFrom: string;
  /** Whole days left out between the practice days and the holdout. */
  readonly embargoDays: number;
  /** Who confirmed the boundary (BT-2 session or registry commit), or null while the conservative default holds. */
  readonly confirmedBy: string | null;
  /** Platform regimes (UPG-1b): each starts on its UTC day and lasts until the next. Days before the first are 'pre'. */
  readonly regimes?: readonly { readonly label: string; readonly from: string }[];
}

/** The regime a day belongs to: the last regime starting on or before it. */
export const regimeOf = (w: PracticeWindow, day: string): string => {
  let label = 'pre';
  for (const r of [...(w.regimes ?? [])].sort((a, b) => (a.from < b.from ? -1 : 1))) if (r.from <= day) label = r.label;
  return label;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

export const dayMs = (day: string): number => {
  if (!DAY.test(day)) throw new RangeError(`not a YYYY-MM-DD day: ${day}`);
  const ms = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(ms)) throw new RangeError(`not a calendar day: ${day}`);
  return ms;
};
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => dayOf(dayMs(day) + n * DAY_MS);

export class HoldoutWallError extends Error {
  override readonly name = 'HoldoutWallError';
}

export const checkWindow = (w: PracticeWindow): PracticeWindow => {
  for (const d of [w.decisionFrom, w.decisionTo, w.holdoutFrom]) dayMs(d);
  if (!Number.isInteger(w.embargoDays) || w.embargoDays < 1) throw new RangeError('embargoDays must be an integer >= 1');
  if (!(w.decisionFrom < w.holdoutFrom && w.holdoutFrom <= w.decisionTo)) throw new RangeError('holdoutFrom must fall inside the decision window, after its first day');
  if (wallDay(w) <= w.decisionFrom) throw new RangeError('the wall leaves no practice day');
  return w;
};

export const loadWindow = (path: string): PracticeWindow => {
  const j = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const str = (k: string): string => {
    const v = j[k];
    if (typeof v !== 'string') throw new RangeError(`${path}: ${k} must be a string`);
    return v;
  };
  const c = j['confirmedBy'];
  return checkWindow({
    decisionFrom: str('decisionFrom'), decisionTo: str('decisionTo'), holdoutFrom: str('holdoutFrom'),
    embargoDays: j['embargoDays'] as number, confirmedBy: typeof c === 'string' ? c : null,
    ...(Array.isArray(j['regimes']) ? { regimes: (j['regimes'] as { label: string; from: string }[]).map((r) => ({ label: String(r.label), from: (dayMs(String(r.from)), String(r.from)) })) } : {}),
  });
};

/** The first day research may never read: the first embargo day. */
export const wallDay = (w: PracticeWindow): string => addDays(w.holdoutFrom, -w.embargoDays);
export const wallMs = (w: PracticeWindow): number => dayMs(wallDay(w));

/** A decision day of the practice set. */
export const isPracticeDay = (w: PracticeWindow, day: string): boolean => day >= w.decisionFrom && day < wallDay(w);

/** Throws for any day at or after the wall. Lead-in days before the window are history and may be read. */
export const assertReadable = (w: PracticeWindow, day: string): void => {
  dayMs(day);
  if (day >= wallDay(w)) throw new HoldoutWallError(`day ${day} is at or after the holdout wall ${wallDay(w)}: research never reads it`);
};

/** The manifest days research may load (lead-in and practice days), in order. Holdout and embargo days are dropped unread. */
export const readableDays = (w: PracticeWindow, days: readonly ManifestDay[]): ManifestDay[] =>
  days.filter((d) => d.day < wallDay(w)).sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));

/** Passes rows through and throws on the first row whose block time is at or after the wall. */
export function* guardRows(w: PracticeWindow, rows: Iterable<DatasetRow>): Generator<DatasetRow> {
  const wall = wallMs(w);
  for (const r of rows) {
    if (r.blockTime * 1000 >= wall) throw new HoldoutWallError(`row at ${new Date(r.blockTime * 1000).toISOString()} (slot ${r.slot}) is at or after the holdout wall ${wallDay(w)}`);
    yield r;
  }
}
