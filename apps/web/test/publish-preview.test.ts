import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../../.github/scripts/publish-preview.sh', import.meta.url));
const NEW = 'a'.repeat(40);
const OLD = 'b'.repeat(40);

// A stateful gh stand-in. State lives in files: `tag` (missing, junk, or a sha), `release` (exists or not),
// `assets` ("name id" lines). Every call is logged to `calls.log`.
const STUB = `#!/usr/bin/env bash
S="$STUB_DIR"
echo "$*" >> "$S/calls.log"
arg() { for a in "$@"; do case "$a" in $PREFIX*) echo "\${a#$PREFIX}"; return;; esac; done; }
case "$*" in
  "api repos/o/r/git/ref/tags/preview"*)
    t="$(cat "$S/tag")"
    if [ "$t" = missing ]; then echo '{"message":"Not Found","status":"404"}'; exit 1; fi
    if [ "$t" = junk ]; then echo '{"message":"Not Found"}'; exit 0; fi
    echo "$t"; exit 0 ;;
  "api repos/o/r/commits/"*) echo "Latest commit subject"; exit 0 ;;
  "api repos/o/r/compare/"*) echo "- abc1234 a change"; exit 0 ;;
  "api repos/o/r/releases/tags/preview"*) [ -f "$S/release" ] || exit 1; cat "$S/assets"; exit 0 ;;
  "api -X PATCH repos/o/r/git/refs/tags/preview"*) PREFIX="sha=" ; arg "$@" > "$S/tag"; exit 0 ;;
  "api -X POST repos/o/r/git/refs"*) PREFIX="sha="; arg "$@" > "$S/tag"; exit 0 ;;
  "api -X PATCH repos/o/r/releases/assets/"*)
    id="\${4##*/}"; new="\${6#name=}"
    if [ "$FAIL_NEXT_RENAME" = 1 ] && [ "$new" = zeroed-preview.apk ] && [ "$id" != 100 ]; then exit 1; fi
    if grep -q "^$new " "$S/assets"; then exit 1; fi
    sed -i "s/^[^ ]* $id\\$/$new $id/" "$S/assets"; exit 0 ;;
  "api -X DELETE repos/o/r/releases/assets/"*) id="\${4##*/}"; sed -i "/ $id\\$/d" "$S/assets"; exit 0 ;;
  "release view preview --json"*) awk '{print $1" 1000"}' "$S/assets"; exit 0 ;;
  "release view preview"*) [ -f "$S/release" ]; exit $? ;;
  "release upload preview"*)
    [ "$FAIL_UPLOAD" = 1 ] && exit 1
    name="$(basename "$4")"
    grep -q "^$name " "$S/assets" && exit 1
    n="$(cat "$S/counter")"; echo $((n + 1)) > "$S/counter"; echo "$name $n" >> "$S/assets"; exit 0 ;;
  "release create preview"*)
    touch "$S/release"; echo "zeroed-preview.apk 500" >> "$S/assets"
    [ "$(cat "$S/tag")" = missing ] && echo "$GITHUB_SHA" > "$S/tag"
    exit 0 ;;
esac
exit 0
`;

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

interface Scenario {
  tag: 'missing' | 'junk' | typeof OLD;
  release: boolean;
  assets?: string[];
  env?: Record<string, string>;
}

