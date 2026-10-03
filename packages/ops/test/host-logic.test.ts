// OPS-1e: the host's decision helpers (ops/host/files/usr/local/lib/zeroed/logic.sh) run in bash here, and
// the scripts that use them are checked for the wiring the e2e (ops/test/e2e.sh) then drives on a real host.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(w).toContain('export ZEROED_MODE=paper ZEROED_RECORDER=on ZEROED_SIMULATE=on ZEROED_DRILLS=on ZEROED_HEALTH_ADDR="$WORKER_API_ADDR"');
    expect(w).toContain('entry=/opt/zeroed/current/packages/worker/src/main.ts');
    expect(w).toContain('exec /usr/local/bin/node /opt/zeroed/stub/worker.mjs "$@"');
    expect(w).not.toMatch(/ZEROED_MODE=(?!paper )/);
  });

  it('the worker API is loopback 127.0.0.1:8788 for the wrapper, the runner unit and tailscale serve alike', () => {
    expect(sh('echo "$WORKER_API_ADDR"').out).toBe('127.0.0.1:8788');
    expect(read('packages/runner/systemd/zeroed-dryrun@.service')).toContain('--health-addr 127.0.0.1:8788');
    expect(read('ops/host/files/usr/local/sbin/zeroed-tailscale')).toContain('tailscale serve --bg --https=443 "http://$WORKER_API_ADDR"');
  });

  it('the stand-in serves /health on loopback only', () => {
    const r = spawnSync('node', [join(root, 'ops/host/files/opt/zeroed/stub/worker.mjs')], {
      env: { PATH: process.env['PATH'] ?? '', STATE_DIRECTORY: tmp, ZEROED_HEALTH_ADDR: '0.0.0.0:18788' },
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

  it('is opt-in: the installer never installs or starts Tailscale, and the repository key is pinned', () => {
    const main = read('ops/host/install-main.sh');
    expect(main).not.toMatch(/apt-get[^\n]*tailscale|zeroed-tailscale|tailscale up/);
    const ts = read('ops/host/files/usr/local/sbin/zeroed-tailscale');
    const fpr = '2596A99EAAB33821893C0A79458CA832957F5868';
    expect(ts).toContain(`TS_FPR=${fpr}`);
    expect(ts.indexOf('[ "$got" = "$TS_FPR" ]')).toBeLessThan(ts.indexOf('apt-get'));
    expect(ts).toContain('tailscale funnel --https=443 off');
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

  it('keeps the addresses the host was installed with', () => {
    expect(upd('. /etc/zeroed/host.env')).toBeGreaterThan(0);
    expect(upd('. /etc/zeroed/host.env')).toBeLessThan(upd('REPO="${ZEROED_REPO:-'));
  });

  it("installs RUN-1's units from the release by name, removes dropped ones, and enables only the tick timer", () => {
    expect(main).toContain('RELEASE_UNITS=/opt/zeroed/current/packages/runner/systemd');
    expect(main).toContain('[[ "$n" =~ ^zeroed-dryrun[a-z0-9-]*@?\\.(service|timer)$ ]] || continue');
    expect(main).toContain('if [ -e /etc/systemd/system/zeroed-dryrun-tick.timer ]; then systemctl enable --now zeroed-dryrun-tick.timer >/dev/null; fi');
    expect(main).not.toMatch(/enable[^\n]*zeroed-dryrun@|enable[^\n]*zeroed-dryrun-reboot/);
    expect(main).toContain('zeroed-check.timer');
    const names = ['zeroed-dryrun@.service', 'zeroed-dryrun-tick.service', 'zeroed-dryrun-tick.timer', 'zeroed-dryrun-reboot.service', 'other.service', 'zeroed-dryrun@x.service'];
    const ok = names.filter((n) => sh(`[[ "${n}" =~ ^zeroed-dryrun[a-z0-9-]*@?\\.(service|timer)$ ]] && echo y || echo n`).out === 'y');
    expect(ok).toEqual(['zeroed-dryrun@.service', 'zeroed-dryrun-tick.service', 'zeroed-dryrun-tick.timer', 'zeroed-dryrun-reboot.service']);
  });

  it('zeroed-update applies it after the switch and before the worker restart, and tries again after a failure', () => {
    const s = read('ops/host/files/usr/local/sbin/zeroed-update');
    expect(s.indexOf('apply_host "$commit" || true')).toBeGreaterThan(s.indexOf('mv -Tf /opt/zeroed/current.new /opt/zeroed/current'));
    expect(s.indexOf('apply_host "$commit" || true')).toBeLessThan(s.indexOf('systemctl restart zeroed-worker.service'));
    expect(s).toContain(`if bash "$installer" --update > "$STATE_DIR/host_update.log" 2>&1; then`);
    expect(s).toContain(`grep -q -- '--update) UPDATE=1' "$installer"`);
    expect(s).toMatch(/if \[ "\$commit" = "\$current" \]; then\n[^\n]*\n[^\n]*host_applied[^\n]*\n\s+\[ -z "\$\(active_run\)" \] \|\| exit 0/);
  });
});
