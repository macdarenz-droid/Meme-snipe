// CI-SHARD: the CI test suite runs in parallel shards; `check` (the one name OPS-GATE and the preview release read)
// waits on every shard and on typecheck and build, and passes only when every one passed and the shards ran every test
// file exactly once (.github/scripts/shard-cover.mjs).
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const file = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));
const wf = readFileSync(file('.github/workflows/ci.yml'), 'utf8');
const job = (name: string): string => {
  const start = wf.indexOf(`\n  ${name}:\n`);
  if (start < 0) throw new Error(`no job ${name}`);
  const next = wf.slice(start + 1).search(/\n {2}[a-z][a-z-]*:\n/);
  return next < 0 ? wf.slice(start) : wf.slice(start, start + 1 + next);
};
const COVER = file('.github/scripts/shard-cover.mjs');

describe('ci.yml: the shards and the one `check`', () => {
  const shards = (job('test').match(/shard: \[([0-9, ]+)\]/)?.[1] ?? '').split(',').map((x) => Number(x.trim()));

  it('`check` keeps its name (no display name) and waits on typecheck, build and every shard', () => {
    const check = job('check');
    expect(check).not.toMatch(/\n {4}name:/);
    expect(check).toMatch(/needs: \[static, test\]/);
    // It runs when a needed job failed (a red check, never a skipped one) but not when the run was cancelled.
    expect(check).toContain('!cancelled()');
    expect(check).toMatch(/\[ "\$STATIC" = success \] && \[ "\$TEST" = success \]/);
    expect(check).toContain('node .github/scripts/shard-cover.mjs reports/test-files/test-files.json reports/shard-*/shard.json');
  });

  it('every shard index 1..N runs `pnpm test --shard=i/N` with its JSON report uploaded; no shard stops the others', () => {
    const t = job('test');
    expect(shards).toEqual(Array.from({ length: shards.length }, (_, i) => i + 1));
    expect(shards.length).toBeGreaterThanOrEqual(2);
    expect(t).toContain(`pnpm test --shard=\${{ matrix.shard }}/${shards.length} --reporter=default --reporter=json --outputFile.json=shard.json`);
    expect(t).toContain('fail-fast: false');
    expect(t).toContain('name: shard-${{ matrix.shard }}');
  });

  it('typecheck, build and the file list still run, once, in the static job', () => {
    const s = job('static');
    for (const step of ['pnpm typecheck', 'pnpm -r --if-present build', 'pnpm exec vitest list --filesOnly --json > test-files.json']) expect(s).toContain(step);
    expect(wf.match(/pnpm typecheck/g)).toHaveLength(1);
  });

  it('every job skips draft pull requests, as before', () => {
    for (const name of ['static', 'test', 'check', 'historical-data']) expect(job(name)).toContain('!github.event.pull_request.draft');
  });

  it('the readers of the verdict still ask for `check`', () => {
    expect(readFileSync(file('ops/deploy/tag.sh'), 'utf8')).toContain('commit_verdict check');
    expect(readFileSync(file('ops/host/files/usr/local/sbin/zeroed-update'), 'utf8')).toContain('commit_verdict check');
    expect(readFileSync(file('.github/scripts/require-check.sh'), 'utf8')).toContain('select(.name == "check"');
  });
});

describe('shard-cover.mjs: every test file ran exactly once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'shard-cover-'));
  const at = (f: string) => join(dir, f);
  const list = (files: string[]) => {
    writeFileSync(at('list.json'), JSON.stringify(files.map((f) => ({ file: at(f), projectName: 'light' }))));
    return at('list.json');
  };
  const shard = (name: string, files: string[], success = true) => {
    writeFileSync(at(name), JSON.stringify({ success, testResults: files.map((f) => ({ name: at(f), status: 'passed' })) }));
    return at(name);
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [COVER, ...args], { cwd: dir, encoding: 'utf8' });

  it('the shards together run the list exactly: passes', () => {
    const r = run(list(['a.test.ts', 'b.test.ts', 'c.test.ts']), shard('s1.json', ['a.test.ts', 'c.test.ts']), shard('s2.json', ['b.test.ts']));
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('Every one of the 3 test files ran exactly once across 2 shards.');
  });

  it('a file in no shard fails, naming it', () => {
    const r = run(list(['a.test.ts', 'b.test.ts']), shard('s1.json', ['a.test.ts']));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('b.test.ts: ran in no shard');
  });

  it('a file in two shards fails, naming both', () => {
    const r = run(list(['a.test.ts']), shard('s1.json', ['a.test.ts']), shard('s2.json', ['a.test.ts']));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/a\.test\.ts: ran in 2 shards/);
  });

  it('a file the list does not hold fails', () => {
    const r = run(list(['a.test.ts']), shard('s1.json', ['a.test.ts', 'z.test.ts']));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('z.test.ts: ran but is not in the file list');
  });

  it('a shard that did not pass fails, even when the files add up', () => {
    const r = run(list(['a.test.ts']), shard('s1.json', ['a.test.ts'], false));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('the shard did not pass');
  });

  it('an empty list, an unreadable report, or no shard at all fails', () => {
    expect(run(list([]), shard('s1.json', [])).status).toBe(1);
    writeFileSync(at('broken.json'), '{');
    expect(run(list(['a.test.ts']), at('broken.json')).status).toBe(1);
    expect(run(list(['a.test.ts'])).status).toBe(2);
  });
});
