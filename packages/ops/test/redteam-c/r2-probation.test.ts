// RC-R2-3 probation cases, on the same harness as r2-late-crash.test.ts (red team C round 2). Original note: a release whose worker passes the trial start (worker-smoke, 30 s hold) and the switch
// hold (zeroed-update holds(), 30 s with no restart), then crashes at minute 10 and every 10 minutes after. systemd
// restarts it (Restart=always, RestartSec=5): one restart per 600 s never reaches StartLimitBurst=10 in
// StartLimitIntervalSec=600, so the unit never fails. The real zeroed-update and zeroed-check run here with systemd,
// curl, git, sleep and the alert channel stood in (paths moved under a scratch root); the watchdog's own checks
// (packages/ops/src/watchdog/logic.ts evaluate) see the heartbeats such a worker sends. Correct behaviour: some gate
// notices (an alert, a rollback, or the release no longer marked deployed). Fails on the current code.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const FILES = join(repo, 'ops/host/files');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
let root = '';
let bin = '';
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const exe = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
const relocate = (text: string) => text
  .replace('. /usr/local/lib/zeroed/common.sh', `. "${root}/common.sh"`)
  .replaceAll('/usr/local/lib/zeroed/worker-smoke', `${bin}/worker-smoke`)
  .replaceAll('/opt/zeroed', `${root}/opt/zeroed`)
  .replaceAll('/var/lib/zeroed-record-upload', `${root}/var/lib/zeroed-record-upload`)
  .replaceAll('/var/lib/zeroed/', `${root}/var/lib/zeroed/`)
  .replaceAll('GNUPGHOME=/etc/zeroed/gnupg ', '');

const setup = (): void => {
  root = mkdtempSync(join(tmpdir(), 'r2-probation-'));
  roots.push(root);
  bin = join(root, 'bin');
  mkdirSync(bin, { recursive: true });
  for (const d of ['state', 'cred', 'var/lib/zeroed', 'sd', `opt/zeroed/releases/${A}/ops`, `opt/zeroed/releases/${B}/ops`, 'opt/zeroed/repo', 'ev']) mkdirSync(join(root, d), { recursive: true });
  for (const c of [A, B]) writeFileSync(join(root, `opt/zeroed/releases/${c}/ops/host-config.json`), '{"worker":"release"}');
  symlinkSync(join(root, `opt/zeroed/releases/${A}`), join(root, 'opt/zeroed/current'));
  writeFileSync(join(root, 'state/deployed'), `${A}\n`);
  writeFileSync(join(root, 'var/lib/zeroed/open_intents'), '0');
  writeFileSync(join(root, 'var/lib/zeroed/open_positions'), '0');
  writeFileSync(join(root, 'cred/helius_api_key'), 'x');
  writeFileSync(join(root, 'sd/nrestarts'), '0');
  writeFileSync(join(root, 'sd/health_sha'), B);
  writeFileSync(join(root, 'common.sh'), `
. "${FILES}/usr/local/lib/zeroed/logic.sh"
CRED_DIR="${root}/cred"; STATE_DIR="${root}/state"; PAIR_CODE_FILE="${root}/pair-code"
EVIDENCE_ROOT="${root}/ev"; EVIDENCE_INDEX="${root}/ev-index/evidence.json"
ZEROED_BRANCH=main; ZEROED_REPO=o/r; ZEROED_API_URL=http://127.0.0.1:9; WEB_FLOW_FPR=FPR
log() { printf '%s\\n' "$*" >> "${root}/log"; }
lock() { :; }
notify() { printf '%s\\n' "$1" >> "${root}/notify"; }
alert() { printf '%s|%s\\n' "$1" "$2" >> "${root}/alerts"; }
alert_clear() { :; }
keys_stored() { return 1; }
paired() { return 1; }
worker_ready() { [ -s "$CRED_DIR/helius_api_key" ]; }
commit_verdict() { cat >/dev/null; echo green; }
e2e_commit() { echo "$2"; }
`);
  exe('git', `case "$*" in
  *rev-parse*) echo ${B} ;;
  *verify-commit*) echo '[GNUPG:] GOODSIG x'; echo '[GNUPG:] VALIDSIG a b c d e f g h i FPR' ;;
  *) exit 0 ;;
esac`);
  exe('worker-smoke', 'exit 0');
  exe('sleep', 'exit 0');
  writeFileSync(join(root, 'sd/now'), String(1_800_000_000));
  exe('date', `if [ "$1" = +%s ]; then cat ${root}/sd/now; else /bin/date "$@"; fi`);
  exe('curl', `printf '{"mode":"paper","git_sha":"%s"}' "$(cat ${root}/sd/health_sha)"`);
  exe('systemctl', `case "$1" in
  show) cat ${root}/sd/nrestarts ;;
  list-units) ;;
  *) exit 0 ;;
esac`);
};

