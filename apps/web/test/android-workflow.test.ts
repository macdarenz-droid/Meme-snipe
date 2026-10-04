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
    // WAIT_S 1 makes a pending check time out at once; bash's SECONDS ticks on whole wall-clock seconds, so a 1 s
    // deadline can pass after a few ms. Runs that must reach a later answer get a long one (they end on that answer).
    const run = (listings: object[], wait = '1') => {
      const dir = mkdtempSync(join(tmpdir(), 'zeroed-require-'));
      listings.forEach((l, i) => writeFileSync(join(dir, `l${i}`), JSON.stringify(l)));
      writeFileSync(join(dir, 'gh'), `#!/usr/bin/env bash\necho "$*" >> "${dir}/calls"\nn=$(wc -l < "${dir}/calls"); cat "${dir}/l$((n - 1))" 2>/dev/null || cat "${dir}/l${listings.length - 1}"\n`);
      chmodSync(join(dir, 'gh'), 0o755);
      const r = spawnSync('bash', [script], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env['PATH']}`, GH_REPO: 'o/r', GITHUB_SHA: 'a'.repeat(40), WAIT_S: wait, POLL_S: '0.2' } });
      const calls = readFileSync(join(dir, 'calls'), 'utf8');
      rmSync(dir, { recursive: true, force: true });
      return { status: r.status, out: r.stdout, calls };
    };
    const runs = (...r: object[]) => ({ total_count: r.length, check_runs: r });
    const gha = { slug: 'github-actions' };
    const ok = run([runs(), runs({ name: 'check', status: 'in_progress', conclusion: null, app: gha }), runs({ name: 'check', status: 'completed', conclusion: 'success', app: gha })], '60');
    expect(ok.status, ok.out).toBe(0);
    expect(ok.calls).toContain(`repos/o/r/commits/${'a'.repeat(40)}/check-runs`);
    for (const bad of [
      runs({ name: 'check', status: 'completed', conclusion: 'failure', app: gha }),
      runs({ name: 'check', status: 'completed', conclusion: 'skipped', app: gha }),
      runs({ name: 'check', status: 'completed', conclusion: 'success', app: { slug: 'some-bot' } }),
      runs({ name: 'build', status: 'completed', conclusion: 'success', app: gha }),
      runs({ name: 'check', status: 'in_progress', conclusion: null, app: gha }),
      runs(),
    ]) expect(run([bad]).status).toBe(1);
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
