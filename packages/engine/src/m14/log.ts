// M14 log codes and their fields (B-M27-01: a field not declared here is written as `[redacted]`). Z03 wiring of the
// C03 port onto M27: C03 wrote `M14.*`; M27's code rule is `module.event` in lower case, as M24, M25 and M27 use.
import type { LogCodes } from '../m27/log.ts';

export const M14_LOG_CODES = {
  'm14.provider_disabled': { fields: { provider: 'name', reason: 'symbol' } },
  'm14.provider_stopped': {
    fields: { provider: 'name', reason: 'symbol', restored: 'boolean', limited_in_window: 'integer', http_status: 'integer', retry_after_ms: 'number' },
  },
  'm14.provider_paused': { fields: { provider: 'name', pause_ms: 'number', http_status: 'integer' } },
  'm14.provider_resumed': { fields: { provider: 'name' } },
  'm14.stop_store_invalid': { fields: { problem: 'symbol' } },
  'm14.stop_store_failed': { fields: {} },
  'm14.byte_hold_started': {
    fields: {
      provider: 'name', method: 'name', need_bytes: 'integer', at_least_bytes: 'integer', declared: 'boolean', over_own_cap: 'boolean',
      hold_ms: 'integer',
    },
  },
} as const satisfies LogCodes;
