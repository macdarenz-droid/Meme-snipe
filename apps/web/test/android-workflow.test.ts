import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const wf = readFileSync(fileURLToPath(new URL('../../../.github/workflows/android-preview.yml', import.meta.url)), 'utf8');
const releaseJob = wf.slice(wf.indexOf('\n  release:'));

describe('android-preview workflow', () => {
  it('touches the release only from the integration branch, never from a pull request', () => {
    const cond = releaseJob.match(/\n    if: (.*)\n/)?.[1] ?? '';
    expect(cond).toContain("github.ref == 'refs/heads/ccr-14987baf-i6lrsl'");
    expect(cond).toMatch(/event_name == 'push'/);
    expect(cond).toMatch(/event_name == 'workflow_dispatch'/);
    expect(cond).not.toContain('pull_request');
  });

  it('gives write access to the release job only', () => {
    expect(wf.slice(0, wf.indexOf('\njobs:'))).not.toContain('contents: write');
    expect(releaseJob).toContain('contents: write');
    expect(wf.slice(0, wf.indexOf('\n  release:'))).not.toMatch(/gh release|contents: write/);
  });

  it('replaces the single asset without a window where the link is dead', () => {
    const script = readFileSync(fileURLToPath(new URL('../../../.github/scripts/publish-preview.sh', import.meta.url)), 'utf8');
    expect(releaseJob).toContain('bash .github/scripts/publish-preview.sh');
    // Never --clobber (it deletes the old asset before the upload): upload under a temporary name, then swap.
    expect(script).not.toMatch(/--clobber/);
    expect(script).toContain('gh release upload preview "$NEXT"');
  });

  it('publishes only after CI check passed on the exact commit (OPS-GATE)', () => {
    const require = releaseJob.indexOf('run: bash .github/scripts/require-check.sh');
    expect(require).toBeGreaterThan(0);
    expect(require).toBeLessThan(releaseJob.indexOf('run: bash .github/scripts/publish-preview.sh'));
    expect(releaseJob).toContain('checks: read');
    const script = fileURLToPath(new URL('../../../.github/scripts/require-check.sh', import.meta.url));
    // A gh stand-in serving each call the next listing from a queue; the script must ask about GITHUB_SHA only.
    // A stand-in `sleep` advances the script's test clock (CLOCK_FILE) instead of waiting: no wall clock decides.
    const run = (listings: object[], clock = '0') => {
      const dir = mkdtempSync(join(tmpdir(), 'zeroed-require-'));
      listings.forEach((l, i) => writeFileSync(join(dir, `l${i}`), JSON.stringify(l)));
      writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/calls"\nn=$(wc -l < "${dir}/calls"); cat "${dir}/l$((n - 1))" 2>/dev/null || cat "${dir}/l${listings.length - 1}"\n`);
      writeFileSync(join(dir, 'sleep'), `#!/usr/bin/env bash\necho $(( $(cat "${dir}/clock") + $1 )) > "${dir}/clock"\n`);
      writeFileSync(join(dir, 'clock'), clock);
      chmodSync(join(dir, 'gh'), 0o755);
      chmodSync(join(dir, 'sleep'), 0o755);
      // The kill timeout only turns a script that never stops (no deadline) into a failure; no outcome depends on it.
      const r = spawnSync('bash', [script], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, PATH: `${dir}:${process.env['PATH']}`, GH_REPO: 'o/r', GITHUB_SHA: 'a'.repeat(40), WAIT_S: '60', POLL_S: '20', CLOCK_FILE: join(dir, 'clock') } });
      let calls = '';
      try {
        calls = readFileSync(join(dir, 'calls'), 'utf8');
      } catch {}
      rmSync(dir, { recursive: true, force: true });
      return { status: r.status, out: r.stdout + r.stderr, calls };
    };
    const runs = (...r: object[]) => ({ total_count: r.length, check_runs: r });
    const gha = { slug: 'github-actions' };
    const ok = run([runs(), runs({ name: 'check', status: 'in_progress', conclusion: null, app: gha }), runs({ name: 'check', status: 'completed', conclusion: 'success', app: gha })]);
    expect(ok.status, ok.out).toBe(0);
    expect(ok.calls).toContain(`repos/o/r/commits/${'a'.repeat(40)}/check-runs`);
    const red = runs({ name: 'check', status: 'completed', conclusion: 'failure', app: gha });
    const pending = runs({ name: 'check', status: 'in_progress', conclusion: null, app: gha });
    for (const bad of [
      red,
      runs({ name: 'check', status: 'completed', conclusion: 'skipped', app: gha }),
      runs({ name: 'check', status: 'completed', conclusion: 'success', app: { slug: 'some-bot' } }),
      runs({ name: 'build', status: 'completed', conclusion: 'success', app: gha }),
      pending,
      runs(),
    ]) expect(run([bad]).status).toBe(1);
    // Still pending at the deadline: polls at 0, 20, 40 and 60 s, then gives up.
    const late = run([pending]);
    expect(late.calls.trim().split('\n')).toHaveLength(4);
    expect(late.out).toContain(`::error::check on ${'a'.repeat(12)} is pending after 60 s`);
    // The test clock moves timing only: whatever it starts at, red, pending and missing still fail, and a clock
    // that is not whole seconds stops the script before it can publish.
    for (const clock of ['0', '999999999']) for (const bad of [red, pending, runs()]) expect(run([bad], clock).status, clock).toBe(1);
    for (const clock of ['', '-5', '1.5', '08', 'x', '1e3', '0\n1']) {
      const r = run([runs({ name: 'check', status: 'completed', conclusion: 'success', app: gha })], clock);
      expect(r.status, JSON.stringify(clock)).toBe(1);
      expect(r.out).toContain('::error::CLOCK_FILE does not hold whole seconds.');
      expect(r.calls).toBe('');
    }
    // The default wait ends with ~4 min to spare before the release job's timeout, so the job reports why it stopped.
    const waits = [...readFileSync(script, 'utf8').matchAll(/\$\{WAIT_S:-(\d+)\}/g)].map((m) => Number(m[1]));
    const timeout = Number(/timeout-minutes: (\d+)/.exec(releaseJob)?.[1]);
    expect(waits.length).toBe(2);
    expect(new Set(waits).size).toBe(1);
    expect(waits[0]! + 240).toBeLessThanOrEqual(timeout * 60);
    expect(waits[0]).toBe(timeout * 60 - 240);
    // A re-run counts: the newest run of check decides.
    expect(run([runs({ name: 'check', status: 'completed', conclusion: 'failure', started_at: '2026-10-04T01:00:00Z', app: gha }, { name: 'check', status: 'completed', conclusion: 'success', started_at: '2026-10-04T02:00:00Z', app: gha })]).status).toBe(0);
  });

  it('commits no keystore', () => {
    expect(readFileSync(fileURLToPath(new URL('../../../.gitignore', import.meta.url)), 'utf8')).toMatch(/\*\.keystore/);
  });

  it('keeps pull requests from forks away from the keystore cache', () => {
    const step = wf.slice(wf.indexOf('name: Restore debug keystore'), wf.indexOf('name: Create debug keystore'));
    expect(step).toContain("if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository");
    // With the restore skipped, cache-hit is empty, so the throwaway key is created.
    expect(wf).toMatch(/name: Create debug keystore[^\n]*\n\s+if: steps\.keystore\.outputs\.cache-hit != 'true'/);
  });
});

