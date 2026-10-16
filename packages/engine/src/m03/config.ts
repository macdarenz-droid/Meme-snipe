// M03 discovery config (SPEC-A A-M03-01 and A-M03-04 "Config"; card Z08). PumpPortal is off by default (owner,
// 2026-10-07; ruling Z08-2). `paid_methods` must stay empty: `checkPumpPortalConfig` refuses anything else at start.
import { ALL_MODES, type ConfigFieldDef } from '../m25/fields.ts';
import { BACKFILL_DEFAULTS } from './backfill.ts';
import { PUMPPORTAL_DEFAULTS } from './pumpportal.ts';

const base = { section: 'discovery', unit: null, displayUnit: null, min: null, max: null, step: null, enumValues: null, secret: false,
  requiresRestart: true, riskDirectionOnIncrease: 'neutral', affectsReturns: false, modeScope: ALL_MODES } as const;

export const M03_CONFIG = [
  { ...base, key: 'discovery.pumpportal.enabled', type: 'bool', default: PUMPPORTAL_DEFAULTS.enabled, label: 'PumpPortal',
    description: 'Off: PumpPortal is not used for now (owner, 7 Oct). Chain backfill finds migrations.' },
  { ...base, key: 'discovery.pumpportal.max_sub_msgs_per_s', type: 'int', min: '1', max: '200', step: '1', default: PUMPPORTAL_DEFAULTS.maxSubMsgsPerS,
    label: 'PumpPortal messages a second', description: 'Subscription messages a second, at most 200 [DA-02].' },
  { ...base, key: 'discovery.pumpportal.backoff_max_ms', type: 'duration_ms', unit: 'ms', displayUnit: 'ms', min: '5000', max: '300000', step: '1',
    default: PUMPPORTAL_DEFAULTS.backoffMaxMs, label: 'PumpPortal longest wait', description: 'Longest wait before a reconnect.' },
  { ...base, key: 'discovery.pumpportal.silence_alert_ms', type: 'duration_ms', unit: 'ms', displayUnit: 'ms', min: '60000', max: '3600000', step: '1',
    default: PUMPPORTAL_DEFAULTS.silenceAlertMs, label: 'PumpPortal silence', description: 'Silence while backfill sees migrations that marks the stream down.' },
  { ...base, key: 'discovery.pumpportal.paid_methods', type: 'list', default: [], label: 'PumpPortal paid methods',
    description: 'Must be empty: paid subscriptions are never sent.' },
  { ...base, key: 'discovery.backfill.interval_ms', type: 'duration_ms', unit: 'ms', displayUnit: 'ms', min: '15000', max: '600000', step: '1',
    default: BACKFILL_DEFAULTS.intervalMs, label: 'Migration check', description: 'How often the chain is read for new migrations.' },
  { ...base, key: 'discovery.backfill.max_pages_per_run', type: 'int', min: '1', max: '100', step: '1', default: BACKFILL_DEFAULTS.maxPagesPerRun,
    label: 'Migration pages a run', description: 'Pages of 1,000 signatures read in one run; the rest wait for the next.' },
  { ...base, key: 'discovery.dexscreener.enabled', type: 'bool', default: true, label: 'DexScreener check',
    description: 'Daily coverage cross-check of recorded migrations against DexScreener.' },
  { ...base, key: 'discovery.dexscreener.max_calls_per_day', type: 'int', min: '0', max: '5000', step: '1', default: 500,
    label: 'DexScreener calls a day', description: 'Calls a UTC day for the cross-check.' },
  { ...base, key: 'discovery.dexscreener.pumpswap_dex_ids', type: 'list', default: ['pumpswap'], label: 'PumpSwap dex ids',
    description: 'DexScreener dexId values counted as PumpSwap pairs.' },
] as const satisfies readonly ConfigFieldDef[];
