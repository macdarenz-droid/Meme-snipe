import { describe, expect, test } from 'vitest';
import { createRng, labelTripleBarrier, type LabelInput, type ValuePoint } from '../src/stats/index.ts';

const SOL = 1_000_000_000n;
const cost = SOL; // 1 SOL entry, all buy-side costs included
const fee = 3_000_000n; // 0.003 SOL per failed exit attempt

const make = (path: ValuePoint[], over: Partial<LabelInput> = {}): LabelInput => ({
  entry: { filled: true, slot: 100, cost, failedCost: 0n },
  path,
  observedThroughSlot: 1000,
  barrier: { cfgId: 'tp30_sl15_h50', takeProfitBps: 3000, stopLossBps: 1500, horizonSlots: 50 },
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

  test('exact barrier hits touch; one lamport short does not (bigint, no float rounding)', () => {
    // Every (cost, bps) pair whose barrier value is a whole number of lamports, plus the review's case.
    const costs = [700n, 10_000n, 20_000n, 70_000n, 1_230_000n, 999_990_000n, 1_000_000_000n];
    const bpsList = [1, 7, 15, 150, 1500, 2500, 3000, 4999, 7000, 10_000, 25_000];
    let cases = 0;
    let floatMisses = 0;
    for (const c of costs) {
      for (const bps of bpsList) {
        for (const side of ['up', 'down'] as const) {
          if (side === 'down' && bps > 10_000) continue;
          const num = c * (10_000n + (side === 'up' ? BigInt(bps) : -BigInt(bps)));
          if (num % 10_000n !== 0n) continue;
          const exact = num / 10_000n;
          const barrier = side === 'up'
            ? { cfgId: 'b', takeProfitBps: bps, stopLossBps: 10_000, horizonSlots: 50 }
            : { cfgId: 'b', takeProfitBps: 1_000_000, stopLossBps: bps, horizonSlots: 50 };
          const entry = { filled: true, slot: 100, cost: c, failedCost: 0n };
          const hit = labelTripleBarrier(make([{ slot: 101, value: exact }], { entry, barrier }));
          expect(hit.yTb, `${side} cost ${c} bps ${bps}`).toBe(side === 'up' ? 1 : -1);
          const nearValue = side === 'up' ? exact - 1n : exact + 1n;
          if (side === 'down' && exact === 0n) continue;
          const near = labelTripleBarrier(make([{ slot: 101, value: nearValue }], { entry, barrier }));
          expect(near.yTb, `${side} cost ${c} bps ${bps} one lamport short`).toBe(0);
          // What a float ratio would have said for the exact hit.
          const r = Number(exact) / Number(c) - 1;
          if (side === 'up' ? !(r >= bps / 10_000) : !(r <= -bps / 10_000)) floatMisses++;
          cases++;
        }
      }
    }
    expect(cases).toBeGreaterThanOrEqual(52);
    expect(floatMisses).toBeGreaterThan(0); // the float comparison this replaces got some of these wrong
    // The review's example: cost 700, value 805, +15% → 805/700 − 1 = 0.1499999999999999 in floats.
    expect(labelTripleBarrier(make([{ slot: 101, value: 805n }], { entry: { filled: true, slot: 100, cost: 700n, failedCost: 0n }, barrier: { cfgId: 'r', takeProfitBps: 1500, stopLossBps: 1500, horizonSlots: 50 } })).yTb).toBe(1);
  });

  test('an exit before any recorded value is censored, not unsellable', () => {
    const l = labelTripleBarrier(make([v(160, 1.0)], { barrier: { cfgId: 'v', takeProfitBps: 3000, stopLossBps: 1500, horizonSlots: 20 } }));
    // Vertical barrier at 120 with no point yet: exit at 122 has no known value.
    expect(l).toMatchObject({ censored: true, rNet: null, blocked: false });
  });

  test('invalid input is rejected', () => {
    expect(() => labelTripleBarrier(make([], { barrier: { cfgId: 'x', takeProfitBps: 0.5, stopLossBps: 1500, horizonSlots: 10 } }))).toThrow(RangeError);
    expect(() => labelTripleBarrier(make([v(100, 1)]))).toThrow(RangeError); // not after the entry
    expect(() => labelTripleBarrier(make([v(105, 1), v(104, 1)]))).toThrow(RangeError);
    expect(() => labelTripleBarrier(make([v(1001, 1)]))).toThrow(RangeError); // after observedThroughSlot
    expect(() => labelTripleBarrier(make([], { barrier: { cfgId: 'x', takeProfitBps: 3000, stopLossBps: 15000, horizonSlots: 10 } }))).toThrow(RangeError);
  });
});
