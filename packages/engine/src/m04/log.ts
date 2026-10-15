// M04 log codes (card Z07) for the engine's M27 logger (merged with mergeLogCodes).
export const M04_LOG_CODES = {
  'm04.poll_failed': { fields: { class: 'string', error_code: 'string' } },
  'm04.pool_closed': { fields: { pool: 'id', reason: 'string' } },
  'm04.first_read_failed': { fields: { pool: 'id', error_code: 'string' } },
  'm04.pool_unreadable': { fields: { pool: 'id', error_code: 'string' } },
  'm04.pool_stale': { fields: { pool: 'id', lag_slots: 'integer' } },
  'm04.exit_read_lagging': { fields: { pool: 'id', lag_slots: 'integer' } },
  'm04.source_refused': { fields: { kind: 'string', error_code: 'string' } },
  'm04.subscribe_closed': { fields: { pools: 'integer' } },
} as const;
