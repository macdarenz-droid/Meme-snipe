// Z01-COV: the remaining branches of the pure M10 files (SPEC-B Common DoD #8, ARCH 16.1): rng carry, latency refusals,
// and every refusal of the parameter-file reader that the main suite leaves out.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { describe, it } from 'vitest';
import type { Slot } from '@bot/types';
import { createLatencyModel, lognormalParams, slotAfterLatency } from '../../src/m10/latency.ts';
import { isSignatureShape, parseSimParamSet, PRIOR_2026_10, simParamSetJson } from '../../src/m10/params.ts';
import { createRng, nextBelow } from '../../src/m10/rng.ts';
import { liveSlotTimeBasis } from '../../src/m15/slot-time.ts';
import { sig } from './sig.ts';

/** PCG32 on BigInt, written from the reference's definition, to check the carry case the golden list never reaches. */
function reference(seed: bigint, count: number): number[] {
  const M64 = (1n << 64n) - 1n, M32 = (1n << 32n) - 1n, MUL = 6364136223846793005n, INC = 109n;
  let st = INC;                                                  // pcg32_srandom_r: step from 0 leaves inc
  st = (st + seed) & M64;
  const step = (): number => {
    const old = st;
    st = (old * MUL + INC) & M64;
    const xs = (((old >> 18n) ^ old) >> 27n) & M32, rot = old >> 59n;
    return Number(((xs >> rot) | (xs << ((32n - rot) & 31n))) & M32);
  };
  step();
  return Array.from({ length: count }, step);
}

describe('rng: the carry out of the low word', () => {
  it('seed 1923658066 makes the low-word sum cross 2^32 in the second seeding step; the outputs equal the BigInt reference', () => {
    // (109 + seed) × 0x4c957f2d mod 2^32 ≥ 2^32 − 109, so adding the increment carries into the high word.
    const r = createRng(1_923_658_066);
    assert.deepEqual(Array.from({ length: 8 }, () => r.nextU32()), reference(1_923_658_066n, 8));
    assert.deepEqual(Array.from({ length: 4 }, () => createRng(1_923_658_067).nextU32()), Array(4).fill(reference(1_923_658_067n, 1)[0]));
  });
});

describe('latency: remaining refusals', () => {
  it('lognormalParams refuses a median ≤ 0, a p95 not above the median, and a non-finite p95', () => {
    for (const [m, p] of [[0, 5], [-1, 5], [5, 5], [5, 4], [1, Infinity], [Number.NaN, 5]] as const) assert.throws(() => lognormalParams(m, p), /need 0 < median < p95/);
    assert.ok(lognormalParams(1, 2).sigma > 0);
  });
  it('slotAfterLatency refuses a negative or non-finite latency', () => {
    const basis = liveSlotTimeBasis({ slot: 100n as Slot, atMs: 1_000_000 }, 400);
    for (const ms of [-1, Number.NaN, Infinity]) assert.throws(() => slotAfterLatency(100n as Slot, ms, basis), /finite ms >= 0/);
    assert.equal(slotAfterLatency(100n as Slot, 0, basis), 100n);
  });
  it('a lognormal model refuses a multiplier outside 1..10', () => {
    const m = createLatencyModel(PRIOR_2026_10.latency);
    for (const x of [0.5, 11, Number.NaN]) assert.throws(() => m.sampleMs(createRng(1), x), /multiplier/);
  });
});

describe('signature shape: base58 and leading zero bytes', () => {
  it('rejects characters outside the alphabet; 64 leading "1"s are 64 zero bytes', () => {
    assert.equal(isSignatureShape(`0${sig('A', 1).slice(1)}`), false);        // "0" is not base58
    assert.equal(isSignatureShape('1'.repeat(64)), true);
    assert.equal(isSignatureShape(`11${sig('B', 2).slice(2)}`), false);       // wrong decoded length
    assert.equal(isSignatureShape(5), false);
    assert.equal(isSignatureShape('1'.repeat(63)), false);
    assert.equal(isSignatureShape(sig('C', 3)), true);
  });
});

