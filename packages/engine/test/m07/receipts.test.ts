// PATHS-FIX rulings 17, 19 and 20: the pull account's receipts folder stays bounded; only one valid receipt per segment,
// under its bound name, stays; nothing is ever deleted outside the folder.
import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'vitest';
import { RECEIPT_CAPS, receiptFileName, sweepReceipts } from '../../src/m07/receipts.ts';
import { tempDir } from '../helpers.ts';

/** The test's stand-in for the signed-receipt check: `{"ok":true,"segment":…}` is valid for that segment. */
const segmentOf = (b: Buffer): string | null => {
  const j = JSON.parse(b.toString('utf8')) as { ok?: boolean; segment?: string };
  return j.ok === true && typeof j.segment === 'string' ? j.segment : null;
};
const receipt = (segment: string) => JSON.stringify({ ok: true, segment });
const put = (dir: string, segment: string, name = receiptFileName(segment)) => writeFileSync(join(dir, name), receipt(segment));

describe('receipts sweep (PATHS-FIX rulings 17, 19, 20)', () => {
  it('keeps one valid receipt per segment under its bound name; deletes invalid, too large, links, empty folders, misnamed and duplicates', () => {
    const dir = tempDir('receipts');
    const outside = tempDir('outside');
    writeFileSync(join(outside, 'bot.db'), 'state');
    put(dir, '2026-10-08/14/trades.ndjson.zst');
    put(dir, '2026-10-08/14/pools.ndjson.zst');
    put(dir, '2026-10-08/14/trades.ndjson.zst', 'copy-of-trades.json');
    writeFileSync(join(dir, 'bad.json'), '{"ok":false}');
    writeFileSync(join(dir, 'big.json'), `{"ok":true,"segment":"x","pad":"${'x'.repeat(RECEIPT_CAPS.maxFileBytes)}"}`);
    writeFileSync(join(dir, 'garbage.json'), 'not json');
    symlinkSync(join(outside, 'bot.db'), join(dir, 'link.json'));
    mkdirSync(join(dir, 'empty'));
    const r = sweepReceipts(dir, segmentOf);
    assert.deepEqual(readdirSync(dir).sort(), [receiptFileName('2026-10-08/14/pools.ndjson.zst'), receiptFileName('2026-10-08/14/trades.ndjson.zst')].sort());
    assert.equal(r.kept, 2);
    assert.deepEqual(r.deleted.map((d) => `${d.name}:${d.why}`).sort(),
      ['bad.json:invalid', 'big.json:too_large', 'copy-of-trades.json:misnamed', 'empty:not_a_file', 'garbage.json:invalid', 'link.json:not_a_file']);
    assert.equal(r.alert, true);
    // A link is removed, never what it points to.
    assert.equal(existsSync(join(outside, 'bot.db')), true);
  });

  it('never recurses: a folder with something in it is left and reported as stuck (ruling 19)', () => {
    const dir = tempDir('receipts-norecurse');
    mkdirSync(join(dir, 'sub'));
    put(join(dir, 'sub'), 'a/b.zst');
    const r = sweepReceipts(dir, segmentOf);
    assert.deepEqual(r.stuck.map((s) => `${s.name}:${s.why}`), ['sub:not_a_file']);
    assert.equal(existsSync(join(dir, 'sub', receiptFileName('a/b.zst'))), true);
    assert.equal(r.alert, true);
  });

  it('an entry swapped between the check and the delete never deletes anything outside receipts/ (ruling 19)', () => {
    const dir = tempDir('receipts-race');
    const state = tempDir('state');
    writeFileSync(join(state, 'bot.db'), 'ledger');
    mkdirSync(join(state, 'log'));
    writeFileSync(join(state, 'log', 'day.jsonl'), 'log');
    writeFileSync(join(dir, 'to-state-dir'), 'x');
    writeFileSync(join(dir, 'to-state-file'), 'x');
    writeFileSync(join(dir, 'to-full-dir'), 'x');
    // The pull account swaps each entry after the sweep read it and before it deletes it.
    const swap: Record<string, () => void> = {
      'to-state-dir': () => symlinkSync(join(state, 'log'), join(dir, 'to-state-dir')),
      'to-state-file': () => symlinkSync(join(state, 'bot.db'), join(dir, 'to-state-file')),
      'to-full-dir': () => { mkdirSync(join(dir, 'to-full-dir')); writeFileSync(join(dir, 'to-full-dir', 'keep'), 'k'); },
    };
    let n = 0;
    const r = sweepReceipts(dir, () => {
      const name = Object.keys(swap).sort()[n++]!;
      unlinkSync(join(dir, name));
      swap[name]!();
      return null;
    });
    assert.equal(n, 3);
    // Links are removed as links; the folder with something in it is left and reported.
    assert.deepEqual(r.deleted.map((d) => d.name).sort(), ['to-state-dir', 'to-state-file']);
    assert.deepEqual(r.stuck.map((s) => s.name), ['to-full-dir']);
    assert.equal(r.alert, true);
    assert.equal(existsSync(join(state, 'bot.db')), true);
    assert.equal(existsSync(join(state, 'log', 'day.jsonl')), true);
    assert.equal(existsSync(join(dir, 'to-full-dir', 'keep')), true);
  });

  it('a clean folder raises nothing', () => {
    const dir = tempDir('receipts-clean');
    for (let i = 0; i < 3; i += 1) put(dir, `s/${i}.zst`);
    const r = sweepReceipts(dir, segmentOf);
    assert.deepEqual({ kept: r.kept, deleted: r.deleted.length, stuck: r.stuck.length, alert: r.alert }, { kept: 3, deleted: 0, stuck: 0, alert: false });
  });

  it('valid receipts over the count or byte cap are kept but alerted on (a valid receipt is never deleted here)', () => {
    const dir = tempDir('receipts-cap');
    for (let i = 0; i < 5; i += 1) put(dir, `s/${i}.zst`);
    const byCount = sweepReceipts(dir, segmentOf, { ...RECEIPT_CAPS, maxCount: 4 });
    assert.deepEqual({ kept: byCount.kept, overCap: byCount.overCap, alert: byCount.alert }, { kept: 5, overCap: true, alert: true });
    const byBytes = sweepReceipts(dir, segmentOf, { ...RECEIPT_CAPS, maxBytes: 20 });
    assert.equal(byBytes.overCap, true);
    assert.equal(readdirSync(dir).length, 5);
  });

  // Root deletes whatever the folder's mode, so this runs only as a normal user (as in CI).
  it.skipIf(process.getuid?.() === 0)('an entry that cannot be deleted is reported as stuck and alerted on', () => {
    const dir = tempDir('receipts-stuck');
    writeFileSync(join(dir, 'bad.json'), 'nope');
    chmodSync(dir, 0o555);
    try {
      const r = sweepReceipts(dir, segmentOf);
      assert.deepEqual(r.stuck.map((s) => s.name), ['bad.json']);
      assert.equal(r.alert, true);
    } finally {
      chmodSync(dir, 0o755);
    }
  });
});
