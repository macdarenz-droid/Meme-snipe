// RED TEAM C round 3: the two-step resume. Deploy 1 = the fix batch (#271 RC-FIXES-2, merged at e4a8c05) while the
// host still runs the stand-in ("worker": "stub"); Deploy 2 = #268 RESUME-WORKER ("worker": "release", at 25c4d9b),
// switched by Deploy 1's zeroed-update (the new probation logic). The host scripts are taken from the commit they
// would run at (git show), so this file runs from any tree; systemd, curl, git, date and the Telegram channel are
// stood in, paths moved under a scratch root. alert/alert_clear are the real ones (one message per key and episode).
// Each `it` asserts the correct behaviour: a failure is a finding (see the round 3 report).
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const HOST = 'e4a8c056d530440c66e3e64223e0f000ca86c1c9'; // Deploy 1: integration with #271 merged (the host files it installs)
const D1 = HOST; // the stand-in release (its host-config says "stub")
const D2 = '25c4d9bfcfd7179b413176ff7d3807f83370cd01'; // #268 RESUME-WORKER: "worker": "release"
const D3 = 'd'.repeat(40); // a later release
const show = (sha: string, path: string) => execFileSync('git', ['-C', repo, 'show', `${sha}:${path}`], { encoding: 'utf8' });
const F = 'ops/host/files';
const UPDATE = show(HOST, `${F}/usr/local/sbin/zeroed-update`);
const LOGIC = show(HOST, `${F}/usr/local/lib/zeroed/logic.sh`);
const COMMON = show(HOST, `${F}/usr/local/lib/zeroed/common.sh`);
const fn = (name: string) => {
  const m = new RegExp(`^${name}\\(\\) \\{[\\s\\S]*?^\\}`, 'm').exec(COMMON);
  if (!m) throw new Error(`${name} not found in common.sh at ${HOST}`);
  return m[0];
};
const CONFIG: Record<string, string> = { [D1]: show(D1, 'ops/host-config.json'), [D2]: show(D2, 'ops/host-config.json'), [D3]: show(D2, 'ops/host-config.json') };

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

let root = '';
let bin = '';
const T0 = 1_800_000_000;
const exe = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
const set = (f: string, v: string | number) => writeFileSync(join(root, f), String(v));
const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), 'utf8') : '');
const rel = (c: string) => join(root, `opt/zeroed/releases/${c}`);
const current = () => spawnSync('readlink', ['-f', join(root, 'opt/zeroed/current')], { encoding: 'utf8' }).stdout.trim();
const relocate = (text: string) => text
  .replace('. /usr/local/lib/zeroed/common.sh', `. "${root}/common.sh"`)
  .replaceAll('/usr/local/lib/zeroed/worker-smoke', `${bin}/worker-smoke`)
  .replaceAll('/opt/zeroed', `${root}/opt/zeroed`)
  .replaceAll('/var/lib/zeroed/', `${root}/var/lib/zeroed/`)
  .replaceAll('GNUPGHOME=/etc/zeroed/gnupg ', '');

