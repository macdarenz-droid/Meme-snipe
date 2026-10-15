// M15 log codes and their fields (B-M15-01 "Observability"; B-M27-01: a field not declared here is written as
// `[redacted]`). Provider labels only, never URLs (ARCH 12.4).
import type { LogCodes } from '../m27/log.ts';

export const M15_LOG_CODES = {
  'm15.slot_outlier': { fields: { provider: 'name', context_slot: 'bigint', highest_seen_slot: 'bigint', method: 'name' } },
  'm15.height_failover': { fields: { provider: 'name', failures: 'integer' } },
  'm15.samples_empty': { fields: { reason: 'symbol' } },
  'm15.provider_unknown': { fields: { provider: 'name' } },
} as const satisfies LogCodes;
