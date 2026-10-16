// M05 log codes (card Z09) for the engine's M27 logger (merged with mergeLogCodes).
import type { LogCodes } from '../m27/log.ts';

export const M05_LOG_CODES = {
  'm05.transition': { fields: { pool: 'id', from: 'string', to: 'string', reason: 'string' } },
  'm05.blacklisted': { fields: { pool: 'id', from: 'string', to: 'string', reason: 'string' } },
  'm05.transition_refused': { fields: { from: 'string', to: 'string', reason: 'string' } },
  'm05.transition_not_applied': { fields: { from: 'string', to: 'string', error_code: 'string' } },
  'm05.not_a_candidate': { fields: { pool: 'id', reason: 'string' } },
  'm05.unknown_candidate': { fields: { pool: 'id', event: 'string' } },
  'm05.evicted': { fields: { pool: 'id', reason: 'string' } },
  'm05.unpin_unknown': { fields: { pool: 'id' } },
  'm05.watch_refused': { fields: { pool: 'id', class: 'string' } },
  'm05.watchlist_shrunk_degraded': { fields: { pinned: 'integer', tail: 'integer' } },
  'm05.retry_failed': { fields: { pool: 'id', state: 'string', reason: 'string' } },
  'm05.patch_not_applied': { fields: { pool: 'id', error_code: 'string' } },
  'm05.retired': { fields: { pool: 'id', reason: 'string' } },
  'm05.blacklist_not_saved': { fields: { mint: 'id', error_code: 'string' } },
} as const satisfies LogCodes;
