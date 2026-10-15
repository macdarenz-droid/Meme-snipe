// M07 recorder config (SPEC-A A-M07-02 and A-M07-03 "Config"; card Z08, rulings Z08-3 and Z08-4). Registered in
// m25/registry.ts. The byte cap and free floor are DISKBUDGET ruling 2's; retention is 7 days for receipted segments
// only (unreceipted data is never deleted).
import { ALL_MODES, type ConfigFieldDef } from '../m25/fields.ts';
import { ENGINE_PATHS } from '../paths.ts';
import { DEFAULT_DISK_POLICY, GIB } from './disk.ts';

const base = { section: 'recorder', unit: null, displayUnit: null, min: null, max: null, step: null, enumValues: null, secret: false,
  requiresRestart: true, riskDirectionOnIncrease: 'neutral', affectsReturns: false, modeScope: ALL_MODES } as const;

export const M07_CONFIG = [
  { ...base, key: 'recorder.data_dir', type: 'string', default: ENGINE_PATHS.mdDir, label: 'Recorder folder',
    description: 'Market-data segments, manifests and receipts (PATHS-FIX).' },
  { ...base, key: 'recorder.flush_ms', type: 'duration_ms', unit: 'ms', displayUnit: 'ms', min: '1000', max: '60000', step: '1', default: 10_000,
    label: 'Recorder flush', description: 'A crash loses at most this much recording.' },
  { ...base, key: 'recorder.codec_preference', type: 'enum', enumValues: ['gzip', 'zstd'], default: 'gzip', label: 'Recorder codec',
    description: 'gzip; a zstd preference falls back to gzip on this Node.' },
  { ...base, key: 'recorder.retention_days', type: 'int', min: '7', max: '365', step: '1', default: DEFAULT_DISK_POLICY.retentionDays, label: 'Pulled segment days',
    description: 'Days a pulled and verified segment stays on the host. Segments not pulled are never deleted.' },
  { ...base, key: 'recorder.disk_warn_pct', type: 'int', min: '50', max: '98', step: '1', default: DEFAULT_DISK_POLICY.warnPct, label: 'Disk clean-up at',
    description: 'Disk use (percent) above which the oldest pulled segments are deleted.' },
  { ...base, key: 'recorder.disk_stop_pct', type: 'int', min: '51', max: '99', step: '1', default: DEFAULT_DISK_POLICY.stopPct, label: 'Disk stop at',
    description: 'Disk use (percent) above which recording stops, except the manifest and coverage.' },
  { ...base, key: 'recorder.max_bytes', type: 'int', unit: 'bytes', displayUnit: 'bytes', min: String(GIB), max: String(40 * GIB), step: '1', default: DEFAULT_DISK_POLICY.maxBytes,
    label: 'Recorder size cap', description: 'Segments on the host above this size stop recording once no pulled segment is left to delete.' },
  { ...base, key: 'recorder.min_free_bytes', type: 'int', unit: 'bytes', displayUnit: 'bytes', min: String(GIB), max: String(20 * GIB), step: '1', default: DEFAULT_DISK_POLICY.minFreeBytes,
    label: 'Free disk floor', description: 'Free space below this stops recording once no pulled segment is left to delete.' },
  { ...base, key: 'recorder.disk_check_ms', type: 'duration_ms', unit: 'ms', displayUnit: 'ms', min: '10000', max: '600000', step: '1', default: 60_000,
    label: 'Disk check', description: 'How often disk use and receipts are checked.' },
  { ...base, key: 'recorder.research_pubkey', type: 'string', default: '/etc/bot/research-ed25519.pub.pem', label: 'Research key',
    description: 'Root-owned public key that signs pull receipts.' },
] as const satisfies readonly ConfigFieldDef[];
