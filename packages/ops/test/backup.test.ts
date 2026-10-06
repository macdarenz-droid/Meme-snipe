// OPS-1j: the hourly backup holds the worker's whole bot state (not only its SQLite files), the restore drill and
// the restore check every file of it, and the update gate fails closed while the worker is not active.
// sqlite3 and age are stand-ins here (the CI runner has neither); ops/test/e2e.sh runs the real ones on a host.
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
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
  const r = spawnSync('bash', ['-c', `set -euo pipefail; . "${LIB}/logic.sh"; ${script}`], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ZEROED_LIB: LIB } });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
};

// Stand-ins: sqlite3 copies on .backup and answers the checks; age "encrypts" by copying.
const bin = join(tmp, 'bin');
mkdirSync(bin);
writeFileSync(join(bin, 'sqlite3'), `#!/usr/bin/env bash
[ "$1" = -readonly ] && shift
db="$1"; shift
[ -z "\${ZEROED_TEST_REMOVE_FILE:-}" ] || rm -f -- "$ZEROED_TEST_REMOVE_FILE"
case "$*" in
  *.backup*) [ -z "\${ZEROED_TEST_SNAPSHOT_HOOK:-}" ] || node "$ZEROED_TEST_SNAPSHOT_HOOK" "$ZEROED_BACKUP_SRC"; dest="$*"; dest="\${dest##*.backup \\'}"; cp "$db" "\${dest%\\'}" ;;
  *integrity_check*) echo ok ;;
  *sqlite_schema*) if [ -n "\${ZEROED_TEST_SCHEMA_CHANGED:-}" ] && [ "$db" != "$ZEROED_BACKUP_SRC/ledger.sqlite" ]; then echo changed; else echo trades; fi ;;
  *count*) echo 3 ;;
esac
`);
writeFileSync(join(bin, 'age'), `#!/usr/bin/env bash
if [ "$1" = -d ]; then if [ -n "\${4:-}" ]; then cat "$4"; else cat; fi; elif [ "\${ZEROED_TEST_AGE_FAIL:-}" = 1 ]; then exit 1; else if [ -n "\${4:-}" ]; then cat > "$4"; else cat; fi; fi
`);
chmodSync(join(bin, 'sqlite3'), 0o755);
chmodSync(join(bin, 'age'), 0o755);
// Deterministic filesystem availability; all other stat operations use the real binary.
writeFileSync(join(bin, 'stat'), `#!/usr/bin/env bash
if [ "$1" = -f ] && [ -n "\${ZEROED_TEST_FREE_BYTES:-}" ]; then
  if [ "\${ZEROED_TEST_OUT_FREE_BYTES:-}" != "" ] && [ "\${!#}" = "$ZEROED_BACKUP_OUT" ]; then
    printf '%s:1\\n' "$ZEROED_TEST_OUT_FREE_BYTES"
  else printf '%s:1\\n' "$ZEROED_TEST_FREE_BYTES"; fi
else exec /usr/bin/stat "$@"; fi
`);
chmodSync(join(bin, 'stat'), 0o755);
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
  'entry-seeds.json': '{"trade-1":{"mint":"coin"}}\n',
  'paper.json': '{"attempts":{}}\n',
  'deployer-state.json': JSON.stringify(nodeEval(`import { createHash } from 'node:crypto'; const payload=JSON.stringify({asOf:{slot:{$n:"1"},txIndex:0,ixIndex:0,receivedAt:1},coverage:[],index:{asOf:{slot:{$n:"1"},txIndex:0,ixIndex:0,receivedAt:1}}}); console.log(JSON.stringify({version:1,payload,sha256:createHash('sha256').update(payload).digest('hex')}));`))+'\n',
  'fill-budget.json': '{"day":"2026-10-04","used":3}\n',
  'credits.json': '{"month":"2026-10","used":{"helius":4}}\n',
  'control.json': '{"paused":false,"pausedAtMs":null,"latches":{}}\n',
  'exposure.json': '{"trades":[],"fromMs":0}\n',
  'deployers.jsonl': '{"key":"create:x"}\n',
  'deployers.jsonl.reserve': '\0'.repeat(65536),
  'chain-volume/data-volume-2026-10-03.json': '{"sol":1}\n',
  'open_intents': '0\n',
  'cold_start': '2026-10-04T00:00:00.000Z',
  'clean_stop': '2026-10-04T00:00:00.000Z',
  'planned_restart': '{"cause":"drill","at":1}\n',
  'account.json.tmp': '{"half',
  'journal.jsonl': '{"seq":1}\n',
  'journal.jsonl.reserve': '\0'.repeat(64 * 1024),
  'recorder/units/1/1-2/stats.json': '{}\n',
  'drill.token': 'secret-per-boot',
  // #218 HEAP-GUARD: Node fatal reports carry the host name and network interfaces; never copied off the host.
  'reports/report.20261005.010000.1234.0.001.json': '{"header":{"host":"zeroed-1"}}\n',
};
const BOT_STATE = ['account.json', 'chain-volume/data-volume-2026-10-03.json', 'cold_start', 'control.json', 'credits.json', 'deployer-state.json', 'deployers.jsonl', 'deployers.jsonl.reserve', 'entry-seeds.json', 'exits.json', 'exposure.json', 'fill-budget.json', 'ledger.sqlite', 'paper.json'];