/** The host after Deploy 1: current = D1 (stand-in), deployed = D1, no probation (the old zeroed-update switched it). */
const setup = (tag: string): void => {
  root = mkdtempSync(join(tmpdir(), 'r3-resume-'));
  roots.push(root);
  bin = join(root, 'bin');
  for (const d of ['bin', 'state', 'cred', 'var/lib/zeroed', 'sd', 'opt/zeroed/repo', 'ev']) mkdirSync(join(root, d), { recursive: true });
  for (const c of [D1, D2, D3]) {
    mkdirSync(join(rel(c), 'ops'), { recursive: true });
    mkdirSync(join(rel(c), 'packages/worker/src'), { recursive: true });
    writeFileSync(join(rel(c), 'packages/worker/src/main.ts'), '');
    writeFileSync(join(rel(c), 'ops/host-config.json'), CONFIG[c]!);
  }
  writeFileSync(join(root, 'logic.sh'), LOGIC.replaceAll('/opt/zeroed', `${root}/opt/zeroed`));
  symlinkSync(rel(D1), join(root, 'opt/zeroed/current'));
  set('state/deployed', `${D1}\n`);
  set('var/lib/zeroed/open_intents', '0\n');
  set('cred/helius_api_key', 'x');
  set('sd/nrestarts', 0);
  set('sd/now', T0);
  set('sd/tag', tag);
  set('sd/health', JSON.stringify({ mode: 'paper', git_sha: tag, open_positions: [] }));
  writeFileSync(join(root, 'common.sh'), `
. "${root}/logic.sh"
CRED_DIR="${root}/cred"; STATE_DIR="${root}/state"; PAIR_CODE_FILE="${root}/pair-code"
EVIDENCE_ROOT="${root}/ev"; EVIDENCE_INDEX="${root}/ev-index/evidence.json"
ZEROED_BRANCH=main; ZEROED_REPO=o/r; ZEROED_API_URL=http://127.0.0.1:9; WEB_FLOW_FPR=FPR
log() { printf '%s\\n' "$*" >> "${root}/log"; }
lock() { :; }
notify() { printf '%s\\n' "$1" >> "${root}/notify"; }
${fn('alert')}
${fn('alert_clear')}
keys_stored() { return 1; }
paired() { return 1; }
commit_verdict() { cat >/dev/null; echo green; }
e2e_commit() { echo "$2"; }
`);
  exe('git', `case "$*" in
  *rev-parse*) cat ${root}/sd/tag ;;
  *verify-commit*) echo '[GNUPG:] GOODSIG x'; echo '[GNUPG:] VALIDSIG a b c d e f g h i FPR' ;;
  *) exit 0 ;;
esac`);
  exe('worker-smoke', 'exit 0');
  exe('sleep', 'exit 0');
  exe('date', `if [ "$1" = +%s ]; then cat ${root}/sd/now; else /bin/date "$@"; fi`);
  exe('curl', `cat ${root}/sd/health`);
  exe('systemctl', `case "$1" in
  show) cat ${root}/sd/nrestarts ;;
  list-units) cat ${root}/sd/units 2>/dev/null ;;
  *) exit 0 ;;
esac`);
};
const update = () => {
  const r = spawnSync('bash', ['-c', relocate(UPDATE)], { encoding: 'utf8', env: { PATH: `${bin}:${process.env['PATH'] ?? ''}` } });
  return { status: r.status, out: `${r.stderr}${read('log')}` };
};
const at = (s: number) => set('sd/now', T0 + s);
/** Deploy 2: D2 tagged, switched by Deploy 1's zeroed-update, held, on probation with D1 (the stand-in) behind it. */
const deploy2 = () => {
  setup(D2);
  const r = update();
  expect(r.status, r.out).toBe(0);
  expect(current()).toBe(rel(D2));
  expect(read('state/probation')).toMatch(new RegExp(`^${D2}\\|${rel(D1)}\\|${D1}\\|${T0}\\|0`));
};

