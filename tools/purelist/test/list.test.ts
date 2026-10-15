// Z01-COV-4 (red team): a pure-file list entry that matches no file must fail the config, naming the entry, so a
// misspelled or moved path cannot silently drop a file from the 100% gate.
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { parsePureList } from '../list.ts';

const root = (): string => {
  const r = mkdtempSync(join(tmpdir(), 'purelist-'));
  mkdirSync(join(r, 'packages/a/src'), { recursive: true });
  writeFileSync(join(r, 'packages/a/src/x.ts'), 'export {};\n');
  return r;
};

describe('parsePureList', () => {
  it('reads paths, comments and an optional floor (default 100)', () => {
    const r = parsePureList('# header\n\npackages/a/src/x.ts  # why\n', root());
    assert.deepEqual(r, [{ path: 'packages/a/src/x.ts', min: 100, reason: 'why' }]);
    const floor = parsePureList('packages/a/src/x.ts  min=97.25  # ratchet\n', root());
    assert.deepEqual(floor, [{ path: 'packages/a/src/x.ts', min: 97.25, reason: 'ratchet' }]);
  });
  it('an entry that matches no file throws and names the entry', () => {
    assert.throws(() => parsePureList('packages/a/src/xx.ts  # misspelled\n', root()), /"packages\/a\/src\/xx\.ts" matches no file/);
    assert.throws(() => parsePureList('packages/a/src  # a directory\n', root()), /"packages\/a\/src" matches no file/);
  });
  it('refuses a line without a reason, a glob, a duplicate and a floor outside 0..100', () => {
    for (const bad of ['packages/a/src/x.ts\n', 'packages/a/src/x.ts  # \n', '  # why\n']) assert.throws(() => parsePureList(bad, root()), /needs "<path>/);
    assert.throws(() => parsePureList('packages/a/src/*.ts  # glob\n', root()), /a path, not a glob/);
    assert.throws(() => parsePureList('packages/a/src/x.ts  # a\npackages/a/src/x.ts  # b\n', root()), /listed twice/);
    for (const min of ['0', '100.5', 'x', '-1']) assert.throws(() => parsePureList(`packages/a/src/x.ts  min=${min}  # r\n`, root()), /floor/);
  });
});
