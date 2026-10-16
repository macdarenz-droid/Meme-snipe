// M10 log codes and their fields (A-M10-01 "Observability"; B-M27-01: a field not declared here is written as `[redacted]`).
import type { LogCodes } from '../m27/log.ts';

export const M10_LOG_CODES = {
  'm10.param_set_loaded': { fields: { name: 'name', fill_model_version: 'name', cost_model_version: 'name' } },
  'm10.cost_unpriced': { fields: { reason: 'string' } },
} as const satisfies LogCodes;
