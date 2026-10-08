// M27 settings read from the active config (wiring of B-M27-01 at engine start).
import type { Config } from '@bot/types';
import { configValue } from '../m25/registry.ts';

export interface M27Settings {
  seriesCap: number; logRetentionDays: number; ringBudgetBytes: number; logMaxBytesPerDay: number; logQueueBytes: number; logDir: string; metricsPort: number; rollupMaxBytes: number;
}

export function m27Settings(config: Config): M27Settings {
  return {
    seriesCap: configValue(config, 'm27.series_cap'),
    logRetentionDays: configValue(config, 'm27.log_retention_days'),
    ringBudgetBytes: configValue(config, 'm27.ring_budget_bytes'),
    logMaxBytesPerDay: configValue(config, 'm27.log_max_bytes_per_day'),
    logQueueBytes: configValue(config, 'm27.log_queue_bytes'),
    logDir: configValue(config, 'm27.log_dir'),
    metricsPort: configValue(config, 'm27.metrics_port'),
    rollupMaxBytes: configValue(config, 'm27.rollup_max_bytes'),
  };
}
