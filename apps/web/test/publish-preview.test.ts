import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../.github/scripts/publish-preview.sh', import.meta.url));
const NEW = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

// A gh stand-in: logs every call, and answers the tag lookup and the release lookup per scenario.
const STUB = `#!/usr/bin/env bash
echo "$*" >> "$STUB_LOG"
case "$*" in
  *"git/ref/tags/preview"*)
    if [ "$TAG" = "missing" ]; then echo '{"message":"Not Found","status":"404"}'; exit 1; fi
    if [ "$TAG" = "junk0" ]; then echo '{"message":"Not Found"}'; exit 0; fi
    echo "$OLD_SHA"; exit 0 ;;
  *"/commits/"*) echo "Latest commit subject"; exit 0 ;;
  *"/compare/"*) echo "- abc1234 a change"; exit 0 ;;
  "release view preview --json"*) echo "zeroed-preview.apk 123"; exit 0 ;;
  "release view preview"*) [ "$RELEASE" = "missing" ] && exit 1; exit 0 ;;
esac
exit 0
`;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function run(scenario: { TAG: 'missing' | 'junk0' | 'existing'; RELEASE: 'missing' | 'exists' }) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-preview-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'gh'), STUB);
  chmodSync(join(dir, 'gh'), 0o755);
  writeFileSync(join(dir, 'zeroed-preview.apk'), 'apk');
  const log = join(dir, 'calls.log');
  writeFileSync(log, '');
  const result = spawnSync('bash', [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env['PATH']}`, STUB_LOG: log, GH_REPO: 'o/r', GITHUB_SHA: NEW, VERSION_NAME: 'preview-aaaaaaa', OLD_SHA: OLD, ...scenario },
  });
  return { status: result.status, stderr: result.stderr, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean), notes: readFileSync(join(dir, 'notes.md'), 'utf8') };
}

describe('publish-preview.sh', () => {
  it('creates the tag when it does not exist (the 404 body must not count as a tag)', () => {
    const r = run({ TAG: 'missing', RELEASE: 'missing' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.startsWith('api -X POST repos/o/r/git/refs -f ref=refs/tags/preview'))).toBe(true);
    expect(r.calls.some((c) => c.includes('-X PATCH'))).toBe(false);
    expect(r.calls.some((c) => c.includes('/compare/'))).toBe(false);
    expect(r.calls).toContain('release create preview --prerelease --title Zeroed preview --notes-file notes.md --verify-tag');
    expect(r.calls).toContain('release upload preview zeroed-preview.apk --clobber');
    expect(r.notes).toContain('preview-aaaaaaa');
  });

  it('ignores a success reply that is not a sha', () => {
    const r = run({ TAG: 'junk0', RELEASE: 'exists' });
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.includes('-X PATCH'))).toBe(false);
    expect(r.calls.some((c) => c.startsWith('api -X POST'))).toBe(true);
  });

  it('moves an existing tag, lists the changes and replaces the asset', () => {
    const r = run({ TAG: 'existing', RELEASE: 'exists' });
    expect(r.status).toBe(0);
    expect(r.calls).toContain(`api -X PATCH repos/o/r/git/refs/tags/preview -f sha=${NEW} -F force=true`);
    expect(r.calls.some((c) => c.startsWith('api -X POST'))).toBe(false);
    expect(r.calls.some((c) => c.includes(`/compare/${OLD}...${NEW}`))).toBe(true);
    expect(r.calls).toContain('release edit preview --prerelease --title Zeroed preview --notes-file notes.md');
    expect(r.calls.some((c) => c.startsWith('release create'))).toBe(false);
    expect(r.calls).toContain('release upload preview zeroed-preview.apk --clobber');
    expect(r.notes).toContain('- abc1234 a change');
  });

  it('passes bash syntax check', () => {
    expect(() => execFileSync('bash', ['-n', script])).not.toThrow();
  });
});
