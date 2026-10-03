import { describe, expect, it } from 'vitest';
import { formatUsd, formatUsdCompact } from '../src/lib/format.ts';

describe('money formatting', () => {
  it('signs amounts with + and a true minus', () => {
    expect(formatUsd(1.5, true)).toBe('+$1.50');
    expect(formatUsd(-1.5, true)).toBe('−$1.50');
    expect(formatUsd(25000)).toBe('$25,000.00');
  });

  it('keeps calendar amounts short at any scale', () => {
    expect(formatUsdCompact(-0.78, true)).toBe('−$0.78');
    expect(formatUsdCompact(-197.31, true)).toBe('−$197');
    expect(formatUsdCompact(1234, true)).toBe('+$1.2K');
    expect(formatUsdCompact(-25000)).toBe('−$25K');
    for (const v of [0.5, 9.996, 42.42, 999.6, 999.99, 1250, 25000, 1_340_000]) expect(formatUsdCompact(-v, true).length).toBeLessThanOrEqual(6);
  });
});
