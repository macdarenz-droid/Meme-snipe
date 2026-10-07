// RC-FIXES-2b (S1 on #271): a long boot's gaps (red team C's case: ~77 MB) never need the whole file in memory. The gaps
// go in chunks of GAPS_CHUNK_BYTES, so a clean stop packs one chunk, and the next start after a kill packs at most the
// chunks left plain. Measured: no chunk on disk passes the bound, and the start's sealing of an 80 MB boot runs in a
// child process under a small heap with its peak RSS growth far below the gaps' size.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { GAPS_CHUNK_BYTES, Recorder, recordedGaps } from '../../src/run/recorder.ts';

const RECORDER = fileURLToPath(new URL('../../src/run/recorder.ts', import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), 'rc-gaps-mem-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const line = (i: number) => ({ key: 'coverage:rugs:gap', value: { fromSlot: String(300_000_000 + i), toSlot: String(300_000_000 + i), reason: `cut trade log ${'5'.repeat(88)}, transaction not found ${i}`, via: `logs:${'P'.repeat(44)}` }, receivedAt: 1_780_000_000_000 + i });
const GAPS = 280_000; // about 80 MB of gap lines

describe('RC-FIXES-2b: gaps memory stays bounded', () => {
  it('an 80 MB boot killed mid-way: no chunk passes the bound, and the next start seals it with a small peak RSS', () => {
    const root = join(tmp, 'kill');
    const r = new Recorder({ root, boot: 'b1', gitSha: 'x', rotateBytes: 1 << 20 });
    for (let i = 0; i < GAPS; i++) {
      r.gap(line(i));
      if (i % 2_000 === 1_999) r.flush();
    }
    r.flush();
    // Killed: no close. Every chunk is within the bound (plus at most one line).
    const dir = join(root, 'b1');
    const sizes = readdirSync(dir).filter((f) => /^gaps-\d{3}\.jsonl$/.test(f)).map((f) => statSync(join(dir, f)).size);
    expect(sizes.length).toBe(1);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(GAPS_CHUNK_BYTES);
    const total = readdirSync(dir).filter((f) => f.startsWith('gaps-')).length;
    expect(total).toBeGreaterThan(15);

    // The next start, in a fresh process with a 32 MB heap: its peak RSS growth while sealing.
    const script = `
      const { sealLeftovers } = await import(${JSON.stringify(RECORDER)});
      globalThis.gc?.();
      const before = process.resourceUsage().maxRSS;
      const fixed = sealLeftovers(${JSON.stringify(root)}, 'b2');
      const after = process.resourceUsage().maxRSS;
      console.log(JSON.stringify({ fixed, grewKiB: after - before }));`;
    const c = spawnSync(process.execPath, ['--max-old-space-size=32', '--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8' });
    expect(c.status, c.stderr).toBe(0);
    const out = JSON.parse(c.stdout.trim().split('\n').at(-1)!) as { fixed: string[]; grewKiB: number };
    console.log(`80 MB of gaps: ${total} chunks; sealing at start grew peak RSS by ${out.grewKiB} KiB`);
    expect(out.fixed).toEqual(['b1']);
    expect(out.grewKiB).toBeLessThan(32 * 1024);
    expect(recordedGaps(dir).filter((g) => (g as { key?: string }).key !== undefined)).toHaveLength(GAPS);
  }, 120_000);
});
