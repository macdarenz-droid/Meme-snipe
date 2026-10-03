import { readdirSync, readFileSync } from 'node:fs';
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

  it('replaces the single asset in place', () => {
    const script = readFileSync(fileURLToPath(new URL('../../../.github/scripts/publish-preview.sh', import.meta.url)), 'utf8');
    expect(releaseJob).toContain('bash .github/scripts/publish-preview.sh');
    expect(script).toContain('gh release upload preview zeroed-preview.apk --clobber');
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
