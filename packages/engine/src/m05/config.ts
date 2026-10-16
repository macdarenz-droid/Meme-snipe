// M05 universe config (SPEC-A A-M05-01 and A-M05-02 "Config"; card Z09). `screening_required = false` (Phase 0) is
// valid only while no strategy is enabled in any mode (C-44; `checkUniverseConfig`). The per-strategy universe limits
// (`strategy.<id>.universe.*`) belong to the strategy runtime (M09) and are passed in as `UniverseLimits`.
import { ALL_MODES, type ConfigFieldDef } from '../m25/fields.ts';
import { UNIVERSE_DEFAULTS } from './universe.ts';
import { WATCHLIST_DEFAULTS } from './watchlist.ts';

const base = { section: 'universe', unit: null, displayUnit: null, min: null, max: null, step: null, enumValues: null, secret: false,
  requiresRestart: false, riskDirectionOnIncrease: 'neutral', affectsReturns: false, modeScope: ALL_MODES } as const;
const ms = { type: 'duration_ms', unit: 'ms', displayUnit: 'ms', step: '1' } as const;

export const M05_CONFIG = [
  { ...base, key: 'universe.screening_required', type: 'bool', default: UNIVERSE_DEFAULTS.screeningRequired, label: 'Screening',
    description: 'Off only while no strategy is enabled (Phase 0 recording).' },
  { ...base, key: 'universe.phase0_limit_set', type: 'enum', enumValues: ['pm01', 'mr01'], default: UNIVERSE_DEFAULTS.limitSetId, affectsReturns: true,
    label: 'Universe limits', description: 'The strategy limit set the prefilter uses (PM-01 by default; MR-01 is parked).' },
  { ...base, ...ms, key: 'universe.cooldown_ms', min: '0', max: '86400000', default: UNIVERSE_DEFAULTS.cooldownMs, affectsReturns: true,
    label: 'Cooldown', description: 'Wait per mint after a position ends.' },
  { ...base, ...ms, key: 'universe.prefilter_retry_ms', min: '600000', max: '86400000', default: UNIVERSE_DEFAULTS.prefilterRetryMs, affectsReturns: true,
    label: 'Prefilter retry', description: 'When a pool that failed the prefilter is checked again.' },
  { ...base, ...ms, key: 'universe.stale_to_state_ms', min: '5000', max: '600000', default: UNIVERSE_DEFAULTS.staleToStateMs,
    label: 'Stale after', description: 'Pool data older than this marks a watched pool stale.' },
  { ...base, key: 'universe.screen_backlog_max', type: 'int', min: '10', max: '1000', step: '1', default: UNIVERSE_DEFAULTS.screenBacklogMax,
    label: 'Screening backlog', description: 'Unscreened pools kept; the oldest above it are dropped.' },
  { ...base, key: 'universe.max_watched', type: 'int', min: '1', max: '30', step: '1', default: WATCHLIST_DEFAULTS.maxWatched, affectsReturns: true,
    label: 'Watched pools', description: 'Candidate pools polled at 1 Hz; at most a third of the accounts per call.' },
  { ...base, key: 'universe.tail_max_pools', type: 'int', min: '0', max: '60', step: '1', default: WATCHLIST_DEFAULTS.tailMaxPools,
    label: 'Tail pools', description: 'Evicted pools still recorded at 0.1 Hz.' },
  { ...base, ...ms, key: 'universe.tail_extra_ms', min: '3600000', max: '86400000', default: WATCHLIST_DEFAULTS.tailExtraMs,
    label: 'Tail extra', description: 'Recording time after the longest holding period.' },
] as const satisfies readonly ConfigFieldDef[];
