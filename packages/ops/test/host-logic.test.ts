// OPS-1e: the host's decision helpers (ops/host/files/usr/local/lib/zeroed/logic.sh) run in bash here, and
// the scripts that use them are checked for the wiring the e2e (ops/test/e2e.sh) then drives on a real host.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const LOGIC = join(root, 'ops/host/files/usr/local/lib/zeroed/logic.sh');
const sh = (script: string, input = '', env: Record<string, string> = {}) => {
  const r = spawnSync('bash', ['-c', `set -euo pipefail; . "${LOGIC}"; ${script}`], { input, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...env } });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
};
const tmp = mkdtempSync(join(tmpdir(), 'zeroed-logic-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('webhook retry back-off', () => {
  it('waits 1, 2, 4, 8 minutes, then every 30, and tells the owner after 5 failed tries', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 20].map((n) => Number(sh(`backoff_s ${n}`).out))).toEqual([60, 120, 240, 480, 960, 1800, 1800, 1800]);
    expect(sh('echo "$WEBHOOK_MAX_TRIES"').out).toBe('5');
    const common = read('ops/host/files/usr/local/lib/zeroed/common.sh');
    const body = common.slice(common.indexOf('webhook_try() {'), common.indexOf('webhook_off() {'));
    expect(body).toContain('if [ "$tries" -ge "$WEBHOOK_MAX_TRIES" ]; then');
    expect(body).toContain('alert webhook-failed');
    expect(body).toContain('alert_clear webhook-failed');
    expect(body).toContain('webhook_info | webhook_fp > "$STATE_DIR/webhook_expected"');
  });

  it('every place that sets the webhook goes through the retry, and zeroed-check retries when due', () => {
    for (const p of ['ops/host/files/usr/local/sbin/zeroed-pair', 'ops/host/files/usr/local/sbin/zeroed-telegram-pair', 'ops/host/files/usr/local/sbin/zeroed-check']) {
      const s = read(p);
      expect(s, p).toContain('webhook_try');
      expect(s, p).not.toMatch(/^\s*set_webhook\b/m);
    }
    const check = read('ops/host/files/usr/local/sbin/zeroed-check');
    expect(check).toContain('if [ "$(date +%s)" -ge "$(cat "$STATE_DIR/webhook_next" 2>/dev/null || echo 0)" ]; then webhook_try || true; fi');
  });
});

describe('webhook fingerprint', () => {
  const info = (result: Record<string, unknown>) => JSON.stringify({ ok: true, result });
  const base = { url: 'https://zeroed-watchdog.x.workers.dev/telegram', has_custom_certificate: false, pending_update_count: 0, max_connections: 40, ip_address: '1.2.3.4', allowed_updates: ['message'] };
  const fp = (s: string) => sh('webhook_fp', s);

  it('is "none" without a webhook, "error" when Telegram does not answer, and a SHA-256 otherwise', () => {
    expect(fp(info({ url: '', has_custom_certificate: false, pending_update_count: 0 })).out).toBe('none');
    expect(fp('{"ok":false,"error_code":401}').out).toBe('error');
    expect(fp('not json').out).toBe('error');
    expect(fp(info(base)).out).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with the URL, the certificate, the connections or the update types', () => {
    const a = fp(info(base)).out;
    for (const change of [{ url: 'https://evil.example/hook' }, { has_custom_certificate: true }, { max_connections: 100 }, { allowed_updates: ['message', 'callback_query'] }]) {
      expect(fp(info({ ...base, ...change })).out, JSON.stringify(change)).not.toBe(a);
    }
  });

  it('ignores what Telegram changes on its own (IP address, pending count, last error)', () => {
    const a = fp(info(base)).out;
    expect(fp(info({ ...base, ip_address: '5.6.7.8', pending_update_count: 9, last_error_date: 1, last_error_message: 'x' })).out).toBe(a);
  });

  it('names only the host of a changed URL', () => {
    expect(sh('webhook_host', info({ ...base, url: 'https://evil.example:8443/hook?a=b' })).out).toBe('evil.example:8443');
    expect(sh('webhook_host', info({ url: '' })).out).toBe('none');
  });

  it('zeroed-check alerts on a change, sets its own webhook back, and says when it is cleared; re-pairing is not a change', () => {
    const check = read('ops/host/files/usr/local/sbin/zeroed-check');
    expect(check).toMatch(/if \[ "\$now_fp" != "\$\(cat "\$STATE_DIR\/webhook_expected"\)" \]; then\n\s+alert webhook-changed "ALERT [^\n]+\n\s+webhook_try \|\| true/);
    expect(check).toContain('alert_clear webhook-changed "CLEARED');
    expect(check).toContain('[ ! -s "$PAIR_CODE_FILE" ]');
    const common = read('ops/host/files/usr/local/lib/zeroed/common.sh');
    expect(common.slice(common.indexOf('webhook_off() {'))).toMatch(/deleteWebhook[^\n]*\n\s+printf 'none\\n' > "\$STATE_DIR\/webhook_expected"/);
  });
});

describe('stored-key check', () => {
  it('records the ciphertext hash (never a value) on every store, and checks decrypt and hash for each key', () => {
    const common = read('ops/host/files/usr/local/lib/zeroed/common.sh');
    const store = common.slice(common.indexOf('store_cred() {'), common.indexOf('# tg METHOD'));
    expect(store).toContain('record_cred "$1"');
    expect(store).toContain('sha256sum "$CRED_DIR/$1" | cut -c1-64 > "$STATE_DIR/cred_sha/$1"');
    const check = read('ops/host/files/usr/local/sbin/zeroed-check');
    expect(check).toContain('why=missing');
    expect(check).toContain('! systemd-creds decrypt --name="$n" "$CRED_DIR/$n" - >/dev/null 2>&1');
    expect(check).toContain('why="changed outside a key handoff"');
    expect(check).toContain('alert key-mismatch "ALERT');
    expect(check).toContain('alert_clear key-mismatch "CLEARED');
    // Decrypted values go only to /dev/null.
    expect(check.match(/systemd-creds decrypt[^\n]*/g)).toEqual(['systemd-creds decrypt --name="$n" "$CRED_DIR/$n" - >/dev/null 2>&1; then']);
  });

  it('alerts once per episode and keeps an undelivered alert pending', () => {
    const common = read('ops/host/files/usr/local/lib/zeroed/common.sh');
    const alert = common.slice(common.indexOf('alert() {'), common.indexOf('alert_clear() {'));
    expect(alert).toContain('[ ! -e "$STATE_DIR/alerts/$1" ] || return 0');
    expect(alert).toContain('if notify "$2"; then : > "$STATE_DIR/alerts/$1"; else');
  });
});

describe('re-pairing', () => {
  it('a code lasts 30 minutes', () => {
    expect(sh('pair_code_expired 1000 2800 && echo y || echo n').out).toBe('n');
    expect(sh('pair_code_expired 1000 2801 && echo y || echo n').out).toBe('y');
  });

  it('asks before making a code on a paired server, and tells the current chat', () => {
    const s = read('ops/host/files/usr/local/sbin/zeroed-pair-code');
    expect(s).toMatch(/if paired; then\n\s+printf '[^']*Type yes to continue: '/);
    expect(s).toContain('[ "$answer" = yes ] || { log "Cancelled. Nothing changed."; exit 1; }');
    expect(s.indexOf('[ "$answer" = yes ]')).toBeLessThan(s.indexOf('new_pair_code'));
  });

  it('keeps the old chat until the new /pair succeeds, and expires the code', () => {
    const s = read('ops/host/files/usr/local/sbin/zeroed-telegram-pair');
    // Only the success branch stores the chat.
    expect(s.match(/store_cred telegram_chat_id/g)).toHaveLength(1);
    const success = s.slice(s.indexOf('if [ "$got" = "$want" ]; then'), s.indexOf('  else\n    rm -f "$PAIR_CODE_FILE"'));
    expect(success).toContain('store_cred telegram_chat_id');
    expect(s).not.toMatch(/rm[^\n]*telegram_chat_id/);
    expect(s).toContain('pair_code_expired "$issued_at" "$(date +%s)"');
    expect(s.indexOf('pair_code_expired')).toBeLessThan(s.indexOf('get_updates()'));
    // A paired server with no code pending reads nothing (the webhook has the messages).
    expect(s).toContain('[ -s "$PAIR_CODE_FILE" ] || exit 0');
  });
});

describe('qualifying dry run (update gate)', () => {
  const ev = join(tmp, 'evidence');
  const run = (id: string, meta: Record<string, unknown> | null, files: Record<string, string> = {}) => {
    mkdirSync(join(ev, id), { recursive: true });
    if (meta) writeFileSync(join(ev, id, 'run.json'), JSON.stringify(meta));
    for (const [k, v] of Object.entries(files)) writeFileSync(join(ev, id, k), v);
  };
  const active = (units = '') => sh(`qualifying_run "${ev}" "$U"`, '', { U: units }).out;

  it('is active while its unit is active or activating', () => {
    mkdirSync(ev, { recursive: true });
    expect(active()).toBe('');
    expect(active('zeroed-dryrun@q1.service loaded active running Zeroed dry run q1 (drills and evidence)')).toBe('q1');
    expect(active('zeroed-dryrun@q2.service loaded activating auto-restart Zeroed dry run q2')).toBe('q2');
    expect(active('zeroed-dryrun-tick.service loaded active exited x')).toBe('');
  });

  it('is active while a named run has no report (after a reboot, before the runner resumes)', () => {
    run('vps-20261004T0000Z-aaaaaaaaaaaa', { name: 'q3', label: 'vps', commit: 'a'.repeat(40), startedAt: 1 });
    expect(active()).toBe('q3');
    writeFileSync(join(ev, 'vps-20261004T0000Z-aaaaaaaaaaaa', 'report.json'), JSON.stringify({ pass: false }));
    expect(active()).toBe('');
    run('local-x', { label: 'rehearsal' });
    expect(active()).toBe('');
  });

  it('zeroed-update waits on it before switching, and the host checks use the same rule', () => {
    const s = read('ops/host/files/usr/local/sbin/zeroed-update');
    const gate = s.indexOf('run="$(active_run)"');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(s.indexOf('ln -sfn "$dest" /opt/zeroed/current.new'));
    expect(s).toContain('log "Waiting on ${commit:0:12}: the qualifying dry run $run is active."');
    expect(s).toContain("systemctl list-units 'zeroed-dryrun@*' --state=active,activating --plain --no-legend");
    expect(read('packages/runner/src/cli.ts')).toContain("['list-units', 'zeroed-dryrun@*', '--state=active,activating', '--plain', '--no-legend']");
  });
});

describe('evidence on the host', () => {
  it('is indexed with id, name, state and path, newest first; junk is left out', () => {
    const ev = join(tmp, 'ev2');
    mkdirSync(join(ev, 'vps-20261004T0100Z-bbbbbbbbbbbb'), { recursive: true });
    writeFileSync(join(ev, 'vps-20261004T0100Z-bbbbbbbbbbbb', 'run.json'), JSON.stringify({ name: 'q1', label: 'vps', commit: 'b'.repeat(40), startedAt: 5 }));
    writeFileSync(join(ev, 'vps-20261004T0100Z-bbbbbbbbbbbb', 'report.json'), JSON.stringify({ pass: true }));
    mkdirSync(join(ev, 'vps-20261005T0100Z-cccccccccccc'), { recursive: true });
    writeFileSync(join(ev, 'vps-20261005T0100Z-cccccccccccc', 'run.json'), JSON.stringify({ name: 'q2', label: 'vps', commit: 'c'.repeat(40), startedAt: 9 }));
    writeFileSync(join(ev, 'vps-20261005T0100Z-cccccccccccc', 'ABORTED'), 'refused to run: stub\n');
    mkdirSync(join(ev, 'no-run-json'), { recursive: true });
    mkdirSync(join(ev, 'bad'), { recursive: true });
    writeFileSync(join(ev, 'bad', 'run.json'), '{not json');
    const r = sh(`evidence_index "${ev}"`);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.out)).toEqual([
      { id: 'vps-20261005T0100Z-cccccccccccc', name: 'q2', label: 'vps', commit: 'c'.repeat(40), started: 9, finished: false, pass: null, aborted: 'refused to run: stub', path: join(ev, 'vps-20261005T0100Z-cccccccccccc') },
      { id: 'vps-20261004T0100Z-bbbbbbbbbbbb', name: 'q1', label: 'vps', commit: 'b'.repeat(40), started: 5, finished: true, pass: true, aborted: null, path: join(ev, 'vps-20261004T0100Z-bbbbbbbbbbbb') },
    ]);
    expect(JSON.parse(sh(`evidence_index "${join(tmp, 'missing')}"`).out)).toEqual([]);
  });

  it('the directory is created by the installer and the health route serves the index; nothing uploads it', () => {
    expect(read('ops/host/install-main.sh')).toContain('install -d -m 0700 -o root -g root /var/lib/zeroed-dryrun /var/lib/zeroed-dryrun/evidence');
    expect(read('ops/host/files/usr/local/lib/zeroed/common.sh')).toContain('EVIDENCE_ROOT=/var/lib/zeroed-dryrun/evidence');
    expect(read('packages/runner/systemd/zeroed-dryrun@.service')).toContain('--evidence-root /var/lib/zeroed-dryrun/evidence');
    const stub = read('ops/host/files/opt/zeroed/stub/worker.mjs');
    expect(stub).toContain("readFileSync('/var/lib/zeroed-index/evidence.json', 'utf8')");
    expect(stub).toContain('evidence: evidence()');
    expect(stub).toContain("const healthAddr = process.env.ZEROED_API_ADDR ?? '';");
    // No path from the host to the repository or GitHub: no token, no push, no upload.
    for (const p of ['ops/host/install-main.sh', ...['zeroed-check', 'zeroed-update', 'zeroed-status', 'zeroed-tailscale'].map((n) => `ops/host/files/usr/local/sbin/${n}`)]) {
      expect(read(p), p).not.toMatch(/git push|gh (api|release)|GITHUB_TOKEN|-X (POST|PUT|PATCH)[^\n]*api\.github|ZEROED_API_URL[^\n]*-X/);
    }
  });
});