// A checksummed committed WAL frame for stand-in SQLite; real WAL recovery is covered by the offline e2e.
const fixtureWal=(committed=true):Buffer=>{
  const b=Buffer.alloc(32+24+512);b.writeUInt32BE(0x377f0682,0);b.writeUInt32BE(3007000,4);b.writeUInt32BE(512,8);b.writeUInt32BE(1,16);b.writeUInt32BE(2,20);
  let s0=0,s1=0;const checksum=(at:number,size:number)=>{for(let n=at;n<at+size;n+=8){s0=(s0+b.readUInt32LE(n)+s1)>>>0;s1=(s1+b.readUInt32LE(n+4)+s0)>>>0;}};
  checksum(0,24);b.writeUInt32BE(s0,24);b.writeUInt32BE(s1,28);
  b.writeUInt32BE(1,32);b.writeUInt32BE(committed?1:0,36);b.writeUInt32BE(1,40);b.writeUInt32BE(2,44);checksum(32,8);checksum(56,512);b.writeUInt32BE(s0,48);b.writeUInt32BE(s1,52);return b;
};
const stateDir = (name: string, files: Record<string, string> = STATE): string => {
  const dir = join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), rel==='ledger.sqlite-wal'&&body==='wal'?fixtureWal():body);
  }
  return dir;
};

const run = (script: string, args: string[], env: Record<string, string>) => {
  const r = spawnSync('bash', [join(SBIN, script), ...args], { encoding: 'utf8', env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, ZEROED_LIB: LIB, ...env } });
  return { status: r.status, out: r.stdout + r.stderr };
};

/** Runs zeroed-backup on `src`; returns the bundle's path, or the failure. */
const backup = (src: string, out: string, env: Record<string, string> = {}) => {
  const recipients = join(tmp, 'recipients');
  writeFileSync(recipients, 'age1host\n');
  const r = run('zeroed-backup', [], { ZEROED_BACKUP_SRC: src, ZEROED_BACKUP_OUT: out, ZEROED_BACKUP_RECIPIENTS: recipients, ...env });
  const names = r.status === 0 && existsSync(out) ? readdirSync(out).filter((n) => n.endsWith('.tar.age')) : [];
  return { ...r, bundle: names.length === 1 ? join(out, names[0]!) : null };
};

const unpack = (bundle: string): string => {
  const to = mkdtempSync(join(tmp, 'unpacked-'));
  expect(spawnSync('tar', ['-x', '-C', to, '-f', bundle]).status).toBe(0);
  return to;
};

describe('backup: the whole bot state', () => {
  it('lists every bot-state file and leaves out the evidence, the runtime markers, files mid-write and SQLite side files', () => {
    const dir = stateDir('list');
    expect(logic(`backup_files "${dir}"`).out.split('\n')).toEqual(BOT_STATE);
  });

  it("leaves out exactly RUN-1's evidence and runtime files, so a restore is what the host-loss drill restores", () => {
    expect(EVIDENCE_FILES).toEqual(['journal.jsonl', 'journal.jsonl.reserve', 'recorder']);
    const excluded: Record<string, string> = { ...STATE, 'journal.jsonl.reserve': 'zeros' };
    const selected = logic(`backup_files "${stateDir('evidence-excluded', excluded)}"`).out.split('\n');
    expect(selected).toEqual(BOT_STATE);
    for (const rel of [...EVIDENCE_FILES, ...Object.values(STATE_FILES), 'reports/report.20261005.010000.1234.0.001.json', 'account.json.tmp', 'ledger.sqlite-wal']) {
      expect(selected, rel).not.toContain(rel);
    }
    expect(Object.keys(STATE_FILES).sort()).toEqual(['cleanStop', 'drillToken', 'journal', 'openIntents', 'plannedRestart', 'recorder']);
  });

  it("backs up the worker's JSON state byte for byte beside the ledger, with a manifest of every file", () => {
    const src = stateDir('src');
    const out = join(tmp, 'out');
    const r = backup(src, out);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/: 14 file\(s\), 1 recipient\(s\)\./);
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
    expect(r.out).toContain('Backup copy of exits.json is not valid JSON or versioned state.');
  });

  it('backs up nothing on a host whose worker has no state yet', () => {
    const r = backup(join(tmp, 'none'), join(tmp, 'out-none'));
    expect(r.status).toBe(0);
    expect(r.out).toContain('No worker state yet; nothing backed up.');
  });
});