describe('parseSimParamSet: remaining refusals', () => {
  const none = (): string => { throw new Error('no files'); };
  const prior = (): Record<string, unknown> => JSON.parse(simParamSetJson(PRIOR_2026_10)) as Record<string, unknown>;
  const problem = (v: unknown, read: (f: string) => string = none): string => {
    const r = parseSimParamSet(v, read);
    assert.equal(r.ok, false);
    return r.ok ? '' : r.error.problem;
  };
  const withKey = (k: string, v: unknown): Record<string, unknown> => ({ ...prior(), [k]: v });

  it('top-level values of the wrong kind', () => {
    for (const bad of [5, null, [], 'x']) assert.equal(problem(bad), 'not an object');
    assert.match(problem(withKey('createdAtMs', -1)), /createdAtMs must be Unix ms/);
    assert.match(problem(withKey('createdAtMs', 1.5)), /createdAtMs must be Unix ms/);
    assert.match(problem(withKey('provenance', '')), /provenance is required/);
    assert.match(problem(withKey('provenance', 7)), /provenance is required/);
    assert.match(problem(withKey('gapThroughStopP99Bps', -1)), /gapThroughStopP99Bps must be an integer >= 0/);
    assert.match(problem(withKey('gapThroughStopP99Bps', 1.5)), /gapThroughStopP99Bps must be an integer >= 0/);
    assert.match(problem(withKey('gapSamples', -1)), /gapSamples must be an integer >= 0/);
    assert.match(problem(withKey('gapSamples', 'x')), /gapSamples must be an integer >= 0/);
  });
  it('latency of the wrong kind or shape', () => {
    assert.match(problem(withKey('latency', 5)), /latency: not an object/);
    assert.match(problem(withKey('latency', { kind: 'other' })), /kind must be/);
    assert.match(problem(withKey('latency', { kind: 'lognormal_prior', medianMs: 1500, p95Ms: 5000, extra: 1 })), /unknown field/);
    assert.match(problem(withKey('latency', { kind: 'lognormal_prior', medianMs: 1500 })), /missing field p95Ms/);
    assert.match(problem(withKey('latency', { kind: 'empirical', source: '', n: 100, sourceSha256: 'a'.repeat(64) })), /source is required/);
    assert.match(problem(withKey('latency', { kind: 'empirical', source: 5, n: 100, sourceSha256: 'a'.repeat(64) })), /source is required/);
    assert.match(problem(withKey('latency', { kind: 'empirical', source: 'a.ndjson', n: 100 })), /missing field sourceSha256/);
  });
  it('failureClassMix of the wrong kind or value', () => {
    assert.match(problem(withKey('failureClassMix', 5)), /failureClassMix: not an object/);
    assert.match(problem(withKey('failureClassMix', { unknown: 'x' })), /failureClassMix.unknown must be in \[0, 1\]/);
    assert.match(problem(withKey('failureClassMix', { unknown: Infinity })), /must be in \[0, 1\]/);
    assert.match(problem(withKey('failureClassMix', { unknown: -0.5, ...{} })), /must be in \[0, 1\]/);
    assert.match(problem(withKey('failureClassMix', { unknown: 1.5 })), /must be in \[0, 1\]/);
  });
  it('cost and evidence of the wrong kind or shape', () => {
    assert.match(problem(withKey('cost', 5)), /cost: not an object/);
    assert.match(problem(withKey('cost', { ...(prior().cost as object), extra: '1' })), /cost: unknown field/);
    assert.match(problem(withKey('evidence', 5)), /evidence: not an object/);
    assert.match(problem(withKey('evidence', { failure: 5 })), /evidence.failure: not an object/);
    assert.match(problem(withKey('evidence', { failure: { source: 'a', n: 30, sourceSha256: 'a'.repeat(64), more: 1 } })), /evidence.failure: unknown field/);
  });

  /** One evidence file served from memory, for the record-level refusals. */
  const served = (lines: readonly string[]): { read: (f: string) => string; entry: { source: string; n: number; sourceSha256: string } } => {
    const text = `${lines.join('\n')}\n`;
    return { read: () => text, entry: { source: 'evidence/x.ndjson', n: 1, sourceSha256: createHash('sha256').update(text, 'utf8').digest('hex') } };
  };
  const costWith = (rec: Record<string, unknown>): string => {
    const f = served([JSON.stringify({ sig: sig('Z', 1), slot: 1, ...rec })]);
    return problem({ ...prior(), evidence: { cost: { ...f.entry, n: 100 } } }, f.read);
  };
  it('a cost record with a bad field names the field and the kind of value it needs', () => {
    assert.match(costWith({ cuLimit: -1 }), /cost record field cuLimit must be an integer/);
    assert.match(costWith({ cuLimit: '5' }), /cost record field cuLimit must be an integer/);
    assert.match(costWith({ cuLimit: 1.5 }), /cost record field cuLimit must be an integer/);
    assert.match(costWith({ senderTipLamports: 'abc' }), /cost record field senderTipLamports must be a u64 decimal string/);
    assert.match(costWith({ senderTipLamports: 5 }), /cost record field senderTipLamports must be a u64 decimal string/);
    assert.match(costWith({ unknownField: '1' }), /one or more cost fields/);
    assert.match(costWith({}), /one or more cost fields/);
  });
  it('a record with a missing or wrong slot is refused', () => {
    for (const slot of [-1, 1.5, 'x', undefined]) {
      const f = served([JSON.stringify({ sig: sig('Z', 2), slot, gapBps: 1 })]);
      assert.match(problem({ ...prior(), evidence: { gap: { ...f.entry, n: 50 } } }, f.read), /every record needs a slot/);
    }
  });
});

describe('nextBelow: the rejection step', () => {
  it('a bound near 2^32 redraws a value below the threshold, as the reference bounded draw does', () => {
    const n = 3_000_000_000, threshold = (2 ** 32 - n) % n;
    const a = createRng(7), b = createRng(7);
    let rejected = 0;
    for (let i = 0; i < 200; i++) {
      let r = b.nextU32();
      while (r < threshold) { r = b.nextU32(); rejected++; }
      assert.equal(nextBelow(a, n), r % n);
    }
    assert.ok(rejected > 0, 'at least one draw was rejected');
  });
});
