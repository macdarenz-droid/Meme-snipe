// Regime volume from the chain (§6.4; supervisor ruling after external review, 2026-10-03): the daily sum of pump curve
// and canonical PumpSwap trade volume in lamports, over complete UTC days only. One function for the backtest (DATA-1's
// hourly census) and live (the same hour rows, from DATA-1c's `volume-hours-DAY.csv` release assets). A day with an uncovered or missing hour is
// left out: unknown, never zero, so the regime's volume condition is not covered and the regime is off.
import { DAY_MS, HOUR_MS } from '../config/time.ts';
import type { VolumeHour } from './raw.ts';

const HOURS_PER_DAY = DAY_MS / HOUR_MS;

export const dailyChainVolume = (hours: readonly VolumeHour[]): { readonly day: number; readonly volumeLamports: bigint }[] => {
  const byDay = new Map<number, Map<number, VolumeHour>>();
  for (const h of hours) {
    const day = Math.floor(h.hourStartMs / DAY_MS);
    const m = byDay.get(day) ?? new Map<number, VolumeHour>();
    // The same hour twice with different values cannot be trusted: the day becomes unknown.
    const prev = m.get(h.hourStartMs);
    m.set(h.hourStartMs, prev !== undefined && (prev.lamports !== h.lamports || prev.covered !== h.covered) ? { ...h, covered: false } : h);
    byDay.set(day, m);
  }
  const out: { day: number; volumeLamports: bigint }[] = [];
  for (const [day, m] of byDay) {
    const all = [...m.values()];
    if (all.length !== HOURS_PER_DAY || !all.every((h) => h.covered)) continue;
    out.push({ day, volumeLamports: all.reduce((s, h) => s + h.lamports, 0n) });
  }
  return out.sort((a, b) => a.day - b.day);
};

/** Header of DATA-1c's `volume-hours-DAY.csv` (release `data-volume-DAY`; `days/DAY/volume_hours-NNN.csv.zst` in a dataset). */
export const VOLUME_HOURS_HEADER = 'hour_start_ms,lamports,covered';
const U64 = /^(0|[1-9][0-9]{0,19})$/;
const U64_MAX = (1n << 64n) - 1n;

/**
 * DATA-1c's volume-hours CSV for UTC day number `day`, shared by the live reader and the backtest: the header, then
 * exactly 24 rows in hour order (row i starts at day start + i hours), lamports a u64 of SOL-quoted curve and canonical
 * WSOL PumpSwap buys and sells, covered `1` or `0`. An uncovered hour comes back `covered: false`, so its day stays
 * unknown in `dailyChainVolume`. Null when anything differs: the whole day is refused (unknown, never zero).
 */
export const parseVolumeHoursCsv = (text: string, day: number): VolumeHour[] | null => {
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== HOURS_PER_DAY + 1 || lines[0] !== VOLUME_HOURS_HEADER) return null;
  const out: VolumeHour[] = [];
  for (let i = 0; i < HOURS_PER_DAY; i++) {
    const cells = lines[i + 1]!.split(',');
    if (cells.length !== 3 || !U64.test(cells[1]!) || (cells[2] !== '0' && cells[2] !== '1')) return null;
    const hourStartMs = day * DAY_MS + i * HOUR_MS;
    if (cells[0] !== String(hourStartMs)) return null;
    const lamports = BigInt(cells[1]!);
    if (lamports > U64_MAX) return null;
    out.push({ hourStartMs, lamports, covered: cells[2] === '1' });
  }
  return out;
};
