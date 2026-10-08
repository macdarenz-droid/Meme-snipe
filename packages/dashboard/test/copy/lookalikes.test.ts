// The committed look-alike tables are exactly what generate-lookalikes.ts makes from the two pinned Unicode 18.0.0
// files (Z05 round 4, ruling 20).
import { strict as assert } from 'node:assert';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { INPUT_SHA256, LOOKALIKES_FILE, UNICODE_DIR, generateLookalikes, readInputs } from './generate-lookalikes.ts';
import { GENERATED_LOOKALIKE, L_OR_I, SMALL_CAPITALS } from './lookalikes.ts';

describe('look-alike tables (ruling 20)', () => {
  it('lookalikes.ts equals the generator output from the pinned inputs', () => {
    const { confusables, unicodeData } = readInputs();
    assert.equal(readFileSync(LOOKALIKES_FILE, 'utf8'), generateLookalikes(confusables, unicodeData));
  });

  it('the header names both inputs and their sha256', () => {
    const header = readFileSync(LOOKALIKES_FILE, 'utf8').split('\n').slice(0, 5).join('\n');
    for (const [name, sha] of Object.entries(INPUT_SHA256)) {
      assert.ok(header.includes(name), name);
      assert.ok(header.includes(sha), sha);
    }
  });

  it('small capitals come from UnicodeData.txt: U+A730 and U+A7AF have no skeleton, U+A7AE\'s is l', () => {
    assert.equal(SMALL_CAPITALS['\u{A730}'], 'f');
    assert.equal(SMALL_CAPITALS['\u{A7AF}'], 'q');
    assert.equal(GENERATED_LOOKALIKE['\u{A730}'], undefined);
    assert.equal(GENERATED_LOOKALIKE['\u{A7AF}'], undefined);
    assert.equal(GENERATED_LOOKALIKE['\u{A7AE}'], 'l');
    assert.ok(L_OR_I.has('\u{A7AE}'));
    assert.equal(SMALL_CAPITALS['\u{A7AE}'], undefined);
  });

  it('refuses an input whose sha256 differs from the pinned one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lookalikes-'));
    try {
      copyFileSync(join(UNICODE_DIR, 'UnicodeData.txt'), join(dir, 'UnicodeData.txt'));
      writeFileSync(join(dir, 'confusables.txt'), `${readFileSync(join(UNICODE_DIR, 'confusables.txt'), 'utf8')}\n`);
      assert.throws(() => readInputs(dir), /confusables\.txt: sha256/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
