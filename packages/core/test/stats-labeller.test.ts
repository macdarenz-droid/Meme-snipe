import { describe, expect, test } from 'vitest';
import { createRng, labelTripleBarrier, type LabelInput, type ValuePoint } from '../src/stats/index.ts';

const SOL = 1_000_000_000n;
const cost = SOL; // 1 SOL entry, all buy-side costs included
const fee = 3_000_000n; // 0.003 SOL per failed exit attempt

const make = (path: ValuePoint[], over: Partial<LabelInput> = {}): LabelInput => ({
  entry: { filled: true, slot: 100, cost, failedCost: 0n },
  path,
  observedThroughSlot: 1000,
  barrier: { cfgId: 'tp30_sl15_h50', takeProfit: 0.3, stopLoss: 0.15, horizonSlots: 50 },
  exit: { latencySlots: 2, retrySlots: 3, maxAttempts: 4, failProbability: 0, failedAttemptCost: fee },
  rng: createRng(1),
  ...over,
});
const v = (slot: number, sol: number | null): ValuePoint => ({ slot, value: sol === null ? null : BigInt(Math.round(sol * 1e9)) });

describe('triple-barrier labeller', () => {
  test('upper barrier: exits after latency at the executable value then', () => {
    const l = labelTripleBarrier(make([v(101, 1.1), v(105, 1.32), v(106, 1.4), v(107, 1.35), v(120, 2)]));
    expect(l.yTb).toBe(1);
    expect(l.touchSlot).toBe(105);
    expect(l.exitSlot).toBe(107);
    expect(l.rNet).toBeCloseTo(0.35, 12);
    expect(l.mfe).toBeCloseTo(0.4, 12);
    expect(l.mae).toBeCloseTo(0.1, 12);
    expect(l).toMatchObject({ blocked: false, nExitAttempts: 1, yMeta: 1, ySevere: 0, censored: false, entryFilled: true });
  });

  test('lower barrier with gap-through: the fill is worse than the stop', () => {
    const l = labelTripleBarrier(make([v(101, 0.95), v(103, 0.6), v(104, 0.4), v(110, 0.9)]));
    expect(l.yTb).toBe(-1);
    expect(l.touchSlot).toBe(103);
    expect(l.exitSlot).toBe(105);
    expect(l.rNet).toBeCloseTo(-0.6, 12); // as of slot 105 the value is still 0.4
    expect(l.ySevere).toBe(1);
    expect(l.yMeta).toBe(0);
  });

  test('vertical barrier: no touch inside the horizon', () => {
    const l = labelTripleBarrier(make([v(110, 1.1), v(140, 0.9), v(151, 1.05), v(160, 2)]));
    expect(l.yTb).toBe(0);
    expect(l.touchSlot).toBe(150);
    expect(l.exitSlot).toBe(152);
    expect(l.rNet).toBeCloseTo(0.05, 12);
  });

  test('an unobserved window is censored, never scored 0', () => {
    const l = labelTripleBarrier(make([v(110, 1.1)], { observedThroughSlot: 120 }));
    expect(l).toMatchObject({ censored: true, rNet: null, yTb: null, yMeta: null, ySevere: null });
  });

  test('an exit that would land after the observed window is censored', () => {
    const l = labelTripleBarrier(make([v(110, 1.5)], { observedThroughSlot: 111 }));
    expect(l.censored).toBe(true);
    expect(l.rNet).toBeNull();
  });

  test('a blocked exit pays every failed attempt and is severe', () => {
    const l = labelTripleBarrier(make([v(101, 1.0), v(103, null)]));
    expect(l.yTb).toBe(-1); // unsellable counts as executable value 0
    expect(l.blocked).toBe(true);
    expect(l.nExitAttempts).toBe(4);
    expect(l.exitSlot).toBe(103 + 2 + 3 * 3);
    expect(l.rNet).toBeCloseTo(-1 - (4 * 0.003), 12); // value 0 and four failed attempts
    expect(l.ySevere).toBe(1);
    expect(l.mae).toBe(-1);
  });

  test('failed attempts on a sellable pool exhaust the ladder: blocked at the liquidation value', () => {
    const l = labelTripleBarrier(make([v(101, 1.4)], { exit: { latencySlots: 1, retrySlots: 1, maxAttempts: 3, failProbability: 1, failedAttemptCost: fee } }));
    expect(l.blocked).toBe(true);
    expect(l.nExitAttempts).toBe(3);
    expect(l.rNet).toBeCloseTo(0.4 - 3 * 0.003, 12);
    expect(l.ySevere).toBe(1);
  });

  test('random attempt failures are deterministic for a seed and charged', () => {
    const exit = { latencySlots: 1, retrySlots: 2, maxAttempts: 6, failProbability: 0.5, failedAttemptCost: fee };
    const path = [v(101, 1.4), v(130, 1.2)];
    const a = labelTripleBarrier(make(path, { exit, rng: createRng(99) }));
    const b = labelTripleBarrier(make(path, { exit, rng: createRng(99) }));
    expect(a).toEqual(b);
    if (!a.blocked) expect(a.rNet).toBeCloseTo(0.4 - (a.nExitAttempts - 1) * 0.003, 12);
    const attempts = new Set(Array.from({ length: 40 }, (_, s) => labelTripleBarrier(make(path, { exit, rng: createRng(s) })).nExitAttempts));
    expect(attempts.size).toBeGreaterThan(1);
  });

  test('failed entry attempts count against the return', () => {
    const l = labelTripleBarrier(make([v(101, 1.35)], { entry: { filled: true, slot: 100, cost, failedCost: 6_000_000n } }));
    expect(l.rNet).toBeCloseTo(0.35 - 0.006, 12);
    const miss = labelTripleBarrier(make([], { entry: { filled: false, slot: 100, cost, failedCost: 6_000_000n } }));
    expect(miss).toMatchObject({ entryFilled: false, yTb: null, censored: false, nExitAttempts: 0 });
    expect(miss.rNet).toBeCloseTo(-0.006, 15);
  });

  test('invalid input is rejected', () => {
    expect(() => labelTripleBarrier(make([v(100, 1)]))).toThrow(RangeError); // not after the entry
    expect(() => labelTripleBarrier(make([v(105, 1), v(104, 1)]))).toThrow(RangeError);
    expect(() => labelTripleBarrier(make([v(1001, 1)]))).toThrow(RangeError); // after observedThroughSlot
    expect(() => labelTripleBarrier(make([], { barrier: { cfgId: 'x', takeProfit: 0.3, stopLoss: 1.5, horizonSlots: 10 } }))).toThrow(RangeError);
  });
});
