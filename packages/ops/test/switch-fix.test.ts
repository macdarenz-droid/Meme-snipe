// Card SWITCH-FIX (the three red teams on bac1f88a): the host-side fixes. The decision helpers run in bash (logic.sh,
// as host-logic.test.ts does); the scripts and unit files are checked for the wiring the ops e2e drives on a real host.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
