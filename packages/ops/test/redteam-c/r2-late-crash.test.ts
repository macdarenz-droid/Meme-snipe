// RED TEAM C round 2, task 2: a release whose worker passes the trial start (worker-smoke, 30 s hold) and the switch
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
import { type Heartbeat, evaluate, limitsFrom } from '../../src/watchdog/logic.ts';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const FILES = join(repo, 'ops/host/files');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const root = mkdtempSync(join(tmpdir(), 'r2-late-crash-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const bin = join(root, 'bin');
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
  mkdirSync(bin, { recursive: true });
  for (const d of ['state', 'cred', 'var/lib/zeroed', 'sd', `opt/zeroed/releases/${A}/ops`, `opt/zeroed/releases/${B}/ops`, 'opt/zeroed/repo', 'ev']) mkdirSync(join(root, d), { recursive: true });
  for (const c of [A, B]) writeFileSync(join(root, `opt/zeroed/releases/${c}/ops/host-config.json`), '{"worker":"release"}');
  symlinkSync(join(root, `opt/zeroed/releases/${A}`), join(root, 'opt/zeroed/current'));
  writeFileSync(join(root, 'state/deployed'), `${A}\n`);
  writeFileSync(join(root, 'var/lib/zeroed/open_intents'), '0');
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

describe('red team C r2: a worker that passes every start gate and crashes at minute 10', () => {
  it('some gate (zeroed-update, zeroed-check, systemd, watchdog) raises an alert or rolls the release back', () => {
    setup();
    // The deploy: smoke passes, the switch hold sees no restart for 30 s, the release is marked deployed.
    const first = run('zeroed-update');
    expect(first.status, first.err + read('log')).toBe(0);
    expect(read('state/deployed').trim()).toBe(B);
    expect(read('alerts')).toBe('');

    // Each 10 minutes for 2 hours the worker crashes; systemd restarts it (NRestarts +1); its next boot answers health
    // as B again. zeroed-update (every 5 min) and zeroed-check (every minute) run on.
    const watchdogAlerts: string[] = [];
    const lim = limitsFrom({});
    const unit = readFileSync(join(FILES, 'etc/systemd/system/zeroed-worker.service'), 'utf8');
    const burst = Number(/^StartLimitBurst=(\d+)$/m.exec(unit)![1]);
    const interval = Number(/^StartLimitIntervalSec=(\d+)$/m.exec(unit)![1]);
    const restartSec = Number(/^RestartSec=(\d+)$/m.exec(unit)![1]);
    const crashes: number[] = [];
    let unitFailed = false;
    for (let minute = 10; minute <= 120; minute += 10) {
      const crashAtS = minute * 60;
      crashes.push(crashAtS);
      // systemd's start limit: more than `burst` starts in `interval` seconds fails the unit.
      if (crashes.filter((t) => t > crashAtS - interval).length > burst) unitFailed = true;
      writeFileSync(join(root, 'sd/nrestarts'), String(crashes.length));
      // The watchdog: the last heartbeat 15 s before the crash, the new boot's first one after RestartSec, the
      // --reconcile pre-step and boot (generously 60 s). Checked every 10 s across the gap.
      const last: Heartbeat = { seq: 40, ts: (crashAtS - 15) * 1000, boot: `boot-${minute - 10}`, git_sha: B, policy_version: 'p', last_processed_slot: null, feed_ages_ms: {}, open_position: null, unresolved_intents: { count: 0, oldest_age_s: null }, signer: 'paper', lease_epoch: null, sol_reserve: null, paused: false };
      const back = crashAtS + restartSec + 60;
      for (let t = crashAtS; t < back; t += 10) for (const a of evaluate({ hb: last, receivedAt: last.ts }, t * 1000, lim, { slot: null, heldMints: null })) watchdogAlerts.push(a.text);
      const next: Heartbeat = { ...last, seq: 1, ts: back * 1000, boot: `boot-${minute}` };
      for (const a of evaluate({ hb: next, receivedAt: next.ts }, (back + 10) * 1000, lim, { slot: null, heldMints: null })) watchdogAlerts.push(a.text);
      for (let k = 0; k < 2; k++) run('zeroed-update');
      for (let k = 0; k < 10; k++) run('zeroed-check');
    }
    const noticed = {
      deployed: read('state/deployed').trim() === B ? 'still B' : 'changed',
      failedRelease: read('state/failed_release').trim() === B,
      hostAlerts: read('alerts').trim(),
      hostNotifyAlerts: read('notify').split('\n').filter((l) => l.includes('ALERT')),
      unitFailed,
      watchdogAlerts,
      restarts: crashes.length,
    };
    expect(noticed.hostAlerts !== '' || noticed.hostNotifyAlerts.length > 0 || noticed.failedRelease || noticed.deployed === 'changed' || noticed.unitFailed || noticed.watchdogAlerts.length > 0, JSON.stringify(noticed)).toBe(true);
  });
});
