// Melbourne civil time (Australia/Melbourne) from a UTC instant, by rule, with no Intl and no Date: the trading day and
// week for the loss limits (docs/ARCHITECTURE.md §8, "the owner's day"). ENG-1's purity guard bans locale and time-zone
// reads, and both would differ between machines, so this is plain integer arithmetic on milliseconds since the epoch.
//
// Rule table (Victoria, Summer Time Act 1972 as amended; in force since 2008):
//   standard time AEST = UTC+10:00 (600 minutes)
//   daylight time AEDT = UTC+11:00 (660 minutes), from the first Sunday in October at 02:00 AEST
//                                                 to the first Sunday in April at 03:00 AEDT.
// Both changes happen at 16:00 UTC on the Saturday before. Instants before 2008 are refused: the rule differed then.

/** Milliseconds in a minute. Not money: a time unit (allowed in the money-literal scan by name and value). */
export const MS_PER_MINUTE = 60_000;
/** First year of the calendar arithmetic (the Unix epoch). Not money. */
export const EPOCH_YEAR = 1970;
/** First year the current Victorian daylight-saving rule applies. Not money. */
export const RULE_FROM_YEAR = 2008;

const MINUTES_PER_DAY = 24 * 60;
const MS_PER_DAY = MS_PER_MINUTE * MINUTES_PER_DAY;

interface Zone { readonly name: string; readonly offsetMinutes: number }
/** The tz-rule table: two zones and the dates that switch between them. */
export const MELBOURNE_RULES = {
  standard: { name: 'AEST', offsetMinutes: 10 * 60 } satisfies Zone,
  daylight: { name: 'AEDT', offsetMinutes: 11 * 60 } satisfies Zone,
  /** Daylight time starts on the first Sunday of this month (1-based), at this local standard hour. */
  startMonth: 10,
  startLocalHour: 2,
  /** Daylight time ends on the first Sunday of this month, at this local daylight hour. */
  endMonth: 4,
  endLocalHour: 3,
} as const;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInYear = (y: number): number => (isLeap(y) ? 366 : 365);
const daysInMonth = (y: number, m: number): number => (m === 2 && isLeap(y) ? 29 : DAYS_IN_MONTH[m - 1] ?? 0);

/** Floor division for integers stored as numbers (both operands safe integers, divisor > 0). */
const floorDiv = (a: number, b: number): number => Math.floor(a / b);
const mod = (a: number, b: number): number => ((a % b) + b) % b;

/** Days since 1970-01-01 of a civil date (month 1-12). */
export const daysFromCivil = (year: number, month: number, day: number): number => {
  let days = 0;
  for (let y = EPOCH_YEAR; y < year; y++) days += daysInYear(y);
  for (let y = year; y < EPOCH_YEAR; y++) days -= daysInYear(y);
  for (let m = 1; m < month; m++) days += daysInMonth(year, m);
  return days + day - 1;
};

export interface CivilDate { readonly year: number; readonly month: number; readonly day: number }

/** Civil date of a day count since 1970-01-01. */
export const civilFromDays = (days: number): CivilDate => {
  let year = EPOCH_YEAR;
  let rest = days;
  while (rest < 0) { year--; rest += daysInYear(year); }
  while (rest >= daysInYear(year)) { rest -= daysInYear(year); year++; }
  let month = 1;
  while (rest >= daysInMonth(year, month)) { rest -= daysInMonth(year, month); month++; }
  return { year, month, day: rest + 1 };
};

/** 0 = Sunday ... 6 = Saturday. 1970-01-01 was a Thursday. */
export const weekdayOfDays = (days: number): number => mod(days + 4, 7);

const firstSundayDays = (year: number, month: number): number => {
  const first = daysFromCivil(year, month, 1);
  return first + mod(7 - weekdayOfDays(first), 7);
};

const checkInstant = (utcMs: number): void => {
  if (!Number.isSafeInteger(utcMs)) throw new RangeError(`instant must be integer milliseconds, got ${utcMs}`);
};

