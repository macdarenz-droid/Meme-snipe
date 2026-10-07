// RED TEAM C (probe, not product code): the Recorder keeps every coverage gap of the boot in `#gaps` and rewrites the
// whole list into manifest.json at every seal, prune and attach. A long boot with routine gaps (a cut trade log whose
// transaction is not found, every watch disconnect, every shed) grows the heap and the manifest without a bound, and each
// manifest rewrite costs O(gaps) synchronous CPU on the worker's one thread.
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GAPS_FILE, MANIFEST_STREAM_GAPS, Recorder, recordedGaps, sealLeftovers } from '../../src/run/recorder.ts';

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

describe('RC-H3: every gap stays readable', () => {
  const gap = (i: number) => ({ key: 'coverage:rugs:gap', value: { fromSlot: String(300_000_000 + i), toSlot: String(300_000_000 + i), reason: `cut trade log ${i}`, via: 'logs:P' }, receivedAt: 1_780_000_000_000 + i });

  it('200k gaps: the manifest stays small, each rewrite stays fast, and recordedGaps returns all of them in order, with the seal gaps', () => {
    const root = mkdtempSync(join(tmpdir(), 'rtc-rec-'));
    try {
      const r = new Recorder({ root, boot: 'b1', gitSha: 'x', rotateBytes: 1 << 20 });
      for (let i = 0; i < 200_000; i++) {
        r.gap(gap(i));
        if (i % 1000 === 0) r.flush();
      }
      const t0 = performance.now();
      r.attach('probe.json', '0'.repeat(64), 1);
      r.close();
      const ms = performance.now() - t0;
      const m = JSON.parse(readFileSync(join(root, 'b1', 'manifest.json'), 'utf8')) as { coverage_gaps: unknown[]; coverage_gaps_file: unknown };
      const bytes = statSync(join(root, 'b1', 'manifest.json')).size;
      console.log(`after the fix: manifest ${bytes} bytes, two rewrites ${ms.toFixed(0)} ms, gaps file ${statSync(join(root, 'b1', GAPS_FILE)).size} bytes`);
      expect(m.coverage_gaps).toHaveLength(MANIFEST_STREAM_GAPS);
      expect(m.coverage_gaps_file).toEqual({ path: GAPS_FILE, total: 200_000, listed: MANIFEST_STREAM_GAPS });
      const all = recordedGaps(join(root, 'b1'));
      expect(all).toHaveLength(200_000);
      expect(all[0]).toEqual(gap(0));
      expect(all[499]).toEqual(gap(499));
      expect(all[500]).toEqual(gap(500));
      expect(all.at(-1)).toEqual(gap(199_999));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a kill: the next start counts the file\'s whole lines, cuts a torn one, and recordedGaps still returns every gap', () => {
    const root = mkdtempSync(join(tmpdir(), 'rtc-rec-'));
    try {
      const r = new Recorder({ root, boot: 'b1', gitSha: 'x', rotateBytes: 1 << 20 });
      for (let i = 0; i < 700; i++) r.gap(gap(i));
      r.frame({ seq: 1, receivedAt: 1_780_000_000_000, source: 's', place: 'p', duplicate: false, body: { type: 'slot', slot: 5n } } as never);
      r.flush();
      // No close (a kill), and the last append was torn.
      appendFileSync(join(root, 'b1', GAPS_FILE), '{"key":"coverage:rugs:ga');
      expect(sealLeftovers(root, 'b2')).toEqual(['b1']);
      const m = JSON.parse(readFileSync(join(root, 'b1', 'manifest.json'), 'utf8')) as { coverage_gaps_file: unknown; coverage_gaps: { reason?: string }[] };
      expect(m.coverage_gaps_file).toEqual({ path: GAPS_FILE, total: 700, listed: 0 });
      const all = recordedGaps(join(root, 'b1'));
      expect(all.filter((g) => (g as { key?: string }).key === 'coverage:rugs:gap')).toEqual(Array.from({ length: 700 }, (_, i) => gap(i)));
      expect(all.some((g) => /without a clean stop/.test((g as { reason?: string }).reason ?? ''))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
