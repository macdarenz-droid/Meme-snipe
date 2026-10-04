// BT-1f: the consumer-side download of an owner-program release (ci/fetch-owner-programs.sh) against a fake `gh` that
// serves the REST release and asset calls. The supplement lands in DIR only when every check passes, and
// readOwnerPrograms reads what landed.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { readOwnerPrograms, writeOwnerPrograms, OWNER_PROGRAMS_FILE, OWNER_PROGRAMS_MANIFEST } from '../src/dataset/owner-programs.ts';

const SCRIPT = fileURLToPath(new URL('../ci/fetch-owner-programs.sh', import.meta.url));
const TAG = 'owner-programs-2026-10-04';
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const ROWS = [
  { owner: 'Owner2222222222222222222222222222222', program: 'Prog11111111111111111111111111111111' },
  { owner: 'Owner1111111111111111111111111111111', program: null },
];

let tmp = '';
let bin = '';
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'bt1f-'));
  bin = join(tmp, 'bin');
  mkdirSync(bin);
  // gh api: the release JSON from releases/TAG/meta.json, an asset's bytes from releases/TAG/assets/ID.
  writeFileSync(join(bin, 'gh'), `#!/usr/bin/env bash
echo "$*" >> "${tmp}/gh-calls"
[ "$1" = api ] || { echo "gh stub: $*" >&2; exit 1; }
shift
[ "$1" = -H ] && shift 2
case "$1" in
  repos/o/r/releases/tags/*) f="${tmp}/releases/\${1##*/}/meta.json"; [ -f "$f" ] && exec cat "$f"; echo "HTTP 404" >&2; exit 1 ;;
  repos/o/r/releases/assets/*) f=$(ls "${tmp}"/releases/*/assets/"\${1##*/}" 2>/dev/null | head -1); [ -n "$f" ] && exec cat "$f"; exit 1 ;;
esac
echo "gh stub: $*" >&2; exit 1
`);
  chmodSync(join(bin, 'gh'), 0o755);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Asset { name: string; body: Buffer; digest?: string | null; state?: string }
interface Release { author?: string; draft?: boolean; prerelease?: boolean; assets: Asset[] }

/** The files owner-programs.yml publishes: the supplement, its manifest and SHA256SUMS over the two. */
const supplement = (fetchedAt = '2026-10-04T03:00:00.000Z'): Map<string, Buffer> => {
  const d = mkdtempSync(join(tmp, 'sup-'));
  writeOwnerPrograms(d, ROWS, { calls: 1, source: 'helius', fetchedAt, datasets: [{ tag: 'data-2026-09-01-2026-10-01', manifestSha256: 'a'.repeat(64) }] });
  const files = new Map([OWNER_PROGRAMS_FILE, OWNER_PROGRAMS_MANIFEST].map((n) => [n, readFileSync(join(d, n))] as const));
  return sums(files);
};
const sums = (files: Map<string, Buffer>, names = [OWNER_PROGRAMS_FILE, OWNER_PROGRAMS_MANIFEST]): Map<string, Buffer> => {
  const out = new Map([...files].filter(([n]) => n !== 'SHA256SUMS'));
  out.set('SHA256SUMS', Buffer.from(names.map((n) => `${sha(files.get(n) ?? '')}  ${n}\n`).join('')));
  return out;
};
const assets = (files: Map<string, Buffer>): Asset[] => [...files].map(([name, body]) => ({ name, body }));

let n = 0;
const publish = (tag: string, r: Release): void => {
  const dir = join(tmp, 'releases', tag);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'assets'), { recursive: true });
  const list = r.assets.map((a) => {
    const id = ++n;
    writeFileSync(join(dir, 'assets', String(id)), a.body);
    return { id, name: a.name, state: a.state ?? 'uploaded', digest: a.digest === undefined ? `sha256:${sha(a.body)}` : a.digest };
  });
  writeFileSync(join(dir, 'meta.json'), JSON.stringify({ tag_name: tag, author: { login: r.author ?? 'github-actions[bot]' }, draft: r.draft ?? false, prerelease: r.prerelease ?? true, assets: list }));
};

