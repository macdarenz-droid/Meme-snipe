// Volume-hours cross-check (src/dataset/volume.ts): re-derived per hour from kept trade rows, exact match required.
import { describe, expect, it } from 'vitest';
import { WSOL, addTradeRows, compareVolumeHours, isCanonicalWsolPool, volumeFailed } from '../src/dataset/volume.ts';

// Real migration (2026-10-02): mint and the canonical pool its migrate created (scanner canonical_test.go).
const MINT = '8rjKP44zZewzNGx6DyF3Ck1Ub6y45pXbures2Dx3pump';
const POOL = '62jTpYEzdU7a8ayjgedtU7J43fqesgYRfJAi8rX7VgJS';
const OTHER_POOL = 'GVhfB8GTUrFiRE2JX5MZ6rk621kSc6aCXr54kpNYitYz';
const DAY = '2026-09-01';
const T0 = Date.parse(`${DAY}T00:00:00Z`) / 1000;
const hourRows = (lamports: Record<number, string>, covered = '1') =>
  Array.from({ length: 24 }, (_, i) => ({ hour_start_ms: String((T0 + i * 3600) * 1000), lamports: lamports[i] ?? '0', covered }));

describe('volume hours', () => {
  it('recognises the canonical WSOL pool of a real migration and nothing else', () => {
    expect(isCanonicalWsolPool(POOL, MINT)).toBe(true);
    expect(isCanonicalWsolPool(OTHER_POOL, MINT)).toBe(false);
  });

  it('sums SOL-quoted curve trades and canonical WSOL pool trades by block hour, excluding everything else', () => {
    const sums = new Map<number, bigint>();
    const bt = String(T0 + 5 * 3600 + 7);
    addTradeRows(sums, [
      { block_time: bt, quote_mint: '', sol_amount: '100' },
      { block_time: bt, quote_mint: '11111111111111111111111111111111', sol_amount: '20' },
      { block_time: bt, quote_mint: WSOL, sol_amount: '3' },
      { block_time: bt, quote_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', sol_amount: '0', quote_amount: '999' },
    ], [
      { block_time: bt, pool: POOL, base_mint: MINT, quote_mint: WSOL, quote_amount: '1000' },
      { block_time: bt, pool: OTHER_POOL, base_mint: MINT, quote_mint: WSOL, quote_amount: '7000' },
      { block_time: bt, pool: POOL, base_mint: MINT, quote_mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', quote_amount: '5' },
    ]);
    expect([...sums]).toEqual([[T0 + 5 * 3600, 1123n]]);
    const ok = compareVolumeHours(DAY, hourRows({ 5: '1123' }), sums, true);
    expect(volumeFailed(ok)).toBe(false);
    expect(ok).toMatchObject({ hours: 24, hours_covered: 24, hours_matched: 24, lamports_total: '1123' });
  });

  it('fails a differing hour, a missing hour, a bad covered value and an uncovered hour on a complete day', () => {
    const sums = new Map([[T0 + 5 * 3600, 1123n]]);
    const off = compareVolumeHours(DAY, hourRows({ 5: '1122' }), sums, false);
    expect(off.mismatches).toEqual([{ hour_start_ms: String((T0 + 5 * 3600) * 1000), volume_hours: '1122', rederived: '1123' }]);
    expect(volumeFailed(compareVolumeHours(DAY, hourRows({ 5: '1123' }).slice(0, 23), sums, false))).toBe(true);
    const bad = hourRows({ 5: '1123' });
    bad[3] = { ...bad[3]!, covered: 'yes' };
    expect(compareVolumeHours(DAY, bad, sums, false).problems).toEqual(['row 3: covered "yes"']);
    expect(compareVolumeHours(DAY, hourRows({ 5: '1123' }, '0'), sums, true).problems).toHaveLength(24);
    expect(volumeFailed(compareVolumeHours(DAY, hourRows({ 5: '1123' }, '0'), sums, false))).toBe(false);
  });

  it('a system-program curve whose quote_amount differs from sol_amount fails the day (the census counts quote_amount)', () => {
    // scanner_test.go TestCensusSystemProgramQuoteDivergenceReachesVolumeHours: volume_hours then carries 999.
    const sums = new Map<number, bigint>();
    addTradeRows(sums, [{ block_time: String(T0 + 2 * 3600), quote_mint: '11111111111111111111111111111111', sol_amount: '100', quote_amount: '999' }], []);
    const c = compareVolumeHours(DAY, hourRows({ 2: '999' }), sums, true);
    expect(volumeFailed(c)).toBe(true);
    expect(c.mismatches).toEqual([{ hour_start_ms: String((T0 + 2 * 3600) * 1000), volume_hours: '999', rederived: '100' }]);
  });
});
