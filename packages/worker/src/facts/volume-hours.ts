// Regime chain volume, live (FACTS-1d, §6.4): DATA-1c publishes `volume-hours-DAY.csv` with each `data-day-DAY`
// release. The reader ingests its rows as `read:chain-volume-hour`, the same rows the backtest replays, so core's
// `dailyChainVolume` and the regime read one series in both. A day whose asset is missing, unreadable or fails its
// checksum ingests nothing: unknown, never zero.
import { createHash } from 'node:crypto';
import { DAY_MS, HOUR_MS } from '../../../core/src/config/time.ts';
import type { VolumeHour } from '../../../core/src/facts/index.ts';

/** Header of the asset. */
export const VOLUME_HOURS_HEADER = 'hour_start_ms,lamports';
const U64 = /^(0|[1-9][0-9]{0,19})$/;
const U64_MAX = (1n << 64n) - 1n;

/** The `YYYY-MM-DD` name of a UTC day number. */
export const dayName = (day: number): string => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** The UTC day number of a `YYYY-MM-DD` name, or null when it is not a real date. */
export const dayNumber = (name: string): number | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) return null;
  const ms = Date.parse(`${name}T00:00:00Z`);
  return Number.isFinite(ms) && dayName(ms / DAY_MS) === name ? ms / DAY_MS : null;
};

export const volumeHoursAsset = (day: string): string => `volume-hours-${day}.csv`;
export const volumeSumsAsset = (day: string): string => `SHA256SUMS-${day}`;

/**
 * The asset for UTC day `day` (`YYYY-MM-DD`): one row per covered hour, lamports of every buy and sell on the
 * SOL-quoted curve and canonical WSOL PumpSwap pools. Uncovered hours are left out, so a day with fewer than 24 rows
 * stays unknown in `dailyChainVolume`. Null when anything is malformed: the whole asset is refused.
 */
export const parseVolumeHoursCsv = (text: string, day: string): VolumeHour[] | null => {
  const d = dayNumber(day);
  if (d === null) return null;
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.at(-1) === '') lines.pop();
  if (lines[0] !== VOLUME_HOURS_HEADER) return null;
  const out: VolumeHour[] = [];
  const seen = new Set<number>();
  for (const line of lines.slice(1)) {
    const cells = line.split(',');
    if (cells.length !== 2 || !U64.test(cells[0]!) || !U64.test(cells[1]!)) return null;
    const hourStartMs = Number(cells[0]);
    const lamports = BigInt(cells[1]!);
    if (hourStartMs % HOUR_MS !== 0 || Math.floor(hourStartMs / DAY_MS) !== d || seen.has(hourStartMs) || lamports > U64_MAX) return null;
    seen.add(hourStartMs);
    out.push({ hourStartMs, lamports, covered: true });
  }
  return out.sort((a, b) => a.hourStartMs - b.hourStartMs);
};

/** The sha256 SHA256SUMS-DAY lists for `asset`, or null when it lists none (or names a path outside the release). */
export const listedSha256 = (sums: string, asset: string): string | null => {
  for (const line of sums.split('\n')) {
    const m = /^([0-9a-f]{64})\s+\*?(\S+)$/.exec(line.trim());
    if (m !== null && m[2] === asset) return m[1]!;
  }
  return null;
};

export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
