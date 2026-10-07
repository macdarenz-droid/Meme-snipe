// RC-FIXES: the hourly backup packs the worker's whole state (not only SQLite), leaves out the journal, the recording
// and the deployer index, and the restore drill checks every file it packed.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const BACKUP = join(root, 'ops/host/files/usr/local/sbin/zeroed-backup');
const DRILL = join(root, 'ops/host/files/usr/local/sbin/zeroed-restore-drill');
const has = (b: string) => spawnSync('bash', ['-c', `command -v ${b}`]).status === 0;
const tmp = mkdtempSync(join(tmpdir(), 'rc-backup-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const rig = (name: string) => {
  const base = join(tmp, name);
  const src = join(base, 'state');
  const out = join(base, 'out');
  const bin = join(base, 'bin');
  mkdirSync(join(src, 'recorder', 'boot1'), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(src, 'ledger.sqlite'), 'ledger');
  for (const f of ['control.json', 'account.json', 'exits.json', 'paper.json', 'credits.json', 'fill-budget.json']) writeFileSync(join(src, f), '{"a":1}\n');
  for (const f of ['journal.jsonl', 'journal.jsonl.reserve', 'deployers.jsonl', 'deployer-state.json', 'ledger.sqlite-wal', 'ledger.sqlite-writer.lock', 'credits.json.tmp',
    'clean_stop', 'planned_restart', 'cold_start', 'drill.token', 'last_exit.json', 'refused.json']) writeFileSync(join(src, f), '{}');
  writeFileSync(join(src, 'recorder', 'boot1', 'frames.jsonl'), 'x');
  // sqlite3 is not on every machine: a stand-in that copies for ".backup", answers "ok" to the integrity check and lists
  // no tables.
  writeFileSync(join(bin, 'sqlite3'), `#!/usr/bin/env bash
case "$*" in *".backup '"*) d="\${3#.backup \\'}"; cp "$1" "\${d%\\'}";; *integrity_check*) echo ok;; esac
`);
  chmodSync(join(bin, 'sqlite3'), 0o755);
  const key = join(base, 'id.key');
  spawnSync('age-keygen', ['-o', key]);
  const pub = spawnSync('age-keygen', ['-y', key], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(base, 'recipients'), `${pub}\n`);
  const env = { PATH: `${bin}:${process.env['PATH']}`, ZEROED_BACKUP_SRC: src, ZEROED_BACKUP_OUT: out, ZEROED_BACKUP_RECIPIENTS: join(base, 'recipients') };
  const backup = () => spawnSync('bash', [BACKUP], { encoding: 'utf8', env });
  const list = () => {
    const file = readdirSync(out).find((f) => f.endsWith('.tar.age'))!;
    return spawnSync('bash', ['-c', 'age -d -i "$1" "$2" | tar -t', 'x', key, join(out, file)], { encoding: 'utf8' }).stdout
      .split('\n').map((l) => l.replace(/^\.\//, '')).filter((l) => l !== '' && !l.endsWith('/')).sort();
  };
  const drill = () => spawnSync('bash', [DRILL, key], { encoding: 'utf8', env });
  const extract = (rel: string) => {
    const file = readdirSync(out).find((f) => f.endsWith('.tar.age'))!;
    return spawnSync('bash', ['-c', 'age -d -i "$1" "$2" | tar -xO "./$3"', 'x', key, join(out, file), rel], { encoding: 'utf8' }).stdout;
  };
  return { src, out, bin, backup, list, drill, extract };
};

describe.skipIf(!has('age') || !has('age-keygen'))('RC-FIXES: zeroed-backup packs the whole state', () => {
  it('every state file and the ledger; never the journal, the recording, the deployer store (deployers.jsonl), WAL, locks, temp files or one-boot markers; the graduates series (deployer-state.json) is kept', () => {
    const r = rig('whole');
    const b = r.backup();
    expect(b.status, b.stderr + b.stdout).toBe(0);
    expect(r.list()).toEqual(['MANIFEST.sha256', 'account.json', 'control.json', 'credits.json', 'deployer-state.json', 'exits.json', 'fill-budget.json', 'ledger.sqlite', 'paper.json']);
    const d = r.drill();
    expect(d.status, d.stdout).toBe(0);
    expect(d.stdout).toContain('8 file(s) (1 database(s))');
  });

  it('the ledger and its state files are one cut: a write while the ledger is copied makes it copy them again', () => {
    const r = rig('cut');
    // The first ".backup" writes account.json (the worker booking a fill meanwhile); later ones do not.
    writeFileSync(join(r.bin, 'sqlite3'), `#!/usr/bin/env bash
case "$*" in *".backup '"*) d="\${3#.backup \\'}"; cp "$1" "\${d%\\'}"; [ -f "${r.src}/../once" ] || { touch "${r.src}/../once"; printf '{"a":2}\\n' > "${r.src}/account.json"; };; *integrity_check*) echo ok;; esac
`);
    const b = r.backup();
    expect(b.status, b.stderr + b.stdout).toBe(0);
    expect(r.extract('account.json')).toBe('{"a":2}\n');
  });

  it('the restore drill fails a state file that does not parse', () => {
    const r = rig('bad-json');
    writeFileSync(join(r.src, 'account.json'), '{"cut');
    expect(r.backup().status).toBe(0);
    const d = r.drill();
    expect(d.status).not.toBe(0);
    expect(d.stdout).toContain('account.json is not valid JSON');
  });
});
