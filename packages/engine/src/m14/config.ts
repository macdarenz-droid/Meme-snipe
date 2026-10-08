// M14 config fields (A-M14-01 and A-M14-02 "Config"; registered by B-M25-01) and the settings the gateway reads from
// the active config. Z03 wiring of the C03 port onto M25. `rpc.providers` is a list of objects (`ProviderConfig`),
// which the M25 field types (frozen `ConfigFieldSchema`) cannot hold, so the list is a root-owned JSON file named by
// `rpc.providers_file` and validated by `loadProviders` (providers.ts); URLs stay in the secret store either way.
import { ALL_MODES, type ConfigFieldDef } from '../m25/fields.ts';
import { DEFAULT_MAX_RESPONSE_BYTES } from './client.ts';
import { DEFAULT_P0_RESERVE_BPS, DEFAULT_TIMEOUT_MS } from './gateway.ts';
import { MAX_TIMER_MS } from './timers.ts';
import type { Priority } from './types.ts';

const base = { section: 'rpc', unit: null, displayUnit: null, min: null, max: null, step: null, enumValues: null, secret: false,
  requiresRestart: true, riskDirectionOnIncrease: 'neutral', affectsReturns: false, modeScope: ALL_MODES } as const;
const MIB = 1_048_576;
const timeout = (p: Priority) => ({
  ...base, key: `rpc.default_timeout_ms.p${p}`, type: 'duration_ms', unit: 'ms', displayUnit: 'ms', min: '100', max: String(MAX_TIMER_MS), step: '1',
  default: DEFAULT_TIMEOUT_MS[p], label: `P${p} read timeout`, description: `Default time a P${p} call may wait and run before it fails.`,
}) as const;

export const M14_CONFIG = [
  { ...base, key: 'rpc.providers_file', type: 'string', default: '/etc/bot/rpc-providers.json', label: 'RPC providers file',
    description: 'JSON list of RPC providers (labels, roles, limits, documented limits). URLs and keys stay in the secret store.' },
  { ...base, key: 'rpc.max_response_bytes', type: 'int', unit: 'bytes', displayUnit: 'bytes', min: String(MIB), max: String(1_024 * MIB), step: '1',
    default: DEFAULT_MAX_RESPONSE_BYTES, label: 'RPC answer size cap', description: 'A larger answer is cut off and the call fails (too_large).' },
  { ...base, key: 'rpc.p0_reserve_bps', type: 'bps', unit: 'bps', displayUnit: 'bps', min: '1000', max: '5000', step: '1',
    default: DEFAULT_P0_RESERVE_BPS, label: 'P0 reserve', description: 'Share of every provider rate kept for exit-critical (P0) reads.' },
  timeout(0), timeout(1), timeout(2), timeout(3), timeout(4),
  { ...base, key: 'rpc.send_enabled', type: 'bool', riskDirectionOnIncrease: 'increases_risk', modeScope: ['live_small', 'live'], default: false,
    label: 'RPC sends', description: 'Off until the send path is built (M4); while off, every send call is refused before any request.' },
] as const satisfies readonly ConfigFieldDef[];
