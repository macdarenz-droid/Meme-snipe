// The command line and the fallback workflow file: refusals, the forced label, outputs, the secret scan gate.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_EXIT, STUB_ENTRY } from '../src/contract.ts';
import { tickAction } from '../src/runner.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const cli = (args: string[], env: Record<string, string> = {}) =>
  spawnSync(process.execPath, ['--no-warnings', 'packages/runner/src/cli.ts', ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', ...env }, timeout: 60_000 });

describe('cli', () => {
  it('refuses to run with key material in the environment', () => {
    const r = cli(['run', '--mode', 'local', '--entry', STUB_ENTRY], { BOT_PRIVATE_KEY: 'x' });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('BOT_PRIVATE_KEY');
    expect(r.stderr).not.toContain("'x'");
  });
  it('refuses any entry but the worker or the stub', () => {
    const r = cli(['run', '--mode', 'local', '--entry', 'packages/runner/test/cli.test.ts']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('is not one of');
  });
  it('refuses a run over 72 h and a segment past the chain limit, and check-segment stops the chain', () => {
    expect(cli(['run', '--mode', 'local', '--entry', STUB_ENTRY, '--hours', '73']).status).toBe(2);
    expect(cli(['run', '--mode', 'local', '--entry', STUB_ENTRY, '--hours', '48', '--segment', '12']).status).toBe(2);
    expect(cli(['check-segment', '--segment', '11', '--hours', '48']).status).toBe(0);
    expect(cli(['check-segment', '--segment', '12', '--hours', '48']).status).toBe(2);
  });
  it('refuses a host run without a requested name, so a restart can never create a run', () => {
    const r = cli(['run', '--mode', 'systemd', '--evidence-root', mkdtempSync(join(tmpdir(), 'run1-e-'))]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--run-name');
  });
  it('labels any GitHub Actions run a rehearsal and writes the job outputs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'run1-cli-'));
    const out = join(dir, 'out');
    writeFileSync(out, '');
    const r = cli(
      ['run', '--mode', 'local', '--entry', STUB_ENTRY, '--hours', '0.002', '--sample-ms', '100', '--state-dir', join(dir, 's'), '--evidence-root', join(dir, 'e'), '--commit', 'abc123def4567890', '--health-addr', '127.0.0.1:18787'],
      { GITHUB_ACTIONS: 'true', GITHUB_OUTPUT: out, ZEROED_STUB_TICK_MS: '50', ZEROED_STUB_CYCLE_MS: '1000' },
    );
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'e', /run_id=(.*)/.exec(readFileSync(out, 'utf8'))?.[1] ?? '', 'run.json'), 'utf8')).entry).toBe(STUB_ENTRY);
    const outputs = readFileSync(out, 'utf8');
    const id = /run_id=(.*)/.exec(outputs)?.[1] ?? '';
    expect(id).toMatch(/^rehearsal-\d{8}T\d{4}Z-abc123def456$/);
    expect(outputs).toContain('done=true');
    const report = JSON.parse(readFileSync(join(dir, 'e', id, 'report.json'), 'utf8')) as { label: string; commit: string };
    expect(report).toMatchObject({ label: 'rehearsal', commit: 'abc123def4567890' });
  }, 60_000);
  it('scan exits 1 on a secret and prints only its name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'run1-scan-'));
    writeFileSync(join(dir, 'a.log'), 'clean');
    expect(cli(['scan', dir], { JUPITER_API_KEY: 'jup-secret-value-123' }).status).toBe(0);
    writeFileSync(join(dir, 'b.log'), 'x-api-key: jup-secret-value-123');
    const r = cli(['scan', dir], { JUPITER_API_KEY: 'jup-secret-value-123' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FOUND JUPITER_API_KEY');
    expect(r.stdout + r.stderr).not.toContain('jup-secret-value-123');
  });
});

