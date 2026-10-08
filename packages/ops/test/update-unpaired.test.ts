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
 * (the release's worker dies at once with credentials), pair_on_smoke and pair_on_notify (the owner's /pair lands
 * during the trial start, before the start decision, or with the closing notice, after it).
 */
const host = (creds: string[]) => {
  const root = mkdtempSync(join(tmpdir(), 'update-unpaired-'));
  roots.push(root);
  const bin = join(root, 'bin');
  for (const d of ['bin', 'state', 'cred', 'var/lib/zeroed', 'sd', 'opt/zeroed/repo', 'ev']) mkdirSync(join(root, d), { recursive: true });
  for (const c of [A, B, C]) {
    mkdirSync(join(root, `opt/zeroed/releases/${c}/ops`), { recursive: true });
    writeFileSync(join(root, `opt/zeroed/releases/${c}/ops/host-config.json`), '{"worker":"release"}');
  }
  symlinkSync(join(root, `opt/zeroed/releases/${A}`), join(root, 'opt/zeroed/current'));
  writeFileSync(join(root, 'state/deployed'), `${A}\n`);
  writeFileSync(join(root, 'var/lib/zeroed/open_intents'), '0');
  writeFileSync(join(root, 'var/lib/zeroed/open_positions'), '0');
  writeFileSync(join(root, 'sd/nrestarts'), '0');
  writeFileSync(join(root, 'sd/tag'), B);
  for (const c of creds) writeFileSync(join(root, `cred/${c}`), 'x');
  const pair = `printf x > ${root}/cred/telegram_chat_id`;
  writeFileSync(join(root, 'common.sh'), `
. "${FILES}/usr/local/lib/zeroed/logic.sh"
CRED_DIR="${root}/cred"; STATE_DIR="${root}/state"; PAIR_CODE_FILE="${root}/pair-code"
EVIDENCE_ROOT="${root}/ev"; EVIDENCE_INDEX="${root}/ev-index/evidence.json"
ZEROED_BRANCH=main; ZEROED_REPO=o/r; ZEROED_API_URL=http://127.0.0.1:9; WEB_FLOW_FPR=FPR
${real('API_NAMES')}
log() { printf '%s\\n' "$*" >> "${root}/log"; }
lock() { echo lock >> "${root}/sd/calls"; }
notify() { printf '%s\\n' "$1" >> "${root}/notify"; if [ -e "${root}/sd/pair_on_notify" ]; then ${pair}; fi; }
${real('alert')}
${real('alert_clear')}
${real('keys_stored')}
${real('paired')}
${real('worker_ready')}
${real('start_worker')}
commit_verdict() { cat >/dev/null; echo green; }
e2e_commit() { echo "$2"; }
`);
  const exe = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  exe('git', `case "$*" in
  *rev-parse*) cat ${root}/sd/tag ;;
  *verify-commit*) echo '[GNUPG:] GOODSIG x'; echo '[GNUPG:] VALIDSIG a b c d e f g h i FPR' ;;
  *) exit 0 ;;
esac`);
  exe('worker-smoke', `if [ -e ${root}/sd/pair_on_smoke ]; then ${pair}; fi`);
  exe('sleep', 'exit 0');
  // The worker answers its health route as the release current points at, only while the unit is active.
  exe('curl', `[ -e ${root}/sd/active ] || exit 7; printf '{"mode":"paper","git_sha":"%s"}' "$(basename "$(readlink -f ${root}/opt/zeroed/current)")"`);
  // systemd: a worker start or restart whose ConditionPathExists fails is skipped (exit 0, unit not active), as on the
  // 8 Oct host; a release that crashes with credentials never stays active. Other units are only recorded.
  exe('systemctl', `printf '%s\\n' "$*" >> ${root}/sd/calls
case "$*" in
  *zeroed-worker*) ;;
  *) case "$1" in show) cat ${root}/sd/nrestarts ;; esac; exit 0 ;;
esac
case "$1" in
  restart|start)
    rm -f ${root}/sd/active
    for c in ${conditions.join(' ')}; do [ -e ${root}/cred/$c ] || exit 0; done
    [ -e ${root}/sd/crash ] || : > ${root}/sd/active ;;
  is-active) [ -e ${root}/sd/active ] ;;
  show) cat ${root}/sd/nrestarts ;;
  *) exit 0 ;;
esac`);
  const relocate = (text: string) => text
    .replace('. /usr/local/lib/zeroed/common.sh', `. "${root}/common.sh"`)
    .replaceAll('/usr/local/lib/zeroed/worker-smoke', `${bin}/worker-smoke`)
    .replaceAll('/opt/zeroed', `${root}/opt/zeroed`)
    .replaceAll('/var/lib/zeroed-record-upload', `${root}/var/lib/zeroed-record-upload`)
    .replaceAll('/var/lib/zeroed/', `${root}/var/lib/zeroed/`)
    .replaceAll('GNUPGHOME=/etc/zeroed/gnupg ', '');
  const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '');
  const set = (f: string, v = '') => writeFileSync(join(root, f), v);
  const bash = (script: string) => {
    const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` } });
    return { status: r.status, out: `${r.stderr}${read('log')}` };
  };
  const update = () => bash(relocate(readFileSync(join(FILES, 'usr/local/sbin/zeroed-update'), 'utf8')));
  /** What zeroed-telegram-pair does on a first pairing: store the chat, then start_worker. */
  const pairNow = () => { set('cred/telegram_chat_id', 'x'); return bash(`set -euo pipefail; . "${root}/common.sh"; start_worker`); };
  const current = () => spawnSync('readlink', ['-f', join(root, 'opt/zeroed/current')], { encoding: 'utf8' }).stdout.trim();
  const rel = (c: string) => join(root, `opt/zeroed/releases/${c}`);
  const workerStarts = () => read('sd/calls').split('\n').filter((l) => /^(re)?start zeroed-worker/.test(l)).length;
  return { root, read, set, update, pairNow, current, rel, workerStarts };
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
    expect(h.read('log')).toContain(`Started ${B.slice(0, 12)} under the hold (switched to before the keys or the pairing). Worker: restarted and up.`);
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

  it('/pair landing just after the start decision: the marker stays, and the next run holds the first start', () => {
    const h = host(KEYS);
    h.set('sd/pair_on_notify');
    expect(h.update().status).toBe(0);
    expect(h.read('state/switch_unheld')).toBe(`${B}|${h.rel(A)}|${A}\n`);
    expect(h.workerStarts()).toBe(0);
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.workerStarts()).toBe(1);
    expect(h.read('state/switch_unheld')).toBe('');
    expect(h.read('state/probation')).toMatch(new RegExp(`^${B}\\|${h.rel(A)}\\|${A}\\|`));
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