describe('workflow supply chain', () => {
  const dir = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url));
  it('pins every third-party action to a full commit SHA, with the tag in a comment', () => {
    const uses = readdirSync(dir)
      .filter((f) => f.endsWith('.yml'))
      .flatMap((f) => readFileSync(dir + f, 'utf8').split('\n').filter((l) => /\buses:/.test(l)).map((l) => `${f}: ${l.trim()}`));
    expect(uses.length).toBeGreaterThan(8);
    for (const line of uses) expect(line, line).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
  });
});

describe('android app data', () => {
  const res = fileURLToPath(new URL('../android/app/src/main/', import.meta.url));
  it('turns off backup and device transfer for all app data', () => {
    const manifest = readFileSync(res + 'AndroidManifest.xml', 'utf8');
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:fullBackupContent="false"');
    expect(manifest).toContain('android:dataExtractionRules="@xml/data_extraction_rules"');
    const rules = readFileSync(res + 'res/xml/data_extraction_rules.xml', 'utf8');
    for (const section of ['cloud-backup', 'device-transfer']) {
      const body = rules.slice(rules.indexOf(`<${section}>`), rules.indexOf(`</${section}>`));
      for (const domain of ['root', 'file', 'database', 'sharedpref', 'external']) {
        expect(body).toContain(`<exclude domain="${domain}" path="." />`);
      }
    }
  });
});