describe('round 3: the resume sequence on the stand-in, then the release worker', () => {
  it('sanity: Deploy 1 runs the stand-in and Deploy 2 the release worker (worker_entry at the host commit)', () => {
    setup(D2);
    const entry = (c: string) => spawnSync('bash', ['-c', `. "${root}/logic.sh"; worker_entry "${rel(c)}"`], { encoding: 'utf8' }).stdout.trim();
    expect(entry(D1)).toBe(join(root, 'opt/zeroed/stub/worker.mjs'));
    expect(entry(D2)).toBe(join(rel(D2), 'packages/worker/src/main.ts'));
  });

  it('R3-1: a probation rollback never lands on the stand-in while the release holds an open paper position', () => {
    deploy2();
    // The release worker restored (or opened) a paper position; no intent is in flight, so open_intents reads 0.
    set('sd/health', JSON.stringify({ mode: 'paper', git_sha: D2, open_positions: [{ trade: 'p1', mint: 'M', stop: 1 }] }));
    set('var/lib/zeroed/open_positions', '1\n');
    at(600);
    set('sd/nrestarts', 1); // one crash at minute 10
    const r = update();
    // Correct: the stand-in manages no exits and reports no position, so the rollback waits (with an alert naming the
    // position), as it waits for open intents. Today it goes ahead and the position is left with no exit management.
    expect({ current: current() === rel(D2) ? 'D2' : current() === rel(D1) ? 'D1 (stand-in)' : current(), notify: read('notify') }, r.out)
      .toEqual({ current: 'D2', notify: expect.stringMatching(/position/) });
  });

  it('R3-2: a failed switch hold never rolls onto the stand-in while the new worker reports open intents', () => {
    setup(D2);
    // D2's reconcile (ExecStartPre) wrote 1 open intent (an exit of a restored position in flight); its health route
    // never answers as D2 within 60 s (e.g. it crashes right after the reconcile).
    exe('systemctl', `case "$1" in
  show) cat ${root}/sd/nrestarts ;;
  restart) echo 1 > ${root}/var/lib/zeroed/open_intents ;;
  list-units) ;;
  *) exit 0 ;;
esac`);
    set('sd/health', JSON.stringify({ mode: 'paper', git_sha: D1 }));
    const r = update();
    // Correct (the probation rule, "a due rollback waits while the worker reports open intents"): no rollback onto the
    // stand-in, whose reconcile then writes 0 open intents over the release's 1 and unblocks every later gate.
    expect({ current: current() === rel(D2) ? 'D2' : current() === rel(D1) ? 'D1 (stand-in)' : current(), failed: read('state/failed_release').trim() === D2 }, r.out)
      .toEqual({ current: 'D2', failed: false });
  });

  it('R3-3: the worker-probation alert is a new message for each new release (its key is cleared, not kept forever)', () => {
    deploy2();
    // A qualifying run is active (by evidence), and D2 restarts: one alert, no rollback.
    mkdirSync(join(root, 'ev/run1'), { recursive: true });
    set('ev/run1/run.json', '{"name":"q1"}');
    at(300);
    set('sd/nrestarts', 1);
    update();
    expect(read('notify')).toMatch(/restarted 1 time\(s\).*during a qualifying dry run/);
    // The run finishes; the window passes; the probation ends.
    set('ev/run1/report.json', '{"pass":true}');
    at(7_300);
    update();
    expect(read('state/probation')).toBe('');
    // D3 is deployed later and a new qualifying run is active when D3 restarts: the owner must hear of it.
    set('sd/tag', D3);
    set('sd/health', JSON.stringify({ mode: 'paper', git_sha: D3 }));
    set('sd/nrestarts', 0);
    at(20_000);
    expect(update().status).toBe(0);
    expect(current()).toBe(rel(D3));
    mkdirSync(join(root, 'ev/run2'), { recursive: true });
    set('ev/run2/run.json', '{"name":"q2"}');
    at(20_300);
    set('sd/nrestarts', 2);
    update();
    const sent = read('notify').split('\n').filter((l) => l.includes('during a qualifying dry run'));
    expect(sent.map((l) => l.slice(0, 80)), read('log')).toHaveLength(2);
  });

  // Known residual (DECISIONS 2026-10-07 RC-R2-3: "a new switch ends the probation of the release before it"); kept as a probe.
  it('R3-4: a later release that fails its switch hold puts D2 back still on probation (its late crash is still caught)', () => {
    deploy2();
    // D3 is tagged 20 min later; its worker never answers as D3, so the server goes back to D2.
    at(1_200);
    set('sd/tag', D3);
    set('sd/health', JSON.stringify({ mode: 'paper', git_sha: D2 }));
    expect(update().status).toBe(1);
    expect(current()).toBe(rel(D2));
    // D2, back on and still inside its 2 h window, crashes once at minute 40.
    at(2_400);
    set('sd/nrestarts', 1);
    update();
    // Correct: D2's probation resumed (rollback to D1, or at least an alert naming D2's restart). Today it is gone.
    expect({ probationOrRollback: read('state/probation').startsWith(D2) || current() === rel(D1) || /restarted 1 time/.test(read('notify')) }, read('log'))
      .toEqual({ probationOrRollback: true });
  });

  it("R3-5: the stand-in's reconcile never reports 0 open intents over a ledger it did not settle", () => {
    // After any switch onto the stand-in (R3-1, R3-2), its --reconcile (the unit's ExecStartPre) runs over the release's
    // state dir. Here the release's last reconcile left 1 open intent.
    const dir = mkdtempSync(join(tmpdir(), 'r3-stub-'));
    roots.push(dir);
    const state = join(dir, 'state');
    const creds = join(dir, 'creds');
    mkdirSync(state);
    mkdirSync(creds);
    for (const n of ['helius_api_key', 'alchemy_api_key', 'jupiter_api_key', 'telegram_bot_token', 'telegram_chat_id']) writeFileSync(join(creds, n), 'x');
    writeFileSync(join(state, 'open_intents'), '1\n');
    writeFileSync(join(dir, 'worker.mjs'), show(HOST, `${F}/opt/zeroed/stub/worker.mjs`));
    const r = spawnSync(process.execPath, ['--no-warnings', join(dir, 'worker.mjs'), '--reconcile'], { encoding: 'utf8', env: { ...process.env, STATE_DIRECTORY: state, CREDENTIALS_DIRECTORY: creds } });
    expect(r.status, r.stderr).toBe(0);
    // Correct: anything but "0" (the release's count kept, or "unknown"), so zeroed-update's gates keep holding.
    expect({ stdout: r.stdout.trim(), open_intents: readFileSync(join(state, 'open_intents'), 'utf8') }).not.toMatchObject({ open_intents: '0\n' });
  });

  it('R3-6: after a rollback, the next release that fails its switch is still reported (not silent on the stand-in)', () => {
    deploy2();
    // D2 crashes once in its probation and goes back to D1, the stand-in: one worker-switch alert.
    at(600);
    set('sd/nrestarts', 1);
    expect(update().status).toBe(1);
    expect(current()).toBe(rel(D1));
    expect(read('notify')).toMatch(/worker of 25c4d9bfcfd7 did not stay up/);
    // The fix, D3, is tagged; its trial passes but its worker never answers after the switch: back to D1 again.
    set('sd/tag', D3);
    set('sd/health', JSON.stringify({ mode: 'paper', git_sha: D1 }));
    set('sd/nrestarts', 0);
    at(3_600);
    expect(update().status).toBe(1);
    expect(current()).toBe(rel(D1));
    // Correct: the owner hears that D3 failed too and the bot is still on the stand-in.
    expect(read('notify'), read('log')).toMatch(/worker of dddddddddddd did not stay up/);
  });
});
