// M10 config fields (A-M10-01 "Config"; registered by B-M25-01).
import type { Mode } from '@bot/types';
import type { ConfigFieldDef } from '../m25/fields.ts';

const SIM_MODES: readonly Mode[] = ['backtest', 'replay', 'paper'];
const base = { section: 'sim', unit: null, displayUnit: null, min: null, max: null, step: null, enumValues: null, secret: false,
  requiresRestart: false, affectsReturns: true, modeScope: SIM_MODES } as const;

export const M10_CONFIG = [
  // A change of set is an `apply_config` command whose risk direction comes from A-M10-05's comparison report (logic 4).
  { ...base, key: 'sim.param_set', type: 'string', riskDirectionOnIncrease: 'neutral', default: 'prior-2026-10', label: 'Simulation parameters',
    description: 'Name of the parameter set file in sim-params/ that fills, failures, sandwiches, gaps and costs are drawn from.' },
  // A larger multiplier is more pessimistic, so raising it lowers risk. Only values of 1 or more exist (gate runs).
  { ...base, key: 'sim.latency_multiplier', type: 'decimal', riskDirectionOnIncrease: 'decreases_risk', min: '1.0', max: '10.0', step: '0.1',
    default: '1.0', label: 'Latency multiplier', description: 'Every simulated latency is multiplied by this (R-4 uses 2).' },
] as const satisfies readonly ConfigFieldDef[];
