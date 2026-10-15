// M01 log codes of card Z07 (venue config cache, orientation guard, venue status) for the engine's M27 logger
// (B-M27-01; plain data, merged with mergeLogCodes beside the constants registry's `M01_LOG_CODES`). Field kinds are
// M27's: a pool or account address is `id`, hashes and enum values `string`.
export const M01_VENUE_LOG_CODES = {
  'm01.fee_config_refreshed': { fields: { slot: 'bigint' } },
  'm01.fee_config_refresh_failed': { fields: { error_code: 'string' } },
  'm01.fee_config_changed': { fields: { name: 'string', old_hash: 'string', new_hash: 'string', version: 'integer' } },
  'm01.fee_config_decode_failed': { fields: { name: 'string', reason: 'string' } },
  'm01.fee_schedule_changed': { fields: { venue: 'string', old_hash: 'string', new_hash: 'string', direction: 'string' } },
  'm01.venue_status_changed': { fields: { venue: 'string', reason: 'string', quotable: 'boolean' } },
  'm01.fee_mismatch': { fields: { venue: 'string', pool: 'id', realised_bps: 'integer', candidates: 'json' } },
  'm01.orientation_fail': { fields: { pool: 'id', observed_bps: 'integer', slot: 'bigint' } },
  'm01.orientation_read_failed': { fields: { pool: 'id', error_code: 'string' } },
  'm01.pool_quarantined': { fields: { pool: 'id', reason: 'string' } },
} as const;
