// Benchmark guard for canonicalJson (C01 review finding R7): per-bar feature hashes and bundle hashes run it on the
// 2 GB, 1 vCPU server, so a change that makes it several times slower fails here. The time is a ratio to a plain
// serialiser measured in the same process (interleaved, best of five), so the machine's speed cancels out. Timing
// reads the repository's reviewed wall clock (tools/policy/clock.ts), the only clock module the lint rules allow.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { canonicalJson } from '../../../packages/types/src/canon.ts';
import { wallClockNowMs } from '../../policy/clock.ts';

/** The serialiser before the strictness checks (the baseline): Object.keys, direct reads, eager paths. */
function plain(value: unknown, path = '$'): string {
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  if (typeof value !== 'object' || value === null) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v, i) => plain(v, `${path}[${i}]`)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().filter((k) => record[k] !== undefined).map((k) => `${JSON.stringify(k)}:${plain(record[k], `${path}.${k}`)}`).join(',')}}`;
}

function elapsedMs(run: () => unknown): number {
  const start = wallClockNowMs();
  run();
  return wallClockNowMs() - start;
}

describe('canonicalJson cost (C01 review R7)', () => {
  it('costs at most 2.5 times a plain serialiser on a large array and many small objects', () => {
    const data = {
      ints: Array.from({ length: 200_000 }, (_, i) => i),
      objects: Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `n${i}`, v: i * 1.5, ok: true, tags: ['a', 'b'], big: BigInt(i) })),
    };
    assert.equal(canonicalJson(data), plain(data));
    let best = Number.POSITIVE_INFINITY;
    let bestPlain = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run++) {
      bestPlain = Math.min(bestPlain, elapsedMs(() => plain(data)));
      best = Math.min(best, elapsedMs(() => canonicalJson(data)));
    }
    assert.ok(best <= 2.5 * bestPlain, `canonicalJson ${best} ms vs plain ${bestPlain} ms`);
  });
});