describe('worker start and API address', () => {
  it('the unit starts the wrapper for reconcile and run; the wrapper sets the RUN-1 environment, paper only', () => {
    const unit = read('ops/host/files/etc/systemd/system/zeroed-worker.service');
    expect(unit).toContain('ExecStartPre=/usr/local/lib/zeroed/worker-start --reconcile');
    expect(unit).toMatch(/^ExecStart=\/usr\/local\/lib\/zeroed\/worker-start$/m);
    const w = read('ops/host/files/usr/local/lib/zeroed/worker-start');
    expect(w).toContain('export ZEROED_MODE=paper ZEROED_RECORDER=on ZEROED_SIMULATE=on ZEROED_DRILLS=on');
    expect(w).toContain('export ZEROED_HEALTH_ADDR="$WORKER_HEALTH_ADDR" ZEROED_API_ADDR="$WORKER_API_ADDR"');
    expect(w).toContain('entry="$(worker_entry /opt/zeroed/current)"');
    expect(w).not.toMatch(/ZEROED_MODE=(?!paper )/);
    // HEAP-GUARD: an explicit heap limit under MemoryMax=800M and a fatal-error report in the state dir, on both execs
    // (the reconcile pre-step and the run use this one wrapper); the directory is made before node starts.
    expect(unit).toMatch(/^MemoryMax=800M$/m);
    expect(w).toContain('reports="${STATE_DIRECTORY:-/var/lib/zeroed}/reports"');
    expect(w).toContain('heap=(--max-old-space-size=560 --report-on-fatalerror --report-compact "--report-directory=$reports")');
    expect(w.indexOf('mkdir -p "$reports"')).toBeGreaterThan(-1);
    expect(w.indexOf('mkdir -p "$reports"')).toBeLessThan(w.indexOf('exec '));
    const execs = w.split('\n').filter((l) => /^\s*exec /.test(l));
    expect(execs).toHaveLength(2);
    for (const l of execs) expect(l, l).toContain('"${heap[@]}" "$entry" "$@"');
  });

  it('the e2e pins the exact command line worker-start builds for the release worker (HEAP-GUARD)', () => {
    const w = read('ops/host/files/usr/local/lib/zeroed/worker-start');
    const lines = w.split('\n').filter((l) => /^(reports|heap)=/.test(l)).join('\n');
    const built = spawnSync('bash', ['-c', `STATE_DIRECTORY=/var/lib/zeroed\n${lines}\nprintf '%s ' /usr/local/bin/node --no-warnings "\${heap[@]}" /opt/zeroed/current/packages/worker/src/main.ts`], { encoding: 'utf8' }).stdout;
    const e2e = read('ops/test/e2e.sh');
    const pinned = /has '\^(\/usr\/local\/bin\/node --no-warnings [^']*\/opt\/zeroed\/current\/packages\/worker\/src\/main\.ts )\$'/.exec(e2e)?.[1];
    expect(pinned).toBe(built);
  });

  it('worker-start keeps only the newest 5 fatal reports, before node starts, and runs clean with none (HEAP-GUARD)', () => {
    const w = read('ops/host/files/usr/local/lib/zeroed/worker-start');
    const from = w.indexOf('shopt -s nullglob');
    const to = w.indexOf('fi\n', w.indexOf('rm -f -- "${old[@]:5}"')) + 3;
    expect(from).toBeGreaterThan(w.indexOf('mkdir -p "$reports"'));
    expect(to).toBeLessThan(w.indexOf('exec '));
    const prune = w.slice(from, to);
    const dir = join(tmp, 'reports-prune');
    const runPrune = () => spawnSync('bash', ['-c', `set -euo pipefail\nreports=${dir}\n${prune}`], { encoding: 'utf8' });
    mkdirSync(dir, { recursive: true });
    // No report at all.
    expect(runPrune().status).toBe(0);
    const at = (k: number) => new Date(Date.UTC(2026, 9, 5, 1, 0, k)).toISOString();
    const put = (k: number) => {
      const f = join(dir, `report.2026.${String(k).padStart(2, '0')}.json`);
      writeFileSync(f, '{}');
      spawnSync('touch', ['-d', at(k), f]);
    };
    for (let k = 0; k < 3; k++) put(k);
    writeFileSync(join(dir, 'notes.txt'), 'kept');
    expect(runPrune().status).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'report.2026.00.json', 'report.2026.01.json', 'report.2026.02.json']);
    for (let k = 3; k < 9; k++) put(k);
    expect(runPrune().status).toBe(0);
    expect(readdirSync(dir).sort()).toEqual(['notes.txt', 'report.2026.04.json', 'report.2026.05.json', 'report.2026.06.json', 'report.2026.07.json', 'report.2026.08.json']);
  });

  it("runs the release's worker only when the release's host-config says so; the stand-in only when it says \"stub\" (RC-M4: anything else is refused)", () => {
    const rel = join(tmp, 'release');
    const cfg = (o: unknown) => {
      mkdirSync(join(rel, 'ops'), { recursive: true });
      writeFileSync(join(rel, 'ops/host-config.json'), JSON.stringify(o));
    };
    const entry = () => sh(`worker_entry "${rel}"`).out;
    const refused = (why: RegExp) => {
      const r = sh(`worker_entry "${rel}"`);
      expect(r.status).toBe(1);
      expect(r.out).toBe('');
      expect(r.err).toMatch(why);
    };
    const STUB = '/opt/zeroed/stub/worker.mjs';
    const MAIN = join(rel, 'packages/worker/src/main.ts');
    expect(entry()).toBe(STUB); // no release deployed yet (a first install)
    mkdirSync(join(rel, 'packages/worker/src'), { recursive: true });
    writeFileSync(MAIN, '');
    refused(/host-config\.json is missing or cannot be read/); // main.ts but no host-config
    cfg({ offsite_backup: false });
    refused(/"worker" is \(missing\), not "release" or "stub"/);
    cfg({ worker: 'stub' });
    expect(entry()).toBe(STUB);
    cfg({ worker: 'Release' });
    refused(/"worker" is Release, not "release" or "stub"/);
    cfg({ worker: 7 });
    refused(/"worker" is \(not a string\)/);
    cfg(['release']);
    refused(/cannot be read/);
    cfg({ worker: 'release' });
    expect(entry()).toBe(MAIN);
    rmSync(MAIN);
    refused(/main\.ts is missing/); // asked for, but the release has no worker
    writeFileSync(join(rel, 'ops/host-config.json'), '{not json');
    refused(/cannot be read/);
    // worker-start and worker-smoke take it under `set -e`: a refusal stops them, never runs anything.
    expect(sh(`e="$(worker_entry "${rel}")"; echo "ran $e"`)).toMatchObject({ status: 1, out: '' });
    // A dangling link (a current whose release folder went) is refused, never the stand-in.
    const dangling = join(tmp, 'dangling-current');
    symlinkSync(join(tmp, 'no-such-release'), dangling);
    expect(sh(`worker_entry "${dangling}"`)).toMatchObject({ status: 1, out: '' });
    // SWITCH-1 is the reviewed switch: the repository now runs the release's own worker.
    // PAUSE (owner, 2026-10-07): the host runs the stand-in until every blocker is fixed; back to 'release' then.
    expect(JSON.parse(read('ops/host-config.json')).worker).toBe('stub');
  });

  it("PRACTICE-ON: the release's shakedown settings, and only those, go to its worker", () => {
    const rel = join(tmp, 'release-shakedown');
    mkdirSync(join(rel, 'ops'), { recursive: true });
    const cfg = (o: unknown) => writeFileSync(join(rel, 'ops/host-config.json'), typeof o === 'string' ? o : JSON.stringify(o));
    const run = () => sh(`worker_shakedown "${rel}"`);
    cfg({ worker: 'release' });
    expect(run()).toMatchObject({ status: 0, out: '' });
    cfg({ worker: 'release', shakedown: { ZEROED_STRATEGY: 'S0', ZEROED_S0_DIAGNOSTIC: 'on', ZEROED_PAPER_EDGE_PPM: '178092', ZEROED_STANDINS: 'A1,B2', ZEROED_WALLET: 'C3' } });
    expect(run()).toMatchObject({ status: 0, out: 'ZEROED_STRATEGY=S0\nZEROED_S0_DIAGNOSTIC=on\nZEROED_PAPER_EDGE_PPM=178092\nZEROED_STANDINS=A1,B2\nZEROED_WALLET=C3' });
    // Nothing else, and nothing that could carry a second line, a space or a shell character.
    for (const bad of [
      { ZEROED_MODE: 'live' }, { ZEROED_RUN_ID: 'x' }, { HELIUS_API_KEY: 'x' }, { zeroed_strategy: 'S0' },
      { ZEROED_STRATEGY: 'S0\nZEROED_MODE=live' }, { ZEROED_STRATEGY: 'S0\n' }, { ZEROED_STRATEGY: 'S0 x' }, { ZEROED_STRATEGY: '$(id)' }, { ZEROED_STRATEGY: '' },
      { ZEROED_PAPER_EDGE_PPM: 178092 }, { ZEROED_STANDINS: ['A1'] }, { ZEROED_STANDINS: 'A'.repeat(401) },
    ]) {
      cfg({ worker: 'release', shakedown: bad });
      expect(run(), JSON.stringify(bad)).toMatchObject({ status: 5, out: '' });
    }
    cfg({ worker: 'release', shakedown: ['ZEROED_STRATEGY=S0'] });
    expect(run().status).not.toBe(0);
    cfg('{not json');
    expect(run().status).not.toBe(0);
    // The wrapper exports them for the release's worker only, before its fixed settings; the trial passes the same.
    const w = read('ops/host/files/usr/local/lib/zeroed/worker-start');
    const take = w.indexOf('settings="$(worker_shakedown /opt/zeroed/current)" || {');
    expect(take).toBeGreaterThan(w.indexOf('if [ "$entry" != /opt/zeroed/stub/worker.mjs ]; then'));
    expect(take).toBeLessThan(w.indexOf('export ZEROED_MODE=paper'));
    expect(w).toContain('exit 2; }');
    const smoke = read('ops/host/files/usr/local/lib/zeroed/worker-smoke');
    expect(smoke).toContain('settings="$(worker_shakedown "$dir" 2>"$tmp/shakedown.err")" || {');
    expect(smoke).toContain('shakedown+=(--setenv="$line")');
    expect(smoke).toContain('"${shakedown[@]}" \\\n    --setenv=NODE_ENV=production');
  });

  it("SWITCH-1: zeroed-update tries the new release's worker before anything changes", () => {
    const upd = read('ops/host/files/usr/local/sbin/zeroed-update');
    const smoke = upd.indexOf('/usr/local/lib/zeroed/worker-smoke "$dest"');
    expect(smoke).toBeGreaterThan(0);
    // Before the host files apply and before current moves; a failed trial alerts and exits.
    expect(smoke).toBeLessThan(upd.indexOf('apply_host "$commit" "$dest" || exit 1'));
    expect(smoke).toBeLessThan(upd.indexOf('ln -sfn "$dest" /opt/zeroed/current.new'));
    expect(upd.slice(smoke, upd.indexOf('apply_host "$commit" "$dest" || exit 1'))).toMatch(/alert worker-smoke "ALERT[^\n]*stays on the release it runs[^\n]*"\n\s+exit 1\n/);
    const s = read('ops/host/files/usr/local/lib/zeroed/worker-smoke');
    // Beside the running worker: its own ports, a scratch state directory, the worker's user, paper only.
    expect(sh('echo "$SMOKE_HEALTH_ADDR $SMOKE_API_ADDR"').out).toBe('127.0.0.1:8797 127.0.0.1:8798');
    expect(s).toContain('--setenv=ZEROED_HEALTH_ADDR="$SMOKE_HEALTH_ADDR" --setenv=ZEROED_API_ADDR="$SMOKE_API_ADDR"');
    expect(s).toContain('--setenv=ZEROED_STATE_DIR="$tmp/state"');
    expect(s).toContain('--setenv=ZEROED_MODE=paper');
    expect(s).not.toMatch(/ZEROED_MODE=(?!paper )/);
    expect(s).not.toMatch(/CREDENTIALS_DIRECTORY|credstore|LoadCredential/);
    expect(s).toContain('if [ "$3" = reconcile ]; then opts=(--wait -p RuntimeMaxSec=120); args=(--reconcile); fi');
    // The worker's own arguments go after the program, never among systemd-run's options.
    expect(s).toContain('/usr/local/bin/node --no-warnings "$entry" "${args[@]}"');
    // Review #110: a transient unit under the worker unit's sandbox, capped in memory, the worker's environment file,
    // the scratch directory its only writable path; and it must stay up for a hold after its first answer.
    expect(sh('echo "$SMOKE_MEMORY_MAX $SMOKE_HOLD_S $SWITCH_HOLD_S"').out).toBe('280M 30 30');
    expect(s).toMatch(/systemd-run --quiet --unit="\$unit" "\$\{opts\[@\]\}" "\$\{props\[@\]\}" \\\n\s+-p User=zeroed-worker -p Group=zeroed-worker -p MemoryMax="\$SMOKE_MEMORY_MAX" -p OOMScoreAdjust=1000 /);
    expect(s).toContain('-p EnvironmentFile=-/etc/zeroed/worker.env -p WorkingDirectory="$dir" -p ReadWritePaths="$tmp"');
    expect(s).toContain('done < <(unit_sandbox "$UNIT_FILE")');
    expect(s).toContain('for _ in $(seq 1 "$SMOKE_HOLD_S"); do');
    const unit = read('ops/host/files/etc/systemd/system/zeroed-worker.service');
    const sandbox = sh(`unit_sandbox "${join(root, 'ops/host/files/etc/systemd/system/zeroed-worker.service')}"`).out.split('\n');
    // Every hardening and limit line of the unit reaches the trial; nothing that would give it identity, keys or state.
    for (const l of unit.slice(unit.indexOf('# Hardening'), unit.indexOf('[Install]')).split('\n').filter((x) => /^[A-Z]/.test(x))) expect(sandbox, l).toContain(l);
    for (const k of ['UMask=0077', 'TasksMax=256', 'LimitCORE=0', 'NoNewPrivileges=yes', 'ProtectSystem=strict', 'PrivateTmp=yes', 'CapabilityBoundingSet=']) expect(sandbox).toContain(k);
    for (const l of sandbox) expect(l).not.toMatch(/^(User|Group|SupplementaryGroups|LoadCredential|LoadCredentialEncrypted|ImportCredential|StateDirectory|ReadWritePaths|MemoryMax|OOMScoreAdjust|ExecStart|ExecStartPre|Restart|EnvironmentFile)=/);
    // Under memory pressure the kernel takes the trial first and the live worker (which owns exits) last.
    expect(unit).toMatch(/^OOMScoreAdjust=-500$/m);
    expect(s).toContain('-p OOMScoreAdjust=1000');
    expect(sandbox.length).toBeGreaterThan(25);
    // After the switch: the new worker must stay up, else back to the release that ran, not tried again, one alert.
    const after = upd.slice(upd.indexOf('ln -sfn "$dest" /opt/zeroed/current.new'));
    // OPS-CLEAN round 4: the rollback target comes from the deployed record, before current moves, with the marker down first.
    const prevAt = upd.indexOf('prev="/opt/zeroed/releases/$current"');
    expect(prevAt).toBeGreaterThan(0);
    expect(prevAt).toBeLessThan(upd.indexOf('ln -sfn "$dest" /opt/zeroed/current.new'));
    expect(upd.indexOf(`printf '%s|%s|%s\\n' "$commit" "$prev" "$current" > "$STATE_DIR/switch_unheld"`)).toBeLessThan(upd.indexOf('ln -sfn "$dest" /opt/zeroed/current.new'));
    expect(upd).not.toContain('readlink -f /opt/zeroed/current 2>/dev/null || true)"\nprev');
    // OPS-CLEAN M1: the restart and hold live in held_restart, which the switch and the held first start both call.
    const held = upd.slice(upd.indexOf('held_restart() {'));
    expect(held.slice(0, held.indexOf('\n}\n'))).toMatch(/systemctl restart zeroed-worker\.service \|\| due_rollback "it failed to start"\n\s+if ! why="\$\(holds\)"; then due_rollback "\$why"; fi/);
    expect(after).toMatch(/if worker_ready; then\n\s+held_restart\n/);
    // held_restart releases the host lock itself, once holding is down.
    expect(held.slice(0, held.indexOf('\n}\n'))).toMatch(/: > "\$STATE_DIR\/holding"\n(\s*#[^\n]*\n)*\s+flock -u 9 2>\/dev\/null \|\| true\n/);
    // RC-FIXES-2b (red team C R3-2): a due rollback goes through probation_check's gate, which ends in rollback().
    const due = upd.slice(upd.indexOf('due_rollback() {'));
    expect(due.slice(0, due.indexOf('\n}\n'))).toMatch(/> "\$STATE_DIR\/probation"\n\s+rm -f "\$STATE_DIR\/switch_unheld" "\$STATE_DIR\/holding"\n\s+probation_check\n\s+exit 1$/);
    const rb = upd.slice(upd.indexOf('rollback() {'), upd.indexOf('# Restart with reconcile first'));
    for (const want of ['printf \'%s\\n\' "$commit" > "$STATE_DIR/failed_release"', 'ln -sfn "$prev" /opt/zeroed/current.new', 'printf \'%s\\n\' "$current" > "$STATE_DIR/deployed"', 'apply_host', 'systemctl restart zeroed-worker.service', 'alert worker-switch "ALERT']) expect(rb, want).toContain(want);
    expect(upd).toContain('[ "$commit" != "$(cat "$STATE_DIR/failed_release" 2>/dev/null || true)" ] || exit 0');
  });

  it('OPS-1i: zeroed-update holds the switch only for the new commit\'s worker, never on an answer from the release before', () => {
    const upd = read('ops/host/files/usr/local/sbin/zeroed-update');
    const fns = upd.slice(upd.indexOf('answers() {'), upd.indexOf('# rollback WHY'));
    // answers() and holds() as the script has them, with systemd, curl and sleep stood in: the unit is active, never
    // restarts, and its health route answers paper as release $SHA_NOW.
    const holds = (shaNow: string) => spawnSync('bash', ['-c', `set -euo pipefail
WORKER_HEALTH_ADDR=127.0.0.1:8787 WORKER_API_ADDR=127.0.0.1:8788 SWITCH_HOLD_S=1 commit=${'b'.repeat(40)}
systemctl() { [ "$1" = show ] && echo 0; return 0; }
sleep() { :; }
curl() { printf '{"mode":"paper","git_sha":"%s"}' "$SHA_NOW"; }
${fns}
holds`], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', SHA_NOW: shaNow } });
    expect(holds('b'.repeat(40))).toMatchObject({ status: 0, stdout: '' });
    const old = holds('a'.repeat(40));
    expect(old.status).toBe(1);
    expect(old.stdout.trim()).toBe(`its health route did not answer as ${'b'.repeat(12)} within 60 s`);
  });

  it('health for the runner on 127.0.0.1:8787 and the worker API on 127.0.0.1:8788, as WORKER-1 and RUN-1 expect', () => {
    expect(sh('echo "$WORKER_API_ADDR"').out).toBe('127.0.0.1:8788');
    expect(sh('echo "$WORKER_HEALTH_ADDR"').out).toBe('127.0.0.1:8787');
    // The runner's default health address (its unit sets none), and WORKER-1's default API address.
    expect(read('packages/runner/src/contract.ts')).toContain("export const DEFAULT_HEALTH_ADDR = '127.0.0.1:8787';");
    expect(read('packages/runner/systemd/zeroed-dryrun@.service')).not.toContain('--health-addr');
    expect(read('packages/worker/src/run/config.ts')).toContain("const apiAddr = env['ZEROED_API_ADDR'] ?? '127.0.0.1:8788';");
    expect(read('ops/host/files/usr/local/sbin/zeroed-tailscale')).toContain('tailscale serve --bg --https=443 "http://$WORKER_API_ADDR"');
    // 127.0.0.1:8789 is RUN-1d's tabletop worker: reserved, never the worker API, never published.
    expect(sh('echo "$TABLETOP_API_ADDR"').out).toBe('127.0.0.1:8789');
    for (const p of ['ops/host/files/usr/local/lib/zeroed/worker-start', 'ops/host/files/usr/local/sbin/zeroed-tailscale', 'packages/runner/systemd/zeroed-dryrun@.service']) expect(read(p), p).not.toContain('8789');
  });

  it('the stand-in serves /health on loopback only', () => {
    const r = spawnSync('node', [join(root, 'ops/host/files/opt/zeroed/stub/worker.mjs')], {
      env: { PATH: process.env['PATH'] ?? '', STATE_DIRECTORY: tmp, ZEROED_API_ADDR: '0.0.0.0:18788' },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('Refused: the worker API must bind loopback only.');
  });
});

describe('live view (tailscale serve)', () => {
  const status = (o: Record<string, unknown>) => sh('serve_ok && echo ok || echo no', JSON.stringify(o)).out;
  const web = { 'zeroed.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8788' } } } };
  it('accepts only HTTPS 443 to the worker API with Funnel off', () => {
    expect(status({ TCP: { 443: { HTTPS: true } }, Web: web })).toBe('ok');
    expect(status({ TCP: { 443: { HTTPS: true } }, Web: web, AllowFunnel: { 'zeroed.tail1.ts.net:443': true } })).toBe('no');
    expect(status({ TCP: { 443: { HTTPS: true } }, Web: { 'zeroed.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:22' } } } } })).toBe('no');
    expect(status({ TCP: { 443: { HTTPS: true }, 22: { TCPForward: '127.0.0.1:22' } }, Web: web })).toBe('no');
    expect(status({})).toBe('no');
  });

  it('accepts nothing more than the worker API (OPS-1h review): a hand-made serve is adopted only in exactly that shape', () => {
    const tcp = { 443: { HTTPS: true } };
    // The owner's hand-made `tailscale serve --bg --https=443 http://127.0.0.1:8788` is exactly this.
    expect(status({ TCP: tcp, Web: web })).toBe('ok');
    expect(status({ TCP: tcp, Web: web, AllowFunnel: {} })).toBe('ok');
    expect(status({ TCP: tcp, Web: web, AllowFunnel: { 'zeroed.tail1.ts.net:443': false } })).toBe('ok');
    const host = 'zeroed.tail1.ts.net:443';
    for (const [why, o] of [
      ['an extra path', { TCP: tcp, Web: { [host]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8788' }, '/admin': { Proxy: 'http://127.0.0.1:9000' } } } } }],
      ['an extra port', { TCP: { ...tcp, 8443: { HTTPS: true } }, Web: { ...web, 'zeroed.tail1.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8788' } } } } }],
      ['a second web host', { TCP: tcp, Web: { ...web, 'other.tail1.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8788' } } } } }],
      ['a TCP forward', { TCP: { ...tcp, 2222: { TCPForward: '127.0.0.1:22' } }, Web: web }],
      ['a TCP forward on 443', { TCP: { 443: { HTTPS: true, TCPForward: '127.0.0.1:22' } }, Web: web }],
      ['plain HTTP', { TCP: { 443: { HTTP: true } }, Web: web }],
      ['a service', { TCP: tcp, Web: web, Services: { 'svc:x': {} } }],
      ['a foreground serve', { TCP: tcp, Web: web, Foreground: { s: { TCP: { 8080: { HTTPS: true } } } } }],
      ['the handler on another port', { TCP: tcp, Web: { 'zeroed.tail1.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8788' } } } } }],
      ['a handler with more than the proxy', { TCP: tcp, Web: { [host]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:8788', Text: 'x' } } } } }],
      ['no web host', { TCP: tcp }],
    ] as const) expect(status(o as Record<string, unknown>), why).toBe('no');
    expect(sh('serve_ok && echo ok || echo no', '[]').out).toBe('no');
  });

  it('Funnel on for any port is found, alerted and turned off, by the minute check and by every install', () => {
    const ports = (o: Record<string, unknown>) => sh('funnel_ports', JSON.stringify(o)).out;
    expect(ports({ Web: web })).toBe('');
    expect(ports({ AllowFunnel: { 'zeroed.tail1.ts.net:443': false } })).toBe('');
    expect(ports({ AllowFunnel: { 'zeroed.tail1.ts.net:443': true, 'zeroed.tail1.ts.net:8443': true } })).toBe('zeroed.tail1.ts.net:443\nzeroed.tail1.ts.net:8443');
    const check = read('ops/host/files/usr/local/sbin/zeroed-check');
    // OPS-1h: both calls are bounded, so the minute check never hangs on tailscale.
    expect(check).toContain('public="$(timeout 30 tailscale serve status --json 2>/dev/null | funnel_ports)"');
    expect(check).toContain('timeout 30 tailscale funnel --https="${hp##*:}" off');
    // OPS-1h review: Funnel that cannot be turned off (error or timeout) takes the whole serve config down, so the API
    // never stays public with only an alert.
    const fb = check.slice(check.indexOf('timeout 30 tailscale funnel --https="${hp##*:}" off'));
    expect(fb).toMatch(/\|\| off=0; done\n\s+if \[ "\$off" = 0 \]; then[^]*?timeout 30 tailscale serve reset[^]*?rm -f "\$STATE_DIR\/live_view"[^]*?notify "\$msg"/);
    // OPS-1h review nit: if serve reset fails too, the owner is told on Telegram, not only in the log.
    expect(fb).toMatch(/else\n\s+# Neither worked[^]*?msg="ALERT Zeroed host: Tailscale Funnel could not be turned off and the live view could not be taken down[^"]*"\n\s+log "\$msg"\n\s+notify "\$msg"/);
    expect(check).toContain('alert funnel-on "ALERT');
    expect(check).toContain('tailscale funnel --https="${hp##*:}" off');
    expect(check).toContain('alert_clear funnel-on "CLEARED');
    // Before the early exit for a host without keys.
    expect(check.indexOf('funnel_ports')).toBeLessThan(check.indexOf('keys_stored || exit 0'));
    const main = read('ops/host/install-main.sh');
    expect(main).toContain('/usr/local/sbin/zeroed-check || true');
    expect(main.indexOf('/usr/local/sbin/zeroed-check || true')).toBeLessThan(main.indexOf('if [ "$UPDATE" = 1 ]; then\n  # zeroed-update restarts'));
    // The only Funnel commands anywhere turn it off.
    for (const p of ['ops/host/install-main.sh', 'ops/host/files/usr/local/sbin/zeroed-check', 'ops/host/files/usr/local/sbin/zeroed-tailscale']) {
      for (const m of read(p).matchAll(/tailscale funnel[^\n]*/g)) expect(m[0], p).toMatch(/ off\b/);
    }
  });

  it('checks the target before publishing, and takes serve down itself when the result is not exactly the worker API', () => {
    const ts = read('ops/host/files/usr/local/sbin/zeroed-tailscale');
    const pre = ts.indexOf('[[ "$WORKER_API_ADDR" =~ ^127\\.0\\.0\\.1:[0-9]{1,5}$ ]]');
    expect(pre).toBeGreaterThan(0);
    expect(pre).toBeLessThan(ts.indexOf('tailscale serve --bg'));
    const fail = ts.slice(ts.indexOf('if ! tailscale serve status --json | serve_ok; then'));
    expect(fail.indexOf('tailscale serve reset')).toBeGreaterThan(0);
    expect(fail.indexOf('tailscale serve reset')).toBeLessThan(fail.indexOf('exit 1'));
    expect(fail.slice(0, fail.indexOf('exit 1'))).not.toContain('Run zeroed-tailscale --off');
    // OPS-1h: no funnel command at all (it waits forever for the Funnel capability, even for "off"); serve --https=443
    // clears Funnel for its port and serve reset clears it everywhere, and the serve_ok check confirms Funnel is off.
    expect(ts).not.toMatch(/tailscale funnel/);
    // HTTPS Certificates and MagicDNS are checked before serving, every tailscale call is bounded, and serve's output
    // (an error or a link the owner must open) is kept and shown, never sent to /dev/null.
    expect(ts.indexOf("has(\"https\")")).toBeGreaterThan(0);
    expect(ts.indexOf("has(\"https\")")).toBeLessThan(ts.indexOf('tailscale serve --bg'));
    expect(ts).toContain('timeout "$TS_WAIT" "$(type -P tailscale)" "$@"');
    expect(ts).toContain('tailscale serve --bg --https=443 "http://$WORKER_API_ADDR" >"$served" 2>&1');
    expect(ts).not.toMatch(/tailscale serve --bg[^\n]*\/dev\/null/);
  });

  it("Tailscale's own repository is in the unattended-upgrades origins", () => {
    const conf = read('ops/host/files/etc/apt/apt.conf.d/52zeroed-unattended-upgrades');
    expect(conf).toMatch(/Unattended-Upgrade::Origins-Pattern \{\n\s+"origin=Tailscale,label=Tailscale,codename=\$\{distro_codename\}";\n\};/);
    expect(conf).toContain('Unattended-Upgrade::Automatic-Reboot "false";');
    // The repository it matches is the one zeroed-tailscale adds, signed by the pinned key.
    expect(read('ops/host/files/usr/local/sbin/zeroed-tailscale')).toContain("printf 'deb [signed-by=%s] https://pkgs.tailscale.com/stable/ubuntu noble main\\n'");
  });

  it('is opt-in: the installer never installs or starts Tailscale, and the repository key is pinned', () => {
    const main = read('ops/host/install-main.sh');
    expect(main).not.toMatch(/apt-get[^\n]*tailscale|zeroed-tailscale|tailscale up/);
    const ts = read('ops/host/files/usr/local/sbin/zeroed-tailscale');
    const fpr = '2596A99EAAB33821893C0A79458CA832957F5868';
    expect(ts).toContain(`TS_FPR=${fpr}`);
    expect(ts.indexOf('[ "$got" = "$TS_FPR" ]')).toBeLessThan(ts.indexOf('apt-get'));
    expect(ts).toContain('--ssh=false');
    const keys = spawnSync('gpg', ['--show-keys', '--with-colons', join(root, 'ops/host/files/etc/zeroed/tailscale-archive.asc')], { encoding: 'utf8' }).stdout;
    expect(keys.split('\n').filter((l) => l.startsWith('fpr:'))[0]).toBe(`fpr:::::::::${fpr}:`);
  });

  it('the firewall lets HTTPS in from the tailnet interface only', () => {
    const nft = read('ops/host/files/etc/nftables.conf');
    const input = nft.slice(nft.indexOf('chain input'), nft.indexOf('chain forward'));
    expect(input.split('\n').filter((l) => /accept/.test(l) && !/^\s*#/.test(l)).map((l) => l.trim())).toEqual([
      'iif lo accept',
      'ct state established,related accept',
      'meta l4proto { icmp, ipv6-icmp } limit rate 10/second accept',
      'iifname "tailscale0" tcp dport 443 accept',
    ]);
  });
});

