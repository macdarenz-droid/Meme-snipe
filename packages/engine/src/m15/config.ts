// M15 slot clock config fields (B-M15-01 "Config"; registered by B-M25-01).
import { ALL_MODES, type ConfigFieldDef } from '../m25/fields.ts';

const base = { section: 'm15', unit: 'ms', displayUnit: 'ms', step: '1', enumValues: null, secret: false, requiresRestart: false,
  riskDirectionOnIncrease: 'neutral', affectsReturns: false, modeScope: ALL_MODES } as const;

export const M15_CONFIG = [
  { ...base, key: 'm15.height_poll_ms', type: 'duration_ms', min: '400', max: '10000', default: 2_000, label: 'Height poll',
    description: 'Time between slot and block height reads on the primary provider (10,000 ms in degraded reads).' },
  { ...base, key: 'm15.height_timeout_ms', type: 'duration_ms', min: '200', max: '5000', default: 1_500, label: 'Height read timeout',
    description: 'Time one slot and block height read may take.' },
  { ...base, key: 'm15.max_future_slot_jump', type: 'int', unit: 'slots', displayUnit: 'slots', min: '100', max: '100000', default: 2_000,
    label: 'Slot jump limit', description: 'A context slot this far above the highest seen slot is ignored while another provider agrees with the old value.' },
  { ...base, key: 'm15.slot_ms_initial', type: 'duration_ms', min: '100', max: '1000', default: 267, label: 'Starting slot time',
    description: 'Slot duration used until the first performance samples arrive.' },
] as const satisfies readonly ConfigFieldDef[];
