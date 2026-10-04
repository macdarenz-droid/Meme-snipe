// OPS-1j: the hourly backup holds the worker's whole bot state (not only its SQLite files), the restore drill and
// the restore check every file of it, and the update gate fails closed while the worker is not active.
// sqlite3 and age are stand-ins here (the CI runner has neither); ops/test/e2e.sh runs the real ones on a host.
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const LIB = join(root, 'ops/host/files/usr/local/lib/zeroed');
const SBIN = join(root, 'ops/host/files/usr/local/sbin');
const tmp = mkdtempSync(join(tmpdir(), 'zeroed-backup-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Runs `code` as an ES module under Node with the repo's TypeScript sources (this package's tsconfig stays its own). */
const nodeEval = (code: string): unknown => {
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', code], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};
const contract = nodeEval("import { EVIDENCE_FILES, STATE_FILES } from './packages/runner/src/contract.ts'; console.log(JSON.stringify({ EVIDENCE_FILES, STATE_FILES }))") as { EVIDENCE_FILES: string[]; STATE_FILES: Record<string, string> };
const { EVIDENCE_FILES, STATE_FILES } = contract;

const logic = (script: string) => {
  const r = spawnSync('bash', ['-c', `set -euo pipefail; . "${LIB}/logic.sh"; ${script}`], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
};

// Stand-ins: sqlite3 copies on .backup and answers the checks; age "encrypts" by copying.
const bin = join(tmp, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'sqlite3'), `#!/usr/bin/env bash
[ "$1" = -readonly ] && shift
db="$1"; shift
case "$*" in
  *.backup*) dest="$*"; dest="\${dest##*.backup \\'}"; cp "$db" "\${dest%\\'}" ;;
  *integrity_check*) echo ok ;;
  *sqlite_schema*) echo trades ;;
  *count*) echo 3 ;;
esac
`);
writeFileSync(join(bin, 'age'), `#!/usr/bin/env bash
if [ "$1" = -d ]; then cat "$4"; else cat > "$4"; fi
`);
chmodSync(join(bin, 'sqlite3'), 0o755);
chmodSync(join(bin, 'age'), 0o755);
// systemctl and chown stand-ins log their calls.
const calls = join(tmp, 'calls');
for (const name of ['systemctl', 'chown']) {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${calls}"\n`);
  chmodSync(join(bin, name), 0o755);
}

/** A worker state dir as the real worker leaves it (worker/src/run/state.ts, account.ts, runner contract). */
const STATE: Record<string, string> = {
  'ledger.sqlite': 'SQLite format 3\0 ledger',
  'ledger.sqlite-wal': 'wal',
  'account.json': '{"openedAtMs":1,"openingEquity":{"$n":"20000000"},"trades":[],"entries":[]}\n',
  'exits.json': '{}\n',
  'deployer-state.json': '{"v":1}\n',
  'fill-budget.json': '{"day":"2026-10-04","used":3}\n',
  'credits.json': '{"month":"2026-10","used":{"helius":4}}\n',
  'control.json': '{"paused":false,"pausedAtMs":null,"latches":{}}\n',
  'exposure.json': '{"trades":[],"fromMs":0}\n',
  'deployers.jsonl': '{"key":"create:x"}\n',
  'chain-volume/2026-10-03.json': '{"sol":1}\n',
  'open_intents': '0\n',
  'cold_start': '2026-10-04T00:00:00.000Z',
  'account.json.tmp': '{"half',
  'journal.jsonl': '{"seq":1}\n',
  'recorder/units/1/1-2/stats.json': '{}\n',
  'drill.token': 'secret-per-boot',
};
const BOT_STATE = ['account.json', 'chain-volume/2026-10-03.json', 'cold_start', 'control.json', 'credits.json', 'deployer-state.json', 'deployers.jsonl', 'exits.json', 'exposure.json', 'fill-budget.json', 'ledger.sqlite', 'open_intents'];

const stateDir = (name: string, files: Record<string, string> = STATE): string => {
  const dir = join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
};

const run = (script: string, args: string[], env: Record<string, string>) => {
  const r = spawnSync('bash', [join(SBIN, script), ...args], { encoding: 'utf8', env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, ZEROED_LIB: LIB, ...env } });
  return { status: r.status, out: r.stdout + r.stderr };
};

/** Runs zeroed-backup on `src`; returns the bundle's path, or the failure. */
const backup = (src: string, out: string) => {
  const recipients = join(tmp, 'recipients');
  writeFileSync(recipients, 'age1host\n');
  const r = run('zeroed-backup', [], { ZEROED_BACKUP_SRC: src, ZEROED_BACKUP_OUT: out, ZEROED_BACKUP_RECIPIENTS: recipients });
  const names = r.status === 0 && existsSync(out) ? readdirSync(out).filter((n) => n.endsWith('.tar.age')) : [];
  return { ...r, bundle: names.length === 1 ? join(out, names[0]!) : null };
};

const unpack = (bundle: string): string => {
  const to = mkdtempSync(join(tmp, 'unpacked-'));
  expect(spawnSync('tar', ['-x', '-C', to, '-f', bundle]).status).toBe(0);
  return to;
};

describe('backup: the whole bot state', () => {
  it('lists every bot-state file and leaves out the evidence, the drill token, files mid-write and SQLite side files', () => {
    const dir = stateDir('list');
    expect(logic(`backup_files "${dir}"`).out.split('\n')).toEqual(BOT_STATE);
  });

  it("leaves out exactly RUN-1's evidence and runtime files, so a restore is what the host-loss drill restores", () => {
    const fn = read('ops/host/files/usr/local/lib/zeroed/logic.sh');
    const body = fn.slice(fn.indexOf('backup_files() {'), fn.indexOf('intents_hold() {'));
    expect(EVIDENCE_FILES).toEqual(['journal.jsonl', 'recorder']);
    expect(body).toContain(`! -path ./${STATE_FILES.journal}`);
    expect(body).toContain(`! -path './${STATE_FILES.recorder}/*'`);
    expect(body).toContain(`! -path ./${STATE_FILES.drillToken}`);
  });

  it("backs up the worker's JSON state byte for byte beside the ledger, with a manifest of every file", () => {
    const src = stateDir('src');
    const out = join(tmp, 'out');
    const r = backup(src, out);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/: 12 file\(s\), 1 recipient\(s\)\./);
    const got = unpack(r.bundle!);
    for (const rel of BOT_STATE) expect(readFileSync(join(got, rel), 'utf8'), rel).toBe(STATE[rel]);
    const manifest = readFileSync(join(got, 'MANIFEST.sha256'), 'utf8').trim().split('\n').map((l) => l.split(/\s+/)[1]);
    expect(manifest).toEqual(BOT_STATE);
    for (const left of ['journal.jsonl', 'recorder', 'drill.token', 'account.json.tmp', 'ledger.sqlite-wal']) expect(readdirSync(got), left).not.toContain(left);
  });

  it('refuses a JSON state file that does not parse instead of backing it up', () => {
    const src = stateDir('torn', { ...STATE, 'exits.json': '{"a":' });
    const r = backup(src, join(tmp, 'out-torn'));
    expect(r.status).toBe(1);
    expect(r.out).toContain('Backup copy of exits.json is not valid JSON.');
  });

  it('backs up nothing on a host whose worker has no state yet', () => {
    const r = backup(join(tmp, 'none'), join(tmp, 'out-none'));
    expect(r.status).toBe(0);
    expect(r.out).toContain('No worker state yet; nothing backed up.');
  });
});

describe('restore drill and restore', () => {
  const src = stateDir('drill-src');
  const out = join(tmp, 'drill-out');
  const made = backup(src, out);
  const id = join(tmp, 'host.key');
  writeFileSync(id, 'AGE-SECRET-KEY-TEST\n');

  it('the drill checks and lists every restored file, JSON state included', () => {
    expect(made.status, made.out).toBe(0);
    const r = run('zeroed-restore-drill', [id, made.bundle!], { ZEROED_BACKUP_SRC: src, ZEROED_BACKUP_OUT: out });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('PASS: ');
    expect(r.out).toContain('12 file(s) restored to a scratch directory and verified.');
    for (const rel of ['account.json', 'exits.json', 'deployer-state.json', 'fill-budget.json', 'credits.json', 'control.json']) expect(r.out, rel).toContain(`  ${rel}: `);
  });

  it('the drill fails a backup whose JSON state does not parse, even with a matching manifest', () => {
    const bad = unpack(made.bundle!);
    writeFileSync(join(bad, 'account.json'), '{"x":');
    const sums = spawnSync('bash', ['-c', `cd "${bad}" && sha256sum -- $(awk '{print $2}' MANIFEST.sha256) > MANIFEST.new && mv MANIFEST.new MANIFEST.sha256`]);
    expect(sums.status).toBe(0);
    const tampered = join(tmp, 'bad.tar.age');
    expect(spawnSync('tar', ['-c', '-C', bad, '-f', tampered, '.']).status).toBe(0);
    const r = run('zeroed-restore-drill', [id, tampered], { ZEROED_BACKUP_SRC: src, ZEROED_BACKUP_OUT: out });
    expect(r.status).toBe(1);
    expect(r.out).toContain('FAIL: account.json is not valid JSON');
  });

  it('the restore puts the whole bot state back, keeps the evidence and moves what was there aside', () => {
    const live = join(tmp, 'restore-live');
    cpSync(src, live, { recursive: true });
    writeFileSync(join(live, 'account.json'), '{"newer":true}\n');
    writeFileSync(join(live, 'stray.json'), '{}\n');
    writeFileSync(join(live, 'journal.jsonl'), '{"seq":1}\n{"seq":2}\n');
    const aside = join(tmp, 'aside');
    const r = run('zeroed-restore', [id, made.bundle!], { ZEROED_BACKUP_SRC: live, ZEROED_BACKUP_OUT: out, ZEROED_RESTORE_ASIDE: aside, ZEROED_RESTORE_DRILL: join(SBIN, 'zeroed-restore-drill') });
    expect(r.status, r.out).toBe(0);
    for (const rel of BOT_STATE) expect(readFileSync(join(live, rel), 'utf8'), rel).toBe(STATE[rel]);
    expect(readdirSync(live)).not.toContain('stray.json');
    expect(readdirSync(live)).not.toContain('MANIFEST.sha256');
    expect(readFileSync(join(live, 'journal.jsonl'), 'utf8')).toBe('{"seq":1}\n{"seq":2}\n');
    expect(readFileSync(join(live, 'recorder/units/1/1-2/stats.json'), 'utf8')).toBe('{}\n');
    const [kept] = readdirSync(aside);
    expect(readFileSync(join(aside, kept!, 'account.json'), 'utf8')).toBe('{"newer":true}\n');
    expect(readFileSync(calls, 'utf8')).toBe(`systemctl stop zeroed-worker.service\nchown -R zeroed-worker:zeroed-worker ${live}\nsystemctl start zeroed-worker.service\n`);
  });

  it('a backup without control.json restores with entries paused, in the form the worker reads', () => {
    const { 'control.json': _dropped, ...rest } = STATE;
    const noCtl = stateDir('restore-noctl-src', rest);
    const made2 = backup(noCtl, join(tmp, 'noctl-out'));
    expect(made2.status, made2.out).toBe(0);
    const live = join(tmp, 'restore-noctl-live');
    cpSync(src, live, { recursive: true });
    const r = run('zeroed-restore', [id, made2.bundle!], { ZEROED_BACKUP_SRC: live, ZEROED_BACKUP_OUT: join(tmp, 'noctl-out'), ZEROED_RESTORE_ASIDE: join(tmp, 'aside2'), ZEROED_RESTORE_DRILL: join(SBIN, 'zeroed-restore-drill') });
    expect(r.status, r.out).toBe(0);
    expect(r.out).toContain('The backup had no control.json, so entries start paused.');
    // Read back with the worker's own reader: it throws on a file it does not accept.
    const { ctl, none } = nodeEval(`import { controlFile, NO_CONTROL } from './packages/worker/src/run/state.ts'; import { NO_LATCHES } from './packages/core/src/risk/types.ts'; console.log(JSON.stringify({ ctl: controlFile(${JSON.stringify(live)}).read(NO_CONTROL), none: NO_LATCHES }))`) as { ctl: { paused: boolean; pausedAtMs: unknown; latches: unknown }; none: unknown };
    expect(ctl.paused).toBe(true);
    expect(typeof ctl.pausedAtMs).toBe('number');
    expect(ctl.latches).toEqual(none);
  });
});

describe('open intents hold updates and restarts, fail closed', () => {
  const hold = (active: string, files: Record<string, string>) => {
    const dir = mkdtempSync(join(tmp, 'intents-'));
    for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
    return logic(`if intents_hold ${active} "${dir}"; then echo hold; else echo go; fi`).out;
  };

  it('an active worker must report exactly 0', () => {
    expect(hold('active', { open_intents: '0\n' })).toBe('go');
    expect(hold('active', { open_intents: '2\n' })).toBe('hold');
    expect(hold('active', { open_intents: '' })).toBe('hold');
    expect(hold('active', {})).toBe('hold');
  });

  it('a worker that is starting, reconciling, restarting or stopped holds unless its last count is 0', () => {
    for (const state of ['activating', 'deactivating', 'inactive', 'failed', 'unknown']) {
      expect(hold(state, { open_intents: '1\n', 'ledger.sqlite': 'x' }), state).toBe('hold');
      expect(hold(state, { open_intents: 'garbage', 'ledger.sqlite': 'x' }), state).toBe('hold');
      expect(hold(state, { 'ledger.sqlite': 'x' }), state).toBe('hold');
      expect(hold(state, { open_intents: '0\n', 'ledger.sqlite': 'x' }), state).toBe('go');
    }
  });

  it('a count that cannot be read holds', () => {
    const dir = mkdtempSync(join(tmp, 'unreadable-'));
    mkdirSync(join(dir, 'open_intents'));
    expect(logic(`if intents_hold activating "${dir}"; then echo hold; else echo go; fi`).out).toBe('hold');
  });

  it('a new host with no worker state at all does not hold', () => {
    expect(hold('inactive', {})).toBe('go');
  });

  it('the update gate and the safe-restart check both use it, whatever the worker state', () => {
    const update = read('ops/host/files/usr/local/sbin/zeroed-update');
    expect(update).toContain('if intents_hold "$(systemctl is-active zeroed-worker.service 2>/dev/null || true)" /var/lib/zeroed; then');
    expect(update).not.toContain('if systemctl is-active --quiet zeroed-worker.service; then');
    const common = read('ops/host/files/usr/local/lib/zeroed/common.sh');
    const busy = common.slice(common.indexOf('worker_busy() {'), common.indexOf('keys_stored()'));
    expect(busy).toContain('intents_hold "$(systemctl is-active zeroed-worker.service 2>/dev/null || true)" /var/lib/zeroed');
    expect(busy).not.toContain('|| return 1');
  });
});
