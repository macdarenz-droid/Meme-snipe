// Card SWITCH-FIX (the three red teams on bac1f88a): the host-side fixes. The decision helpers run in bash (logic.sh,
// as host-logic.test.ts does); the scripts and unit files are checked for the wiring the ops e2e drives on a real host.
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const LOGIC = join(root, 'ops/host/files/usr/local/lib/zeroed/logic.sh');
const sh = (script: string, input = '') => {
  const r = spawnSync('bash', ['-c', `set -euo pipefail; . "${LOGIC}"; ${script}`], { input, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
  return { status: r.status, out: r.stdout.trim(), err: r.stderr };
};
const tmp = mkdtempSync(join(tmpdir(), 'zeroed-sw-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HOUR = 3_600_000;
const nameAt = (ms: number, zst = true): string => `zeroed-${new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15)}Z.tar${zst ? '.zst' : ''}.age`;

describe('SW-1(a): the backups keep a floor that the byte budget never cuts', () => {
  const keep = (copies: Array<[string, number]>, max: number, count = 72) => {
    const r = sh(`backup_keep 24 7 ${max} ${count}`, copies.map(([n, b]) => `${n} ${b}\n`).join(''));
    expect(r.status, r.err).toBe(0);
    const lines = r.out.split('\n');
    const status = (lines.at(-1) as string).split(' ');
    return { deleted: lines.filter((l) => l.startsWith('delete ')).map((l) => l.slice(7)), floor: Number(status[1]), kept: Number(status[3]), count: Number(status[5]), over: status[7] };
  };

  it('24 hourly and 7 daily copies stay even when the budget would cut them; the floor over the budget is flagged', () => {
    const t0 = Date.UTC(2026, 9, 1);
    const copies: Array<[string, number]> = Array.from({ length: 10 * 24 }, (_, h) => [nameAt(t0 + h * HOUR), 1_000]);
    const r = keep(copies, 5_000);                                      // far under the floor's 31 copies
    expect(r.count).toBe(24 + 6);                                         // the newest day is already in the 24 hours
    expect(r.over).toBe('1');
    const kept = copies.map(([n]) => n).filter((n) => !r.deleted.includes(n));
    expect(kept.slice(-24)).toEqual(copies.slice(-24).map(([n]) => n));
    expect(new Set(kept.map((n) => n.slice(7, 15))).size).toBe(7);
  });

  it('above the floor, newer copies stay while all fit the budget and at most 72 are kept; other names are never touched', () => {
    const t0 = Date.UTC(2026, 9, 1);
    const copies: Array<[string, number]> = Array.from({ length: 5 * 24 }, (_, h) => [nameAt(t0 + h * HOUR, h % 2 === 0), 100]);
    copies.push(['budget.status', 10], ['zeroed-x.tar.age', 10], ['notes.txt', 10]);
    const r = keep(copies, 4_000);
    expect(r.kept).toBe(4_000);
    expect(r.count).toBe(40);
    expect(r.over).toBe('0');
    expect(r.deleted).not.toContain('budget.status');
    expect(r.deleted).not.toContain('zeroed-x.tar.age');
    expect(keep(copies, 1e12).count).toBe(72);                            // the count cap still holds
    // Old (.tar.age) and new (.tar.zst.age) copies sort by time together: the floor (the newest 24 and the newest of
    // each of the other 4 days) plus the newest 12 others, contiguous.
    const timed = copies.slice(0, -3).map(([n]) => n);
    const kept = timed.filter((n) => !r.deleted.includes(n));
    const daily = [0, 1, 2, 3].map((d) => timed[d * 24 + 23] as string);
    expect(kept).toEqual(expect.arrayContaining([...timed.slice(-24), ...daily]));
    const others = kept.filter((n) => !timed.slice(-24).includes(n) && !daily.includes(n));
    expect(others).toEqual(timed.slice(-24 - 12 - 1, -24).filter((n) => !daily.includes(n)));
  });

  it('90 simulated days of hourly copies: what is kept stays bounded by max(budget, floor) and never below the floor', () => {
    const t0 = Date.UTC(2026, 9, 1);
    // The compressed copy grows with the database and then levels off at its retention bound (engine test
    // switch-fix-retention: the database is bounded once its 90-day bars expire); 2 MB a day up to 180 MB here.
    const size = (h: number): number => Math.floor(Math.min(180_000_000, 2_000_000 * (1 + h / 24)));
    let have: Array<[string, number]> = [];
    let maxKept = 0;
    const budget = 6_000_000_000;
    for (let h = 0; h < 90 * 24; h++) {
      have.push([nameAt(t0 + h * HOUR), size(h)]);
      if (h % 6 !== 5) continue;                                          // every 6 hours keeps the test quick; the rule is the same
      const r = keep(have, budget);
      have = have.filter(([n]) => !r.deleted.includes(n));
      maxKept = Math.max(maxKept, have.reduce((a, [, b]) => a + b, 0));
      expect(have.slice(-Math.min(have.length, 24)).length).toBe(Math.min(h + 1, 24));
      expect(r.kept <= Math.max(budget, r.floor)).toBe(true);
    }
    expect(have.length).toBeLessThanOrEqual(72);
    expect(maxKept).toBeLessThanOrEqual(Math.max(budget, 31 * 180_000_000));
  });

  it('zeroed-backup compresses with zstd, keeps by backup_keep and writes budget.status; the installer guarantees zstd', () => {
    const s = read('ops/host/files/usr/local/sbin/zeroed-backup');
    expect(s).toContain('| zstd -q -3 -T1 | age -R "$RECIPIENTS"');
    expect(s).toContain('backup_keep "$FLOOR_HOURLY" "$FLOOR_DAILY" "$MAX_BYTES" "$KEEP"');
    expect(s).toMatch(/^FLOOR_HOURLY=24$/m);
    expect(s).toMatch(/^FLOOR_DAILY=7$/m);
    expect(s).toContain('MAX_BYTES="${ZEROED_BACKUP_MAX_BYTES:-6000000000}"');
    expect(s).not.toMatch(/tail -n \+"\$\(\(KEEP \+ 1\)\)"/);           // the old count-only prune is gone
    expect(read('ops/host/install-main.sh')).toMatch(/^PACKAGES=\(.*\bzstd\b.*\)$/m);
    expect(read('ops/host/files/usr/local/sbin/zeroed-restore-drill')).toContain('zstd -q -d -c');
    expect(read('ops/host/files/usr/local/sbin/zeroed-backup-offsite')).toContain('"$OUT"/zeroed-*.tar.zst.age');
  });
});

describe('SW-1(c): the server disk alerts (SPEC-B B-M24-04: 80% warning, 95% or the 500 MB reserve critical)', () => {
  const df = (size: number, avail: number) => sh('disk_alerts', `     1B-blocks        Avail\n${size} ${avail}\n`).out.split('\n');
  it('below 80% clears both; above 80% warns; above 95% or under 500 MB free is critical; unreadable input says nothing', () => {
    expect(df(100e9, 30e9)).toEqual([expect.stringMatching(/^off\|disk-critical\|/), expect.stringMatching(/^off\|disk-low\|/)]);
    expect(df(100e9, 15e9)).toEqual([expect.stringMatching(/^off\|disk-critical\|/), expect.stringMatching(/^on\|disk-low\|ALERT .*85% full/)]);
    expect(df(100e9, 4e9)[0]).toMatch(/^on\|disk-critical\|ALERT .*96% full \(4000 MB free\)/);
    expect(df(5e9, 400e6)[0]).toMatch(/^on\|disk-critical\|/);           // 92% used, but under the 500 MB reserve
    expect(sh('disk_alerts', 'garbage\n').out).toBe('');
  });

  it('the backup budget alert reads budget.status; zeroed-check runs both, before any key check', () => {
    expect(sh('backup_budget_alert "floor_bytes 9000000000 kept_bytes 9000000000 kept 31 over 1 max_bytes 6000000000" 6000000000').out).toMatch(/^on\|backup-budget\|ALERT .*9000 MB, over the 6000 MB budget/);
    expect(sh('backup_budget_alert "floor_bytes 1 kept_bytes 1 kept 1 over 0" 6000000000').out).toMatch(/^off\|backup-budget\|CLEARED/);
    expect(sh('backup_budget_alert "nonsense" 6000000000').out).toBe('');
    const check = read('ops/host/files/usr/local/sbin/zeroed-check');
    expect(check).toContain('done < <(df -B1 --output=size,avail / 2>/dev/null | disk_alerts)');
    expect(check).toContain('done < <(backup_budget_alert "$budget" "$budget_max")');
    expect(check.indexOf('disk_alerts')).toBeLessThan(check.indexOf('keys_stored || exit 0'));
  });
});

describe('SW-2: zeroed-provider-resume', () => {
  const script = join(root, 'ops/host/files/usr/local/sbin/zeroed-provider-resume');
  const run = (args: string[], env: Record<string, string>) => new Promise<{ status: number | null; out: string }>((resolve) => {
    const c = spawn('bash', [script, ...args], { env: { PATH: process.env['PATH'] ?? '', ...env } });
    let out = '';
    c.stdout.on('data', (d) => { out += String(d); });
    c.on('close', (status) => resolve({ status, out }));
  });

  it('refuses a bad label; writes provider-resume-<label> and succeeds once the recorder deletes it; times out and removes it otherwise', async () => {
    const control = join(tmp, 'control');
    mkdirSync(control);
    expect((await run(['../etc'], { ZEROED_CONTROL_DIR: control })).status).toBe(2);
    expect((await run([], { ZEROED_CONTROL_DIR: control })).status).toBe(2);
    const late = await run(['shyft'], { ZEROED_CONTROL_DIR: control, ZEROED_PROVIDER_RESUME_WAIT_S: '1' });
    expect(late.status).toBe(1);
    expect(readdirSync(control)).toEqual([]);
    // A stand-in recorder: deletes the request as soon as it appears.
    const p = run(['chainstack'], { ZEROED_CONTROL_DIR: control, ZEROED_PROVIDER_RESUME_WAIT_S: '10' });
    for (let i = 0; i < 100 && !existsSync(join(control, 'provider-resume-chainstack')); i++) await new Promise((r) => setTimeout(r, 50));
    expect(readdirSync(control)).toEqual(['provider-resume-chainstack']);
    rmSync(join(control, 'provider-resume-chainstack'));
    const ok = await p;
    expect(ok.status, ok.out).toBe(0);
    expect(ok.out).toContain('handled by the recorder');
    expect((await run(['shyft'], { ZEROED_CONTROL_DIR: join(tmp, 'none') })).status).toBe(1);
  });

  it('the README has the runbook', () => {
    expect(read('ops/README.md')).toContain('**Runbook: a stopped read provider (`m14.provider_stopped`; SW-2).**');
    writeFileSync(join(tmp, 'x'), '');
  });
});

describe('SW-7: the worker starts on a synchronised clock, never blocked by it', () => {
  it('Wants= and After=time-sync.target; the installer enables systemd-time-wait-sync and bounds its wait to 2 minutes', () => {
    const unit = read('ops/host/files/etc/systemd/system/zeroed-worker.service');
    expect(unit).toMatch(/^Wants=.*\btime-sync\.target\b/m);
    expect(unit).toMatch(/^After=.*\btime-sync\.target\b/m);
    expect(unit).not.toMatch(/^Requires=.*time-sync/m);
    expect(read('ops/host/install-main.sh')).toContain('systemctl enable systemd-time-wait-sync.service');
    expect(read('ops/host/files/etc/systemd/system/systemd-time-wait-sync.service.d/zeroed-timeout.conf')).toMatch(/^\[Service\]\nTimeoutStartSec=120$/m);
    expect(read('ops/host/install-main.sh')).toContain('/etc/systemd/system/systemd-time-wait-sync.service.d/zeroed-*) return 0 ;;');
  });
});

describe('SW-22: SSH on the tailnet only once the pull account has a key', () => {
  const conf = read('ops/host/files/etc/nftables.conf');
  it('ssh_rule turns the rule on, tailnet-only with a pull key; ssh_public_open tells the two apart', () => {
    const key = join(tmp, 'pull-key');
    const none = join(tmp, 'no-key');
    writeFileSync(key, 'ssh-ed25519 AAAA test\n');
    const withKey = sh(`ssh_rule ${JSON.stringify(key)}`, conf).out;
    const without = sh(`ssh_rule ${JSON.stringify(none)}`, conf).out;
    expect(withKey).toMatch(/^    iifname "tailscale0" tcp dport 22 ct state new limit rate 6\/minute accept$/m);
    expect(withKey).not.toMatch(/^#SSH_RULE#/m);
    expect(without).toMatch(/^    tcp dport 22 ct state new limit rate 6\/minute accept$/m);
    expect(sh('ssh_public_open && echo y || echo n', without).out).toBe('y');
    expect(sh('ssh_public_open && echo y || echo n', withKey).out).toBe('n');
    expect(sh('ssh_public_open && echo y || echo n', conf).out).toBe('n');
    // The installer's two places that open SSH both go through it; zeroed-check alerts on a public rule with a key.
    const main = read('ops/host/install-main.sh');
    expect(main.match(/ssh_rule \/etc\/zeroed\/pull-keys\/zeroed-pull < \/etc\/nftables.conf/g)?.length).toBe(2);
    expect(main).not.toContain("sed -i 's/^#SSH_RULE#//' /etc/nftables.conf");
    expect(read('ops/host/files/usr/local/sbin/zeroed-check')).toContain('nft list ruleset 2>/dev/null | ssh_public_open');
  });
});

describe('SW-19: one length limit for the provider URLs on both sides', () => {
  it('384 characters: its base64 (512) fits the handoff\'s value rule; both scripts check the same 384', () => {
    expect(Buffer.from('x'.repeat(384)).toString('base64').length).toBe(512);
    expect(Buffer.from('x'.repeat(385)).toString('base64').length).toBeGreaterThan(512);
    const pair = read('ops/host/files/usr/local/sbin/zeroed-pair');
    expect(pair).toContain('[[ "$val" =~ ^[A-Za-z0-9._:/+=@-]{0,512}$ ]]');
    expect(pair).toContain('[ "${#url}" -le 384 ]');
    expect(read('ops/deploy/publish.sh')).toContain('[ "${#u}" -le 384 ]');
    expect(pair).not.toContain('{1,500}');
  });
});

describe('SW-20: wrangler never sees a provider URL, an API key, the deploy code or the GitHub token', () => {
  const run = (script: string, env: Record<string, string>) => new Promise<{ status: number | null; out: string }>((resolve) => {
    const c = spawn('bash', [join(root, script)], { env: { PATH: process.env['PATH'] ?? '', ...env } });
    let out = '';
    c.stdout.on('data', (d) => { out += String(d); });
    c.stderr.on('data', (d) => { out += String(d); });
    c.on('close', (status) => resolve({ status, out }));
  });

  it('publish.sh: every wrangler call gets only the Cloudflare values (TEST values; fails before: the whole step environment)', async () => {
    const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, result: { subdomain: 'owners-pick' } })); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const bin = mkdtempSync(join(tmpdir(), 'sw20-'));
    const envLog = join(bin, 'wrangler-env.log');
    writeFileSync(join(bin, 'gh'), '#!/usr/bin/env bash\ncase "$1 $2" in "api "*) echo 1 ;; esac\nexit 0\n');
    writeFileSync(join(bin, 'age'), '#!/usr/bin/env bash\nout=""; while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done; cat > /dev/null; : > "$out"\n');
    writeFileSync(join(bin, 'age-keygen'), `#!/usr/bin/env bash\ncat >/dev/null; echo age1${'q'.repeat(58)}\n`);
    writeFileSync(join(bin, 'wrangler'), `#!/usr/bin/env bash\nenv | cut -d= -f1 | sort | tr '\\n' ' ' >> ${JSON.stringify(envLog)}; echo >> ${JSON.stringify(envLog)}\n[ "\${1:-}" = secret ] && cat > /dev/null\n[ "\${1:-}" = deploy ] && echo "Deployed https://zeroed-watchdog.owners-pick.workers.dev"\nexit 0\n`);
    for (const f of ['gh', 'age', 'age-keygen', 'wrangler']) chmodSync(join(bin, f), 0o755);
    const r = await run('ops/deploy/publish.sh', {
      PATH: `${bin}:${process.env['PATH'] ?? ''}`, GH_REPO: 'o/r', GH_TOKEN: 'TESTgh', GITHUB_SHA: 'a'.repeat(40), ISSUED: '1', PICKUP_POLL_S: '0', PICKUP_GRACE_S: '0',
      DEPLOY_CODE: 'abacus abdomen able about above absent', HELIUS_API_KEY: 'TESTa', ALCHEMY_API_KEY: 'TESTb', JUPITER_API_KEY: 'TESTc', TELEGRAM_BOT_TOKEN: '1:TESTd',
      RPC_SHYFT_URL: 'https://rpc.shyft.example/?api_key=TESTs', RPC_CHAINSTACK_URL: 'https://chainstack.example/TESTc',
      CLOUDFLARE_API_TOKEN: 'TESTcf', CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_API_URL: `http://127.0.0.1:${port}/client/v4`, WRANGLER: join(bin, 'wrangler'),
    });
    server.close();
    const calls = existsSync(envLog) ? readFileSync(envLog, 'utf8').trim().split('\n') : [];
    rmSync(bin, { recursive: true, force: true });
    expect(r.status, r.out).toBe(0);
    expect(calls.length).toBe(4);                                         // deploy and three secrets
    for (const c of calls) {
      const names = c.split(' ');
      expect(names).toContain('CLOUDFLARE_API_TOKEN');
      for (const n of ['RPC_SHYFT_URL', 'RPC_CHAINSTACK_URL', 'HELIUS_API_KEY', 'ALCHEMY_API_KEY', 'JUPITER_API_KEY', 'TELEGRAM_BOT_TOKEN', 'DEPLOY_CODE', 'GH_TOKEN']) expect(names, n).not.toContain(n);
    }
  });

  it('reports.sh and the npm step keep their tokens away from the npm tools', () => {
    expect(read('ops/deploy/reports.sh')).toContain('wrangler() { env -u DATA_STORE_TOKEN -u GH_TOKEN -u GITHUB_TOKEN $WRANGLER "$@"; }');
    expect(read('ops/deploy/reports.sh')).not.toMatch(/\$WRANGLER --config/);
    expect(read('.github/workflows/deploy.yml')).toContain('run: env -u GH_TOKEN -u GITHUB_TOKEN npm ci --ignore-scripts --no-audit --no-fund');
  });
});

describe('SW-18: one worker unit name, two bodies (ruling SW-18a, option A)', () => {
  const FULL = read('ops/host/files/etc/systemd/system/zeroed-worker.service');
  const REC = read('ops/host/files/usr/local/lib/zeroed/units/zeroed-worker.recorder.service');
  const COMMON = read('ops/host/files/usr/local/lib/zeroed/common.sh');
  const fn = COMMON.slice(COMMON.indexOf('WORKER_UNIT_FILE='), COMMON.indexOf('\n}\n', COMMON.indexOf('worker_unit_apply() {')) + 3);
  const lines = (u: string, key: string) => u.split('\n').filter((l) => l.startsWith(`${key}=`));

  it('the recorder body: no signer group or folders, the four credentials only, link-local and private ranges refused; otherwise the full body\'s sandbox', () => {
    expect(lines(REC, 'SupplementaryGroups')).toEqual(['SupplementaryGroups=zeroed-pull']);
    expect(REC).not.toMatch(/zeroed-signer\.service|SupplementaryGroups=.*zeroed-signer/);
    expect(REC).toMatch(/^InaccessiblePaths=-\/run\/zeroed-signer -\/var\/lib\/zeroed-signer$/m);
    const creds = [...lines(REC, 'LoadCredentialEncrypted'), ...lines(REC, 'LoadCredential'), ...lines(REC, 'ImportCredential'), ...lines(REC, 'SetCredential')].map((l) => l.split('=')[1]!.split(':')[0]).sort();
    expect(creds).toEqual(['heartbeat_hmac_key', 'rpc_chainstack_url', 'rpc_shyft_url', 'telegram_chat_id']);
    expect(REC).toMatch(/^IPAddressDeny=169\.254\.0\.0\/16 10\.0\.0\.0\/8 172\.16\.0\.0\/12 192\.168\.0\.0\/16 fe80::\/10$/m);
    expect(REC).not.toMatch(/^IPAddress(Deny|Allow)=.*(127\.|::1|100\.64|localhost)/m);
    expect(lines(REC, 'ReadWritePaths')).toEqual(['ReadWritePaths=/var/lib/zeroed-md /var/lib/zeroed-usage']);
    // Every other setting of the full body is kept as it is (the deploy gate, probation, the OOM order, the hardening).
    const rest = (u: string) => u.split('\n').filter((l) => /^[A-Z][A-Za-z]*=/.test(l) && !/^(Description|After|SupplementaryGroups|LoadCredentialEncrypted|ReadWritePaths|InaccessiblePaths|IPAddressDeny)=/.test(l));
    expect(rest(REC)).toEqual(rest(FULL));
    expect(lines(FULL, 'SupplementaryGroups')).toContain('SupplementaryGroups=zeroed-signer');   // the full body is unchanged
  });

  const sandbox = () => {
    const d = mkdtempSync(join(tmpdir(), 'sw18-'));
    for (const x of ['units', 'rel-rec/ops', 'rel-rec/packages/engine/scripts', 'rel-stub/ops', 'bin']) mkdirSync(join(d, x), { recursive: true });
    writeFileSync(join(d, 'units/zeroed-worker.recorder.service'), REC);
    writeFileSync(join(d, 'units/zeroed-worker.full.service'), FULL);
    writeFileSync(join(d, 'live.service'), FULL);
    writeFileSync(join(d, 'rel-rec/ops/host-config.json'), '{"worker":"recorder"}');
    writeFileSync(join(d, 'rel-rec/packages/engine/scripts/recorder.ts'), '');
    writeFileSync(join(d, 'rel-stub/ops/host-config.json'), '{"worker":"stub"}');
    writeFileSync(join(d, 'bin/analyze'), `#!/usr/bin/env bash\necho "verify $*" >> ${JSON.stringify(join(d, 'calls'))}\n[ ! -e ${JSON.stringify(join(d, 'verify_fail'))} ]\n`);
    writeFileSync(join(d, 'bin/systemctl'), `#!/usr/bin/env bash\necho "systemctl $*" >> ${JSON.stringify(join(d, 'calls'))}\n[ ! -e ${JSON.stringify(join(d, 'reload_fail'))} ]\n`);
    chmodSync(join(d, 'bin/analyze'), 0o755);
    chmodSync(join(d, 'bin/systemctl'), 0o755);
    const apply = (rel: string, extra = '') => spawnSync('bash', ['-c', `set -euo pipefail; . "${LOGIC}"; log() { echo "$*" >> "${d}/log"; }; ZEROED_WORKER_UNIT_FILE="${d}/live.service" ZEROED_WORKER_UNIT_BODIES="${d}/units"; ${fn}
SYSTEMD_ANALYZE="${d}/bin/analyze" SYSTEMCTL="${d}/bin/systemctl" worker_unit_apply "${join(d, rel)}" ${extra}`], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
    const calls = () => (existsSync(join(d, 'calls')) ? readFileSync(join(d, 'calls'), 'utf8').trim().split('\n') : []);
    return { d, apply, calls, live: () => readFileSync(join(d, 'live.service'), 'utf8') };
  };

  it('worker_unit_apply: the recorder body for a recorder release (verified, renamed in, reloaded); nothing again when in place; the full body back for any other', () => {
    const s = sandbox();
    expect(s.apply('rel-rec').status).toBe(0);
    expect(s.live()).toBe(REC);
    expect(s.calls()).toEqual([expect.stringMatching(/^verify .*\/zeroed-worker\.service$/), 'systemctl daemon-reload']);
    expect(s.apply('rel-rec').status).toBe(0);
    expect(s.calls().length).toBe(2);                                     // in place: no verify, no reload
    expect(s.apply('rel-stub').status).toBe(0);
    expect(s.live()).toBe(FULL);
    expect(s.apply('rel-stub').status).toBe(0);
    expect(s.calls().length).toBe(4);
    expect(s.apply('missing').status).toBe(0);                            // no current: the stand-in, full body kept
    expect(readdirSync(s.d)).not.toContain('live.service.zeroed-unit');
  });

  it('worker_unit_apply: a full body of an older release is left as it is; a body that does not verify or a failed reload changes nothing', () => {
    const s = sandbox();
    writeFileSync(join(s.d, 'live.service'), `${FULL}# an older release's full body\n`);
    expect(s.apply('rel-stub').status).toBe(0);
    expect(s.live()).toBe(`${FULL}# an older release's full body\n`);
    writeFileSync(join(s.d, 'verify_fail'), '');
    expect(s.apply('rel-rec').status).toBe(1);
    expect(s.live()).toBe(`${FULL}# an older release's full body\n`);
    rmSync(join(s.d, 'verify_fail'));
    writeFileSync(join(s.d, 'reload_fail'), '');
    expect(s.apply('rel-rec').status).toBe(1);
    expect(s.live()).toBe(`${FULL}# an older release's full body\n`);
    rmSync(join(s.d, 'reload_fail'));
    rmSync(join(s.d, 'units/zeroed-worker.recorder.service'));
    expect(s.apply('rel-rec').status).toBe(1);                            // no body on this host: refused
    expect(s.apply('rel-rec', '--no-reload').status).toBe(1);
  });

  it('zeroed-update applies it before current moves, before the held restart and before the rollback\'s restart; the installer and worker-smoke use it', () => {
    const u = read('ops/host/files/usr/local/sbin/zeroed-update');
    expect(u.indexOf('if ! worker_unit_apply "$dest"; then')).toBeLessThan(u.indexOf('printf \'%s|%s|%s\\n\' "$commit" "$prev" "$current" > "$STATE_DIR/switch_unheld"'));
    const held = u.slice(u.indexOf('held_restart() {'), u.indexOf('\n}\n', u.indexOf('held_restart() {')));
    expect(held.indexOf('worker_unit_apply /opt/zeroed/current || due_rollback')).toBeLessThan(held.indexOf('systemctl restart zeroed-worker.service'));
    const roll = u.slice(u.indexOf('apply_host "${current:-$(basename "$prev")}" "$prev" || true'));
    expect(roll.indexOf('if worker_unit_apply "$prev"; then')).toBeLessThan(roll.indexOf('systemctl restart zeroed-worker.service'));
    const main = read('ops/host/install-main.sh');
    expect(main).toContain('install -m 0644 -o root -g root /etc/systemd/system/zeroed-worker.service /usr/local/lib/zeroed/units/zeroed-worker.full.service');
    expect(main.indexOf('worker_unit_apply /opt/zeroed/current --no-reload')).toBeLessThan(main.indexOf('say "Services"'));
    expect(read('ops/host/files/usr/local/lib/zeroed/worker-smoke')).toContain('*/"$RECORDER_ENTRY") UNIT_FILE="${ZEROED_WORKER_UNIT_BODIES:-/usr/local/lib/zeroed/units}/zeroed-worker.recorder.service"');
  });
});
