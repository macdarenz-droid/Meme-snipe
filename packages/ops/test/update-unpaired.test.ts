// OPS-CLEAN part 1 (seen live on 8 Oct): the keys arrived before the owner's Telegram /pair. The switch restarted the
// worker, its unit skipped the start (ConditionPathExists=telegram_chat_id fails, and systemctl exits 0), the hold waited
// 60 s for a health answer that never came, and the server rolled a good release back and marked it failed for good.
// Round 2 (review M1, m2): a release switched to before the worker could start gets its first start under the same hold
// and probation once it can (switch_unheld), and a running worker that could not start again holds the switch back.
// The real zeroed-update runs here with its real keys_stored, paired, worker_ready, start_worker, alert and alert_clear
// (from common.sh); systemctl models the unit's start conditions; git, curl, sleep, the trial start and Telegram are
// stood in, paths under a scratch root.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const FILES = join(repo, 'ops/host/files');
const COMMON = readFileSync(join(FILES, 'usr/local/lib/zeroed/common.sh'), 'utf8');
const UNIT = readFileSync(join(FILES, 'etc/systemd/system/zeroed-worker.service'), 'utf8');
/** A definition from the real common.sh (a one-line function, a multi-line one, or the API_NAMES array). */
const real = (name: string) => {
  const m = new RegExp(`^${name}(\\(\\) \\{.*\\}|\\(\\) \\{[\\s\\S]*?^\\}|=\\(.*\\))$`, 'm').exec(COMMON);
  if (!m) throw new Error(`${name} not found in common.sh`);
  return m[0];
};
/** The credential files the unit's ConditionPathExists lines name. */
const conditions = [...UNIT.matchAll(/^ConditionPathExists=\/etc\/credstore\.encrypted\/(\S+)$/gm)].map((m) => m[1]!);
const KEYS = ['helius_api_key', 'alchemy_api_key', 'jupiter_api_key', 'telegram_bot_token'];
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/**
 * A host on release A with the given credentials, the deploy tag on B. Flags in sd/: active (the worker runs), crash
 * (the release's worker dies at once with credentials), pair_on_smoke, pair_on_notify and pair_on_fetch (the owner's
 * /pair lands during the trial start, before the start decision, with the closing notice, after it, or during the
 * fetch of a run with nothing to deploy), lock_busy (the host lock stays taken), kill_on_timers and kill_on_ln (the run
 * is killed after current moved, or just before), kill_after_mv (killed between moving current and writing deployed),
 * repair_on_sleep and rotate_on_sleep (a re-pair of the chat, or a key handoff through zeroed-pair's own restart block,
 * lands during the hold). Each release's installer records the release whose host files it applied in sd/applied; each
 * worker start records the helius key it loaded in sd/loaded_key; each `flock -u` records whether holding existed.
 */
