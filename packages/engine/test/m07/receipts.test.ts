// PATHS-FIX ruling 17: the pull account's receipts folder stays bounded; only valid receipts stay.
import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { RECEIPT_CAPS, sweepReceipts } from '../../src/m07/receipts.ts';
import { tempDir } from '../helpers.ts';

const valid = (b: Buffer) => b.toString('utf8').startsWith('{"ok":true');
const receipt = (i: number) => `{"ok":true,"i":${i}}`;

describe('receipts sweep (PATHS-FIX ruling 17)', () => {
  it('keeps valid receipts and deletes everything else: invalid, too large, links, folders; a throwing check is invalid', () => {
    const dir = tempDir('receipts');
    const secret = join(tempDir('outside'), 'bot.db');
    writeFileSync(secret, 'state');
    writeFileSync(join(dir, 'a.json'), receipt(1));
    writeFileSync(join(dir, 'b.json'), receipt(2));
    writeFileSync(join(dir, 'bad.json'), '{"ok":false}');
    writeFileSync(join(dir, 'big.json'), `{"ok":true,"pad":"${'x'.repeat(RECEIPT_CAPS.maxFileBytes)}"}`);
    writeFileSync(join(dir, 'boom.json'), '{"ok":true,"boom":1}');
    symlinkSync(secret, join(dir, 'link.json'));
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'x'), receipt(3));
    const r = sweepReceipts(dir, (b, name) => {
      if (name === 'boom.json') throw new Error('bad signature encoding');
      return valid(b);
    });
    assert.deepEqual(readdirSync(dir).sort(), ['a.json', 'b.json']);
    assert.equal(r.kept, 2);
    assert.equal(r.keptBytes, receipt(1).length + receipt(2).length);
    assert.deepEqual(r.deleted.map((d) => `${d.name}:${d.why}`).sort(),
      ['bad.json:invalid', 'big.json:too_large', 'boom.json:invalid', 'link.json:not_a_file', 'sub:not_a_file']);
    assert.equal(r.overCap, false);
    assert.equal(r.alert, true);
    // A link is removed, never what it points to.
    assert.equal(existsSync(secret), true);
  });

  it('a clean folder raises nothing', () => {
    const dir = tempDir('receipts-clean');
    for (let i = 0; i < 3; i += 1) writeFileSync(join(dir, `${i}.json`), receipt(i));
    const r = sweepReceipts(dir, valid);
    assert.deepEqual({ kept: r.kept, deleted: r.deleted.length, stuck: r.stuck.length, alert: r.alert }, { kept: 3, deleted: 0, stuck: 0, alert: false });
  });

  it('valid receipts over the count or byte cap are kept but alerted on (a valid receipt is never deleted here)', () => {
    const dir = tempDir('receipts-cap');
    for (let i = 0; i < 5; i += 1) writeFileSync(join(dir, `${i}.json`), receipt(i));
    const byCount = sweepReceipts(dir, valid, { ...RECEIPT_CAPS, maxCount: 4 });
    assert.deepEqual({ kept: byCount.kept, overCap: byCount.overCap, alert: byCount.alert }, { kept: 5, overCap: true, alert: true });
    const byBytes = sweepReceipts(dir, valid, { ...RECEIPT_CAPS, maxBytes: 20 });
    assert.equal(byBytes.overCap, true);
    assert.equal(readdirSync(dir).length, 5);
  });

  // Root deletes whatever the folder's mode, so this runs only as a normal user (as in CI).
  it.skipIf(process.getuid?.() === 0)('an entry that cannot be deleted is reported as stuck and alerted on', () => {
    const dir = tempDir('receipts-stuck');
    writeFileSync(join(dir, 'bad.json'), 'nope');
    chmodSync(dir, 0o555);
    try {
      const r = sweepReceipts(dir, valid);
      assert.deepEqual(r.stuck.map((s) => s.name), ['bad.json']);
      assert.equal(r.alert, true);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});
