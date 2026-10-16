// M03 log codes and their fields (B-M27-01), card Z08.
import type { LogCodes } from '../m27/log.ts';

export const M03_LOG_CODES = {
  'm03.pp_disabled': { fields: {} },
  'm03.pp_starting': { fields: { endpoint: 'string' } },
  'm03.pp_connected': { fields: { reconnect: 'boolean' } },
  'm03.pp_disconnected': { fields: { close_code: 'integer' } },
  'm03.pp_ban_suspected': { fields: { pause_ms: 'integer' } },
  'm03.coverage_cross_check': { fields: { checked_mints: 'integer', pools_only_in_vendor: 'integer', other_dex_pairs: 'integer', known_pools_under_other_dex: 'integer', status: 'symbol' } },
  // A-M03-02 (card Z09).
  'm03.migration_verified': { fields: { pool: 'id', slot: 'bigint' } },
  'm03.migration_rejected': { fields: { reason: 'string' } },
  'm03.backfill_page_failed': { fields: { error_code: 'string' } },
  'm03.backfill_tx_failed': { fields: { error_code: 'string' } },
  'm03.tx_version_unsupported': { fields: {} },
  'm03.d12_switch_condition': { fields: { gap_bps: 'integer', chain_migrations: 'integer' } },
  'm03.backfill_error': { fields: { error_code: 'string' } },
} as const satisfies LogCodes;
