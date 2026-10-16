// M08 log codes (card Z09) for the engine's M27 logger (merged with mergeLogCodes). Bars and features log nothing
// per bar (too noisy, A-M08-01 "Observability").
import type { LogCodes } from '../m27/log.ts';

export const M08_LOG_CODES = {
  'm08.bar_1m_write_failed': { fields: { error_code: 'string', held: 'integer' } },
  'm08.poll_counts_early': { fields: { pool: 'id', early_ms: 'integer' } },
} as const satisfies LogCodes;
