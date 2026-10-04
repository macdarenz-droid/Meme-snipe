import type { CalendarMonth, DayRecord } from '../api/contract.ts';
import { totalUsd } from '../api/modes.ts';
import { formatUsdCompact } from '../lib/format.ts';
import { formatSol, formatUsdExact, toLamports, toMicro, toneOf, toneOfLamports, usdToPlot } from '../lib/money.ts';
import { Money } from '../components/Money.tsx';
import { CALENDAR_TINT_MAX } from '../theme/contrast.ts';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const monthName = new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const dayLabel = new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

const absMicro = (usd: string) => {
  const v = toMicro(usd);
  return v < 0n ? -v : v;
};

export const monthTitle = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return monthName.format(new Date(Date.UTC(y, m - 1, 1)));
};

/** The month is shown in SOL when every day carries its lamports (APP-SOL); else in dollars, as before. */
const inSol = (cal: CalendarMonth): boolean => cal.days.every((d) => d.netLamports != null);

/** Month total: exact, and only from days of the calendar's own mode. */
export function monthTotals(cal: CalendarMonth) {
  return {
    netUsd: totalUsd(cal.mode, cal.days, (d) => d.netUsd),
    netLamports: inSol(cal) ? cal.days.reduce((s, d) => s + toLamports(d.netLamports!), 0n).toString() : null,
    trades: cal.days.reduce((s, d) => s + d.trades, 0),
    pauses: cal.days.reduce((s, d) => s + d.pauses, 0),
  };
}

/** One cell per Melbourne day, tinted by net result, with the signed amount printed so colour is never the only cue. */
export function PnlCalendar({ cal, onPrev, onNext, onSelectDay }: { cal: CalendarMonth; onPrev: () => void; onNext: () => void; onSelectDay: (d: DayRecord) => void }) {
  const [y, m] = cal.month.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7;
  const byDate = new Map(cal.days.map((d) => [d.date, d]));
  const sol = inSol(cal);
  // Tint strength only: the largest day, in lamports or micro-dollars, not a sum.
  const absOf = (d: DayRecord) => (sol ? (toLamports(d.netLamports!) < 0n ? -toLamports(d.netLamports!) : toLamports(d.netLamports!)) : absMicro(d.netUsd));
  const maxAbs = cal.days.map(absOf).reduce((mx, a) => (a > mx ? a : mx), 0n);
  const totals = monthTotals(cal);
  const cells: (number | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  while (cells.length % 7) cells.push(null);
  const title = monthTitle(cal.month);

  return (
    <div className="calendar">
      <div className="dash-month">
        <button type="button" className="icon-button dash-month-step" onClick={onPrev} aria-label="Previous month">
          ‹
        </button>
        <span className="dash-month-title">{title}</span>
        <button type="button" className="icon-button dash-month-step" onClick={onNext} aria-label="Next month">
          ›
        </button>
      </div>
      <div className="calendar-grid" role="grid" aria-label={`Daily results, ${title}, Melbourne time`}>
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
              const date = `${cal.month}-${String(day).padStart(2, '0')}`;
              const d = byDate.get(date);
              const label = dayLabel.format(new Date(Date.UTC(y, m - 1, day)));
              if (!d) {
                return (
                  <div role="gridcell" key={i} className="calendar-cell" aria-label={`${label}, no trades`}>
                    <span className="calendar-day">{day}</span>
                  </div>
                );
              }
              const tone = (sol ? toneOfLamports(d.netLamports!) : toneOf(d.netUsd)) || 'flat';
              const abs = absOf(d);
              const net = sol ? formatSol(d.netLamports!, true) : formatUsdExact(d.netUsd, true);
              const strength = maxAbs > 0n ? 10 + Number((abs * BigInt(CALENDAR_TINT_MAX - 10)) / maxAbs) : 0;
              const pauses = d.pauses ? `, ${d.pauses} ${d.pauses === 1 ? 'pause' : 'pauses'}` : '';
              return (
                <div role="gridcell" key={i} className="calendar-cell">
                  <button
                    type="button"
                    className={`calendar-button calendar-${tone}`}
                    style={{ ['--tint' as string]: `${strength}%` }}
                    onClick={() => onSelectDay(d)}
                    aria-label={`${label}: ${net}, ${d.trades} ${d.trades === 1 ? 'trade' : 'trades'}${pauses}`}
                  >
                    <span className="calendar-day">
                      {day}
                      {d.pauses > 0 && <span className="dash-pause" aria-hidden="true" />}
                    </span>
                    <span className="calendar-net num">{sol ? net.replace(' SOL', '') : formatUsdCompact(usdToPlot(d.netUsd), true)}</span>
                    <span className="dash-day-count num" aria-hidden="true">
                      {d.trades}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <dl className="dash-month-total">
        <div>
          <dt>Month net</dt>
          <dd className={`num ${totals.netLamports !== null ? toneOfLamports(totals.netLamports) : toneOf(totals.netUsd)}`}>{cal.days.length ? <Money lamports={totals.netLamports} usd={totals.netUsd} signed /> : '—'}</dd>
        </div>
        <div>
          <dt>Trades</dt>
          <dd className="num">{totals.trades}</dd>
        </div>
        <div>
          <dt>Pauses</dt>
          <dd className="num">{totals.pauses}</dd>
        </div>
      </dl>
    </div>
  );
}
