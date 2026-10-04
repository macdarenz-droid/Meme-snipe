// Time units in integer milliseconds. Kept in config/ with the other literals; they are units, not limits.
export const SECOND_MS = 1_000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** UTC day number (days since 1970-01-01) of 2026-07-20, the first day of DATA-1's chain-volume series (§6.4). */
export const VOLUME_SERIES_START_DAY = 20_654;