function run(s: Scenario) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-preview-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'gh'), STUB);
  chmodSync(join(dir, 'gh'), 0o755);
  writeFileSync(join(dir, 'zeroed-preview.apk'), 'apk');
  writeFileSync(join(dir, 'tag'), s.tag);
  writeFileSync(join(dir, 'assets'), (s.assets ?? []).map((a) => `${a}\n`).join(''));
  writeFileSync(join(dir, 'counter'), '200');
  writeFileSync(join(dir, 'calls.log'), '');
  if (s.release) writeFileSync(join(dir, 'release'), '');
  const result = spawnSync('bash', [script], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${dir}:${process.env['PATH']}`, STUB_DIR: dir, GH_REPO: 'o/r', GITHUB_SHA: NEW, VERSION_NAME: 'preview-aaaaaaa', ...s.env },
  });
  const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
  return {
    status: result.status,
    stderr: result.stderr,
    calls: read('calls.log').split('\n').filter(Boolean),
    notes: read('notes.md'),
    tag: read('tag').trim(),
    assets: read('assets').split('\n').filter(Boolean),
  };
}

const wrote = (calls: string[], pattern: RegExp) => calls.some((c) => pattern.test(c));

describe('publish-preview.sh', () => {
  it('creates the release with the asset when neither the tag nor the release exists', () => {
    const r = run({ tag: 'missing', release: false });
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.startsWith('release create preview zeroed-preview.apk '))).toBe(true);
    expect(r.tag).toBe(NEW);
    expect(r.assets).toEqual(['zeroed-preview.apk 500']);
  });

  it('swaps an existing asset, then moves the tag and edits the notes', () => {
    const r = run({ tag: OLD, release: true, assets: ['zeroed-preview.apk 100'] });
    expect(r.status).toBe(0);
    expect(r.assets).toEqual(['zeroed-preview.apk 200']);
    expect(r.tag).toBe(NEW);
    expect(wrote(r.calls, /^release edit preview /)).toBe(true);
    expect(wrote(r.calls, /--clobber/)).toBe(false);
    expect(r.notes).toContain('- abc1234 a change');
    // Order: the upload comes before anything is renamed or deleted, and the tag and notes come last.
    const at = (p: RegExp) => r.calls.findIndex((c) => p.test(c));
    expect(at(/^release upload /)).toBeLessThan(at(/-X PATCH repos\/o\/r\/releases\/assets\//));
    expect(at(/-X DELETE /)).toBeLessThan(at(/-X PATCH repos\/o\/r\/git\/refs\/tags\/preview/));
    expect(at(/-X PATCH repos\/o\/r\/git\/refs\/tags\/preview/)).toBeLessThan(at(/^release edit /));
  });

  it('leaves everything untouched when the upload fails', () => {
    const r = run({ tag: OLD, release: true, assets: ['zeroed-preview.apk 100'], env: { FAIL_UPLOAD: '1' } });
    expect(r.status).not.toBe(0);
    expect(r.assets).toEqual(['zeroed-preview.apk 100']);
    expect(r.tag).toBe(OLD);
    expect(wrote(r.calls, /-X DELETE|-X PATCH|-X POST|^release edit/)).toBe(false);
  });

  it('puts the old asset back when the new one cannot take the fixed name', () => {
    const r = run({ tag: OLD, release: true, assets: ['zeroed-preview.apk 100'], env: { FAIL_NEXT_RENAME: '1' } });
    expect(r.status).not.toBe(0);
    expect(r.assets).toContain('zeroed-preview.apk 100');
    expect(r.tag).toBe(OLD);
    expect(wrote(r.calls, /^release edit/)).toBe(false);
    expect(r.stderr).toContain('previous asset was put back');
  });

  it('recovers when an earlier run stopped between the renames', () => {
    const r = run({ tag: OLD, release: true, assets: ['zeroed-preview.apk.prev 100', 'zeroed-preview.apk.next 150'] });
    expect(r.status).toBe(0);
    expect(r.assets).toEqual(['zeroed-preview.apk 200']);
  });

  it('creates the tag when it is missing (the 404 body must not count as a tag)', () => {
    const r = run({ tag: 'missing', release: true, assets: ['zeroed-preview.apk 100'] });
    expect(r.status).toBe(0);
    expect(wrote(r.calls, /^api -X POST repos\/o\/r\/git\/refs -f ref=refs\/tags\/preview/)).toBe(true);
    expect(wrote(r.calls, /-X PATCH repos\/o\/r\/git\/refs/)).toBe(false);
    expect(wrote(r.calls, /\/compare\//)).toBe(false);
    expect(r.tag).toBe(NEW);
  });

  it('ignores a success reply that is not a sha', () => {
    const r = run({ tag: 'junk', release: true, assets: ['zeroed-preview.apk 100'] });
    expect(r.status).toBe(0);
    expect(wrote(r.calls, /-X PATCH repos\/o\/r\/git\/refs/)).toBe(false);
    expect(r.tag).toBe(NEW);
  });

  it('passes bash syntax check', () => {
    expect(() => execFileSync('bash', ['-n', script])).not.toThrow();
  });
});