describe('backup disk budget', () => {
  it('backs up only known state paths, excluding reserve markers and unrelated files', () => {
    const src = stateDir('budget-list', { ...STATE, 'journal.jsonl.reserve': 'zeros', 'unrelated.json': '{}', 'debug.log': 'evidence', 'nested/account.json': '{}' });
    expect(logic(`backup_files "${src}"`).out.split('\n')).toEqual(BOT_STATE);
  });

  it('compresses the state before encrypting it', () => {
    const r = backup(stateDir('compressed'), join(tmp, 'compressed-out'));
    expect(r.status, r.out).toBe(0);
    // age's stand-in passes through the plaintext: gzip must already be present.
    expect([...readFileSync(r.bundle!).subarray(0, 2)]).toEqual([0x1f, 0x8b]);
  });

  it('skips below the actual recorder pause line without replacing an existing backup', () => {
    expect(nodeEval("import { DEFAULT_DISK_POLICY } from './packages/worker/src/run/disk.ts'; console.log(JSON.stringify(DEFAULT_DISK_POLICY.recorderPauseBytes))")).toBe(1610612736);
    for (const pause of [1610612736, 2147483648]) {
      const out = join(tmp, `low-${pause}`);
      mkdirSync(out);
      const old = join(out, 'zeroed-20260101T000000Z.tar.age');
      writeFileSync(old, 'good backup');
      const r = backup(stateDir(`low-src-${pause}`), out, { ZEROED_TEST_FREE_BYTES: String(pause - 1), ZEROED_DISK_RECORDER_PAUSE_BYTES: String(pause) });
      expect(r.status, r.out).toBe(0);
      expect(r.out).toContain('Backup skipped:');
      expect(readFileSync(old, 'utf8')).toBe('good backup');
      expect(readdirSync(out)).toEqual(['zeroed-20260101T000000Z.tar.age']);
    }
    expect(read('ops/host/files/etc/systemd/system/zeroed-backup.service')).toContain('EnvironmentFile=-/etc/zeroed/worker.env');
  });

  it('caps the sum of archives, pruning oldest first and preserving the newest existing copy', () => {
    const out = join(tmp, 'cap-out');
    mkdirSync(out);
    const old = 'zeroed-20260101T000000Z.tar.age', recent = 'zeroed-20260102T000000Z.tar.age';
    writeFileSync(join(out, old), Buffer.alloc(180000));
    writeFileSync(join(out, recent), Buffer.alloc(180000));
    const r = backup(stateDir('cap-src'), out, { ZEROED_BACKUP_MAX_BYTES: '262144', ZEROED_BACKUP_SNAPSHOT_BYTES: '131072' });
    expect(r.status, r.out).toBe(0);
    const names = readdirSync(out);
    expect(names).not.toContain(old);
    expect(names).toContain(recent);
    expect(names.reduce((n, f) => n + statSync(join(out, f)).size, 0)).toBeLessThanOrEqual(262144);
    expect(names.filter((f) => f.endsWith('.tar.age'))).toHaveLength(2);
  });

  it('keeps at most 72 compressed encrypted archives', () => {
    const out = join(tmp, 'count-out');
    mkdirSync(out);
    for (let k = 0; k < 74; k++) writeFileSync(join(out, `zeroed-20260101T0000${String(k).padStart(2, '0')}Z.tar.age`), 'old');
    const r = backup(stateDir('count-src'), out);
    expect(r.status, r.out).toBe(0);
    expect(readdirSync(out)).toHaveLength(72);
    expect(readdirSync(out)).not.toContain('zeroed-20260101T000000Z.tar.age');
    expect(readdirSync(out)).toContain('zeroed-20260101T000073Z.tar.age');
  });

  it('checks destination free bytes as well as source bytes, and includes all bounded staging in the floor', () => {
    const pause = 1610612736;
    const floor = pause + 262144 + 65536;
    const env = { ZEROED_BACKUP_MAX_BYTES: '262144', ZEROED_BACKUP_SNAPSHOT_BYTES: '131072', ZEROED_TEST_FREE_BYTES: String(floor) };
    const src = stateDir('separate-disk-src');
    const refused = backup(src, join(tmp, 'separate-disk-low'), { ...env, ZEROED_TEST_OUT_FREE_BYTES: String(floor - 1) });
    expect(refused.status, refused.out).toBe(0);
    expect(refused.out).toContain('Backup skipped:');
    expect(refused.bundle).toBeNull();
    const accepted = backup(src, join(tmp, 'separate-disk-equal'), { ...env, ZEROED_TEST_OUT_FREE_BYTES: String(floor) });
    expect(accepted.status, accepted.out).toBe(0);
    expect(accepted.bundle).not.toBeNull();
    const unknown = backup(src, join(tmp, 'unknown-disk'), { ...env, ZEROED_TEST_OUT_FREE_BYTES: 'unknown' });
    expect(unknown.status, unknown.out).toBe(0);
    expect(unknown.out).toContain('Backup skipped:');
    expect(unknown.bundle).toBeNull();
  });

  it('encrypting a failed candidate publishes nothing and preserves existing state and the newest backup', () => {
    const out = join(tmp, 'encrypt-failed');
    mkdirSync(out);
    const old = 'zeroed-20260101T000000Z.tar.age';
    writeFileSync(join(out, old), 'good backup');
    const src = stateDir('encrypt-failed-src');
    const r = backup(src, out, { ZEROED_TEST_AGE_FAIL: '1' });
    expect(r.status, r.out).toBe(1);
    expect(readdirSync(out)).toEqual([old]);
    expect(readFileSync(join(out, old), 'utf8')).toBe('good backup');
    for (const rel of BOT_STATE) expect(readFileSync(join(src, rel), 'utf8')).toBe(STATE[rel]);
  });

  it('includes the actual streamed saveState path and restores a state the worker loader accepts', () => {
    const src = stateDir('real-saved-state');
    const path = join(src, 'deployer-state.json');
    expect(nodeEval(`
      import { PERSIST_FILE, saveState } from './packages/worker/src/persist/state.ts';
      import { DeployerIndex, RugLabeller } from './packages/core/src/gates/index.ts';
      import { RUG_CONFIG } from './packages/core/src/config/rugs.ts';
      const asOf = { slot: 400000000n, txIndex: 5, ixIndex: 0, receivedAt: 1790000000000 };
      saveState(${JSON.stringify(path)}, { asOf, index: new DeployerIndex().snapshot(asOf), labeller: new RugLabeller(RUG_CONFIG).snapshot(), coverage: [], candidates: [], tails: [] });
      console.log(JSON.stringify({ file: PERSIST_FILE }));
    `)).toEqual({ file: 'deployer-state.json' });
    const r = backup(src, join(tmp, 'real-saved-state-out'));
    expect(r.status, r.out).toBe(0);
    const got = unpack(r.bundle!);
    expect(readFileSync(join(got, 'deployer-state.json'))).toEqual(readFileSync(path));
    expect(nodeEval(`
      import { loadState } from './packages/worker/src/persist/state.ts';
      import { RUG_CONFIG } from './packages/core/src/config/rugs.ts';
      const restored = loadState(${JSON.stringify(join(got, 'deployer-state.json'))}, RUG_CONFIG);
      console.log(JSON.stringify({ ok: restored.ok, version: restored.ok ? restored.version : null, slot: restored.ok ? String(restored.asOf.slot) : null }));
    `)).toEqual({ ok: true, version: 2, slot: '400000000' });
  });

  it('refuses an oversized state snapshot without deleting the last good archive or leaving staging files', () => {
    const out = join(tmp, 'large-out');
    mkdirSync(out);
    const old = 'zeroed-20260101T000000Z.tar.age';
    writeFileSync(join(out, old), 'good backup');
    const r = backup(stateDir('large-src', { ...STATE, 'deployer-state.json': JSON.stringify({ data: randomBytes(100000).toString('hex') }) }), out,
      { ZEROED_BACKUP_MAX_BYTES: '262144', ZEROED_BACKUP_SNAPSHOT_BYTES: '131072' });
    expect(r.status, r.out).toBe(1);
    expect(r.out).toContain('snapshot limit');
    expect(readdirSync(out)).toEqual([old]);
    expect(readFileSync(join(out, old), 'utf8')).toBe('good backup');
  });
});

