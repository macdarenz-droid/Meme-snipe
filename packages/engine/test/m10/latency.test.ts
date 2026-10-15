// A-M10-01 logic 5 and acceptance (latency prior), and bug B1 on the latency path: a latency in ms becomes slots only
// through the one slot-to-time function. The B1 test also runs the old fixed 400 ms rule through the same check.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import type { Slot } from '@bot/types';
import { createLatencyModel, slotAfterLatency } from '../../src/m10/latency.ts';
import { createRng } from '../../src/m10/rng.ts';
import { parseSimParamSet, PRIOR_2026_10, simParamSetJson, type LatencySpec } from '../../src/m10/params.ts';
import { createHash } from 'node:crypto';
import { historySlotTimeBasis, liveSlotTimeBasis, slotToTimeMs } from '../../src/m15/slot-time.ts';

const S = (n: number): Slot => BigInt(n) as Slot;
/** An empirical latency spec from a parameter set verified against a 100-record source file (Z06-8). */
function verifiedEmpirical(record: (i: number) => object): LatencySpec {
  const text = Array.from({ length: 100 }, (_, i) => JSON.stringify(record(i))).join('\n');
  const sourceSha256 = createHash('sha256').update(text, 'utf8').digest('hex');
  const set = { ...(JSON.parse(simParamSetJson(PRIOR_2026_10)) as object), latency: { kind: 'empirical', source: 'evidence/latency.ndjson', n: 100, sourceSha256 } };
  const r = parseSimParamSet(set, (f) => { if (f !== 'evidence/latency.ndjson') throw new Error('missing'); return text; });
  assert.ok(r.ok, r.ok ? '' : r.error.problem);
  return r.ok ? r.value.latency : PRIOR_2026_10.latency;
}
const quantile = (sorted: number[], p: number): number => sorted[Math.floor(p * (sorted.length - 1))] as number;

describe('A-M10-01 latency model', () => {
  it('given 100,000 prior samples with seed 7, the median is within 2% of 1,500 ms and the p95 within 3% of 5,000 ms', () => {
    const m = createLatencyModel(PRIOR_2026_10.latency), rng = createRng(7);
    const xs = Array.from({ length: 100_000 }, () => m.sampleMs(rng, 1)).sort((a, b) => a - b);
    const med = quantile(xs, 0.5), p95 = quantile(xs, 0.95);
    assert.ok(Math.abs(med / 1_500 - 1) <= 0.02, String(med));
    assert.ok(Math.abs(p95 / 5_000 - 1) <= 0.03, String(p95));
  });

  it('the multiplier scales every draw (R-4 uses 2) and must be 1-10', () => {
    const m = createLatencyModel(PRIOR_2026_10.latency);
    const a = createRng(3), b = createRng(3);
    for (let i = 0; i < 100; i++) assert.ok(Math.abs(m.sampleMs(a, 2) - 2 * m.sampleMs(b, 1)) < 1e-9);
    for (const bad of [0.5, 0.999, 10.01, Number.NaN]) assert.throws(() => m.sampleMs(createRng(1), bad), /multiplier/);
  });

  it('empirical latency draws uniformly from the samples of a verified set', () => {
    // 100 distinct records whose latencies are 100, 200, 300 and 400 ms, 25 each.
    const m = createLatencyModel(verifiedEmpirical((i) => ({ id: i, latencyMs: 100 * (1 + (i % 4)) })));
    const rng = createRng(5), counts = new Map<number, number>();
    for (let i = 0; i < 40_000; i++) { const v = m.sampleMs(rng, 1); counts.set(v, (counts.get(v) ?? 0) + 1); }
    assert.deepEqual([...counts.keys()].sort((a, b) => a - b), [100, 200, 300, 400]);
    for (const c of counts.values()) assert.ok(Math.abs(c - 10_000) < 400, String(c));
  });

  it('ruling Z06-9: an empirical spec built in code cannot skip the gate (verified source, ≥ 100 samples, all > 0)', () => {
    const sha = 'a'.repeat(64);
    const hundred = Array.from({ length: 100 }, (_, i) => 900 + i);
    assert.throws(() => createLatencyModel({ kind: 'empirical', samplesMs: hundred, source: 'x', n: 100, sourceSha256: sha }), /verified parameter set/);
    assert.throws(() => createLatencyModel({ kind: 'empirical', samplesMs: [0, 5], source: 'x', n: 2, sourceSha256: sha }), /E_SIM_PARAMS/);
    // A verified spec whose samples were edited afterwards is refused too.
    const v = verifiedEmpirical((i) => ({ id: i, latencyMs: 900 + i }));
    assert.doesNotThrow(() => createLatencyModel(v));
    if (v.kind === 'empirical') {
      v.samplesMs.length = 10;
      assert.throws(() => createLatencyModel(v), /at least 100 samples/);
      assert.throws(() => createLatencyModel({ ...v }), /verified parameter set/);
    }
  });

  it('the same seed gives the same draws (reproducible)', () => {
    const m = createLatencyModel(PRIOR_2026_10.latency);
    const a = createRng(11), b = createRng(11);
    assert.deepEqual(Array.from({ length: 50 }, () => m.sampleMs(a, 1)), Array.from({ length: 50 }, () => m.sampleMs(b, 1)));
  });
});

describe('B1 on the latency path: ms become slots at the measured slot time', () => {
  it('a 9,200 ms latency from slot 5,000 lands at slot 5,037 at 250 ms slots (old rule: 5,023)', () => {
    const basis = liveSlotTimeBasis({ slot: S(5_000), atMs: 1_790_000_000_000 }, 250);
    const check = (landing: bigint): void => assert.equal(landing, 5_037n);
    check(slotAfterLatency(S(5_000), 9_200, basis));
    assert.throws(() => check(5_000n + BigInt(Math.ceil(9_200 / 400))));   // the old 400 ms rule
  });

  it('in history the landing slot follows the day-specific anchors (420 ms vs 316 ms slots)', () => {
    const july = historySlotTimeBasis([{ slot: S(0), atMs: 0 }, { slot: S(100), atMs: 42_000 }]);
    const sept = historySlotTimeBasis([{ slot: S(0), atMs: 0 }, { slot: S(100), atMs: 31_600 }]);
    assert.equal(slotAfterLatency(S(10), 1_500, july), S(14));          // 1,500 / 420 = 3.6 slots
    assert.equal(slotAfterLatency(S(10), 1_500, sept), S(15));          // 1,500 / 316 = 4.7 slots
    const s = slotAfterLatency(S(10), 1_500, sept);
    assert.ok(slotToTimeMs(s, sept) - slotToTimeMs(S(10), sept) >= 1_500);
    assert.throws(() => slotAfterLatency(S(1), -1, july), /latency/);
  });
});

describe('ruling Z06-2: a landing is never before the decision slot', () => {
  it('slots sharing one block-time second: slotAfterLatency(104, 0) is not slot 100', () => {
    // The red team's repro: slots 100-105 share 1,000,000 ms, so the first slot at that time is 100.
    const b = historySlotTimeBasis([{ slot: S(100), atMs: 1_000_000 }, { slot: S(105), atMs: 1_000_000 }, { slot: S(200), atMs: 1_040_000 }]);
    const landing = slotAfterLatency(S(104), 0, b);
    assert.ok(landing >= 104n, String(landing));
    assert.equal(landing, S(104));
    assert.equal(slotAfterLatency(S(104), 1, b), S(106));
  });
});