const fetchTo = (tag: string, dir: string) =>
  spawnSync('bash', [SCRIPT, tag, dir], { encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', GITHUB_REPOSITORY: 'o/r', GH_BIN: join(bin, 'gh') } });
const out = (label: string) => join(tmp, 'out', label);

const refused = (label: string, r: Release, why: RegExp, tag = TAG) => {
  publish(tag, r);
  const dir = out(label);
  const res = fetchTo(tag, dir);
  expect(res.status, res.stdout).toBe(1);
  expect(res.stderr).toMatch(why);
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(`${dir}.partial`)).toBe(false);
};

describe('fetch-owner-programs.sh', () => {
  test('downloads a release by the workflow, checks it, and readOwnerPrograms reads it', () => {
    publish(TAG, { assets: assets(supplement()) });
    const dir = out('ok');
    const r = fetchTo(TAG, dir);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(`${TAG} (2 owners)`);
    expect(new Map(readOwnerPrograms(dir))).toEqual(new Map(ROWS.map((x) => [x.owner, x.program])));
    // read-only: only REST reads
    for (const l of readFileSync(join(tmp, 'gh-calls'), 'utf8').trim().split('\n')) expect(l).toMatch(/^api (-H Accept: application\/octet-stream )?repos\/o\/r\/releases\/(tags|assets)\//);
  });

  test('refuses a release not made by the workflow, a draft, or one not marked prerelease', () => {
    refused('author', { author: 'someone', assets: assets(supplement()) }, /not a published owner-program release/);
    refused('draft', { draft: true, assets: assets(supplement()) }, /not a published owner-program release/);
    refused('final', { prerelease: false, assets: assets(supplement()) }, /not a published owner-program release/);
  });

  test('refuses missing or extra assets, and assets without a sha256 digest or not fully uploaded', () => {
    const files = supplement();
    refused('missing', { assets: assets(files).filter((a) => a.name !== 'SHA256SUMS') }, /not a published owner-program release/);
    refused('extra', { assets: [...assets(files), { name: 'notes.txt', body: Buffer.from('x') }] }, /not a published owner-program release/);
    refused('nodigest', { assets: assets(files).map((a) => (a.name === OWNER_PROGRAMS_FILE ? { ...a, digest: null } : a)) }, /not a published owner-program release/);
    refused('md5', { assets: assets(files).map((a) => (a.name === OWNER_PROGRAMS_FILE ? { ...a, digest: `md5:${'0'.repeat(32)}` } : a)) }, /not a published owner-program release/);
    refused('starter', { assets: assets(files).map((a) => (a.name === OWNER_PROGRAMS_FILE ? { ...a, state: 'starter' } : a)) }, /not a published owner-program release/);
  });

  test('refuses a file that does not match its asset digest', () => {
    const files = supplement();
    const good = files.get(OWNER_PROGRAMS_FILE)!;
    refused('digest', { assets: assets(files).map((a) => (a.name === OWNER_PROGRAMS_FILE ? { ...a, body: Buffer.concat([good, Buffer.from('x')]), digest: `sha256:${sha(good)}` } : a)) }, /owner-programs\.jsonl does not match its asset digest/);
  });

  test('refuses a file that does not match SHA256SUMS, and SHA256SUMS that lists other files', () => {
    const files = supplement();
    const changed = new Map(files).set(OWNER_PROGRAMS_FILE, Buffer.concat([files.get(OWNER_PROGRAMS_FILE)!, Buffer.from('{"owner":"x","program":null}\n')]));
    refused('sums', { assets: assets(changed) }, /does not match SHA256SUMS/);
    const listed = new Map(files).set('SHA256SUMS', Buffer.concat([files.get('SHA256SUMS')!, Buffer.from(`${sha('x')}  other.json\n`)]));
    refused('list', { assets: assets(listed) }, /SHA256SUMS must list exactly/);
    const short = sums(files, [OWNER_PROGRAMS_FILE]);
    refused('short', { assets: assets(short) }, /SHA256SUMS must list exactly/);
  });

  test("refuses a manifest that does not describe the supplement, or one fetched on another day than the tag's", () => {
    const files = supplement();
    const m = JSON.parse(files.get(OWNER_PROGRAMS_MANIFEST)!.toString()) as Record<string, unknown>;
    const withManifest = (patch: Record<string, unknown>) => assets(sums(new Map(files).set(OWNER_PROGRAMS_MANIFEST, Buffer.from(JSON.stringify({ ...m, ...patch })))));
    refused('rows', { assets: withManifest({ rows: 3 }) }, /manifest does not match/);
    refused('sha', { assets: withManifest({ sha256: 'b'.repeat(64) }) }, /manifest does not match/);
    refused('file', { assets: withManifest({ file: 'other.jsonl' }) }, /manifest does not match/);
    refused('day', { assets: assets(supplement('2026-10-05T00:00:01.000Z')) }, /manifest does not match .*tag's day/);
  });

  test('refuses another tag form, a missing release, and an existing DIR, before downloading anything', () => {
    for (const tag of ['data-2026-09-01-2026-10-01', 'owner-programs-latest', 'owner-programs-2026-10-04;x']) {
      const r = fetchTo(tag, out('tag'));
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/is not an owner-program release/);
    }
    const missing = fetchTo('owner-programs-2020-01-01', out('missing'));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/release owner-programs-2020-01-01 not found/);
    publish(TAG, { assets: assets(supplement()) });
    const dir = out('exists');
    mkdirSync(dir, { recursive: true });
    const r = fetchTo(TAG, dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/already exists/);
  });
});
