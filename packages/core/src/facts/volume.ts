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

/**
 * `dailyChainVolume` kept up to date one hour row at a time (FACTS-1d review): each row touches only its own day, and
 * hours older than the kept window are dropped once per new boundary day, so loading a whole window costs time in
 * proportion to its rows. `add` says whether the complete days changed, so the producer releases a new fact only then.
 * Same rules as `dailyChainVolume`: a contradicting repeat of an hour makes it uncovered, and only complete days count.
 */
export class ChainVolumeDays {
  readonly #keepMs: number;
  readonly #hours = new Map<number, Map<number, VolumeHour>>();
  readonly #complete = new Map<number, bigint>();
  #trimDay = Number.MIN_SAFE_INTEGER;
  /** Hour rows visited so far (the linear-cost test reads it). */
  steps = 0;

  constructor(keepMs: number) {
    this.#keepMs = keepMs;
  }

  add(r: VolumeHour): boolean {
    const day = Math.floor(r.hourStartMs / DAY_MS);
    const m = this.#hours.get(day) ?? new Map<number, VolumeHour>();
    this.#hours.set(day, m);
    const prev = m.get(r.hourStartMs);
    m.set(r.hourStartMs, prev !== undefined && (prev.lamports !== r.lamports || prev.covered !== r.covered) ? { ...r, covered: false } : r);
    let changed = this.#settle(day);
    const cut = r.hourStartMs - this.#keepMs;
    const cutDay = Math.floor(cut / DAY_MS);
    if (cutDay > this.#trimDay) {
      // A new boundary day: every older day goes, once.
      this.#trimDay = cutDay;
      for (const d of [...this.#hours.keys()]) {
        if (d >= cutDay) continue;
        this.#hours.delete(d);
        changed = this.#complete.delete(d) || changed;
      }
    }
    const edge = this.#hours.get(cutDay);
    if (edge !== undefined) {
      let cutHere = false;
      for (const t of [...edge.keys()]) if (t < cut) cutHere = edge.delete(t) || cutHere;
      if (cutHere) changed = this.#settle(cutDay) || changed;
    }
    return changed;
  }

  /** The complete days, oldest first, as `dailyChainVolume` returns them. */
  days(): { readonly day: number; readonly volumeLamports: bigint }[] {
    return [...this.#complete].sort((a, b) => a[0] - b[0]).map(([day, volumeLamports]) => ({ day, volumeLamports }));
  }

  /** Recomputes one day; true when its complete total changed. */
  #settle(day: number): boolean {
    const m = this.#hours.get(day);
    let sum: bigint | null = 0n;
    if (m === undefined || m.size !== HOURS_PER_DAY) sum = null;
    else {
      for (const h of m.values()) {
        this.steps++;
        if (!h.covered) sum = null;
        else if (sum !== null) sum += h.lamports;
      }
    }
    const before = this.#complete.get(day);
    if (sum === null) return this.#complete.delete(day);
    this.#complete.set(day, sum);
    return before !== sum;
  }
}
