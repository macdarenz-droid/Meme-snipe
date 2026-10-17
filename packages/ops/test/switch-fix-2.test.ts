// Card SWITCH-FIX-2 (the three red teams on 3439ee02): the host-side fixes, run against the real scripts with stand-in
// tools where a real one cannot run here.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { evaluate, HELD_CODES, limitsFrom, planAlerts, type Heartbeat } from '../src/watchdog/logic.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('SW-33: zeroed-backup leaves no half-written bundle behind', () => {
  // A stand-in `age` that writes part of its output and then fails (as a full disk or a kill would) when AGE_FAIL is
  // set, and copies otherwise; sqlite3, zstd and tar are the real ones (the PATHS-FIX backup test requires them).
  const bin = mkdtempSync(join(tmpdir(), 'zeroed-sw33-bin-'));
  writeFileSync(join(bin, 'age'), '#!/usr/bin/env bash\nout=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; -R) shift 2 ;; *) shift ;; esac; done\nif [ -n "${AGE_FAIL:-}" ]; then head -c 100 > "$out"; exit 1; fi\ncat > "$out"\n');
  chmodSync(join(bin, 'age'), 0o755);
  const setup = () => {
    const t = mkdtempSync(join(tmpdir(), 'zeroed-sw33-'));
    const src = join(t, 'zeroed');
    const out = join(t, 'backups');
    mkdirSync(src);
    mkdirSync(out);
    expect(spawnSync('sqlite3', [join(src, 'bot.db'), 'CREATE TABLE ledger(x); INSERT INTO ledger VALUES (1);']).status).toBe(0);
    writeFileSync(join(t, 'recipients'), 'age1test\n');
    const env = { ZEROED_BACKUP_SRC: src, ZEROED_BACKUP_USAGE_SRC: join(t, 'none'), ZEROED_BACKUP_OUT: out, ZEROED_BACKUP_RECIPIENTS: join(t, 'recipients'),
      ZEROED_LOGIC: join(root, 'ops/host/files/usr/local/lib/zeroed/logic.sh') };
    const run = (extra: Record<string, string> = {}) => spawnSync('bash', [join(root, 'ops/host/files/usr/local/sbin/zeroed-backup')],
      { encoding: 'utf8', env: { PATH: `${bin}:${process.env['PATH'] ?? ''}`, ...env, ...extra } });
    return { t, out, run };
  };

  it('a run that fails while writing removes its .new file and keeps no bundle', () => {
    const { t, out, run } = setup();
    const r = run({ AGE_FAIL: '1' });
    expect(r.status).not.toBe(0);
    expect(readdirSync(out)).toEqual([]);
    rmSync(t, { recursive: true, force: true });
  });

  it('the next run sweeps a stale .new (a run that could not clean up), never one a live run is still writing', () => {
    const { t, out, run } = setup();
    const stale = join(out, 'zeroed-20261001T000000Z.tar.zst.age.new');
    const staleStatus = join(out, 'budget.status.new');
    const live = join(out, 'zeroed-20261017T000000Z.tar.zst.age.new');
    for (const f of [stale, staleStatus, live]) writeFileSync(f, 'partial');
    const old = new Date(Date.now() - 11 * 60_000);
    utimesSync(stale, old, old);
    utimesSync(staleStatus, old, old);
    const r = run();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const left = readdirSync(out).sort();
    expect(left.filter((f) => f.endsWith('.new'))).toEqual(['zeroed-20261017T000000Z.tar.zst.age.new']);
    expect(left.filter((f) => /^zeroed-\d{8}T\d{6}Z\.tar\.zst\.age$/.test(f))).toHaveLength(1);
    rmSync(t, { recursive: true, force: true });
  });

  it('the bundle is written under one name the exit trap knows', () => {
    const s = read('ops/host/files/usr/local/sbin/zeroed-backup');
    expect(s).toContain(`trap 'rm -rf "$work"; [ -z "$pending" ] || rm -f -- "$pending"' EXIT`);
  });
});