describe('host start decision', () => {
  it('starts a requested name once, resumes an unfinished run by its name, and never runs two', () => {
    expect(tickAction({ request: 'q1', started: [], unfinished: null, active: [] })).toMatchObject({ start: 'q1', mark: true });
    expect(tickAction({ request: 'q1', started: ['q1'], unfinished: null, active: [] }).start).toBeNull();
    expect(tickAction({ request: 'q2', started: ['q1'], unfinished: 'q1', active: [] })).toMatchObject({ start: 'q1', mark: false });
    expect(tickAction({ request: 'q2', started: [], unfinished: null, active: ['q1'] }).start).toBeNull();
    expect(tickAction({ request: null, started: [], unfinished: null, active: [] }).start).toBeNull();
    expect(tickAction({ request: '../x', started: [], unfinished: null, active: [] }).start).toBeNull();
  });
});

describe('fallback workflow', () => {
  const wf = readFileSync(join(root, '.github/workflows/dryrun-rehearsal.yml'), 'utf8');
  const steps = wf.split(/\n      - /).slice(1);
  const idx = (needle: string) => steps.findIndex((s) => s.includes(needle));
  it('reads secrets only in the run and scan steps, as environment variables', () => {
    const withSecrets = steps.filter((s) => s.includes('secrets.')).map((s) => s.split('\n')[0]);
    expect(withSecrets).toEqual(['name: Run the worker with drills', 'name: Secret scan']);
    expect(wf.match(/\$\{\{ secrets\.[A-Z_]+ \}\}/g)?.every((m) => /HELIUS|ALCHEMY|JUPITER|TELEGRAM/.test(m))).toBe(true);
    expect(wf).not.toMatch(/run: .*\$\{\{ secrets/);
  });
  it('scans before every upload, and uploads only after a clean scan', () => {
    const scan = idx('name: Secret scan');
    const uploads = steps.flatMap((s, i) => (s.includes('upload-artifact@') ? [i] : []));
    expect(uploads.length).toBe(2);
    for (const u of uploads) {
      expect(u).toBeGreaterThan(scan);
      expect(steps[u]).toContain("steps.scan.outcome == 'success'");
    }
    expect(steps[idx('Start the next job')]).toContain("success() && steps.run.outputs.done == 'false'");
  });
  it('checks commit, entry, chain limits and the previous job before any secret is read', () => {
    const run = idx('name: Run the worker with drills');
    const check = idx('name: Check the commit, entry and chain limits');
    expect(check).toBeGreaterThanOrEqual(0);
    expect(check).toBeLessThan(run);
    expect(steps[check]).toContain('git merge-base --is-ancestor "$SHA" FETCH_HEAD');
    expect(steps[check]).toContain('packages/worker/src/main.ts|packages/runner/stub/worker.ts');
    expect(steps[check]).toContain('check-segment --segment "$SEGMENT"');
    const prev = idx('name: Check the previous job');
    expect(prev).toBeLessThan(idx("name: Restore the previous job's state"));
    expect(steps[prev]).toContain('.workflowName == "Dry-run rehearsal" and .event == "workflow_dispatch"');
    const next = steps[idx('Start the next job')]!;
    expect(next.indexOf('check-segment')).toBeLessThan(next.indexOf('gh workflow run'));
    expect(wf).toContain('group: dryrun-rehearsal-${{ inputs.run_id || github.run_id }}');
    expect(wf).toContain('rotate that key');
  });
  it('host unit never restarts a refused or aborted run', () => {
    const unit = readFileSync(join(root, 'packages/runner/systemd/zeroed-dryrun@.service'), 'utf8');
    expect(unit).toContain(`RestartPreventExitStatus=${RUNNER_EXIT.refused} ${RUNNER_EXIT.aborted}`);
    expect(unit).toContain('--run-name %i');
    expect(unit).not.toContain('resume-latest');
  });
  it('pins every action to a commit and fits the 6 h job limit', () => {
    for (const m of wf.matchAll(/uses: (\S+)/g)) expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
    expect(Number(/timeout-minutes: (\d+)/.exec(wf)?.[1])).toBeLessThanOrEqual(360);
    expect(wf).toContain('--segment-minutes 335');
    expect(wf).toContain('persist-credentials: false');
  });
});
