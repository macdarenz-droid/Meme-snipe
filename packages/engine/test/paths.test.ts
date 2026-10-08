// PATHS-FIX (DISK-BUDGET.md §2.9, ruling 6): every place the engine writes sits inside what zeroed-worker.service may
// write under ProtectSystem=strict: its StateDirectory or one of its ReadWritePaths. Read from the unit file itself.
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'vitest';
import { M24_CONFIG } from '../src/m24/config.ts';
import { M27_CONFIG } from '../src/m27/config.ts';
import { ENGINE_PATHS, MD_DIR, SPOOL_DIR, STATE_DIR, USAGE_DIR, writerLockPath } from '../src/paths.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const UNIT = readFileSync(join(ROOT, 'ops/host/files/etc/systemd/system/zeroed-worker.service'), 'utf8');

/** The folders the unit may write: /var/lib/<StateDirectory> and each ReadWritePaths entry ("-" prefix dropped). */
function writable(unit: string): string[] {
  const values = (key: string) => unit.split('\n').filter((l) => l.startsWith(`${key}=`)).flatMap((l) => l.slice(key.length + 1).trim().split(/\s+/)).filter(Boolean);
  return [...values('StateDirectory').map((d) => `/var/lib/${d}`), ...values('ReadWritePaths').map((p) => p.replace(/^-/, ''))];
}
const inside = (path: string, roots: readonly string[]) => roots.some((r) => path === r || path.startsWith(`${r}/`));
const def = (fields: readonly { key: string; default: unknown }[], key: string) => String(fields.find((f) => f.key === key)?.default);

describe('engine write paths (PATHS-FIX)', () => {
  const roots = writable(UNIT);

  it('the unit writes exactly its state folder and the three installer-made folders', () => {
    assert.deepEqual([...roots].sort(), [MD_DIR, SPOOL_DIR, STATE_DIR, USAGE_DIR].sort());
    assert.match(UNIT, /^ProtectSystem=strict$/m);
  });

  it('every engine write path and every path default in the config sits inside a writable folder', () => {
    const paths: Record<string, string> = {
      ...ENGINE_PATHS,
      writerLock: writerLockPath(ENGINE_PATHS.db),
      'm24.db_path': def(M24_CONFIG, 'm24.db_path'),
      'm27.log_dir': def(M27_CONFIG, 'm27.log_dir'),
    };
    for (const [name, path] of Object.entries(paths)) assert.ok(inside(path, roots), `${name}: ${path} is outside ${roots.join(', ')}`);
  });

  it('the config defaults are the registry\'s', () => {
    assert.equal(def(M24_CONFIG, 'm24.db_path'), ENGINE_PATHS.db);
    assert.equal(def(M27_CONFIG, 'm27.log_dir'), ENGINE_PATHS.logDir);
  });

  it('the private state stays out of the folders others can read', () => {
    for (const k of ['db', 'preMigrationBackup', 'initMarker', 'recoveryDir', 'diskReserve', 'logDir'] as const) {
      assert.ok(inside(ENGINE_PATHS[k], [STATE_DIR]), k);
    }
    // zeroed-backup copies every *.db / *.sqlite under the state folder; the pre-migration copy must not match.
    assert.doesNotMatch(ENGINE_PATHS.preMigrationBackup, /\.(db|sqlite)$/);
  });
});
