import { TIME_ZONE } from '../api/contract.ts';

const dateTime = new Intl.DateTimeFormat('en-AU', { timeZone: TIME_ZONE, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const date = new Intl.DateTimeFormat('en-AU', { timeZone: TIME_ZONE, day: 'numeric', month: 'short', year: 'numeric' });
const time = new Intl.DateTimeFormat('en-AU', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const monthKey = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit' });

/** All dashboard times are Melbourne time. */
export const melDateTime = (iso: string) => dateTime.format(new Date(iso));
export const melDate = (iso: string) => date.format(new Date(iso));
export const melTime = (iso: string) => time.format(new Date(iso));

/** Current month in Melbourne, YYYY-MM. */
export const melMonth = (now = new Date()) => monthKey.format(now).slice(0, 7);

/** "2026-09" → "2026-10" (step = 1) or "2026-08" (step = −1). */
export function shiftMonth(month: string, step: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + step, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** "42s ago", "3m ago", "2h ago". */
export function ago(iso: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}
