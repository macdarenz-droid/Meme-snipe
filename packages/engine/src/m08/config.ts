// M08 bar and feature config (SPEC-A A-M08-01..03 "Config"; card Z09). `features.robust_z_scaling` changes which events
// trigger entries, so it is fixed before a strategy's configurations are pre-registered (C-20).
import { ALL_MODES, type ConfigFieldDef } from '../m25/fields.ts';
import { BAR_DEFAULTS } from './bars.ts';
import { RETENTION_DEFAULT_DAYS } from './bar-store.ts';
import { FEATURE_DEFAULTS } from './features.ts';

const base = { unit: null, displayUnit: null, min: null, max: null, step: null, enumValues: null, secret: false,
  requiresRestart: true, riskDirectionOnIncrease: 'neutral', affectsReturns: true, modeScope: ALL_MODES } as const;

export const M08_CONFIG = [
  { ...base, section: 'bars', key: 'bars.close_grace_ms', type: 'duration_ms', unit: 'ms', displayUnit: 'ms', min: '0', max: '5000', step: '1',
    default: BAR_DEFAULTS.closeGraceMs, label: 'Bar close grace', description: 'Wait after a bar ends for a late snapshot.' },
  { ...base, section: 'bars', key: 'bars.incomplete_missing_bps', type: 'bps', min: '0', max: '5000', step: '1', riskDirectionOnIncrease: 'increases_risk',
    default: BAR_DEFAULTS.incompleteMissingBps, label: 'Incomplete bar', description: 'Share of missing snapshots above which a bar is incomplete.' },
  { ...base, section: 'bars', key: 'bars.bar_1m_retention_days', type: 'int', min: '7', max: '365', step: '1', affectsReturns: false,
    default: RETENTION_DEFAULT_DAYS, label: '1-minute bars kept', description: 'Days of 1-minute bars kept for charts.' },
  { ...base, section: 'features', key: 'features.robust_z_scaling', type: 'enum', enumValues: ['sqrt_time', 'none'], default: FEATURE_DEFAULTS.robustZScaling,
    label: 'Z-score scaling', description: 'Whether the lookback return is scaled by the square root of time.' },
  { ...base, section: 'features', key: 'features.min_coverage_bps', type: 'bps', min: '1', max: '10000', step: '1', default: FEATURE_DEFAULTS.minCoverageBps,
    label: 'Feature coverage', description: 'Share of expected returns a window needs.' },
  { ...base, section: 'features', key: 'features.basket_min_pools', type: 'int', min: '1', max: '30', step: '1', default: FEATURE_DEFAULTS.basketMinPools,
    label: 'Basket pools', description: 'Watched pools the basket return needs.' },
  { ...base, section: 'features', key: 'features.median_window_ms', type: 'duration_ms', unit: 'ms', displayUnit: 'ms', min: '15000', max: '21600000', step: '15000',
    default: FEATURE_DEFAULTS.medianWindowMs, label: 'Median window', description: 'Window of the rolling median price.' },
  { ...base, section: 'features', key: 'features.dump_window_ms', type: 'duration_ms', unit: 'ms', displayUnit: 'ms', min: '15000', max: '21585000', step: '15000',
    default: FEATURE_DEFAULTS.dumpWindowMs, label: 'Dump window', description: 'Recent window checked for a dump.' },
] as const satisfies readonly ConfigFieldDef[];