describe('install.sh --update', () => {
  const main = read('ops/host/install-main.sh');
  const upd = (s: string) => main.indexOf(s);

  it('keeps SSH as the running firewall has it, shows no code, starts no setup screen', () => {
    expect(main).toContain('--update) UPDATE=1; shift ;;');
    expect(main).toContain(`[ "$UPDATE" = 0 ] || ! nft list ruleset 2>/dev/null | grep -Eq 'tcp dport 22 .*accept' || SSH_WAS_OPEN=1`);
    expect(upd('SSH_WAS_OPEN=1')).toBeLessThan(upd('# @@FILES@@'));
    expect(main).toMatch(/if \[ "\$UPDATE" = 1 \]; then\n\s+# SSH stays[^\n]*\n\s+\[ "\$SSH_WAS_OPEN" = 0 \] \|\| sed -i 's\/\^#SSH_RULE#\/\/' \/etc\/nftables.conf\nelif/);
    expect(main).toContain('[ "$UPDATE" = 1 ] || keys_stored || [ -s "$DEPLOY_CODE_FILE" ] || new_deploy_code');
    const end = main.slice(upd('if [ "$UPDATE" = 1 ]; then\n  # zeroed-update restarts'));
    expect(end.indexOf('exit 0')).toBeLessThan(end.indexOf('exec /usr/local/sbin/zeroed-setup'));
    expect(main).toContain('die "--update keeps SSH as it is; --ssh-key needs a full install"');
  });

  it('is all or nothing: every changed host path is kept first, and any failure puts all of them back', () => {
    // Every write path of an update keeps the old file (or notes a new one) before it changes it.
    expect(main).toContain('cmp -s "$1.zeroed-new" "$1" 2>/dev/null || { CHANGED+=("$1"); keep_old "$1"; }');
    for (const p of ['/etc/zeroed/host.env', '/etc/ssh/sshd_config.d/10-zeroed.conf', '/var/lib/zeroed-host/release-units', '"/etc/systemd/system/$n"', '/usr/local/bin/node']) {
      expect(main.indexOf(`keep_old ${p}`), p).toBeGreaterThan(0);
    }
    expect(main.indexOf('keep_old /etc/zeroed/host.env')).toBeLessThan(main.indexOf('mv /etc/zeroed/host.env.new /etc/zeroed/host.env'));
    expect(main.indexOf('keep_old /usr/local/bin/node')).toBeLessThan(main.indexOf('ln -sfn "/opt/node-$NODE_VERSION/bin/node" /usr/local/bin/node'));
    // A dropped unit: its state is noted and its file kept before it is stopped and removed.
    const drop = main.slice(main.indexOf('for n in $(cat /var/lib/zeroed-host/release-units'));
    expect(drop.indexOf('keep_unit "$n"')).toBeLessThan(drop.indexOf('systemctl disable --now "$n"'));
    expect(drop.indexOf('keep_old "/etc/systemd/system/$n"')).toBeLessThan(drop.indexOf('rm -f "/etc/systemd/system/$n"'));
    // The trap is armed before anything an update changes: packages, Node, files.
    const trap = main.indexOf('  trap on_exit EXIT');
    for (const later of ['say "Packages"', 'say "Node $NODE_VERSION"', '# @@FILES@@']) expect(trap, later).toBeLessThan(main.indexOf(later));
    const onExit = main.slice(main.indexOf('on_exit() {'), main.indexOf('if [ "$UPDATE" = 1 ]; then\n  # An update killed'));
    expect(onExit).toContain('[ "$UPDATE" = 1 ] || return 0');
    expect(onExit).toMatch(/if \[ "\$rc" != 0 \]; then\n\s+roll_back\n/);
  });

  describe('roll-back, run in bash', () => {
    const fns = main.slice(main.indexOf('JOURNAL=/var/lib/zeroed-host/update-journal'), main.indexOf('if [ "$UPDATE" = 0 ] && [ -e "$JOURNAL" ]; then'));
    const start = main.slice(main.indexOf('if [ "$UPDATE" = 0 ] && [ -e "$JOURNAL" ]; then'), main.indexOf('say "Packages"'));
    const run = (dir: string, body: string) => {
      const r = spawnSync('bash', ['-c', `set -euo pipefail; UPDATE=1; say() { echo "$*"; }
        systemctl() { echo "systemctl $*" >> "${dir}/calls"; case "\${1:-} \${2:-}" in "is-enabled --quiet") [ -e "${dir}/enabled-\${3:-}" ];; "is-active --quiet") [ -e "${dir}/active-\${3:-}" ];; *) true;; esac; }
        nft() { echo "nft $*" >> "${dir}/calls"; }
        sync() { echo "sync $*" >> "${dir}/calls"; }
        ${fns}
        JOURNAL="${dir}/journal"
        MANAGED_ROOT="${dir}"
        ${body}`], { encoding: 'utf8' });
      return { ...r, calls: (() => { try { return readFileSync(join(dir, 'calls'), 'utf8'); } catch { return ''; } })() };
    };
    const fresh = (name: string) => {
      const dir = join(tmp, name);
      rmSync(dir, { recursive: true, force: true });
      for (const d of ['opt/zeroed', 'usr/local/bin', 'etc']) mkdirSync(join(dir, d), { recursive: true });
      return dir;
    };

    it('puts a changed file back, keeps the first copy only, and removes a new file', () => {
      const dir = fresh('tx1');
      const a = join(dir, 'opt/zeroed/a');
      const b = join(dir, 'opt/zeroed/b');
      writeFileSync(a, 'old a\n');
      const r = run(dir, `keep_old "${a}"; echo new > "${a}"; keep_old "${a}"; echo newer > "${a}"
        keep_old "${b}"; echo b > "${b}"
        roll_back 2>/dev/null; cat "${a}"; [ -e "${b}" ] && echo b-left || echo b-gone; [ -e "${dir}/journal" ] && echo journal-left || echo journal-gone; ls "${dir}/opt/zeroed" | grep -c zeroed-old || true`);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split('\n')).toEqual(['old a', 'b-gone', 'journal-gone', '0']);
      expect(r.calls).toContain('systemctl daemon-reload');
      expect(r.calls).toContain('nft -f /etc/nftables.conf');
      // Every journal line is synced to disk as it is written.
      expect(r.calls.split('\n').filter((c) => c === `sync ${dir}/journal`)).toHaveLength(2);
    });

    it('touches only the paths this installer manages, whatever the journal says', () => {
      const dir = fresh('tx5');
      const own = join(dir, 'etc/passwd');
      writeFileSync(own, 'root\n');
      writeFileSync(`${own}.zeroed-old`, 'attacker\n');
      const kept = join(dir, 'opt/zeroed/kept');
      writeFileSync(kept, 'new\n');
      writeFileSync(`${kept}.zeroed-old`, 'old\n');
      writeFileSync(join(dir, 'journal'), [`backed ${own}`, `created ${dir}/etc/shadow`, `backed ${dir}/opt/zeroed/../../etc/passwd`, `backed /opt/zeroed/outside-root`, `backed ${kept}`, 'unit ../../evil 1 1', 'nonsense line', ''].join('\n'));
      writeFileSync(join(dir, 'etc/shadow'), 'keep me\n');
      const r = run(dir, `roll_back; cat "${own}"; cat "${dir}/etc/shadow"; cat "${kept}"`);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split('\n')).toEqual(['root', 'keep me', 'old']);
      for (const p of [own, `${dir}/etc/shadow`, `${dir}/opt/zeroed/../../etc/passwd`, '/opt/zeroed/outside-root']) expect(r.stderr).toContain(`Roll-back: skipped ${p} (not a path this installer manages).`);
      expect(r.stderr).toContain('Roll-back: skipped an unknown journal line.');
      expect(r.calls).not.toContain('evil');
      const ok = (p: string) => sh(`MANAGED_ROOT=""; ${fns.slice(fns.indexOf('managed() {'), fns.indexOf('journal() {'))} managed "${p}" && echo y || echo n`).out;
      expect(['/usr/local/sbin/zeroed-update', '/usr/local/lib/zeroed/common.sh', '/usr/local/share/zeroed/eff_large_wordlist.txt', '/usr/local/bin/node', '/etc/systemd/system/zeroed-check.timer', '/etc/zeroed/host.env', '/etc/nftables.conf', '/etc/apt/apt.conf.d/52zeroed-unattended-upgrades', '/etc/ssh/sshd_config.d/10-zeroed.conf', '/var/lib/zeroed-host/release-units', '/opt/zeroed/stub/worker.mjs'].map(ok)).toEqual(Array(11).fill('y'));
      expect(['/etc/passwd', '/usr/local/sbin/sshd', '/usr/local/bin/nodejs', '/etc/systemd/system/ssh.service', '/etc/zeroed/../shadow', '/opt/zeroed/./x', '/root/.ssh/authorized_keys', '/etc/nftables.conf.d/x', '/etc/zeroed/age/host.key', '/etc/zeroed/age', '/etc/zeroed/gnupg/pubring.kbx', '/etc/zeroed/deploy-code', '/etc/zeroed/pair-code', '/etc/zeroed/backup-recipients', '/var/lib/zeroed-host/owner_backup_recipient'].map(ok)).toEqual(Array(15).fill('n'));
      // Every path the installer writes is one it manages.
      const targets = [...read('ops/install.sh').matchAll(/^install_file (\S+) /gm)].map((m) => m[1]!);
      expect(targets.length).toBeGreaterThan(30);
      expect(targets.filter((t) => ok(t) !== 'y')).toEqual([]);
    });

    it('puts a repointed symlink back (the Node link), not the file it points to', () => {
      const dir = fresh('tx2');
      mkdirSync(join(dir, 'node-old'));
      mkdirSync(join(dir, 'node-new'));
      writeFileSync(join(dir, 'node-old/node'), 'old');
      writeFileSync(join(dir, 'node-new/node'), 'new');
      const r = run(dir, `ln -sfn "${dir}/node-old/node" "${dir}/usr/local/bin/node"
        keep_old "${dir}/usr/local/bin/node"; ln -sfn "${dir}/node-new/node" "${dir}/usr/local/bin/node"
        roll_back 2>/dev/null; readlink "${dir}/usr/local/bin/node"; cat "${dir}/node-new/node"`);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split('\n')).toEqual([join(dir, 'node-old/node'), 'new']);
    });

    it("gives a dropped unit back its enabled and running state, and leaves a stopped one stopped", () => {
      const dir = fresh('tx3');
      writeFileSync(join(dir, 'enabled-zeroed-dryrun-tick.timer'), '');
      writeFileSync(join(dir, 'active-zeroed-dryrun-tick.timer'), '');
      const r = run(dir, `keep_unit zeroed-dryrun-tick.timer; keep_unit zeroed-dryrun-reboot.service; cat "$JOURNAL"; : > "${dir}/calls"; roll_back 2>/dev/null`);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split('\n')).toEqual(['unit zeroed-dryrun-tick.timer 1 1', 'unit zeroed-dryrun-reboot.service 0 0']);
      const calls = r.calls.trim().split('\n');
      expect(calls.indexOf('systemctl daemon-reload')).toBeLessThan(calls.indexOf('systemctl enable zeroed-dryrun-tick.timer'));
      expect(calls).toContain('systemctl start zeroed-dryrun-tick.timer');
      expect(calls.filter((c) => c.includes('zeroed-dryrun-reboot'))).toEqual([]);
    });

    it('an update killed half-way is rolled back by the next one before it starts', () => {
      const dir = fresh('tx4');
      const a = join(dir, 'opt/zeroed/a');
      const b = join(dir, 'opt/zeroed/b');
      writeFileSync(a, 'new a\n');
      writeFileSync(`${a}.zeroed-old`, 'old a\n');
      writeFileSync(b, 'half-written\n');
      writeFileSync(join(dir, 'journal'), `backed ${a}\ncreated ${b}\n`);
      const r = run(dir, `${start.replace('trap on_exit EXIT', ': no trap in the test')}
        cat "${a}"; [ -e "${b}" ] && echo b-left || echo b-gone; [ -e "${a}.zeroed-old" ] && echo old-left || echo old-gone; [ -e "$JOURNAL" ] && echo journal-left || echo journal-gone`);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain('A previous update did not finish; putting its host files back first');
      expect(r.stdout).toContain('Previous update: every host file is back as it was (1 restored, 1 removed).');
      expect(r.stdout.trim().split('\n').slice(-4)).toEqual(['old a', 'b-gone', 'old-gone', 'journal-gone']);
    });

    it('never deletes or replaces key material, even when the journal names it', () => {
      const dir = fresh('tx7');
      mkdirSync(join(dir, 'etc/zeroed/age'), { recursive: true });
      mkdirSync(join(dir, 'var/lib/zeroed-host'), { recursive: true });
      const key = join(dir, 'etc/zeroed/age/host.key');
      const code = join(dir, 'etc/zeroed/deploy-code');
      const recipient = join(dir, 'var/lib/zeroed-host/owner_backup_recipient');
      writeFileSync(key, 'AGE-SECRET-KEY-TEST\n');
      writeFileSync(code, 'six test words here please now\n');
      writeFileSync(recipient, 'age1owner\n');
      writeFileSync(`${recipient}.zeroed-old`, 'age1attacker\n');
      writeFileSync(join(dir, 'journal'), [`created ${key}`, `created ${code}`, `backed ${recipient}`, ''].join('\n'));
      const r = run(dir, `roll_back; cat "${key}" "${code}" "${recipient}"`);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split('\n')).toEqual(['AGE-SECRET-KEY-TEST', 'six test words here please now', 'age1owner']);
      for (const p of [key, code, recipient]) expect(r.stderr).toContain(`Roll-back: skipped ${p} (not a path this installer manages).`);
    });

    it('a full install drops a journal left by an interrupted update, so no later update rolls back over it', () => {
      const dir = fresh('tx6');
      const a = join(dir, 'opt/zeroed/a');
      writeFileSync(a, 'freshly installed\n');
      writeFileSync(`${a}.zeroed-old`, 'from before\n');
      writeFileSync(join(dir, 'journal'), `backed ${a}\ncreated ${dir}/opt/zeroed/b\n`);
      const r = run(dir, `UPDATE=0; ${start.replace('trap on_exit EXIT', ': no trap in the test')}
        cat "${a}"; [ -e "${a}.zeroed-old" ] && echo old-left || echo old-gone; [ -e "$JOURNAL" ] && echo journal-left || echo journal-gone`);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.trim().split('\n')).toEqual(['freshly installed', 'old-gone', 'journal-gone']);
      expect(r.calls).not.toContain('nft');
    });
  });

  it('keeps the addresses the host was installed with', () => {
    expect(upd('. /etc/zeroed/host.env')).toBeGreaterThan(0);
    expect(upd('. /etc/zeroed/host.env')).toBeLessThan(upd('REPO="${ZEROED_REPO:-'));
  });

  it("installs RUN-1's units from the release by name, removes dropped ones, and enables only the tick timer", () => {
    expect(main).toContain('RELEASE_UNITS="${ZEROED_RELEASE_DIR:-/opt/zeroed/current}/packages/runner/systemd"');
    expect(main).toContain('[[ "$n" =~ $RELEASE_UNIT_RE ]] || continue');
    expect(main).toContain('if [ -e /etc/systemd/system/zeroed-dryrun-tick.timer ]; then systemctl enable --now zeroed-dryrun-tick.timer >/dev/null; fi');
    expect(main).not.toMatch(/enable[^\n]*zeroed-dryrun@|enable[^\n]*zeroed-dryrun-reboot|enable[^\n]*zeroed-worker-tabletop/);
    expect(main).toContain('zeroed-check.timer');
    const names = ['zeroed-dryrun@.service', 'zeroed-dryrun-tick.service', 'zeroed-dryrun-tick.timer', 'zeroed-dryrun-reboot.service', 'zeroed-worker-tabletop.service', 'zeroed-worker.service', 'zeroed-signer.service', 'other.service', 'zeroed-dryrun@x.service', 'zeroed-worker-tabletop.service.d'];
    const ok = names.filter((n) => sh(`[[ "${n}" =~ $RELEASE_UNIT_RE ]] && echo y || echo n`).out === 'y');
    expect(ok).toEqual(['zeroed-dryrun@.service', 'zeroed-dryrun-tick.service', 'zeroed-dryrun-tick.timer', 'zeroed-dryrun-reboot.service', 'zeroed-worker-tabletop.service']);
  });

  it('a running worker restarts for changed start files only when nothing is in flight', () => {
    expect(main).toMatch(/\/etc\/systemd\/system\/zeroed-worker\.service \| \/usr\/local\/lib\/zeroed\/worker-start \| \/opt\/zeroed\/stub\/worker\.mjs\)\n\s+worker_busy \|\| systemctl restart zeroed-worker\.service/);
    const s = read('ops/host/files/usr/local/sbin/zeroed-update');
    // A failing apply alerts once per episode, not every 5 minutes.
    expect(s).toContain('alert host-apply "ALERT');
    expect(s).toContain('alert_clear host-apply "CLEARED');
  });

  it('zeroed-update applies the new release\'s host files before it switches or restarts anything; a failure keeps the old release', () => {
    const file = read('ops/host/files/usr/local/sbin/zeroed-update');
    // The run's own steps, after the function definitions (rollback, which the probation also uses, moves current too).
    const s = file.slice(file.indexOf('\nprobation_check\n'));
    expect(file.indexOf('\nprobation_check\n')).toBeGreaterThan(file.indexOf('\nrollback() {'));
    const apply = s.indexOf('apply_host "$commit" "$dest" || exit 1');
    expect(apply).toBeGreaterThan(s.indexOf('mv "$dest.new" "$dest"'));
    for (const later of ['ln -sfn "$dest" /opt/zeroed/current.new', 'mv -Tf /opt/zeroed/current.new /opt/zeroed/current', `printf '%s\\n' "$commit" > "$STATE_DIR/deployed"`, '  held_restart\n  worker="restarted and up"', 'zeroed-backup-offsite.timer']) {
      expect(s.indexOf(later), later).toBeGreaterThan(apply);
    }
    // After every gate: a retry next run goes through the same gates (deployed is not moved on failure).
    for (const gate of ['run="$(active_run)"', 'open="$(cat /var/lib/zeroed/open_intents', 'if [ "$verdict" != green ]']) expect(s.indexOf(gate), gate).toBeLessThan(apply);
    expect(file.match(/apply_host "\$commit"/g)).toHaveLength(1);
    // OPS-CLEAN M1: the one start before it is the held first start of the release already deployed (switch_unheld),
    // checked again on the way out of every run that ends well (m3).
    const early = s.slice(0, apply);
    expect(early).not.toContain('held_restart');
    expect(early).toMatch(/^\nprobation_check\nunheld_start\ntrap at_exit EXIT\n/);
    const unheld = file.slice(file.indexOf('unheld_start() {'), file.indexOf('\n}\n', file.indexOf('unheld_start() {')));
    expect(unheld.match(/held_restart/g)).toHaveLength(1);
    expect(unheld).toContain('if [ "$commit" != "$deployed" ]; then');
    expect(file).toContain('if ZEROED_RELEASE_DIR="$2" bash "$installer" --update > "$STATE_DIR/host_update.log" 2>&1; then');
    expect(file).toContain(`grep -q -- '--update) UPDATE=1' "$installer"`);
    // The new release's RUN-1 units, not the running one's.
    expect(main).toContain('RELEASE_UNITS="${ZEROED_RELEASE_DIR:-/opt/zeroed/current}/packages/runner/systemd"');
  });
});

