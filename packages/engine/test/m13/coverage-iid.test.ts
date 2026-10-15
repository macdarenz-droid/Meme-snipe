// A-M13-03 property test: over 1,000 seeded repetitions, the stationary bootstrap interval (10,000 resamples, the
// conservative b/2, b, 2b rule) contains the mean of a large-n normal sample at the nominal 95% within ±1 point.
// n = 400 was chosen before the run (at n = 100 a percentile interval under-covers by about 1.5 points, a known
// small-sample effect); repetition k uses seed k for both the data and the bootstrap. Costs about 2-3 CPU-minutes.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { createRng } from '../../src/m10/rng.ts';
import { stationaryBootstrapMeanCi } from '../../src/m13/stats/intervals.ts';

describe('A-M13-03 stationary bootstrap coverage', () => {
  it('1,000 repetitions, n = 400 standard normals: coverage is 95% ± 1 point', { timeout: 900_000 }, () => {
    let hit = 0;
    for (let k = 0; k < 1_000; k++) {
      const rng = createRng(k);
      const x = Array.from({ length: 400 }, () => Math.sqrt(-2 * Math.log(1 - rng.nextFloat())) * Math.cos(2 * Math.PI * rng.nextFloat()));
      const ci = stationaryBootstrapMeanCi(x, { resamples: 10_000, level: 0.95, rng });
      assert.ok(ci !== null);
      if (ci.low <= 0 && 0 <= ci.high) hit++;
    }
    const coverage = hit / 10;
    assert.ok(Math.abs(coverage - 95) <= 1, `coverage ${coverage}%`);
  });
});
