// Regime chain volume, live (FACTS-1d, §6.4): DATA-1c publishes each UTC day as release `data-volume-DAY` with
// `volume-hours-DAY.csv` and `volume-check-DAY.json`. The reader ingests the CSV's rows (core `parseVolumeHoursCsv`,
// shared with the backtest) as `read:chain-volume-hour`, so core's `dailyChainVolume` and the regime read one series in
// both. A day whose release is missing, whose check did not pass, or whose CSV is malformed ingests nothing: unknown.
import { DAY_MS } from '../../../core/src/config/time.ts';

/** The `YYYY-MM-DD` name of a UTC day number. */
export const dayName = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** The UTC day number of a `YYYY-MM-DD` name, or null when it is not a real date. */
export const dayNumber = (name: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return null;
  const ms = Date.parse(`${name}T00:00:00Z`);
  return Number.isFinite(ms) && dayName(ms / DAY_MS) === name ? ms / DAY_MS : null;
};

export const volumeRelease = (day: string): string => `data-volume-${day}`;
export const volumeHoursAsset = (day: string): string => `volume-hours-${day}.csv`;
export const volumeCheckAsset = (day: string): string => `volume-check-${day}.json`;

/** True only for DATA-1c's passing cross-check: an object whose `mismatches` and `problems` are both empty arrays. */
export const volumeCheckPassed = (text: string): boolean => {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return false;
  }
  if (v === null) return false;
  const o = v as Record<string, unknown>;
  return Array.isArray(o['mismatches']) && o['mismatches'].length === 0 && Array.isArray(o['problems']) && o['problems'].length === 0;
};