describe('bounded SQLite scratch and WAL validation',()=>{
  it.each(['torn','checksum','uncommitted'])('rejects %s WAL without publishing a partial backup',kind=>{
    const src=stateDir(`bad-wal-${kind}`),out=join(tmp,`bad-wal-${kind}-out`),wal=fixtureWal(kind!=='uncommitted');
    if(kind==='checksum')wal[wal.length-1]=1;
    writeFileSync(join(src,'ledger.sqlite-wal'),kind==='torn'?wal.subarray(0,wal.length-1):wal);
    const r=backup(src,out);expect(r.status,r.out).toBe(1);expect(r.bundle).toBeNull();expect(readdirSync(out)).toEqual([]);
  });
  it('charges simultaneous SQLite scratch and output against the raw ceiling',()=>{
    const src=stateDir('sqlite-scratch-cap',{'ledger.sqlite':'x'.repeat(70000)}),out=join(tmp,'sqlite-scratch-cap-out');
    const r=backup(src,out,{ZEROED_BACKUP_MAX_BYTES:'262144',ZEROED_BACKUP_SNAPSHOT_BYTES:'131072'});
    expect(r.status,r.out).toBe(1);expect(r.bundle).toBeNull();expect(readdirSync(out)).toEqual([]);
  });
});

describe('whole-capture source generation stability',()=>{
  it.each(['marker-cycle','new-state','state-replacement','wal-only'])('rejects the whole archive after an interleaved %s update',kind=>{
    const files={...STATE};if(kind==='new-state')delete files['credits.json'];
    const src=stateDir(`generation-${kind}`,files), out=join(tmp,`generation-${kind}-out`);mkdirSync(out);
    const old=join(out,'zeroed-20260101T000000Z.tar.age');writeFileSync(old,'last good archive');
    const hook=join(tmp,`generation-${kind}.mjs`);
    const body=kind==='marker-cycle'?`const before=readFileSync(join(src,'deployers.jsonl.reserve'))[0];const s=new DeployerStore(src);s.keep({kind:'market',id:'same-slot-update',key:'pump:CreateEvent:new',moment:{slot:1n,txIndex:0,ixIndex:1,receivedAt:2},value:{event:{name:'CreateEvent',program:'pump',data:{mint:'New',creator:'Creator',timestamp:1n}}}});const after=readFileSync(join(src,'deployers.jsonl.reserve'))[0];if(before!==0||after!==0||s.failing)throw Error('fixture marker did not complete a clean cycle');`:
      kind==='new-state'?`writeFileSync(join(src,'credits.json'),'{}');`:
      kind==='state-replacement'?`writeFileSync(join(src,'exits.json'),'{}\\n');`:
      `const main=readFileSync(join(src,'ledger.sqlite'));appendFileSync(join(src,'ledger.sqlite-wal'),'new committed WAL frame');if(!readFileSync(join(src,'ledger.sqlite')).equals(main))throw Error('main DB changed in WAL-only fixture');`;
    writeFileSync(hook,`import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';import {join} from 'node:path';import {DeployerStore} from ${JSON.stringify(join(root,'packages/worker/src/run/deployer-store.ts'))};const src=process.argv[2];${body}`);
    const result=backup(src,out,{ZEROED_TEST_SNAPSHOT_HOOK:hook});expect(result.status,result.out).toBe(1);expect(result.out).toContain('State changed during capture');expect(result.bundle).toBeNull();expect(readdirSync(out)).toEqual(['zeroed-20260101T000000Z.tar.age']);expect(readFileSync(old,'utf8')).toBe('last good archive');
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
    expect(r.out).toContain('14 file(s) restored to a scratch directory and verified.');
    for (const rel of ['account.json', 'exits.json', 'deployer-state.json', 'fill-budget.json', 'credits.json', 'control.json']) expect(r.out, rel).toContain(`  ${rel}: `);
  });

  it('still drills and restores a legacy uncompressed archive', () => {
    const got = unpack(made.bundle!);
    const legacy = join(tmp, 'legacy.tar.age');
    expect(spawnSync('tar', ['-c', '-C', got, '-f', legacy, '.']).status).toBe(0);
    expect([...readFileSync(legacy).subarray(0, 2)]).not.toEqual([0x1f, 0x8b]);
    const checked = run('zeroed-restore-drill', [id, legacy], { ZEROED_BACKUP_SRC: src, ZEROED_BACKUP_OUT: out });
    expect(checked.status, checked.out).toBe(0);
    const live = stateDir('legacy-live');
    const restored = run('zeroed-restore', [id, legacy], { ZEROED_BACKUP_SRC: live, ZEROED_BACKUP_OUT: out, ZEROED_RESTORE_ASIDE: join(tmp, 'legacy-aside'), ZEROED_RESTORE_DRILL: join(SBIN, 'zeroed-restore-drill') });
    expect(restored.status, restored.out).toBe(0);
    for (const rel of BOT_STATE) expect(readFileSync(join(live, rel), 'utf8')).toBe(STATE[rel]);
    writeFileSync(calls, '');
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
    expect(r.out).toContain('account.json is not valid JSON');
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
    // The old worker's markers went aside with the rest and none came from the backup: updates hold until the
    // restored worker reconciles and writes its own count.
    expect(readdirSync(live)).not.toContain('open_intents');
    expect(readdirSync(live)).not.toContain('clean_stop');
    expect(logic(`if intents_hold inactive "${live}"; then echo hold; else echo go; fi`).out).toBe('hold');
    expect(readFileSync(join(live, 'journal.jsonl'), 'utf8')).toBe('{"seq":1}\n{"seq":2}\n');
    expect(readFileSync(join(live, 'journal.jsonl.reserve'), 'utf8')).toBe(STATE['journal.jsonl.reserve']);
    expect(readFileSync(join(live, 'recorder/units/1/1-2/stats.json'), 'utf8')).toBe('{}\n');
    const [kept] = readdirSync(aside);
    expect(readFileSync(join(aside, kept!, 'account.json'), 'utf8')).toBe('{"newer":true}\n');
    const actions = readFileSync(calls, 'utf8').trimEnd().split('\n');
    expect(actions).toHaveLength(3);
    expect(actions[0]).toMatch(new RegExp(`^chown -R zeroed-worker:zeroed-worker ${tmp}/\\.restore\\.[^/]+/snap$`));
    expect(actions.slice(1)).toEqual(['systemctl stop zeroed-worker.service', 'systemctl start zeroed-worker.service']);
  });

  it('restores nothing and leaves the worker alone when the backup fails the restore drill', () => {
    const live = join(tmp, 'restore-refused');
    cpSync(src, live, { recursive: true });
    writeFileSync(join(live, 'account.json'), '{"newer":true}\n');
    const drill = join(tmp, 'failing-drill');
    writeFileSync(drill, `#!/usr/bin/env bash\necho "drill $*" >> "${calls}"\nexit 1\n`);
    chmodSync(drill, 0o755);
    writeFileSync(calls, '');
    const r = run('zeroed-restore', [id, made.bundle!], { ZEROED_BACKUP_SRC: live, ZEROED_BACKUP_OUT: out, ZEROED_RESTORE_ASIDE: join(tmp, 'aside-refused'), ZEROED_RESTORE_DRILL: drill });
    expect(r.status).toBe(1);
    expect(r.out).toContain('The backup failed the restore drill; nothing restored.');
    expect(readFileSync(calls, 'utf8')).toBe(`drill ${id} ${made.bundle!}\n`);
    expect(readFileSync(join(live, 'account.json'), 'utf8')).toBe('{"newer":true}\n');
    expect(existsSync(join(tmp, 'aside-refused'))).toBe(false);
  });

  it('rechecks the staged SQLite schema before stop even when the external drill reports success',()=>{
    const live=stateDir('restore-schema-changed'),drill=join(tmp,'successful-schema-drill');
    writeFileSync(drill,'#!/usr/bin/env bash\nexit 0\n');chmodSync(drill,0o755);writeFileSync(calls,'');
    const r=run('zeroed-restore',[id,made.bundle!],{ZEROED_BACKUP_SRC:live,ZEROED_BACKUP_OUT:out,ZEROED_RESTORE_ASIDE:join(tmp,'schema-aside'),ZEROED_RESTORE_DRILL:drill,ZEROED_TEST_SCHEMA_CHANGED:'1'});
    expect(r.status,r.out).toBe(1);expect(r.out).toContain('tables differ');expect(readFileSync(calls,'utf8')).toBe('');expect(readFileSync(join(live,'account.json'),'utf8')).toBe(STATE['account.json']);
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

describe('reviewed archive and snapshot failure regressions', () => {
  const id = join(tmp, 'review.key');
  writeFileSync(id, 'synthetic-test-only');
  const bundle = (name: string, bodies: Record<string, string>, extra?: (dir: string) => void) => {
    const dir = stateDir(`review-${name}`, bodies);
    extra?.(dir);
    const sums = spawnSync('sha256sum', Object.keys(bodies), { cwd: dir, encoding: 'utf8' });
    expect(sums.status).toBe(0);
    writeFileSync(join(dir, 'MANIFEST.sha256'), sums.stdout);
    const archive = join(tmp, `${name}.tar.age`);
    expect(spawnSync('tar', ['-cf', archive, '-C', dir, '.']).status).toBe(0);
    return { dir, archive };
  };
  const drill = (archive: string, env: Record<string, string> = {}) => run('zeroed-restore-drill', [id, archive], { ZEROED_BACKUP_SRC: join(tmp, 'review-empty'), ...env });
  it('rejects manifest traversal before any worker stop or outside write', () => {
    const { dir } = bundle('traversal', { 'account.json': '{}' });
    const outside = join(dirname(dir), 'external.json');
    writeFileSync(outside, '{"sentinel":true}');
    writeFileSync(join(dir, 'MANIFEST.sha256'), spawnSync('sha256sum', ['../external.json'], { cwd: dir, encoding: 'utf8' }).stdout);
    const archive = join(tmp, 'traversal-repacked.tar.age');
    expect(spawnSync('tar', ['-cf', archive, '-C', dir, '.']).status).toBe(0);
    writeFileSync(calls, '');
    expect(drill(archive, { TMPDIR: tmp }).status).toBe(1);
    expect(readFileSync(calls, 'utf8')).toBe('');
    expect(readFileSync(outside, 'utf8')).toBe('{"sentinel":true}');
  });
  it('rejects archive symlinks even with a matching target hash', () => {
    const { dir } = bundle('link', { 'account.json': '{}' });
    const target = join(tmp, 'external-target.json');
    writeFileSync(target, '{}');
    rmSync(join(dir, 'account.json')); symlinkSync(target, join(dir, 'account.json'));
    const archive = join(tmp, 'link-repacked.tar.age');
    expect(spawnSync('tar', ['-cf', archive, '-C', dir, '.']).status).toBe(0);
    expect(drill(archive).status).toBe(1);
  });
  it('rejects unmanifested archive members', () => {
    const { archive } = bundle('extra-member', { 'account.json': '{}' }, (dir) => writeFileSync(join(dir, 'paper.json'), '{}'));
    expect(drill(archive).status).toBe(1);
  });
  it('bounds encrypted and expanded plain inputs before extraction', () => {
    const { archive } = bundle('bounded', { 'account.json': JSON.stringify({ data: 'a'.repeat(20000) }) });
    const compressed = join(tmp, 'bounded-gzip.tar.age');
    const gz = spawnSync('gzip', ['-c', archive]); writeFileSync(compressed, gz.stdout);
    expect(drill(archive, { ZEROED_BACKUP_SNAPSHOT_BYTES: '4096' }).status).toBe(1);
    expect(drill(compressed, { ZEROED_BACKUP_SNAPSHOT_BYTES: '4096' }).status).toBe(1);
  });
  it('preserves a released live journal reserve when validating and restoring legacy archives', () => {
    const { archive } = bundle('legacy-reserve', { 'account.json': '{}', 'journal.jsonl.reserve': '\0'.repeat(65536) });
    const live = stateDir('review-reserve-live', { 'account.json': '{"old":true}', 'journal.jsonl': 'live-evidence', 'journal.jsonl.reserve': '' });
    const result = run('zeroed-restore', [id, archive], { ZEROED_BACKUP_SRC: live, ZEROED_RESTORE_ASIDE: join(tmp, 'review-reserve-aside'), ZEROED_RESTORE_DRILL: join(SBIN, 'zeroed-restore-drill') });
    expect(result.status, result.out).toBe(0);
    expect(readFileSync(join(live, 'journal.jsonl.reserve'))).toHaveLength(0);
    expect(readFileSync(join(live, 'journal.jsonl'), 'utf8')).toBe('live-evidence');
  });
  it('fails closed if a selected file disappears after enumeration', () => {
    const src = stateDir('review-disappear');
    const result = backup(src, join(tmp, 'review-disappear-out'), { ZEROED_TEST_REMOVE_FILE: join(src, 'paper.json') });
    expect(result.status, result.out).toBe(1); expect(result.bundle).toBeNull();
  });
  it('fails closed for a symlink at the actual main saved-state path', () => {
    const src = stateDir('review-main-symlink');
    rmSync(join(src, 'deployer-state.json')); symlinkSync(join(tmp, 'external-target.json'), join(src, 'deployer-state.json'));
    const result = backup(src, join(tmp, 'review-main-symlink-out'));
    expect(result.status, result.out).toBe(1); expect(result.bundle).toBeNull();
  });
  it('cannot clear live deployer uncertainty with a clean backup',()=>{
    const {archive}=bundle('clean-deployer-marker',{'deployers.jsonl':'', 'deployers.jsonl.reserve':'\0'.repeat(65536)});
    const live=stateDir('live-dirty-marker',{'account.json':'{"old":true}','deployers.jsonl':'','deployers.jsonl.reserve':'\x01'+'\0'.repeat(65535)});
    const result=run('zeroed-restore',[id,archive],{ZEROED_BACKUP_SRC:live,ZEROED_RESTORE_ASIDE:join(tmp,'live-dirty-aside'),ZEROED_RESTORE_DRILL:join(SBIN,'zeroed-restore-drill')});
    expect(result.status,result.out).toBe(0);expect(readFileSync(join(live,'deployers.jsonl.reserve'))[0]).toBe(1);
  });
  it('restores legacy deployer data without a diagnostic marker as unknown',()=>{
    const {archive}=bundle('legacy-deployer-marker',{'deployers.jsonl':''});
    const live=stateDir('legacy-marker-live',{'account.json':'{}'});
    const result=run('zeroed-restore',[id,archive],{ZEROED_BACKUP_SRC:live,ZEROED_RESTORE_ASIDE:join(tmp,'legacy-marker-aside'),ZEROED_RESTORE_DRILL:join(SBIN,'zeroed-restore-drill')});
    expect(result.status,result.out).toBe(0);const bytes=readFileSync(join(live,'deployers.jsonl.reserve'));expect(bytes).toHaveLength(65536);expect(bytes[0]).toBe(1);
  });
  it('rejects a torn archived marker before stopping the worker',()=>{
    const {archive}=bundle('torn-deployer-marker',{'deployers.jsonl':'','deployers.jsonl.reserve':'\x01'});
    writeFileSync(calls,'');expect(drill(archive).status).toBe(1);expect(readFileSync(calls,'utf8')).toBe('');
  });
  it('preserves archived deployer uncertainty when live state has a clean marker',()=>{
    const {archive}=bundle('dirty-deployer-marker',{'deployers.jsonl':'','deployers.jsonl.reserve':'\x01'+'\0'.repeat(65535)});
    const live=stateDir('clean-marker-live',{'deployers.jsonl':'','deployers.jsonl.reserve':'\0'.repeat(65536)});
    const result=run('zeroed-restore',[id,archive],{ZEROED_BACKUP_SRC:live,ZEROED_RESTORE_ASIDE:join(tmp,'clean-marker-aside'),ZEROED_RESTORE_DRILL:join(SBIN,'zeroed-restore-drill')});
    expect(result.status,result.out).toBe(0);expect(readFileSync(join(live,'deployers.jsonl.reserve'))[0]).toBe(1);
  });
  it.each(['install', 'evidence', 'restart'])('rolls back all prior state and restarts after post-stop %s failure', (phase) => {
    const { archive } = bundle(`rollback-${phase}`, { 'account.json': '{"backup":true}' });
    const live = stateDir(`rollback-${phase}-live`, { 'account.json':'{"old":true}', 'exits.json':'{"pending":true}', 'journal.jsonl':'live-evidence', 'journal.jsonl.reserve':'' });
    const failure = join(tmp, `rollback-${phase}-once`);
    const failbin = join(tmp, `rollback-${phase}-bin`); mkdirSync(failbin);
    writeFileSync(join(failbin,'mv'), `#!/usr/bin/env bash
if [ ! -e "${failure}" ] && { { [ "${phase}" = install ] && [[ "$2" = */snap ]]; } || { [ "${phase}" = evidence ] && [[ "$2" = */journal.jsonl.reserve ]]; }; }; then touch "${failure}"; echo 'No space left on device' >&2; exit 1; fi
exec /usr/bin/mv "$@"
`);
    writeFileSync(join(failbin,'systemctl'), `#!/usr/bin/env bash
echo "systemctl $*" >> "${calls}"
if [ "${phase}" = restart ] && [ "$1" = start ] && [ ! -e "${failure}" ]; then touch "${failure}"; exit 1; fi
`);
    chmodSync(join(failbin,'mv'),0o755); chmodSync(join(failbin,'systemctl'),0o755);
    writeFileSync(calls,'');
    const result=run('zeroed-restore',[id,archive],{ PATH:`${failbin}:${bin}:${process.env['PATH'] ?? ''}`, ZEROED_BACKUP_SRC:live, ZEROED_RESTORE_ASIDE:join(tmp,`rollback-${phase}-aside`), ZEROED_RESTORE_DRILL:join(SBIN,'zeroed-restore-drill') });
    expect(result.status,result.out).toBe(1);
    expect(readFileSync(join(live,'account.json'),'utf8')).toBe('{"old":true}');
    expect(readFileSync(join(live,'exits.json'),'utf8')).toBe('{"pending":true}');
    expect(readFileSync(join(live,'journal.jsonl'),'utf8')).toBe('live-evidence');
    expect(readFileSync(join(live,'journal.jsonl.reserve'))).toHaveLength(0);
    expect(readFileSync(calls,'utf8').trimEnd().split('\n').filter(x=>x.startsWith('systemctl '))).toEqual(phase==='restart'?['systemctl stop zeroed-worker.service','systemctl start zeroed-worker.service','systemctl start zeroed-worker.service']:['systemctl stop zeroed-worker.service','systemctl start zeroed-worker.service']);
  });
  it('rejects a real streamed saved state with the footer removed', () => {
    const src = stateDir('review-state-footer');
    const path = join(src, 'deployer-state.json');
    nodeEval(`import { saveState } from './packages/worker/src/persist/state.ts'; import { DeployerIndex, RugLabeller } from './packages/core/src/gates/index.ts'; import { RUG_CONFIG } from './packages/core/src/config/rugs.ts'; const asOf = {slot:1n,txIndex:0,ixIndex:0,receivedAt:1}; saveState(${JSON.stringify(path)}, {asOf,index:new DeployerIndex().snapshot(asOf),labeller:new RugLabeller(RUG_CONFIG).snapshot(),coverage:[]}); console.log('{}');`);
    writeFileSync(path, readFileSync(path, 'utf8').trimEnd().split('\n').slice(0, -1).join('\n')+'\n');
    const result = backup(src, join(tmp, 'review-state-footer-out'));
    expect(result.status, result.out).toBe(1); expect(result.bundle).toBeNull();
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

  it("common.sh's worker_busy, run in bash: a qualifying dry run or open intents make the worker busy", () => {
    const common = read('ops/host/files/usr/local/lib/zeroed/common.sh');
    const fn = common.slice(common.indexOf('worker_busy() {'), common.indexOf('keys_stored()'));
    expect(fn.split('/var/lib/zeroed').length).toBe(2);
    const busy = (worker: string, dryrun: string, files: Record<string, string>) => {
      const dir = mkdtempSync(join(tmp, 'busy-'));
      for (const [rel, body] of Object.entries(files)) writeFileSync(join(dir, rel), body);
      const ev = mkdtempSync(join(tmp, 'busy-ev-'));
      // systemctl answers is-active for the worker and list-units for the dry-run units.
      const stub = `systemctl() { case "$1" in is-active) printf '%s\\n' "$WORKER" ;; list-units) printf '%s' "$DRYRUN" ;; esac; }`;
      const r = spawnSync('bash', ['-c', `set -euo pipefail; . "${LIB}/logic.sh"; ${stub}; EVIDENCE_ROOT="${ev}"\n${fn.replace('/var/lib/zeroed', dir)}\nif worker_busy; then echo busy; else echo free; fi`], {
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '', WORKER: worker, DRYRUN: dryrun },
      });
      expect(r.status, r.stderr).toBe(0);
      return r.stdout.trim();
    };
    const unit = 'zeroed-dryrun@q1.service loaded active running Zeroed dry run q1\n';
    expect(busy('active', '', { open_intents: '0\n', 'ledger.sqlite': 'x' })).toBe('free');
    expect(busy('inactive', '', {})).toBe('free');
    expect(busy('active', '', { open_intents: '2\n', 'ledger.sqlite': 'x' })).toBe('busy');
    expect(busy('activating', '', { 'ledger.sqlite': 'x' })).toBe('busy');
    expect(busy('failed', '', { open_intents: 'garbage', 'ledger.sqlite': 'x' })).toBe('busy');
    expect(busy('active', unit, { open_intents: '0\n', 'ledger.sqlite': 'x' })).toBe('busy');
  });

  it("zeroed-update's hold, run in bash: a worker down two runs in a row with intents held alerts once, and it clears when the hold lifts", () => {
    const update = read('ops/host/files/usr/local/sbin/zeroed-update');
    const gate = update.slice(update.indexOf('# Fails closed:'), update.indexOf('dest="/opt/zeroed/releases/$commit"'));
    const common = read('ops/host/files/usr/local/lib/zeroed/common.sh');
    const alerts = common.slice(common.indexOf('# alert KEY TEXT'), common.indexOf('}', common.indexOf('alert_clear() {')) + 1);
    const host = mkdtempSync(join(tmp, 'hold-host-'));
    const state = mkdtempSync(join(tmp, 'hold-state-'));
    const sent = join(host, 'sent');
    writeFileSync(join(state, 'ledger.sqlite'), 'x');
    const step = (worker: string, count: string | null) => {
      if (count === null) rmSync(join(state, 'open_intents'), { force: true });
      else writeFileSync(join(state, 'open_intents'), count);
      const before = existsSync(sent) ? readFileSync(sent, 'utf8') : '';
      const body = [
        'set -euo pipefail',
        `. "${LIB}/logic.sh"`,
        `STATE_DIR="${host}"; commit=${'d'.repeat(40)}`,
        'log() { :; }',
        `notify() { printf '%s\\n' "$1" >> "${sent}"; }`,
        "systemctl() { printf '%s\\n' \"$WORKER\"; }",
        alerts,
        gate.replaceAll('/var/lib/zeroed', state),
        'echo PROCEED',
      ].join('\n');
      const r = spawnSync('bash', ['-c', body], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', WORKER: worker } });
      expect(r.status, r.stderr).toBe(0);
      const after = existsSync(sent) ? readFileSync(sent, 'utf8') : '';
      return { proceed: r.stdout.includes('PROCEED'), told: after.slice(before.length).trim() };
    };
    expect(gate.split('/var/lib/zeroed').length).toBeGreaterThan(2);
    const held = (state: string, count: string) =>
      `ALERT Zeroed host: update ${'d'.repeat(12)} is held: the worker is ${state} and its last open-intent count is ${count}. Nothing updates until a worker starts and reconciles. Console steps: ops/README.md, "Updates held by open intents".`;
    // A running worker with intents open: a normal wait, nothing to tell.
    expect(step('active', '2\n')).toEqual({ proceed: false, told: '' });
    // A routine restart (down for one run, then running): never pages.
    expect(step('activating', '2\n')).toEqual({ proceed: false, told: '' });
    expect(step('active', '2\n')).toEqual({ proceed: false, told: '' });
    expect(step('failed', '2\n')).toEqual({ proceed: false, told: '' });
    // Down a second run in a row: one alert naming its state and last count, then silence while it stays down.
    expect(step('failed', '2\n')).toEqual({ proceed: false, told: held('failed', '2') });
    expect(step('activating', null)).toEqual({ proceed: false, told: '' });
    // Back up and still busy: the episode closes; the update keeps waiting.
    expect(step('active', '1\n')).toEqual({ proceed: false, told: `CLEARED Zeroed host: the worker is running again; update ${'d'.repeat(12)} waits for its open intents (1) to finish.` });
    // Down again with no readable count: the grace starts over, then a new episode says "unknown".
    expect(step('inactive', null)).toEqual({ proceed: false, told: '' });
    expect(step('inactive', null)).toEqual({ proceed: false, told: held('inactive', 'unknown') });
    // Reconciled to 0: the update goes ahead and the owner hears the hold is gone.
    expect(step('inactive', '0\n')).toEqual({ proceed: true, told: `CLEARED Zeroed host: no open intents hold update ${'d'.repeat(12)} now.` });
    expect(step('active', '0\n')).toEqual({ proceed: true, told: '' });
    // The run counter starts over once the update went ahead; a counter that is not a plain number counts as 0.
    expect(step('inactive', '1\n')).toEqual({ proceed: false, told: '' });
    expect(step('active', '0\n')).toEqual({ proceed: true, told: '' });
    writeFileSync(join(host, 'intents_hold_down'), '08\n');
    expect(step('inactive', '1\n')).toEqual({ proceed: false, told: '' });
    expect(step('inactive', '1\n')).toEqual({ proceed: false, told: held('inactive', '1') });
  });

  it('the update gate and the safe-restart check both use it, whatever the worker state', () => {
    const update = read('ops/host/files/usr/local/sbin/zeroed-update');
    expect(update).toContain('wstate="$(systemctl is-active zeroed-worker.service 2>/dev/null || true)"\nif intents_hold "$wstate" /var/lib/zeroed; then');
    expect(update).not.toContain('if systemctl is-active --quiet zeroed-worker.service; then');
    const common = read('ops/host/files/usr/local/lib/zeroed/common.sh');
    const busy = common.slice(common.indexOf('worker_busy() {'), common.indexOf('keys_stored()'));
    expect(busy).toContain('intents_hold "$(systemctl is-active zeroed-worker.service 2>/dev/null || true)" /var/lib/zeroed');
    expect(busy).not.toContain('|| return 1');
  });
});
