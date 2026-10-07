// RC-M3 (red team C): one rule for every daily budget file dated in the future.

/**
 * RC-M3: a daily budget's saved UTC day (a day number, ms / 86_400_000) is "far ahead" when it is more than one day after
 * the clock's day. A clock stepped back under a day (NTP, a VM restore) leaves a file dated at most tomorrow, and that
 * file keeps its spend, as before. A file dated further ahead was written under a wrong clock: it cannot be a day the
 * bot has already reached, so it must not hold the budget until that date. It is replaced by "today (by the clock) is
 * fully spent", written back: never more budget than one true day allows (whatever the wrong-clock boot spent counts as
 * today's), and locked at most until the clock's next UTC day.
 */
export const farAhead = (savedDay: number, today: number): boolean => savedDay > today + 1;