const host = (creds: string[]) => {
  const root = mkdtempSync(join(tmpdir(), 'update-unpaired-'));
  roots.push(root);
  const bin = join(root, 'bin');
  for (const d of ['bin', 'state', 'cred', 'var/lib/zeroed', 'sd', 'opt/zeroed/repo', 'ev']) mkdirSync(join(root, d), { recursive: true });
  for (const c of [A, B, C]) {
    mkdirSync(join(root, `opt/zeroed/releases/${c}/ops`), { recursive: true });
    writeFileSync(join(root, `opt/zeroed/releases/${c}/ops/host-config.json`), '{"worker":"release"}');
    writeFileSync(join(root, `opt/zeroed/releases/${c}/ops/install.sh`), `# --update) UPDATE=1\nbasename "$ZEROED_RELEASE_DIR" >> ${root}/sd/applied\n`);
  }
  symlinkSync(join(root, `opt/zeroed/releases/${A}`), join(root, 'opt/zeroed/current'));
  writeFileSync(join(root, 'state/deployed'), `${A}\n`);
  writeFileSync(join(root, 'var/lib/zeroed/open_intents'), '0');
  writeFileSync(join(root, 'var/lib/zeroed/open_positions'), '0');
  writeFileSync(join(root, 'sd/nrestarts'), '0');
  writeFileSync(join(root, 'sd/tag'), B);
  for (const c of creds) writeFileSync(join(root, `cred/${c}`), 'x');
  const relocate = (text: string) => text
    .replace('. /usr/local/lib/zeroed/common.sh', `. "${root}/common.sh"`)
    .replaceAll('/usr/local/lib/zeroed/worker-smoke', `${bin}/worker-smoke`)
    .replaceAll('/opt/zeroed', `${root}/opt/zeroed`)
    .replaceAll('/var/lib/zeroed-record-upload', `${root}/var/lib/zeroed-record-upload`)
    .replaceAll('/var/lib/zeroed/', `${root}/var/lib/zeroed/`)
    .replaceAll('GNUPGHOME=/etc/zeroed/gnupg ', '');
  const pair = `printf x > ${root}/cred/telegram_chat_id`;
  writeFileSync(join(root, 'common.sh'), `
. "${FILES}/usr/local/lib/zeroed/logic.sh"
CRED_DIR="${root}/cred"; STATE_DIR="${root}/state"; PAIR_CODE_FILE="${root}/pair-code"
EVIDENCE_ROOT="${root}/ev"; EVIDENCE_INDEX="${root}/ev-index/evidence.json"
ZEROED_BRANCH=main; ZEROED_REPO=o/r; ZEROED_API_URL=http://127.0.0.1:9; WEB_FLOW_FPR=FPR
${real('API_NAMES')}
log() { printf '%s\\n' "$*" >> "${root}/log"; }
lock() { [ ! -e "${root}/sd/lock_busy" ] || return 1; echo lock >> "${root}/sd/calls"; }
notify() { printf '%s\\n' "$1" >> "${root}/notify"; if [ -e "${root}/sd/pair_on_notify" ]; then ${pair}; fi; }
${real('alert')}
${real('alert_clear')}
${real('keys_stored')}
${real('paired')}
${real('worker_ready')}
${real('start_worker')}
${relocate(real('worker_busy'))}
${real('restart_for_chat')}
${real('pending_restart')}
commit_verdict() { cat >/dev/null; echo green; }
e2e_commit() { echo "$2"; }
`);
  const exe = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  exe('git', `case "$*" in
  *fetch*) if [ -e ${root}/sd/pair_on_fetch ]; then ${pair}; fi ;;
  *rev-parse*) cat ${root}/sd/tag ;;
  *verify-commit*) echo '[GNUPG:] GOODSIG x'; echo '[GNUPG:] VALIDSIG a b c d e f g h i FPR' ;;
  *) exit 0 ;;
esac`);
  exe('worker-smoke', `if [ -e ${root}/sd/pair_on_smoke ]; then ${pair}; fi`);
  exe('sleep', `if [ -e ${root}/sd/repair_on_sleep ]; then rm -f ${root}/sd/repair_on_sleep; bash -c '. "${root}/common.sh"; restart_for_chat'; fi
if [ -e ${root}/sd/rotate_on_sleep ]; then rm -f ${root}/sd/rotate_on_sleep; printf y > ${root}/cred/helius_api_key; bash ${root}/rotate.sh; fi`);
  // zeroed-pair's restart block after a key handoff, as the script has it.
  const pairScript = readFileSync(join(FILES, 'usr/local/sbin/zeroed-pair'), 'utf8');
  const block = pairScript.slice(pairScript.indexOf('\nif paired; then\n'), pairScript.indexOf('\nfi\n', pairScript.indexOf('\nif paired; then\n')) + 4);
  writeFileSync(join(root, 'rotate.sh'), `. "${root}/common.sh"\nwebhook_try() { :; }\nnew_pair_code() { :; }\nissued=1\n${block}`);
  exe('mv', `case "$*" in *current.new*/opt/zeroed/current) if [ -e ${root}/sd/kill_before_mv ]; then rm -f ${root}/sd/kill_before_mv; kill -9 $PPID; exit 137; fi ;; esac; /bin/mv "$@"; rc=$?; case "$*" in *current.new*/opt/zeroed/current) if [ -e ${root}/sd/kill_after_mv ]; then rm -f ${root}/sd/kill_after_mv; kill -9 $PPID; fi ;; esac; exit $rc`);
  exe('flock', `if [ "$1" = -u ]; then if [ -e ${root}/state/holding ]; then echo 'unlock holding=yes'; else echo 'unlock holding=no'; fi >> ${root}/sd/calls; fi; exit 0`);
  exe('ln', `if [ -e ${root}/sd/kill_on_ln ]; then rm -f ${root}/sd/kill_on_ln; kill -9 $PPID; fi; exec /bin/ln "$@"`);
  // The worker answers its health route as the release current points at, only while the unit is active.
  exe('curl', `[ -e ${root}/sd/active ] || exit 7; printf '{"mode":"paper","git_sha":"%s"}' "$(basename "$(readlink -f ${root}/opt/zeroed/current)")"`);
  // systemd: a worker start or restart whose ConditionPathExists fails is skipped (exit 0, unit not active), as on the
  // 8 Oct host; a release that crashes with credentials never stays active. Other units are only recorded.
  exe('systemctl', `printf '%s\\n' "$*" >> ${root}/sd/calls
case "$*" in
  *zeroed-worker*) ;;
  *backup-offsite.timer*) if [ -e ${root}/sd/kill_on_timers ]; then rm -f ${root}/sd/kill_on_timers; kill -9 $PPID; fi; exit 0 ;;
  *) case "$1" in show) cat ${root}/sd/nrestarts ;; esac; exit 0 ;;
esac
case "$1" in
  try-restart) [ -e ${root}/sd/active ] && cp ${root}/cred/helius_api_key ${root}/sd/loaded_key && rm -f ${root}/sd/active ;;
  restart|start)
    rm -f ${root}/sd/active
    for c in ${conditions.join(' ')}; do [ -e ${root}/cred/$c ] || exit 0; done
    cp ${root}/cred/helius_api_key ${root}/sd/loaded_key
    [ -e ${root}/sd/crash ] || : > ${root}/sd/active ;;
  is-active) [ -e ${root}/sd/active ] ;;
  show) cat ${root}/sd/nrestarts ;;
  *) exit 0 ;;
esac`);
  const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '');
  const set = (f: string, v = '') => writeFileSync(join(root, f), v);
  const bash = (script: string) => {
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` } });
    return { status: r.status, out: `${r.stderr}${read('log')}` };
  };
  const update = () => bash(relocate(readFileSync(join(FILES, 'usr/local/sbin/zeroed-update'), 'utf8')));
  /** What zeroed-telegram-pair does on a first pairing: store the chat, then start_worker. */
  const pairNow = () => { set('cred/telegram_chat_id', 'x'); return bash(`set -euo pipefail; . "${root}/common.sh"; start_worker`); };
  const pendingRestart = () => bash(`set -euo pipefail; . "${root}/common.sh"; pending_restart`);
  const current = () => spawnSync('readlink', ['-f', join(root, 'opt/zeroed/current')], { encoding: 'utf8' }).stdout.trim();
  const rel = (c: string) => join(root, `opt/zeroed/releases/${c}`);
  const workerStarts = () => read('sd/calls').split('\n').filter((l) => /^(re)?start zeroed-worker/.test(l)).length;
  return { root, read, set, update, pairNow, pendingRestart, current, rel, workerStarts };
};
type Host = ReturnType<typeof host>;

/** Keys stored, no pairing, deploy tag on B: the switch to B goes through with no worker start. */
const unpairedSwitch = (): Host => {
  const h = host(KEYS);
  const r = h.update();
  expect(r.status, r.out).toBe(0);
  expect(h.current()).toBe(h.rel(B));
  expect(h.read('state/switch_unheld')).toBe(`${B}|${h.rel(A)}|${A}\n`);
  expect(h.workerStarts()).toBe(0);
  return h;
};

describe('zeroed-update on a host with keys but no Telegram pairing (OPS-CLEAN, 8 Oct)', () => {
  it('the unit still names the pairing as a start condition (the case this guards)', () => {
    expect(conditions).toEqual(['helius_api_key', 'telegram_chat_id']);
  });

  it('keys stored, not paired: the switch goes through, no restart, no hold, no rollback, no failed_release', () => {
    const h = unpairedSwitch();
    expect(h.read('state/deployed').trim()).toBe(B);
    expect(h.read('state/failed_release')).toBe('');
    expect(h.read('state/probation')).toBe('');
    expect(h.read('alerts')).toBe('');
    expect(h.read('log')).toContain(`Deployed ${B.slice(0, 12)}. Worker: not started (not paired yet).`);
    // The switch and its start decision ran under the host lock.
    expect(h.read('sd/calls')).toContain('lock\n');
    // The next run sees it deployed and does nothing.
    expect(h.update().status).toBe(0);
    expect(h.read('state/deployed').trim()).toBe(B);
    expect(h.workerStarts()).toBe(0);
  });

  it('keys stored and paired: the worker restarts, holds and goes on probation', () => {
    const h = host([...KEYS, 'telegram_chat_id']);
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.read('state/deployed').trim()).toBe(B);
    expect(h.read('sd/calls')).toMatch(/^restart zeroed-worker\.service$/m);
    expect(h.read('state/probation')).toMatch(new RegExp(`^${B}\\|${h.rel(A)}\\|${A}\\|\\d+\\|0\\n$`));
    expect(h.read('state/switch_unheld')).toBe('');
    expect(h.read('state/failed_release')).toBe('');
    expect(h.read('log')).toContain(`Deployed ${B.slice(0, 12)}. Worker: restarted and up.`);
  });

  it('no keys: the switch goes through and the worker is not started', () => {
    const h = host([]);
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.read('state/deployed').trim()).toBe(B);
    expect(h.read('state/failed_release')).toBe('');
    expect(h.read('state/probation')).toBe('');
    expect(h.read('state/switch_unheld')).toBe(`${B}|${h.rel(A)}|${A}\n`);
    expect(h.workerStarts()).toBe(0);
    expect(h.read('log')).toContain(`Deployed ${B.slice(0, 12)}. Worker: not started (no keys yet).`);
  });

  it('a paired chat but a key missing: not started (the unit would load a missing credential)', () => {
    const h = host(['helius_api_key', 'telegram_chat_id']);
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.read('state/deployed').trim()).toBe(B);
    expect(h.read('state/failed_release')).toBe('');
    expect(h.workerStarts()).toBe(0);
    expect(h.read('log')).toContain('Worker: not started (no keys yet).');
  });
});

describe('the first start of a release switched to before the pairing is held (OPS-CLEAN round 2, M1)', () => {
  it('/pair starts zeroed-update, not the worker; it restarts B under the hold and puts it on probation behind A', () => {
    const h = unpairedSwitch();
    const p = h.pairNow();
    expect(p.status, p.out).toBe(0);
    expect(h.read('sd/calls')).toMatch(/^start --no-block zeroed-update\.service$/m);
    expect(h.workerStarts()).toBe(0);
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.workerStarts()).toBe(1);
    expect(h.read('state/probation')).toMatch(new RegExp(`^${B}\\|${h.rel(A)}\\|${A}\\|\\d+\\|0\\n$`));
    expect(h.read('state/switch_unheld')).toBe('');
    expect(h.read('log')).toContain(`Started ${B.slice(0, 12)} under the hold. Worker: restarted and up.`);
    // Without a marker, /pair starts the worker itself.
    const q = h.pairNow();
    expect(q.status, q.out).toBe(0);
    expect(h.read('sd/calls')).toMatch(/^start zeroed-worker\.service$/m);
  });

  it('a worker that dies after the hold: the probation rolls it back to A, and B is not tried again', () => {
    const h = unpairedSwitch();
    h.pairNow();
    expect(h.update().status).toBe(0);
    h.set('sd/nrestarts', '1');
    const r = h.update();
    expect(r.status, r.out).toBe(1);
    expect(h.current()).toBe(h.rel(A));
    expect(h.read('state/deployed').trim()).toBe(A);
    expect(h.read('state/failed_release').trim()).toBe(B);
    expect(h.read('log')).toContain(`The worker of ${B.slice(0, 12)} did not stay up after the switch (it restarted 1 time(s)`);
  });

  it('a worker that crashes only with credentials: its held first start fails and it goes back to A', () => {
    const h = unpairedSwitch();
    h.set('sd/crash');
    h.pairNow();
    const r = h.update();
    expect(r.status, r.out).toBe(1);
    expect(h.current()).toBe(h.rel(A));
    expect(h.read('state/deployed').trim()).toBe(A);
    expect(h.read('state/failed_release').trim()).toBe(B);
    expect(h.read('state/switch_unheld')).toBe('');
    expect(h.read('log')).toContain(`did not stay up after the switch (its health route did not answer as ${B.slice(0, 12)} within 60 s); back on ${A.slice(0, 12)}`);
  });

  it('/pair landing mid-switch, before the start decision: the switch itself restarts and holds', () => {
    const h = host(KEYS);
    h.set('sd/pair_on_smoke');
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.workerStarts()).toBe(1);
    expect(h.read('state/switch_unheld')).toBe('');
    expect(h.read('state/probation')).toMatch(new RegExp(`^${B}\\|`));
    expect(h.read('log')).toContain('Worker: restarted and up.');
  });

  it('/pair landing just after the start decision: the same run gives B its held start on its way out (m3)', () => {
    const h = host(KEYS);
    h.set('sd/pair_on_notify');
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.workerStarts()).toBe(1);
    expect(h.read('state/switch_unheld')).toBe('');
    expect(h.read('state/probation')).toMatch(new RegExp(`^${B}\\|${h.rel(A)}\\|${A}\\|`));
    expect(h.read('log')).toContain(`Started ${B.slice(0, 12)} under the hold`);
  });

  it('/pair during a later run with nothing to deploy: the held start comes in that run (m3)', () => {
    const h = unpairedSwitch();
    h.set('sd/pair_on_fetch');
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.workerStarts()).toBe(1);
    expect(h.read('state/switch_unheld')).toBe('');
    expect(h.read('state/probation')).toMatch(new RegExp(`^${B}\\|${h.rel(A)}\\|${A}\\|`));
  });

  it('killed after current moved: the marker is already down, and the next run holds the first start behind A (m1)', () => {
    const h = host(KEYS);
    h.set('sd/kill_on_timers');
    const r = h.update();
    expect(r.status, r.out).not.toBe(0);
    expect(h.current()).toBe(h.rel(B));
    expect(h.read('state/deployed').trim()).toBe(B);
    expect(h.read('state/switch_unheld')).toBe(`${B}|${h.rel(A)}|${A}\n`);
    h.pairNow();
    const n = h.update();
    expect(n.status, n.out).toBe(0);
    expect(h.workerStarts()).toBe(1);
    expect(h.read('state/probation')).toMatch(new RegExp(`^${B}\\|${h.rel(A)}\\|${A}\\|`));
  });

  it('killed after the marker for C but before current moved: B, never started, keeps its marker behind A (m1)', () => {
    const h = unpairedSwitch();
    h.set('sd/tag', C);
    h.set('sd/kill_on_ln');
    expect(h.update().status).not.toBe(0);
    expect(h.current()).toBe(h.rel(B));
    expect(h.read('state/deployed').trim()).toBe(B);
    h.set('sd/tag', B);
    h.pairNow();
    const n = h.update();
    expect(n.status, n.out).toBe(0);
    expect(h.workerStarts()).toBe(1);
    expect(h.read('state/switch_unheld')).toBe('');
    expect(h.read('state/probation')).toMatch(new RegExp(`^${B}\\|${h.rel(A)}\\|${A}\\|`));
  });

  it("a busy host lock: one log line, the running release's host files back, exit 0, nothing switched (m2)", () => {
    const h = host(KEYS);
    h.set('sd/lock_busy');
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.read('log')).toContain(`Waiting on ${B.slice(0, 12)}: the host lock is busy.`);
    expect(h.read('sd/applied').trim().split('\n')).toEqual([B, A]);
    expect(h.current()).toBe(h.rel(A));
    expect(h.read('state/deployed').trim()).toBe(A);
    expect(h.read('state/switch_unheld')).toBe('');
  });

  it('a re-pair during the hold waits: no restart mid-hold, the hold passes, the owed restart runs after (m4)', () => {
    const h = host([...KEYS, 'telegram_chat_id']);
    h.set('sd/repair_on_sleep');
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.read('sd/calls')).not.toMatch(/^try-restart zeroed-worker/m);
    expect(h.read('state/failed_release')).toBe('');
    expect(h.read('state/probation')).toMatch(new RegExp(`^${B}\\|`));
    expect(h.read('state/holding')).toBe('');
    expect(existsSync(join(h.root, 'state/worker_restart_pending'))).toBe(true);
    // zeroed-check's pending restart, once the hold is over.
    const q = h.pendingRestart();
    expect(q.status, q.out).toBe(0);
    expect(h.read('sd/calls')).toMatch(/^try-restart zeroed-worker\.service$/m);
    expect(existsSync(join(h.root, 'state/worker_restart_pending'))).toBe(false);
  });

  it('a newer release while B was never started: the marker keeps A as the rollback target', () => {
    const h = unpairedSwitch();
    h.set('sd/tag', C);
    expect(h.update().status).toBe(0);
    expect(h.current()).toBe(h.rel(C));
    expect(h.read('state/switch_unheld')).toBe(`${C}|${h.rel(A)}|${A}\n`);
    h.set('sd/crash');
    h.pairNow();
    expect(h.update().status).toBe(1);
    expect(h.current()).toBe(h.rel(A));
    expect(h.read('state/deployed').trim()).toBe(A);
    expect(h.read('state/failed_release').trim()).toBe(C);
  });
});

describe('a running worker that could not start again holds the switch (OPS-CLEAN round 2, m2)', () => {
  it('refuses the switch with one alert while the worker runs and the pairing is missing, and goes ahead once it is back', () => {
    const h = host(KEYS);
    h.set('sd/active');
    for (let k = 0; k < 2; k++) {
      const r = h.update();
      expect(r.status, r.out).toBe(0);
    }
    expect(h.current()).toBe(h.rel(A));
    expect(h.read('state/deployed').trim()).toBe(A);
    expect(h.read('state/switch_unheld')).toBe('');
    expect(h.workerStarts()).toBe(0);
    expect(h.read('log')).toContain(`Waiting on ${B.slice(0, 12)}: the worker runs but a key or the pairing is missing.`);
    expect(h.read('notify').split('\n').filter((l) => l.startsWith('ALERT'))).toEqual([`ALERT Zeroed host: the worker runs but a key or the Telegram pairing is missing, so update ${B.slice(0, 12)} waits. It tries again every 5 minutes.`]);
    h.set('cred/telegram_chat_id', 'x');
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.current()).toBe(h.rel(B));
    expect(h.read('notify')).toContain('CLEARED Zeroed host: the keys and the pairing are back; updates go ahead.');
    expect(h.read('log')).toContain('Worker: restarted and up.');
  });
});

describe('OPS-CLEAN round 4: current and deployed agree, no restart mid-hold, one log line per cause', () => {
  it('killed between moving current and writing deployed: current goes back, and the rollback target stays A (13a, 13b)', () => {
    const h = host([...KEYS, 'telegram_chat_id']);
    h.set('sd/kill_after_mv');
    expect(h.update().status).not.toBe(0);
    expect(h.current()).toBe(h.rel(B));
    expect(h.read('state/deployed').trim()).toBe(A);
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.read('log')).toContain(`Put current back to the deployed release ${A.slice(0, 12)} (it pointed at ${B.slice(0, 12)}).`);
    expect(h.current()).toBe(h.rel(B));
    expect(h.read('state/deployed').trim()).toBe(B);
    expect(h.read('state/probation')).toMatch(new RegExp(`^${B}\\|${h.rel(A)}\\|${A}\\|`));
    h.set('sd/nrestarts', '1');
    expect(h.update().status).toBe(1);
    expect(h.current()).toBe(h.rel(A));
    expect(h.read('state/failed_release').trim()).toBe(B);
  });

  it('a folder placed by hand under another name (the ops e2e test copies) is left as current and is the rollback target', () => {
    const h = host([...KEYS, 'telegram_chat_id']);
    const copy = join(h.root, `opt/zeroed/releases/${A}-practice`);
    spawnSync('cp', ['-a', h.rel(A), copy]);
    spawnSync('ln', ['-sfn', copy, join(h.root, 'opt/zeroed/current')]);
    expect(h.update().status).toBe(0);
    expect(h.read('log')).not.toContain('Put current back');
    expect(h.read('state/probation')).toMatch(new RegExp(`^${B}\\|${copy}\\|${A}\\|`));
    h.set('sd/nrestarts', '1');
    expect(h.update().status).toBe(1);
    expect(h.current()).toBe(copy);
    expect(h.read('state/deployed').trim()).toBe(A);
  });

  it('a reboot between the switch and its hold, with the worker able to start: the next run holds the first start (13c)', () => {
    const h = host([...KEYS, 'telegram_chat_id']);
    h.set('sd/kill_on_timers');
    expect(h.update().status).not.toBe(0);
    expect(h.read('state/deployed').trim()).toBe(B);
    expect(h.read('state/switch_unheld')).toBe(`${B}|${h.rel(A)}|${A}\n`);
    expect(h.workerStarts()).toBe(0);
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.workerStarts()).toBe(1);
    expect(h.read('state/switch_unheld')).toBe('');
    expect(h.read('state/probation')).toMatch(new RegExp(`^${B}\\|${h.rel(A)}\\|${A}\\|`));
  });

  it('a key rotation during the hold: no restart mid-hold, one restart after it, with the new keys (14)', () => {
    const h = host([...KEYS, 'telegram_chat_id']);
    h.set('sd/rotate_on_sleep');
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.workerStarts()).toBe(1);
    expect(h.read('sd/calls')).not.toMatch(/^try-restart zeroed-worker/m);
    expect(h.read('state/failed_release')).toBe('');
    expect(h.read('state/probation')).toMatch(new RegExp(`^${B}\\|`));
    expect(existsSync(join(h.root, 'state/worker_restart_pending'))).toBe(true);
    expect(h.read('sd/loaded_key')).toBe('x');
    const q = h.pendingRestart();
    expect(q.status, q.out).toBe(0);
    expect(h.read('sd/calls').match(/^try-restart zeroed-worker\.service$/gm)).toHaveLength(1);
    expect(h.read('sd/loaded_key')).toBe('y');
    expect(existsSync(join(h.root, 'state/worker_restart_pending'))).toBe(false);
  });

  it('a busy lock with a running release from before --update: the skip is logged (15)', () => {
    const h = host(KEYS);
    h.set(`opt/zeroed/releases/${A}/ops/install.sh`, 'echo old installer\n');
    h.set('sd/lock_busy');
    expect(h.update().status).toBe(0);
    expect(h.read('log')).toContain(`Host files from ${A.slice(0, 12)} not applied: its installer has no --update.`);
    expect(h.read('sd/applied').trim()).toBe(B);
  });

  it('the lock is released only once holding is down (16)', () => {
    const h = host([...KEYS, 'telegram_chat_id']);
    expect(h.update().status).toBe(0);
    const calls = h.read('sd/calls').split('\n');
    const restart = calls.indexOf('restart zeroed-worker.service');
    expect(restart).toBeGreaterThan(0);
    expect(calls.slice(0, restart).filter((l) => l.startsWith('unlock')).at(-1)).toBe('unlock holding=yes');
  });

  it('a held first start that has to wait is logged once per run (17)', () => {
    const h = unpairedSwitch();
    h.set('cred/telegram_chat_id', 'x');
    h.set('sd/active');
    h.set('var/lib/zeroed/open_intents', '1');
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.read('log').match(/Waiting on the first held start of /g)).toHaveLength(1);
    expect(h.workerStarts()).toBe(0);
    expect(h.read('state/switch_unheld')).toBe(`${B}|${h.rel(A)}|${A}\n`);
  });
});

describe('OPS-CLEAN round 5: a resumable rollback, no switch over a due one, a reboot-started worker brought back', () => {
  /** A ready host switched to B and on probation behind A. */
  const onB = () => {
    const h = host([...KEYS, 'telegram_chat_id']);
    expect(h.update().status).toBe(0);
    expect(h.current()).toBe(h.rel(B));
    return h;
  };

  it('a rollback killed just after current moved is finished by the next run: current = deployed = A, A restarted (18)', () => {
    const h = onB();
    h.set('sd/nrestarts', '1');
    h.set('sd/kill_after_mv');
    expect(h.update().status).not.toBe(0);
    expect(h.current()).toBe(h.rel(A));
    expect(h.read('state/deployed').trim()).toBe(A);
    const starts = h.workerStarts();
    const r = h.update();
    expect(r.status, r.out).toBe(1);
    expect(h.read('log')).toContain(`Finishing the rollback of ${B.slice(0, 12)} to ${A.slice(0, 12)}`);
    expect(h.current()).toBe(h.rel(A));
    expect(h.read('state/deployed').trim()).toBe(A);
    expect(h.read('state/failed_release').trim()).toBe(B);
    expect(h.workerStarts()).toBe(starts + 1);
    expect(h.read('state/rollback_due')).toBe('');
    expect(h.read('notify')).toContain(`so the server went back to ${A.slice(0, 12)}`);
    // Done: the next run does not roll back again.
    expect(h.update().status).toBe(0);
    expect(h.workerStarts()).toBe(starts + 1);
  });

  it('a rollback killed before current moved is finished by the next run too (18)', () => {
    const h = onB();
    h.set('sd/nrestarts', '1');
    h.set('sd/kill_before_mv');
    expect(h.update().status).not.toBe(0);
    expect(h.current()).toBe(h.rel(B));
    expect(h.read('state/deployed').trim()).toBe(A);
    expect(h.update().status).toBe(1);
    expect(h.current()).toBe(h.rel(A));
    expect(h.read('state/deployed').trim()).toBe(A);
    expect(h.read('state/rollback_due')).toBe('');
  });

  it('a newer deploy waits while a rollback is due, even with the failed worker dead (19)', () => {
    const h = onB();
    h.set('sd/nrestarts', '1');
    h.set('var/lib/zeroed/open_positions', '1');
    expect(h.update().status).toBe(0);
    expect(h.read('notify')).toContain('ALERT Zeroed host: rollback held: 0 open intents, 1 open positions.');
    h.set('sd/active', '');
    spawnSync('rm', ['-f', join(h.root, 'sd/active')]);
    h.set('sd/tag', C);
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.read('log')).toContain(`Waiting on ${C.slice(0, 12)}: the rollback of ${B.slice(0, 12)} is due.`);
    expect(h.current()).toBe(h.rel(B));
    expect(h.read('state/deployed').trim()).toBe(B);
  });

  it('a worker a reboot started on the half-switched release is brought back to the deployed one under the hold (20)', () => {
    const h = host([...KEYS, 'telegram_chat_id']);
    h.set('sd/kill_after_mv');
    expect(h.update().status).not.toBe(0);
    expect(h.current()).toBe(h.rel(B));
    expect(h.read('state/deployed').trim()).toBe(A);
    // The reboot: systemd starts the worker on what current names (B), unheld.
    h.set('sd/active');
    h.set('sd/tag', A);
    const starts = h.workerStarts();
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.read('log')).toContain(`Put current back to the deployed release ${A.slice(0, 12)}`);
    expect(h.read('log')).toContain(`Started ${A.slice(0, 12)} under the hold.`);
    expect(h.workerStarts()).toBe(starts + 1);
    expect(h.current()).toBe(h.rel(A));
    expect(h.read('state/switch_unheld')).toBe('');
    expect(h.read('state/probation')).toMatch(new RegExp(`^${A}\\|${h.rel(A)}\\|${A}\\|`));
  });
});

describe('OPS-CLEAN round 6: the marker keeps the real rollback target; a dead worker\'s counts are named', () => {
  it('B unheld behind A, a killed switch to C, a reboot: the marker becomes B|A|A again and a failed hold of B goes back to A (22)', () => {
    const h = unpairedSwitch();
    h.set('sd/tag', C);
    h.set('sd/kill_after_mv');
    expect(h.update().status).not.toBe(0);
    expect(h.current()).toBe(h.rel(C));
    expect(h.read('state/deployed').trim()).toBe(B);
    expect(h.read('state/switch_unheld')).toBe(`${C}|${h.rel(A)}|${A}\n`);
    // The pairing, then a reboot that starts the worker on C; B's worker cannot hold.
    h.set('cred/telegram_chat_id', 'x');
    h.set('sd/active');
    h.set('sd/tag', B);
    h.set('sd/crash');
    const r = h.update();
    expect(r.status, r.out).toBe(1);
    expect(h.read('log')).toContain(`Put current back to the deployed release ${B.slice(0, 12)}`);
    expect(h.current()).toBe(h.rel(A));
    expect(h.read('state/deployed').trim()).toBe(A);
    expect(h.read('state/failed_release').trim()).toBe(B);
  });

  it('a rollback held by a dead worker\'s last counts: the alert names the files and says to check the positions (23)', () => {
    const h = host([...KEYS, 'telegram_chat_id']);
    expect(h.update().status).toBe(0);
    h.set('sd/nrestarts', '1');
    h.set('var/lib/zeroed/open_positions', '1');
    spawnSync('rm', ['-f', join(h.root, 'sd/active')]);
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    // The harness moves /var/lib/zeroed/ under its scratch root.
    expect(h.read('notify')).toContain(`The worker is not running, so these counts are its last (${h.root}/var/lib/zeroed/open_intents, ${h.root}/var/lib/zeroed/open_positions); check the positions before clearing them. Newer deploys wait until then.`);
    expect(h.current()).toBe(h.rel(B));
  });
});
