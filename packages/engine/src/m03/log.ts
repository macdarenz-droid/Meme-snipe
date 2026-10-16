// M03 log codes and their fields (B-M27-01), card Z08.
import type { LogCodes } from '../m27/log.ts';

export const M03_LOG_CODES = {
  'm03.pp_disabled': { fields: {} },
  'm03.pp_starting': { fields: { endpoint: 'string' } },
  'm03.pp_connected': { fields: { reconnect: 'boolean' } },
  'm03.pp_disconnected': { fields: { code: 'integer' } },
  'm03.pp_ban_suspected': { fields: { pause_ms: 'integer' } },
  'm03.coverage_cross_check': { fields: { checked_mints: 'integer', pools_only_in_vendor: 'integer', status: 'symbol' } },
} as const satisfies LogCodes;
