// M24 config fields (B-M24-01 "Config"; registered by B-M25-01).
import { ALL_MODES, type ConfigFieldDef } from '../m25/fields.ts';

const base = { section: 'm24', unit: null, displayUnit: null, min: null, max: null, step: null, enumValues: null, secret: false,
  requiresRestart: true, riskDirectionOnIncrease: 'neutral', affectsReturns: false, modeScope: ALL_MODES } as const;

export const M24_CONFIG = [
  { ...base, key: 'm24.db_path', type: 'string', label: 'Database file', description: 'SQLite database of the engine (owner bot, mode 0600).',
    default: '/var/lib/bot/bot.db' },
  { ...base, key: 'm24.synchronous', type: 'enum', enumValues: ['FULL'], label: 'SQLite synchronous', default: 'FULL',
    description: 'Durability over speed for money tables; FULL is the only value, so it cannot be changed at run time.' },
] as const satisfies readonly ConfigFieldDef[];
