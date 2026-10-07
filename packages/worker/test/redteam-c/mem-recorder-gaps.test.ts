// RED TEAM C (probe, not product code): the Recorder keeps every coverage gap of the boot in `#gaps` and rewrites the
// whole list into manifest.json at every seal, prune and attach. A long boot with routine gaps (a cut trade log whose
// transaction is not found, every watch disconnect, every shed) grows the heap and the manifest without a bound, and each
// manifest rewrite costs O(gaps) synchronous CPU on the worker's one thread.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Recorder } from '../../src/run/recorder.ts';

describe('RED TEAM C: recorder coverage gaps', () => {
  it('the gap list a long boot keeps stays bounded (manifest under 1 MB after 200k gaps)', () => {
    const root = mkdtempSync(join(tmpdir(), 'rtc-rec-'));
    try {
      const r = new Recorder({ root, boot: 'b1', gitSha: 'x', rotateBytes: 1 << 20 });
      for (let i = 0; i < 200_000; i++) {
        r.gap({ key: 'coverage:rugs:gap', value: { fromSlot: String(300_000_000 + i), toSlot: String(300_000_000 + i), reason: `cut trade log ${'5'.repeat(88)}, transaction not found`, via: `logs:${'P'.repeat(44)}` }, receivedAt: 1_780_000_000_000 + i });
      }
      const t0 = performance.now();
      r.attach('probe.json', '0'.repeat(64), 1);
      const ms = performance.now() - t0;
      const bytes = statSync(join(root, 'b1', 'manifest.json')).size;
      console.log(`manifest ${bytes} bytes, one rewrite ${ms.toFixed(0)} ms`);
      expect(bytes).toBeLessThan(1 << 20);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
