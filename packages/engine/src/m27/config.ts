// M27 config fields (B-M27-01 "Config", plus the bounds the 2 GB host needs; registered by B-M25-01).
import { ALL_MODES, type ConfigFieldDef } from '../m25/fields.ts';
import { ENGINE_PATHS } from '../paths.ts';

const base = { section: 'm27', type: 'int', step: '1', enumValues: null, secret: false, requiresRestart: true, riskDirectionOnIncrease: 'neutral',
  affectsReturns: false, modeScope: ALL_MODES } as const;
const MIB = 1_048_576;

export const M27_CONFIG = [
  { ...base, key: 'm27.series_cap', unit: 'count', displayUnit: 'count', min: '100', max: '5000', default: 5_000, label: 'Metric series cap',
    description: 'Series beyond this are dropped and counted (metrics_series_dropped_total).' },
  { ...base, key: 'm27.log_retention_days', unit: 'days', displayUnit: 'days', min: '1', max: '90', default: 14, label: 'Log retention',
    description: 'Days of log files kept on the host, today included.' },
  { ...base, key: 'm27.ring_budget_bytes', unit: 'bytes', displayUnit: 'bytes', min: '0', max: String(256 * MIB), default: 64 * MIB,
    label: '1 s metric history memory', description: 'Memory for the 1 s metric history; the oldest hours are dropped first when it is full.' },
  { ...base, key: 'm27.log_max_bytes_per_day', unit: 'bytes', displayUnit: 'bytes', min: String(MIB), max: String(1_024 * MIB), default: 256 * MIB,
    label: 'Log size per day', description: 'Above it debug and info lines are dropped for the rest of the day; warn and above are always kept.' },
  { ...base, key: 'm27.log_queue_bytes', unit: 'bytes', displayUnit: 'bytes', min: String(64 * 1_024), max: String(64 * MIB), default: 8 * MIB,
    label: 'Log write queue', description: 'Bytes waiting for the disk before info lines are dropped (debug from half of it); warn and above only at twice it.' },
  { ...base, key: 'm27.log_dir', type: 'string', unit: null, displayUnit: null, min: null, max: null, step: null, default: ENGINE_PATHS.logDir,
    label: 'Log directory', description: 'JSON-lines log files, one per UTC day.' },
  { ...base, key: 'm27.rollup_max_bytes', unit: 'bytes', displayUnit: 'bytes', min: String(64 * MIB), max: String(16_384 * MIB), default: 4_096 * MIB,
    label: 'Metric history on disk', description: 'At it no more minute rollups are stored (per-pool ones first) and an error is logged.' },
  { ...base, key: 'm27.metrics_port', unit: null, displayUnit: null, min: '1024', max: '65535', default: 9_464, label: '/metrics port',
    description: 'Port of the loopback-only /metrics endpoint.' },
] as const satisfies readonly ConfigFieldDef[];
