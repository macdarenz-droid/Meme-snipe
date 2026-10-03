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