/** UTC instant at which daylight time starts in `year`. */
export const daylightStartUtc = (year: number): number =>
  firstSundayDays(year, MELBOURNE_RULES.startMonth) * MS_PER_DAY
  + (MELBOURNE_RULES.startLocalHour * 60 - MELBOURNE_RULES.standard.offsetMinutes) * MS_PER_MINUTE;

/** UTC instant at which daylight time ends in `year`. */
export const daylightEndUtc = (year: number): number =>
  firstSundayDays(year, MELBOURNE_RULES.endMonth) * MS_PER_DAY
  + (MELBOURNE_RULES.endLocalHour * 60 - MELBOURNE_RULES.daylight.offsetMinutes) * MS_PER_MINUTE;

/** Melbourne's offset from UTC, in minutes, at a UTC instant. */
export const melbourneOffsetMinutes = (utcMs: number): number => {
  checkInstant(utcMs);
  const { year } = civilFromDays(floorDiv(utcMs, MS_PER_DAY));
  if (year < RULE_FROM_YEAR) throw new RangeError(`Melbourne time rules are only defined from ${RULE_FROM_YEAR}`);
  // The southern summer spans the new year: daylight before April's change and from October's change.
  const daylight = utcMs < daylightEndUtc(year) || utcMs >= daylightStartUtc(year);
  return (daylight ? MELBOURNE_RULES.daylight : MELBOURNE_RULES.standard).offsetMinutes;
};

/** Melbourne local day number (days since 1970-01-01 in local time) of a UTC instant. */
export const melbourneDayNumber = (utcMs: number): number =>
  floorDiv(utcMs + melbourneOffsetMinutes(utcMs) * MS_PER_MINUTE, MS_PER_DAY);

/**
 * UTC instant of local midnight starting Melbourne day `dayNumber`. Midnight is never inside a change (changes are at
 * 02:00 and 03:00 local), so the offset an hour either side of it is the offset at it.
 */
export const melbourneMidnightUtc = (dayNumber: number): number => {
  const localMidnight = dayNumber * MS_PER_DAY;
  const offset = melbourneOffsetMinutes(localMidnight - MELBOURNE_RULES.standard.offsetMinutes * MS_PER_MINUTE);
  return localMidnight - offset * MS_PER_MINUTE;
};

/** Start (inclusive) and end (exclusive) of the Melbourne day holding `utcMs`, as UTC instants. 23, 24 or 25 hours long. */
export const melbourneDay = (utcMs: number): { readonly start: number; readonly end: number; readonly date: CivilDate } => {
  const n = melbourneDayNumber(utcMs);
  return { start: melbourneMidnightUtc(n), end: melbourneMidnightUtc(n + 1), date: civilFromDays(n) };
};

/** Start (Monday 00:00 Melbourne, inclusive) and end (next Monday, exclusive) of the week holding `utcMs`. */
export const melbourneWeek = (utcMs: number): { readonly start: number; readonly end: number } => {
  const n = melbourneDayNumber(utcMs);
  const monday = n - mod(weekdayOfDays(n) - 1, 7);
  return { start: melbourneMidnightUtc(monday), end: melbourneMidnightUtc(monday + 7) };
};

export interface MelbourneTime extends CivilDate {
  readonly hour: number;
  readonly minute: number;
  readonly zone: 'AEST' | 'AEDT';
}

/** Melbourne wall-clock time of a UTC instant (for logs and reports). */
export const melbourneTime = (utcMs: number): MelbourneTime => {
  const offset = melbourneOffsetMinutes(utcMs);
  const local = utcMs + offset * MS_PER_MINUTE;
  const minuteOfDay = floorDiv(mod(local, MS_PER_DAY), MS_PER_MINUTE);
  return {
    ...civilFromDays(floorDiv(local, MS_PER_DAY)),
    hour: floorDiv(minuteOfDay, 60),
    minute: minuteOfDay % 60,
    zone: offset === MELBOURNE_RULES.daylight.offsetMinutes ? 'AEDT' : 'AEST',
  };
};