const run = (script: string) => {
  const r = spawnSync('bash', ['-c', relocate(readFileSync(join(FILES, 'usr/local/sbin', script), 'utf8'))], { encoding: 'utf8', env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` } });
  return { status: r.status, err: r.stderr };
};
const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '');


const set = (f: string, v: string | number) => writeFileSync(join(root, f), String(v));
const deploy = () => {
  setup();
  const r = run('zeroed-update');
  expect(r.status, r.err + read('log')).toBe(0);
  expect(read('state/deployed').trim()).toBe(B);
  expect(read('state/probation').trim()).toBe(`${B}|${join(root, `opt/zeroed/releases/${A}`)}|${A}|1800000000|0`);
};

describe('RC-R2-3: probation after a switch', () => {
  it('no restart: two hours of runs change nothing, then the probation ends', () => {
    deploy();
    for (let m = 5; m < 120; m += 5) {
      set('sd/now', 1_800_000_000 + m * 60);
      expect(run('zeroed-update').status).toBe(0);
    }
    expect(read('state/deployed').trim()).toBe(B);
    expect(read('state/probation')).not.toBe('');
    set('sd/now', 1_800_000_000 + 7_200);
    run('zeroed-update');
    expect(read('state/probation')).toBe('');
    expect(read('alerts')).toBe('');
    // After the window, a restart is the watchdog's to report, not a rollback.
    set('sd/nrestarts', 3);
    run('zeroed-update');
    expect(read('state/deployed').trim()).toBe(B);
  });

  it('one restart inside the window rolls back once: deployed, current, failed release, one alert; the next runs do nothing more', () => {
    deploy();
    set('sd/now', 1_800_000_000 + 7_199);
    set('sd/nrestarts', 1);
    expect(run('zeroed-update').status).toBe(1);
    expect(read('state/deployed').trim()).toBe(A);
    expect(read('state/failed_release').trim()).toBe(B);
    expect(readFileSync(join(root, 'opt/zeroed/current/ops/host-config.json'), 'utf8')).toContain('release');
    expect(spawnSync('readlink', ['-f', join(root, 'opt/zeroed/current')], { encoding: 'utf8' }).stdout.trim()).toBe(join(root, `opt/zeroed/releases/${A}`));
    expect(read('alerts').trim().split('\n')).toEqual([expect.stringMatching(/^worker-switch\|ALERT .*restarted 1 time\(s\) within 119 min of the switch/)]);
    expect(read('state/probation')).toBe('');
    set('sd/nrestarts', 2);
    run('zeroed-update');
    run('zeroed-update');
    expect(read('alerts').trim().split('\n')).toHaveLength(1);
    expect(read('state/deployed').trim()).toBe(A);
  });

  it('during a qualifying dry run a restart alerts and never rolls back', () => {
    deploy();
    mkdirSync(join(root, 'ev/run1'), { recursive: true });
    writeFileSync(join(root, 'ev/run1/run.json'), '{"name":"q1"}');
    set('sd/nrestarts', 1);
    run('zeroed-update');
    expect(read('state/deployed').trim()).toBe(B);
    expect(read('alerts')).toMatch(/^worker-probation\|ALERT .*during a qualifying dry run, so it is not rolled back/);
  });

  it('a restart count that cannot be read alerts, never passes silently', () => {
    deploy();
    set('sd/nrestarts', '');
    run('zeroed-update');
    expect(read('state/deployed').trim()).toBe(B);
    expect(read('alerts')).toMatch(/^worker-probation\|ALERT .*restart count cannot be read/);
  });

  it('a probation for a release no longer deployed is dropped', () => {
    deploy();
    set('state/deployed', `${A}\n`);
    set('sd/nrestarts', 4);
    // Dropped, not rolled back; the deploy tag (B) is then switched to again, with a fresh baseline.
    expect(run('zeroed-update').status).toBe(0);
    expect(read('alerts')).toBe('');
    expect(read('state/failed_release')).toBe('');
    expect(read('state/probation').trim()).toMatch(new RegExp(`^${B}\\|.*\\|${A}\\|1800000000\\|4$`));
  });

  it('a due rollback waits while intents are open (one alert), also past the window, and goes ahead once they are 0', () => {
    deploy();
    set('var/lib/zeroed/open_intents', 1);
    set('sd/now', 1_800_000_000 + 600);
    set('sd/nrestarts', 1);
    expect(run('zeroed-update').status).toBe(0);
    expect(read('state/deployed').trim()).toBe(B);
    expect(read('alerts')).toMatch(/^worker-probation-held\|ALERT Zeroed host: rollback held: 1 open intents, 0 open positions\./);
    // Still held next run; one alert per episode (the alert stand-in records each call, the real one dedupes by key).
    set('sd/now', 1_800_000_000 + 8_000);
    run('zeroed-update');
    expect(read('state/deployed').trim()).toBe(B);
    expect(read('state/probation')).toMatch(/\|it restarted 1 time\(s\) within 10 min/);
    // Unreadable counts hold too.
    rmSync(join(root, 'var/lib/zeroed/open_intents'));
    run('zeroed-update');
    expect(read('state/deployed').trim()).toBe(B);
    expect(read('alerts')).toMatch(/rollback held: unknown open intents, 0 open positions/);
    // Past the window and with no intent open: the rollback goes ahead.
    set('var/lib/zeroed/open_intents', 0);
    expect(run('zeroed-update').status).toBe(1);
    expect(read('state/deployed').trim()).toBe(A);
    expect(read('state/failed_release').trim()).toBe(B);
    expect(read('alerts')).toMatch(/worker-switch\|ALERT .*restarted 1 time\(s\) within 10 min/);
  });

  it('a rollback onto the stand-in says plainly that the bot is paused on it, with both commits', () => {
    deploy();
    writeFileSync(join(root, `opt/zeroed/releases/${A}/ops/host-config.json`), '{"worker":"stub"}');
    set('sd/nrestarts', 1);
    expect(run('zeroed-update').status).toBe(1);
    expect(read('alerts')).toContain(`The bot is now paused on the stand-in worker: ${A.slice(0, 12)} replaced ${B.slice(0, 12)}, and the next deploy needs a new commit.`);
  });

  it('a first deploy (no current before it) has no rollback target: a restart alerts and drops, and current stays on the release', () => {
    setup();
    rmSync(join(root, 'opt/zeroed/current'));
    rmSync(join(root, 'state/deployed'));
    // The stand-in writes no open_positions: with no earlier release nothing waits on it.
    rmSync(join(root, 'var/lib/zeroed/open_positions'));
    expect(run('zeroed-update').status).toBe(0);
    expect(read('state/probation').trim()).toBe(`${B}||||`.replace('||||', `|||1800000000|0`));
    set('sd/nrestarts', 1);
    expect(run('zeroed-update').status).toBe(1);
    expect(read('alerts')).toMatch(/^worker-switch\|ALERT .*there is no earlier release to go back to\.$/m);
    expect(spawnSync('readlink', ['-f', join(root, 'opt/zeroed/current')], { encoding: 'utf8' }).stdout.trim()).toBe(join(root, `opt/zeroed/releases/${B}`));
    expect(read('state/deployed').trim()).toBe(B);
    expect(read('state/probation')).toBe('');
  });

  it('RC-FIXES-2b: an open position with no intent in flight holds a due rollback; an unreadable count holds; 0 rolls back', () => {
    deploy();
    set('var/lib/zeroed/open_positions', 1);
    set('sd/nrestarts', 1);
    expect(run('zeroed-update').status).toBe(0);
    expect(read('state/deployed').trim()).toBe(B);
    expect(read('alerts')).toMatch(/^worker-probation-held\|ALERT Zeroed host: rollback held: 0 open intents, 1 open positions\./);
    rmSync(join(root, 'var/lib/zeroed/open_positions'));
    run('zeroed-update');
    expect(read('state/deployed').trim()).toBe(B);
    expect(read('alerts')).toMatch(/rollback held: 0 open intents, unknown open positions/);
    set('var/lib/zeroed/open_positions', 0);
    expect(run('zeroed-update').status).toBe(1);
    expect(read('state/deployed').trim()).toBe(A);
  });

  it('RC-FIXES-2b: a qualifying dry run that starts while a rollback waits holds it; it goes ahead once the run has ended', () => {
    deploy();
    set('var/lib/zeroed/open_intents', 1);
    set('sd/nrestarts', 1);
    run('zeroed-update');
    expect(read('state/probation')).toMatch(/\|it restarted 1 time/);
    // The intent settles, but a qualifying run has started meanwhile.
    set('var/lib/zeroed/open_intents', 0);
    mkdirSync(join(root, 'ev/run2'), { recursive: true });
    writeFileSync(join(root, 'ev/run2/run.json'), '{"name":"q2"}');
    expect(run('zeroed-update').status).toBe(0);
    expect(read('state/deployed').trim()).toBe(B);
    expect(read('alerts')).toMatch(/rollback held: a qualifying dry run is active/);
    writeFileSync(join(root, 'ev/run2/report.json'), '{"pass":false}');
    expect(run('zeroed-update').status).toBe(1);
    expect(read('state/deployed').trim()).toBe(A);
  });
});

