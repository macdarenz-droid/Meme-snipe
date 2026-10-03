import { readFileSync } from 'node:fs';
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
    expect(releaseJob).toContain('gh release upload preview zeroed-preview.apk --clobber');
  });

  it('commits no keystore', () => {
    expect(readFileSync(fileURLToPath(new URL('../../../.gitignore', import.meta.url)), 'utf8')).toMatch(/\*\.keystore/);
  });
});
