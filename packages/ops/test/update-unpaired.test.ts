// OPS-CLEAN part 1 (seen live on 8 Oct): the keys arrived before the owner's Telegram /pair. The switch restarted the
// worker, its unit skipped the start (ConditionPathExists=telegram_chat_id fails, and systemctl exits 0), the hold waited
// 60 s for a health answer that never came, and the server rolled a good release back and marked it failed for good.
// The real zeroed-update runs here with its real keys_stored, paired and worker_ready (from common.sh); systemctl
// models the unit's start conditions; git, curl, sleep and the alert channel are stood in, paths under a scratch root.
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

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const host = (creds: string[]) => {
  const root = mkdtempSync(join(tmpdir(), 'update-unpaired-'));
  roots.push(root);
  const bin = join(root, 'bin');
  for (const d of ['bin', 'state', 'cred', 'var/lib/zeroed', 'sd', `opt/zeroed/releases/${A}/ops`, `opt/zeroed/releases/${B}/ops`, 'opt/zeroed/repo', 'ev']) mkdirSync(join(root, d), { recursive: true });
  for (const c of [A, B]) writeFileSync(join(root, `opt/zeroed/releases/${c}/ops/host-config.json`), '{"worker":"release"}');
  symlinkSync(join(root, `opt/zeroed/releases/${A}`), join(root, 'opt/zeroed/current'));
  writeFileSync(join(root, 'state/deployed'), `${A}\n`);
  writeFileSync(join(root, 'var/lib/zeroed/open_intents'), '0');
  writeFileSync(join(root, 'var/lib/zeroed/open_positions'), '0');
  for (const c of creds) writeFileSync(join(root, `cred/${c}`), 'x');
  writeFileSync(join(root, 'common.sh'), `
. "${FILES}/usr/local/lib/zeroed/logic.sh"
CRED_DIR="${root}/cred"; STATE_DIR="${root}/state"; PAIR_CODE_FILE="${root}/pair-code"
EVIDENCE_ROOT="${root}/ev"; EVIDENCE_INDEX="${root}/ev-index/evidence.json"
ZEROED_BRANCH=main; ZEROED_REPO=o/r; ZEROED_API_URL=http://127.0.0.1:9; WEB_FLOW_FPR=FPR
${real('API_NAMES')}
log() { printf '%s\\n' "$*" >> "${root}/log"; }
lock() { :; }
notify() { printf '%s\\n' "$1" >> "${root}/notify"; }
alert() { printf '%s|%s\\n' "$1" "$2" >> "${root}/alerts"; }
alert_clear() { :; }
${real('keys_stored')}
${real('paired')}
${real('worker_ready')}
commit_verdict() { cat >/dev/null; echo green; }
e2e_commit() { echo "$2"; }
`);
  const exe = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  exe('git', `case "$*" in
  *rev-parse*) echo ${B} ;;
  *verify-commit*) echo '[GNUPG:] GOODSIG x'; echo '[GNUPG:] VALIDSIG a b c d e f g h i FPR' ;;
  *) exit 0 ;;
esac`);
  exe('worker-smoke', 'exit 0');
  exe('sleep', 'exit 0');
  // The worker answers its health route as the release current points at, only while the unit is active.
  exe('curl', `[ -e ${root}/sd/active ] || exit 7; printf '{"mode":"paper","git_sha":"%s"}' "$(basename "$(readlink -f ${root}/opt/zeroed/current)")"`);
  // systemd: a start or restart whose ConditionPathExists fails is skipped (exit 0, unit not active), as on the 8 Oct host.
  exe('systemctl', `printf '%s\\n' "$*" >> ${root}/sd/calls
case "$1" in
  restart|start)
    for c in ${conditions.join(' ')}; do [ -e ${root}/cred/$c ] || exit 0; done
    : > ${root}/sd/active ;;
  is-active) [ -e ${root}/sd/active ] ;;
  show) echo 0 ;;
  list-units) ;;
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
  const update = () => {
    const r = spawnSync('bash', ['-c', relocate(readFileSync(join(FILES, 'usr/local/sbin/zeroed-update'), 'utf8'))], { encoding: 'utf8', env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` } });
    return { status: r.status, out: `${r.stderr}${read('log')}` };
  };
  const current = () => spawnSync('readlink', ['-f', join(root, 'opt/zeroed/current')], { encoding: 'utf8' }).stdout.trim();
  return { root, read, update, current };
};

describe('zeroed-update on a host with keys but no Telegram pairing (OPS-CLEAN, 8 Oct)', () => {
  it('the unit still names the pairing as a start condition (the case this guards)', () => {
    expect(conditions).toEqual(['helius_api_key', 'telegram_chat_id']);
  });

  it('keys stored, not paired: the switch goes through, no restart, no hold, no rollback, no failed_release', () => {
    const h = host(KEYS);
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.current()).toBe(join(h.root, `opt/zeroed/releases/${B}`));
    expect(h.read('state/deployed').trim()).toBe(B);
    expect(h.read('state/failed_release')).toBe('');
    expect(h.read('state/probation')).toBe('');
    expect(h.read('alerts')).toBe('');
    expect(h.read('sd/calls')).not.toMatch(/^(restart|start) zeroed-worker/m);
    expect(h.read('log')).toContain(`Deployed ${B.slice(0, 12)}. Worker: not started (not paired yet).`);
    // The next run sees it deployed and does nothing.
    expect(h.update().status).toBe(0);
    expect(h.read('state/deployed').trim()).toBe(B);
  });

  it('keys stored and paired: the worker restarts, holds and goes on probation', () => {
    const h = host([...KEYS, 'telegram_chat_id']);
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.read('state/deployed').trim()).toBe(B);
    expect(h.read('sd/calls')).toMatch(/^restart zeroed-worker\.service$/m);
    expect(h.read('state/probation')).toMatch(new RegExp(`^${B}\\|${join(h.root, `opt/zeroed/releases/${A}`)}\\|${A}\\|\\d+\\|0\\n$`));
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
    expect(h.read('sd/calls')).not.toMatch(/^(restart|start) zeroed-worker/m);
    expect(h.read('log')).toContain(`Deployed ${B.slice(0, 12)}. Worker: not started (no keys yet).`);
  });

  it('a paired chat but a key missing: not started (the unit would load a missing credential)', () => {
    const h = host(['helius_api_key', 'telegram_chat_id']);
    const r = h.update();
    expect(r.status, r.out).toBe(0);
    expect(h.read('state/deployed').trim()).toBe(B);
    expect(h.read('state/failed_release')).toBe('');
    expect(h.read('sd/calls')).not.toMatch(/^(restart|start) zeroed-worker/m);
    expect(h.read('log')).toContain('Worker: not started (no keys yet).');
  });
});
