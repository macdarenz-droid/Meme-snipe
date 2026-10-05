// BT-WALL: scripts/evidence.ts refuses, from its arguments alone, before any git, registry or download step.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { RESEARCH_CONFIG } from '../../core/src/config/index.ts';

const dir = mkdtempSync(join(tmpdir(), 'evidence-script-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const bin = join(dir, 'bin');
mkdirSync(bin);
const calls = join(dir, 'calls');
// Fake gh and git: each records that it was called and fails, so any call before a refusal shows.
for (const tool of ['gh', 'git']) {
  writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${calls}"\nexit 1\n`);
  chmodSync(join(bin, tool), 0o755);
}
const script = join(import.meta.dirname, '..', 'scripts', 'evidence.ts');
const run = (...args: string[]) => {
  rmSync(calls, { force: true });
  const r = spawnSync(process.execPath, ['--no-warnings', script, ...args], { encoding: 'utf8', env: { PATH: `${bin}:/usr/bin:/bin` }, cwd: dir });
  return { status: r.status, stderr: r.stderr, called: existsSync(calls) ? readFileSync(calls, 'utf8') : '' };
};

describe('the evidence script refuses before it touches anything', () => {
  test('a --fetch range reaching the holdout start is refused before any download (or git step)', () => {
    const from = RESEARCH_CONFIG.holdout.fromDay;
    for (const to of [from, '2026-12-31']) {
      const r = run('--fetch', `2026-09-08..${to}`, '--sol-usd', 'x.csv');
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain(`reaches the reserved holdout start ${from}`);
      expect(r.called).toBe('');
    }
    // The day before the holdout start passes this guard and goes on (to its first git step, which the fake fails).
    const before = run('--fetch', '2026-09-08..2026-09-21', '--sol-usd', 'x.csv');
    expect(before.stderr).not.toContain('reserved holdout start');
    expect(before.called).toContain('git ');
  });

  test('a local folder is never gate evidence without --release data-FROM-TO (review W1)', () => {
    const r = run('--dataset', 'some/dir', '--sol-usd', 'x.csv');
    expect(r.stderr).toContain('gate evidence only with --release data-FROM-TO');
    expect(r.called).toBe('');
    expect(run('--dataset', 'some/dir', '--release', 'data-test', '--sol-usd', 'x.csv').stderr).toContain('must be an assembled window release');
    expect(run('--dataset', 'a', '--dataset', 'b', '--release', 'data-2026-09-06-2026-09-20', '--sol-usd', 'x.csv').stderr).toContain('one --dataset folder');
    expect(run('--synthetic', '--release', 'data-2026-09-06-2026-09-20').stderr).toContain('--release names the release a --dataset folder came from');
    // The labelled mode needs no release: it passes the argument checks and goes on.
    expect(run('--dataset', 'some/dir', '--no-lead-in', '--sol-usd', 'x.csv').called).toContain('git ');
  });

  test('a --dataset folder named as a release must carry that release\'s SHA256SUMS (review W1b)', () => {
    const tag = 'data-2026-09-06-2026-09-20';
    const published = join(dir, 'published-SHA256SUMS');
    writeFileSync(published, 'aaaa  manifest.json\n');
    // A gh that serves the release's SHA256SUMS for `release download <tag> ... --pattern SHA256SUMS --dir <d>`.
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "gh $*" >> "${calls}"\nwhile [ $# -gt 0 ]; do [ "$1" = --dir ] && { mkdir -p "$2"; cp "${published}" "$2/SHA256SUMS"; exit 0; }; shift; done\nexit 1\n`);
    const folder = join(dir, 'window');
    mkdirSync(folder, { recursive: true });
    const out = join(dir, 'out');
    const go = () => run('--dataset', folder, '--release', tag, '--sol-usd', 'x.csv', '--out', out);
    // No SHA256SUMS in the folder: refused.
    let r = go();
    expect(r.stderr).toContain(`SHA256SUMS is not release ${tag}'s`);
    expect(r.called).toContain(`gh release download ${tag}`);
    expect(r.called).not.toContain('git ');
    // A different one: refused, before any git step, and no evidence written.
    writeFileSync(join(folder, 'SHA256SUMS'), 'bbbb  manifest.json\n');
    r = go();
    expect(r.stderr).toContain(`SHA256SUMS is not release ${tag}'s`);
    expect(r.called).not.toContain('git ');
    expect(existsSync(out)).toBe(false);
    // The release's own: the check passes and the run goes on (to its first git step, which the fake fails).
    writeFileSync(join(folder, 'SHA256SUMS'), readFileSync(published));
    r = go();
    expect(r.stderr).not.toContain('is not release');
    expect(r.called).toContain('git ');
  });
});