describe('SW-31: m07.disk_budget_high is a held code with its runbook', () => {
  const T0 = 1_800_000_000_000;
  const L = limitsFrom({});
  const hb = (critical: string[]): Heartbeat => ({ seq: 1, ts: T0, boot: 'b1', git_sha: 'a'.repeat(40), policy_version: 'stub', last_processed_slot: null, feed_ages_ms: {},
    open_position: null, unresolved_intents: { count: 0, oldest_age_s: null }, signer: 'not-ready', lease_epoch: null, sol_reserve: null, paused: false, critical });
  const at = (critical: string[]) => evaluate({ hb: hb(critical), receivedAt: T0 }, T0, L, { slot: null, heldMints: null });

  it('ALERT names md-pull; STILL once a day, not hourly; CLEARED below 75% (fails before: hourly, no runbook)', () => {
    expect(HELD_CODES.has('m07.disk_budget_high')).toBe(true);
    const first = planAlerts({}, at(['m07.disk_budget_high']), T0, L);
    expect(first.lines).toEqual(['ALERT Worker critical: m07.disk_budget_high. The recorder is over 75% of its disk cap; run md-pull before it halts at the cap (ops/README.md).']);
    let state = first.next;
    const lines: string[] = [];
    for (let m = 1; m <= 25 * 60; m++) {
      const r = planAlerts(state, at(['m07.disk_budget_high']), T0 + m * 60_000, L);
      lines.push(...r.lines);
      state = r.next;
    }
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^STILL Worker critical: m07\.disk_budget_high\..*\(since 1440 min\)$/);
    expect(planAlerts(state, at([]), T0 + 26 * 3_600_000, L).lines[0]).toMatch(/^CLEARED Worker critical: m07\.disk_budget_high\./);
  });
});

describe('SW-23: the spool group only from the full unit body', () => {
  const main = read('ops/host/install-main.sh');
  it('the installer never adds zeroed-worker to zeroed-spool in /etc/group and removes an older membership (fails before: usermod -aG zeroed-pull,zeroed-spool)', () => {
    expect(main).not.toMatch(/usermod[^\n]*zeroed-spool/);
    expect(main).toContain("if id -nG zeroed-worker 2>/dev/null | tr ' ' '\\n' | grep -qx zeroed-spool; then gpasswd -d zeroed-worker zeroed-spool >/dev/null; fi");
    expect(main).toContain('usermod -aG zeroed-pull zeroed-worker');
  });
  it('the full body gives the spool group; the recorder body neither gives it nor sees the spool', () => {
    expect(read('ops/host/files/etc/systemd/system/zeroed-worker.service')).toMatch(/^SupplementaryGroups=zeroed-pull zeroed-spool$/m);
    const rec = read('ops/host/files/usr/local/lib/zeroed/units/zeroed-worker.recorder.service');
    expect(rec.split('\n').filter((l) => l.startsWith('SupplementaryGroups='))).toEqual(['SupplementaryGroups=zeroed-pull']);
    expect(rec).toMatch(/^InaccessiblePaths=.* -\/var\/lib\/zeroed-spool$/m);
  });
  it('nothing else running as the worker\'s user names the spool', () => {
    expect(read('ops/host/files/etc/systemd/system/zeroed-record-upload@.service')).not.toContain('spool');
    expect(read('ops/host/files/usr/local/lib/zeroed/record-upload.mjs')).not.toContain('spool');
  });
});

describe('SW-35: the recorder\'s young generation is capped the same way on the server and in CI', () => {
  const logic = read('ops/host/files/usr/local/lib/zeroed/logic.sh');
  it('logic.sh sets RECORDER_SEMI_SPACE_MB=1; worker-start passes it to the recorder only; the CI soak passes the same value (fails before: no cap)', () => {
    expect(logic).toMatch(/^RECORDER_SEMI_SPACE_MB=1$/m);
    const ws = read('ops/host/files/usr/local/lib/zeroed/worker-start');
    const recorderCase = ws.slice(ws.indexOf('*/"$RECORDER_ENTRY")'), ws.indexOf('esac'));
    expect(recorderCase).toContain('heap+=("--max-semi-space-size=$RECORDER_SEMI_SPACE_MB")');
    expect(ws.split('--max-semi-space-size').length).toBe(2);                   // only there: the full worker keeps V8's default
    const wf = read('.github/workflows/ops-e2e.yml');
    expect(wf).toContain(`semi="$(bash -c '. ops/host/files/usr/local/lib/zeroed/logic.sh; echo "$RECORDER_SEMI_SPACE_MB"')"`);
    expect(wf).toMatch(/node --expose-gc --no-warnings "--max-old-space-size=\$\{limits% \*\}" "--max-semi-space-size=\$semi" packages\/engine\/scripts\/soak\/soak\.ts 48 /);
  });
});