describe('deploy gate (OPS-GATE): named runs from GitHub Actions, shared by the server and tag.sh', () => {
  type Run = { name: string; status?: string; conclusion?: string | null; app?: string; completed_at?: string };
  const reply = (runs: Run[], total = runs.length) =>
    JSON.stringify({ total_count: total, check_runs: runs.map((r) => ({ status: 'completed', conclusion: 'success', completed_at: '2026-10-04T00:00:00Z', ...r, app: { slug: r.app ?? 'github-actions' } })) });
  const verdict = (runs: Run[], name = 'check', total?: number) => sh(`commit_verdict ${name}`, reply(runs, total)).out;

  it('is green only with a successful named run from GitHub Actions and nothing failed or running', () => {
    expect(verdict([{ name: 'check' }, { name: 'historical-data' }])).toBe('green');
    expect(verdict([{ name: 'check' }, { name: 'zeroed-deploy', status: 'in_progress', conclusion: null }])).toBe('green');
  });
  it.each([
    ['a lone unrelated success', [{ name: 'historical-data' }], /^none: no check run from GitHub Actions$/],
    ['an all-skipped set', [{ name: 'check', conclusion: 'skipped' }, { name: 'e2e', conclusion: 'skipped' }], /^red: check was skipped, not success$/],
    ['check from another app', [{ name: 'check', app: 'some-bot' }], /^none: no check run/],
    ['no runs at all', [], /^none: no check run/],
    ['another GitHub Actions run failed', [{ name: 'check' }, { name: 'historical-data', conclusion: 'failure' }], /^red: historical-data failed$/],
    ['a run still going', [{ name: 'check' }, { name: 'e2e', status: 'in_progress', conclusion: null }], /^pending: e2e still running$/],
    ['a cancelled check', [{ name: 'check', conclusion: 'cancelled' }], /^red: check failed$/],
  ])('refuses %s', (_, runs, why) => {
    expect(verdict(runs as Run[])).toMatch(why);
  });
  it('ignores the scheduled advisory report (zeroed-advisories) whatever its state, and only that name (Z01 ruling 3.4)', () => {
    for (const state of [{ conclusion: 'failure' }, { conclusion: 'cancelled' }, { conclusion: 'timed_out' }, { status: 'in_progress', conclusion: null },
      { status: 'queued', conclusion: null }]) {
      expect(verdict([{ name: 'check' }, { name: 'zeroed-advisories', ...state }]), JSON.stringify(state)).toBe('green');
    }
    expect(verdict([{ name: 'zeroed-advisories' }]), 'it never stands in for check').toMatch(/^none: no check run/);
    expect(verdict([{ name: 'check' }, { name: 'advisories', conclusion: 'failure' }])).toBe('red: advisories failed');
    expect(verdict([{ name: 'check' }, { name: 'zeroed-advisories-x', status: 'in_progress', conclusion: null }])).toBe('pending: zeroed-advisories-x still running');
    expect(sh('echo "$DEPLOY_AUDIT_JOB"').out).toBe('zeroed-advisories');
    const wf = read('.github/workflows/audit-schedule.yml');
    expect(wf).toMatch(/^jobs:\n {2}zeroed-advisories:\n/m);
  });
  it('refuses a listing GitHub cut short, and reads the latest run of a re-run name', () => {
    expect(verdict([{ name: 'check' }], 'check', 101)).toMatch(/^none: more check runs/);
    expect(verdict([{ name: 'e2e', conclusion: 'success', completed_at: '2026-10-04T01:00:00Z' }, { name: 'e2e', conclusion: 'neutral', completed_at: '2026-10-04T00:00:00Z' }], 'e2e')).toBe('green');
  });

  it('finds the newest first-parent commit that touched the ops end-to-end paths', () => {
    const repo = join(tmp, 'gate-repo');
    const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
    const git = (cmd: string) => spawnSync('bash', ['-c', cmd], { cwd: repo, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', HOME: tmp, ...env } }).stdout.trim();
    mkdirSync(repo, { recursive: true });
    git('git init -q -b int . && mkdir -p ops packages/ops/src && echo a > f && git add f && git commit -q -m root');
    const root0 = git('git rev-parse HEAD');
    git('echo 1 > ops/x && git add ops && git commit -q -m ops');
    const opsCommit = git('git rev-parse HEAD');
    git('echo 2 >> f && git commit -qam app');
    const app = git('git rev-parse HEAD');
    const e2e = (ref: string) => sh(`e2e_commit "${repo}" ${ref}`).out;
    expect(e2e(app)).toBe(opsCommit);
    expect(e2e(opsCommit)).toBe(opsCommit);
    expect(e2e(root0)).toBe('');
    git('echo 3 > packages/ops/src/y && git add packages && git commit -q -m pkg');
    expect(e2e('HEAD')).toBe(git('git rev-parse HEAD'));
  });

  it('uses the same paths the ops end-to-end workflow runs on, and both callers use the shared gate', () => {
    const wf = read('.github/workflows/ops-e2e.yml');
    const paths = [...wf.matchAll(/paths: \[([^\]]*)\]/g)].map((m) => m[1]!.split(',').map((p) => p.trim().replace(/^'|'$/g, '').replace(/\/\*\*$/, '')));
    expect(paths.length).toBe(2);
    for (const p of paths) expect([...p].sort()).toEqual(sh('printf "%s\\n" "${E2E_PATHS[@]}"').out.split('\n').sort());
    const update = read('ops/host/files/usr/local/sbin/zeroed-update');
    const tag = read('ops/deploy/tag.sh');
    for (const s of [update, tag]) {
      expect(s).toContain('commit_verdict check');
      expect(s).toContain('commit_verdict e2e');
      expect(s).toMatch(/e2e_commit /);
      expect(s).not.toMatch(/conclusion == "skipped"/);
    }
    expect(tag).toContain('. "$here/../host/files/usr/local/lib/zeroed/logic.sh"');
  });
});

describe('HOST-CAPS on the host', () => {
  const rel = join(tmp, 'caps-releases');
  // Release folders are 40-hex commit names. The tests label them r1..r9 and map them here.
  const H = (l: string) => (/^r\d$/.test(l) ? l.slice(1).padStart(40, '0') : l);
  const label = (n: string) => (/^0{39}\d$/.test(n) ? `r${n.slice(-1)}` : n);
  // names are oldest first, each one second newer than the one before, in 2023 (no age rule: all are old).
  const make = (names: string[], base = 1_700_000_000) => {
    rmSync(rel, { recursive: true, force: true });
    mkdirSync(rel, { recursive: true });
    names.forEach((n, i) => {
      mkdirSync(join(rel, H(n)));
      spawnSync('touch', ['-d', `@${base + i}`, join(rel, H(n))]);
    });
  };
  const gone = (cur: string, prev: string, tag: string) =>
    sh(`prunable_releases "${rel}" "${cur ? join(rel, H(cur)) : ''}" "${prev ? join(rel, H(prev)) : ''}" "${H(tag)}"`)
      .out.split('\n').filter(Boolean).map((p) => label(p.slice(rel.length + 1))).sort();

  it('prunable_releases keeps current, previous, the deploy tag and the 3 newest others, whatever their age', () => {
    make(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9']);
    expect(gone('r9', 'r8', 'r9')).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(9 - gone('r9', 'r8', 'r9').length).toBe(5);
    expect(gone('r1', 'r2', 'r1')).toEqual(['r3', 'r4', 'r5', 'r6']);
    expect(gone('r9', 'r8', 'r1')).toEqual(['r2', 'r3', 'r4']);
  });

  it('prunes folders of any age, including ones made just now (no age rule)', () => {
    make(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9'], Math.floor(Date.now() / 1000) - 60);
    expect(gone('r9', 'r8', 'r9')).toEqual(['r1', 'r2', 'r3', 'r4']);
  });

  it('prunable_releases lists only 40-hex release folders: half-written, odd names, spaces and a * are never listed', () => {
    make(['r1', 'r2', `${'f'.repeat(40)}.new`, 'r3', 'r4', 'r5', 'r6', 'r7']);
    for (const odd of ['*', 'a b', '-rf', 'ABCDEF'.repeat(7).slice(0, 40), 'a'.repeat(39), 'a'.repeat(41)]) mkdirSync(join(rel, odd));
    expect(gone('r7', 'r6', 'r7')).toEqual(['r1', 'r2']);
    // The same folders as the only ones beyond the keep set still list nothing odd.
    make(['r5', 'r6', 'r7']);
    for (const odd of ['*', 'a b']) mkdirSync(join(rel, odd));
    expect(gone('r7', 'r6', 'r7')).toEqual([]);
  });

  it('prunable_releases prunes nothing when current cannot be read', () => {
    make(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
    expect(gone('', 'r6', 'r7')).toEqual([]);
    expect(gone('missing', 'r6', 'r7')).toEqual([]);
    expect(sh(`prunable_releases "${rel}" /etc "${join(rel, H('r6'))}" ${H('r7')}`).out).toBe('');
    rmSync(rel, { recursive: true, force: true });
    mkdirSync(rel);
    expect(gone('a', 'b', 'c')).toEqual([]);
  });

  it("zeroed-update's prune loop never word-splits or globs the names, and runs only in a real run with * and space folders", () => {
    const update = read('ops/host/files/usr/local/sbin/zeroed-update');
    expect(update).not.toMatch(/for old in \$\(/);
    expect(update).toContain('while IFS= read -r old; do');
    // Run the loop itself against a releases root that holds a '*' and an 'a b' folder: only the old 40-hex folders go.
    make(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7']);
    for (const odd of ['*', 'a b']) mkdirSync(join(rel, odd));
    const start = update.indexOf('while IFS= read -r old; do');
    const loop = update.slice(start, update.indexOf('\n', update.indexOf('done < <(prunable_releases', start)));
    const cur = join(rel, H('r7'));
    const r = sh(`log() { :; }; prev="${join(rel, H('r6'))}"; commit="${H('r7')}"; ${loop.replace('/opt/zeroed/releases', rel).replace('"$(readlink -f /opt/zeroed/current 2>/dev/null || true)"', `"${cur}"`)}; ls -1 "${rel}"`);
    expect(r.out.split('\n').filter(Boolean).sort()).toEqual(['*', 'a b', ...['r3', 'r4', 'r5', 'r6', 'r7'].map(H)].sort());
  });

  it('zeroed-update prunes only after a deploy that stayed up, and the system journal has a size cap the installer applies', () => {
    const update = read('ops/host/files/usr/local/sbin/zeroed-update');
    const prune = update.indexOf('prunable_releases /opt/zeroed/releases');
    expect(prune).toBeGreaterThan(update.indexOf('if ! why="$(holds)"; then rollback "$why"; fi'));
    expect(prune).toBeLessThan(update.indexOf('log "Deployed ${commit:0:12}. Worker: $worker."'));
    expect(update).toContain('"$(readlink -f /opt/zeroed/current 2>/dev/null || true)" "$prev" "$commit")');
    const conf = read('ops/host/files/etc/systemd/journald.conf.d/zeroed-journal.conf');
    expect(conf.split('\n').filter((l) => l && !l.startsWith('#'))).toEqual(['[Journal]', 'SystemMaxUse=500M', 'SystemKeepFree=2G']);
    const main = read('ops/host/install-main.sh');
    expect(main).toContain('/etc/systemd/journald.conf.d/zeroed-*) return 0 ;;');
    expect(main).toContain('[[ " ${CHANGED[*]} " != *" /etc/systemd/journald.conf.d/zeroed-journal.conf "* ]] || systemctl restart systemd-journald');
    expect(read('ops/install.sh')).toContain('install_file /etc/systemd/journald.conf.d/zeroed-journal.conf');
  });
});

describe('recording upload alerts (RECORD-UPLOAD)', () => {
  const now = 1_800_000_000;
  const alerts = (status: unknown) => sh(`record_alerts ${now}`, JSON.stringify(status)).out.split('\n').map((l) => l.split('|').slice(0, 2).join(' '));
  const ok = { at: now * 1000, failed_runs: 0, running: false, kept: [], backlog_age_s: 0 };
  const on = (keys: string[]) => ['failed', 'backlog', 'kept', 'stale'].map((k) => `${keys.includes(k) ? 'on' : 'off'} record-upload-${k}`);

  it('raises one alert per problem: 3 failed runs, a backlog over a day, kept files, no report for 3 hours', () => {
    expect(alerts(ok)).toEqual(on([]));
    expect(alerts({ ...ok, failed_runs: 2 })).toEqual(on([]));
    expect(alerts({ ...ok, failed_runs: 3 })).toEqual(on(['failed']));
    // The run in progress counted itself already.
    expect(alerts({ ...ok, failed_runs: 3, running: true })).toEqual(on([]));
    expect(alerts({ ...ok, backlog_age_s: 86_401 })).toEqual(on(['backlog']));
    expect(alerts({ ...ok, kept: [{ key: 'b/days/d/frames-000.jsonl.zst', why: 'holds a stored credential' }] })).toEqual(on(['kept']));
    expect(alerts({ ...ok, at: (now - 10_801) * 1000 })).toEqual(on(['stale']));
  });

  it('with the switch on, a missing status raises the no-report alert and clears nothing (RC-M5); the switch off clears all; every line stays one line', () => {
    expect(alerts({})).toEqual(['on record-upload-stale']);
    expect(alerts({ failed_runs: 9, at: null })).toEqual(['on record-upload-stale']);
    expect(alerts({ enabled: false, failed_runs: 9, at: 0 })).toEqual(on([]));
    expect(alerts({ enabled: false })).toEqual(on([]));
    expect(sh(`record_alerts ${now}`, 'not json').out).toBe('');
    const r = sh(`record_alerts ${now}`, JSON.stringify({ ...ok, failed_runs: 4, last_error: 'a|b\nc' })).out.split('\n');
    expect(r).toHaveLength(4);
    expect(r[0]).toBe('on|record-upload-failed|ALERT Zeroed host: the recording upload failed 4 runs in a row (last: a b c). Recordings stay on the server until it works again.');
  });

  it('zeroed-check raises and clears them from the uploader\'s status file, and the switch decides', () => {
    const check = read('ops/host/files/usr/local/sbin/zeroed-check');
    expect(check).toContain(`if [ "$(jq -r '.record_upload == true' /opt/zeroed/current/ops/host-config.json 2>/dev/null || echo false)" = true ]; then\n  rec="$(cat /var/lib/zeroed-record-upload/status.json 2>/dev/null || echo '{}')"`);
    expect(check).toContain(`if [ "$what" = on ]; then alert "$key" "$text"; else alert_clear "$key" "$text"; fi`);
    expect(check).toContain('seen="$(recorder_first_seen "$now" /var/lib/zeroed/recorder "$STATE_DIR/recorder_first_seen")"');
    expect(check).toContain('done < <(printf \'%s\' "$rec" | record_alerts "$now" /var/lib/zeroed/recorder "$seen")');
    // Before the key check's early exits, so it runs on a server whatever its pairing state.
    expect(check.indexOf('record_alerts')).toBeLessThan(check.indexOf('keys_stored || exit 0'));
  });

  // REC-UPLOAD-QUIET: the upload unit is skipped while its ConditionPathExists folder is missing, so it never writes a
  // status; the alerts follow the same condition instead of raising "never reported" on a host with no recorder.
  const recAlerts = (status: unknown, recorder: string) =>
    sh(`record_alerts ${now} "${recorder}"`, JSON.stringify(status)).out.split('\n').map((l) => l.split('|').slice(0, 2).join(' '));
  const recorder = join(tmp, 'rec-quiet', 'recorder');
  const missing = join(tmp, 'rec-quiet', 'never-made');

  it('(a) no recorder folder and no status: no alert is raised, and any open one is cleared', () => {
    expect(recAlerts({}, missing)).toEqual(on([]));
    expect(recAlerts({ ...ok, at: (now - 10_801) * 1000, failed_runs: 5, backlog_age_s: 90_000, kept: [{ key: 'k', why: 'w' }] }, missing)).toEqual(on([]));
    expect(sh(`record_alerts ${now} "${missing}"`, '').out.split('\n').every((l) => l.startsWith('off|'))).toBe(true);
  });

  it('(b) recorder folder and no status: the "never reported" alert, as before', () => {
    mkdirSync(recorder, { recursive: true });
    expect(recAlerts({}, recorder)).toEqual(['on record-upload-stale']);
    expect(sh(`record_alerts ${now} "${recorder}"`, '{}').out).toContain('has never reported (no status written)');
  });

  it('"never reported" waits 70 minutes from when the recorder folder was first seen; the others are not held', () => {
    const hold = (seen: number) => sh(`record_alerts ${now} "${recorder}" ${seen}`, '{}').out;
    mkdirSync(recorder, { recursive: true });
    expect(hold(now - 600)).toBe('');
    expect(sh(`record_alerts ${now} "${recorder}" ${now - 600}`, JSON.stringify({ ...ok, failed_runs: 3 })).out.split('\n').map((l) => l.split('|').slice(0, 2).join(' '))).toEqual(on(['failed']));
    expect(hold(now - 71 * 60).split('|').slice(0, 2).join(' ')).toBe('on record-upload-stale');
    // A first-seen time in the future, or none at all, counts as old.
    expect(hold(now + 600).split('|').slice(0, 2).join(' ')).toBe('on record-upload-stale');
    expect(sh(`record_alerts ${now} "${recorder}"`, '{}').out.split('|')[0]).toBe('on');
  });

  it('the first-seen stamp is written once, never follows the folder\'s mtime, and goes when the folder goes', () => {
    const dir = join(tmp, 'rec-stamp', 'recorder');
    const stamp = join(tmp, 'rec-stamp', 'first_seen');
    const seen = (t: number) => sh(`recorder_first_seen ${t} "${dir}" "${stamp}"`);
    mkdirSync(join(tmp, 'rec-stamp'), { recursive: true });
    expect(seen(now - 71 * 60).out).toBe('');
    mkdirSync(dir);
    expect(seen(now - 71 * 60).out).toBe(String(now - 71 * 60));
    // Later activity in the folder (touched, a new boot folder) changes nothing.
    expect(sh(`touch "${dir}"`).status).toBe(0);
    mkdirSync(join(dir, 'boot-2'));
    const t = seen(now).out;
    expect(t).toBe(String(now - 71 * 60));
    expect(sh(`record_alerts ${now} "${dir}" ${t}`, '{}').out.split('|').slice(0, 2).join(' ')).toBe('on record-upload-stale');
    // A stamp that is not a time is written again.
    writeFileSync(stamp, 'junk');
    expect(seen(now).out).toBe(String(now));
    // Ruling 13: a stamp that cannot be written prints nothing, which counts as old, so the alert is raised.
    const noDir = join(tmp, 'rec-stamp', 'missing-dir', 'first_seen');
    const unwritable = sh(`recorder_first_seen ${now} "${dir}" "${noDir}"`);
    expect(unwritable.status).toBe(0);
    expect(unwritable.out).toBe('');
    expect(sh(`record_alerts ${now} "${dir}" "${unwritable.out}"`, '{}').out.split('|').slice(0, 2).join(' ')).toBe('on record-upload-stale');
    // The folder gone: the stamp goes too, so a folder that comes back starts a new hold.
    rmSync(dir, { recursive: true });
    expect(seen(now).out).toBe('');
    expect(sh(`test -e "${stamp}"`).status).not.toBe(0);
  });

  it('(c) recorder folder and a status older than 3 hours: the 3-hour alert, as before', () => {
    mkdirSync(recorder, { recursive: true });
    expect(recAlerts({ ...ok, at: (now - 10_801) * 1000 }, recorder)).toEqual(on(['stale']));
    expect(recAlerts(ok, recorder)).toEqual(on([]));
  });

  it('zeroed-check passes the upload unit\'s ConditionPathExists folder, and install.sh carries the same', () => {
    const unit = read('ops/host/files/etc/systemd/system/zeroed-record-upload@.service');
    const cond = /^ConditionPathExists=(.+)$/m.exec(unit)?.[1];
    expect(cond).toBe('/var/lib/zeroed/recorder');
    const call = `done < <(printf '%s' "$rec" | record_alerts "$now" ${cond} "$seen")`;
    expect(read('ops/host/files/usr/local/sbin/zeroed-check')).toContain(call);
    const install = read('ops/install.sh');
    expect(install).toContain(call);
    expect(install).toContain('if [ -n "${2:-}" ] && [ ! -e "$2" ]; then status=\'{"enabled":false}\'; fi');
  });
});

describe('pull mount alert (PATHS-FIX ruling 23)', () => {
  const units = 'zeroed-receipts-fs.service srv-zeroed_pull-md.mount srv-zeroed_pull-md-receipts.mount';
  const run = (states: string) => sh('pull_mount_alerts "${PULL_MOUNT_UNITS[@]}"', states).out;

  it('watches the receipts filesystem and both chroot binds', () => {
    expect(sh('echo "${PULL_MOUNT_UNITS[*]}"').out).toBe(units);
  });

  it('all active: no alert, and an open one is cleared', () => {
    expect(run('active\nactive\nactive\n')).toBe('off|pull-mounts|CLEARED Zeroed host: the market-data pull folders are mounted again.');
  });

  it('any inactive, failed or unreported unit raises one alert naming each', () => {
    expect(run('active\ninactive\nactive\n')).toBe('on|pull-mounts|ALERT Zeroed host: the market-data pull folders are not all mounted (srv-zeroed_pull-md.mount inactive). Pulls and receipts stop until they are.');
    expect(run('failed\nactive\nactive\n').startsWith('on|pull-mounts|') && run('failed\nactive\nactive\n').includes('zeroed-receipts-fs.service failed')).toBe(true);
    // systemctl printed nothing (not installed, bus down): every unit counts as not active.
    expect(run('')).toContain('zeroed-receipts-fs.service unknown, srv-zeroed_pull-md.mount unknown, srv-zeroed_pull-md-receipts.mount unknown');
  });

  it('zeroed-check runs it every minute, before the key check can exit', () => {
    const check = read('ops/host/files/usr/local/sbin/zeroed-check');
    expect(check).toContain('done < <(systemctl is-active "${PULL_MOUNT_UNITS[@]}" 2>/dev/null | pull_mount_alerts "${PULL_MOUNT_UNITS[@]}")');
    expect(check.indexOf('pull_mount_alerts')).toBeLessThan(check.indexOf('keys_stored || exit 0'));
  });
});

describe('D07 host preflight (Z00)', () => {
  // The block runs from the built ops/install.sh, the file the README line downloads. Its reads stay real; the
  // test only shadows df and awk's /proc/meminfo with bash functions, which no host or environment can do.
  const script = read('ops/install.sh');
  const block = script.slice(script.indexOf('D07_MEM_MIN_KB='), script.indexOf('\n# An update is all or nothing.'));
  const die = script.slice(script.indexOf('die() {'), script.indexOf('\n', script.indexOf('die() {')));
  const GIB = 1048576;
  const run = (update: 0 | 1, memKb: string, diskKb: string) => {
    const dir = mkdtempSync(join(tmp, 'd07-'));
    writeFileSync(join(dir, 'meminfo'), `MemTotal:       ${memKb} kB\nMemFree:          100000 kB\n`);
    const r = spawnSync('bash', ['-c', `set -euo pipefail; UPDATE=${update}; ${die}
      df() { [ "$*" = "-P -k /var/lib" ] && [ -n "${diskKb}" ] || return 1; printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n/dev/vda2 %s 9 9 1%% /\\n' "${diskKb}"; }
      awk() { if [ "\${@: -1}" = /proc/meminfo ]; then command awk "\${@:1:$#-1}" "${dir}/meminfo"; else command awk "$@"; fi; }
      ${block}
      echo went-on`], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
    return { status: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
  };
  const twoGb = '2014180'; // a typical 2 GB VM's MemTotal (1.92 GiB)
  const disk55 = '52700000'; // a 55 GB disk's filesystem, in kB (53.96 GB)

  it('passes the 2 GB, 55 GB host and the boundaries: 1.5 GiB and 40 GB exactly', () => {
    expect(run(0, twoGb, disk55)).toEqual({ status: 0, out: 'went-on', err: '' });
    // The low estimate of the 55 GB disk's filesystem (about 50.6 GB, not measured; review F1) passes with a margin.
    expect(run(0, twoGb, '49414063')).toEqual({ status: 0, out: 'went-on', err: '' });
    expect(run(0, String(1.5 * GIB), '39062500')).toEqual({ status: 0, out: 'went-on', err: '' });
  });

  it('a full install refuses below either minimum, says why, and stops before any change', () => {
    const oneGb = run(0, '1004316', disk55); // the 1 GB server zeroed
    expect(oneGb.status).toBe(1);
    expect(oneGb.out).toBe('');
    expect(oneGb.err).toBe("Install stopped: this server is below the bot's host minimum (docs/blueprint/ARCH.md D07): it has 0.96 GiB of RAM; the bot needs a 2 GB server (at least 1.5 GiB reported). Use the 2 GB Vultr server (vc2-1c-2gb, 55 GB SSD).");
    expect(run(0, String(1.5 * GIB - 1), disk55).status).toBe(1);
    const smallDisk = run(0, twoGb, '24413000'); // 25 GB
    expect(smallDisk.status).toBe(1);
    expect(smallDisk.err).toContain('the disk that holds /var/lib is 25.0 GB; the bot needs at least 40 GB.');
    expect(run(0, twoGb, '22460938').status).toBe(1); // the 25 GB server's filesystem, about 23 GB
    expect(run(0, twoGb, '39062499').status).toBe(1);
    const both = run(0, '1004316', '24413000');
    expect(both.err).toContain('it has 0.96 GiB of RAM; the bot needs a 2 GB server (at least 1.5 GiB reported); the disk that holds /var/lib is 25.0 GB');
    // Unreadable or odd values refuse too.
    for (const [m, d] of [['', disk55], ['abc', disk55], [twoGb, ''], [twoGb, '-5'], ['1e9', disk55]] as const) {
      const r = run(0, m, d);
      expect(r.status, `${m}/${d}`).toBe(1);
      expect(r.err, `${m}/${d}`).toMatch(/could not be read/);
    }
  });

  it('an update only warns, so a running server keeps updating', () => {
    const r = run(1, '1004316', '24413000');
    expect(r.status).toBe(0);
    expect(r.out).toBe('went-on');
    expect(r.err.split('\n')).toEqual([
      "Warning: this server is below the bot's host minimum (D07): it has 0.96 GiB of RAM; the bot needs a 2 GB server (at least 1.5 GiB reported).",
      "Warning: this server is below the bot's host minimum (D07): the disk that holds /var/lib is 25.0 GB; the bot needs at least 40 GB.",
    ]);
    expect(run(1, twoGb, disk55)).toEqual({ status: 0, out: 'went-on', err: '' });
  });

  it('reads only the host, before anything changes, with no way to skip it', () => {
    expect(block).toContain(`awk '$1 == "MemTotal:" { print $2; exit }' /proc/meminfo`);
    expect(block).toContain("df -P -k /var/lib 2>/dev/null | awk 'NR == 2 { print $2 }'");
    expect(block).not.toMatch(/ZEROED_|E2E|\$\{[A-Z_]+:-/);
    expect(block).toMatch(/^D07_MEM_MIN_KB=1572864 /m);
    expect(block).toMatch(/^D07_DISK_MIN_KB=39062500 /m);
    // After the root, OS and option checks; before the journal, apt, files or users.
    const at = script.indexOf('D07_MEM_MIN_KB=');
    expect(script.indexOf('die "needs an x86_64 server"')).toBeLessThan(at);
    expect(script.indexOf('--ssh-key must be one public key line')).toBeLessThan(at);
    for (const later of ['JOURNAL=/var/lib/zeroed-host/update-journal', 'say "Packages"', 'say "Users"', 'say "Files"', 'install_file /']) {
      expect(script.indexOf(later), later).toBeGreaterThan(at);
    }
  });
});
