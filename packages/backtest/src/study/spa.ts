// The deployment replay's daily P&L for STATS-1c's SPA (supervisor ruling after the three-way consensus): each
// variant's realised net per Melbourne day over one fixed capital base, on one common calendar, with its activity.
// A variant active on fewer than MIN_DAYS days is ineligible, decided from activity counts before any outcome is read.
import { MIN_DAYS } from '../../../core/src/stats/index.ts';
import { melbourneDay } from '../report.ts';

export interface SpaVariant {
  readonly variant: string;
  /** Realised net per calendar day (closed that Melbourne day) over the capital base; 0 on a day without a close. */
  readonly daily: readonly number[];
  /** Days with at least one entry. */
  readonly activeDays: number;
  readonly entries: number;
  readonly eligible: boolean;
}

export interface SpaPanel {
  /** The fixed capital base, lamports: the policy bankroll at the SOL/USD price of the calendar's first hour. */
  readonly capitalBaseLamports: string;
  readonly calendar: readonly string[];
  readonly minDays: number;
  readonly variants: readonly SpaVariant[];
}

interface Closed { readonly openedAt: number; readonly closedAt: number; readonly net: string; readonly stray?: readonly Stray[] }
interface Stray { readonly at: number; readonly lamports: string }

/**
 * One variant's daily series. Closes outside the calendar are refused: the calendar is the variant's whole window.
 * Failed-entry fees (audit B5) are booked on the day they landed: those a trade carries (already in its net, so moved
 * from its close day to theirs) and those of the variant no trade carries (`uncarried`).
 */
export const spaVariant = (variant: string, trades: readonly Closed[], calendar: readonly string[], capitalBase: bigint, uncarried: readonly Stray[] = []): SpaVariant => {
  if (capitalBase <= 0n) throw new RangeError('the capital base must be positive');
  const index = new Map(calendar.map((d, k) => [d, k]));
  const sums = calendar.map(() => 0n);
  const active = new Set<string>();
  for (const t of trades) {
    const k = index.get(melbourneDay(t.closedAt));
    if (k === undefined) throw new RangeError(`${variant}: a trade closes on ${melbourneDay(t.closedAt)}, outside the calendar`);
    const carried = (t.stray ?? []).reduce((a, x) => a + BigInt(x.lamports), 0n);
    sums[k] = sums[k]! + BigInt(t.net) + carried;
    active.add(melbourneDay(t.openedAt));
  }
  for (const x of [...trades.flatMap((t) => t.stray ?? []), ...uncarried]) {
    const k = index.get(melbourneDay(x.at));
    if (k === undefined) throw new RangeError(`${variant}: a failed entry lands on ${melbourneDay(x.at)}, outside the calendar`);
    sums[k] = sums[k]! - BigInt(x.lamports);
  }
  return { variant, daily: sums.map((x) => Number(x) / Number(capitalBase)), activeDays: active.size, entries: trades.length, eligible: active.size >= MIN_DAYS };
};

export const spaPanel = (variants: readonly { variant: string; trades: readonly Closed[]; uncarried?: readonly Stray[] }[], calendar: readonly string[], capitalBase: bigint): SpaPanel => ({
  capitalBaseLamports: capitalBase.toString(), calendar: [...calendar], minDays: MIN_DAYS,
  variants: variants.map((v) => spaVariant(v.variant, v.trades, calendar, capitalBase, v.uncarried ?? [])),
});
