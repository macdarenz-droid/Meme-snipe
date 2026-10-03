import { formatUsd } from '../lib/format.ts';
import type { DayResultView } from './types.ts';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const monthName = new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLabel = new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

interface Props {
  /** YYYY-MM */
  month: string;
  days: DayResultView[];
  onSelectDay?: (day: DayResultView) => void;
}

/** Each day is tinted by its net result, with the signed amount printed so colour is never the only cue. */
export function PnlCalendar({ month, days, onSelectDay }: Props) {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const byDate = new Map(days.map((d) => [d.date, d]));
  const maxAbs = Math.max(...days.map((d) => Math.abs(d.netUsd)), 0);

  const cells: (number | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);

  return (
    <div className="calendar">
      <div className="calendar-head">
        <span>{monthName.format(first)}</span>
        {days.length === 0 && <span className="muted">No closed trades</span>}
      </div>
      <div className="calendar-grid" role="grid" aria-label={`Daily results, ${monthName.format(first)}`}>
        <div role="row" className="calendar-row">
          {WEEKDAYS.map((d) => (
            <div role="columnheader" key={d} className="calendar-weekday">
              {d}
            </div>
          ))}
        </div>
        {Array.from({ length: cells.length / 7 }, (_, w) => (
          <div role="row" className="calendar-row" key={w}>
            {cells.slice(w * 7, w * 7 + 7).map((day, i) => {
              if (day === null) return <div role="gridcell" key={i} className="calendar-cell calendar-blank" />;
              const date = `${month}-${String(day).padStart(2, '0')}`;
              const result = byDate.get(date);
              const label = dayLabel.format(new Date(Date.UTC(y, m - 1, day)));
              if (!result) {
                return (
                  <div role="gridcell" key={i} className="calendar-cell" aria-label={`${label}, no trades`}>
                    <span className="calendar-day">{day}</span>
                  </div>
                );
              }
              const tone = result.netUsd > 0 ? 'gain' : result.netUsd < 0 ? 'loss' : 'flat';
              const strength = maxAbs ? 10 + Math.round((Math.abs(result.netUsd) / maxAbs) * 22) : 0;
              const count = result.tradeIds.length;
              return (
                <div role="gridcell" key={i} className="calendar-cell">
                  <button
                    type="button"
                    className={`calendar-button calendar-${tone}`}
                    style={{ ['--tint' as string]: `${strength}%` }}
                    onClick={() => onSelectDay?.(result)}
                    aria-label={`${label}: ${formatUsd(result.netUsd, true)}, ${count} ${count === 1 ? 'trade' : 'trades'}`}
                  >
                    <span className="calendar-day">{day}</span>
                    <span className="calendar-net num">{formatUsd(result.netUsd, true)}</span>
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
