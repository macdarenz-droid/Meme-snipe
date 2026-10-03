// TX-1: compute-unit limits come from calibration (p99 × 1.1 of measured units), never a default.
import { describe, expect, test } from 'vitest';
import { MIN_CALIBRATION_SAMPLES, calibrate, calibratedLimit } from '../../src/tx/index.ts';
import { CALIBRATION } from './fixtures-policy.ts';
import { GOLDEN } from './helpers.ts';

describe('calibrated compute-unit limits', () => {
  test('p99 by nearest rank, times 1.1, rounded up', () => {
    const hundred = Array.from({ length: 100 }, (_, i) => (i + 1) * 1_000);
    // ⌈0.99 × 100⌉ = 99th smallest = 99,000; × 1.1 = 108,900.
    expect(calibratedLimit(hundred)).toBe(108_900);
    // Order does not matter; 20 samples: ⌈19.8⌉ = 20th = the maximum.
    const twenty = Array.from({ length: 20 }, (_, i) => 50_001 + ((i * 7) % 20));
    expect(calibratedLimit(twenty)).toBe(Math.ceil((50_020 * 11) / 10));
  });

  test('too few or bad samples, and limits above the runtime cap, are refused', () => {
    expect(() => calibratedLimit(Array(MIN_CALIBRATION_SAMPLES - 1).fill(1_000))).toThrow(/at least/);
    expect(() => calibratedLimit([...Array(25).fill(1_000), 0])).toThrow(/positive/);
    expect(() => calibratedLimit([...Array(25).fill(1_000), 1.5])).toThrow(/positive/);
    expect(() => calibratedLimit(Array(25).fill(1_300_000))).toThrow(/runtime cap/);
  });

  test('the provisional table from 60 real swaps per kind', () => {
    const p99x11 = (kind: string) => {
      const v = GOLDEN.samples.filter((s) => s.kind === kind).map((s) => s.computeUnitsConsumed).sort((a, b) => a - b);
      expect(v.length).toBe(60);
      return Math.ceil((v[Math.ceil(v.length * 0.99) - 1]! * 11) / 10);
    };
    expect(CALIBRATION).toEqual({
      'curve-buy': p99x11('curve-buy'), 'curve-sell': p99x11('curve-sell'), 'curve-sell-close': p99x11('curve-sell'),
      'pool-buy': p99x11('pool-buy'), 'pool-sell': p99x11('pool-sell'), 'pool-sell-close': p99x11('pool-sell'),
    });
    // Each is well below the 200k default, which the fee would otherwise be billed on.
    for (const limit of Object.values(CALIBRATION)) expect(limit).toBeLessThan(200_000);
    expect(calibrate({})).toEqual({});
  });
});
