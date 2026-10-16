// A-M13-01 Phase 0 report, built parts (card Z09): the window rule, the hurdle by size (information only), A-48 and
// the disk projection, reproducibility. Synthetic inputs; the pools are the ARCH Table 2-A shapes priced through the
// real venue maths (test binding in ../m10/pricing.ts).
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import { PRIOR_2026_10 } from '../../src/m10/params.ts';
import { phase0Report, renderPhase0Csv, renderPhase0Markdown, studyWindow, usdMonthlyToLamports, PM01_SLIPPAGE, type Phase0Day, type Phase0Input, type PoolState } from '../../src/m13/phase0.ts';
import type { UniverseManifestFile } from '../../src/m05/manifest.ts';
import { archPool, atMinDepth, flatFees, pricingOf, SOL } from '../m10/pricing.ts';

const R0 = Date.UTC(2026, 9, 20, 7, 0, 0);              // + 30 h = 21 Oct 13:00 → D1 = 22 Oct
const day = (k: number): string => new Date(Date.UTC(2026, 9, 22 + k)).toISOString().slice(0, 10);
const MANIFEST = {} as UniverseManifestFile;
const days = (good: (k: number) => boolean, n = 14): Phase0Day[] => Array.from({ length: n }, (_, k) => ({ dayUtc: day(k), lowCoverage: !good(k), manifest: MANIFEST }));

function pools(nPools: number): PoolState[] {
  const out: PoolState[] = [];
  for (let p = 0; p < nPools; p++) {
    for (let k = 0; k < 7; k++) {
      const q = BigInt(200 + 100 * p + 10 * k);
      const pool = archPool(q, { poolId: `pool-${p}` });
      out.push({ poolId: `pool-${p}`, dayUtc: day(k), minDepthLamports: q * SOL, pricing: pricingOf(atMinDepth(pool), flatFees(p % 2 === 0 ? 30 : 125)) });
    }
  }
  return out;
}
const input = (o: Partial<Phase0Input> = {}): Phase0Input => ({
  r0Ms: R0, days: days(() => true), poolStates: pools(12), solUsdD1: 150, solUsdSource: 'test value (ARCH Table 2-A)', simParams: PRIOR_2026_10,
  streams: [
    { dayUtc: day(0), stream: 'pool_snapshot', codec: 'gzip', compressedBytes: 1_000_000_000, decodedBytes: 8_000_000_000 },
    { dayUtc: day(1), stream: 'pool_snapshot', codec: 'gzip', compressedBytes: 1_200_000_000, decodedBytes: 9_600_000_000 },
    { dayUtc: day(0), stream: 'discovery', codec: 'gzip', compressedBytes: 1_000, decodedBytes: null },
    { dayUtc: day(30), stream: 'discovery', codec: 'gzip', compressedBytes: 9_999_999, decodedBytes: null },
  ],
  ...o,
});

describe('A-M13-01 built parts (SYNTHETIC inputs)', () => {
  it('the report is reproducible byte-for-byte from the same inputs (markdown and CSVs)', () => {
    const a = phase0Report(input()), b = phase0Report(input());
    assert.equal(renderPhase0Markdown(a), renderPhase0Markdown(b));
    assert.deepEqual(renderPhase0Csv(a), renderPhase0Csv(b));
    assert.deepEqual(a.parked, { a24: 'parked', a24b: 'parked', moveRule: 'parked', killCheck: 'not_run_mr01_parked', pm01: 'no_phase0_check' });
    assert.equal(a.hurdle.decides, false);
    assert.ok(renderPhase0Markdown(a).includes('Kill-only check: not run (MR-01 parked, C-76)'));
    // Z09-5 and Z09-6: the price and its source are printed; sizes read in SOL first.
    assert.ok(renderPhase0Markdown(a).includes('SOL/USD of D1: 150 (test value (ARCH Table 2-A))'));
    assert.ok(renderPhase0Markdown(a).includes('| 0.033333333 SOL ($5) |'));
    assert.ok(renderPhase0Markdown(a).includes('| 66.666666667 SOL ($10,000) (subset) |'));
    assert.ok(renderPhase0Markdown(phase0Report(input({ solUsdD1: 100 }))).includes('| 1 SOL ($100) |'));
  });

  it('window: good D1-D5, low D6-D7, good D8-D9 → D1-D9; fewer than 7 good by D14 → insufficient_days', () => {
    const w = studyWindow(R0, days((k) => k < 5 || k > 6));
    assert.equal(w.d1, day(0));
    assert.deepEqual(w.days, Array.from({ length: 9 }, (_, k) => day(k)));
    assert.equal(w.status, 'ok');
    assert.deepEqual(w.lowCoverageDays, [day(5), day(6)]);
    const bad = studyWindow(R0, days((k) => k % 3 === 0));
    assert.equal(bad.status, 'insufficient_days');
    assert.equal(bad.days.length, 14);
    // A day with no manifest counts as not good; R0 exactly at a day start + 30 h starts D1 that day.
    assert.equal(studyWindow(Date.UTC(2026, 9, 20, 18, 0, 0), []).d1, '2026-10-22');
    assert.equal(studyWindow(Date.UTC(2026, 9, 20, 18, 0, 1), []).d1, '2026-10-23');
    assert.equal(phase0Report(input({ days: days((k) => k % 3 === 0) })).caveats.at(-1), 'Fewer than 7 good days by D14: insufficient_days, no decision.');
  });

  it('hurdle per size at $5, $20, $100, $1,000, $10,000: depth cap on min(real, effective), lean-median pool, rows apart, fixed-monthly lines', () => {
    const r = phase0Report(input());
    assert.deepEqual(r.hurdle.bySize.map((h) => h.sizeUsd), [5, 20, 100, 1_000, 10_000]);
    assert.deepEqual(r.hurdle.slippage, PM01_SLIPPAGE);
    const [s5, , , s1000, s10000] = r.hurdle.bySize as [NonNullable<(typeof r.hurdle.bySize)[0]>, unknown, unknown, NonNullable<(typeof r.hurdle.bySize)[0]>, NonNullable<(typeof r.hurdle.bySize)[0]>];
    assert.equal(s5.poolsInSet, 12);
    assert.equal(s5.subset, false);
    // $1,000 = 6,666,666,667 lamports needs 1,333.3 SOL of depth at 0.5%: only the deepest pools (median depth 230 + 100p SOL).
    assert.equal(s1000.poolsInSet, 0);
    assert.equal(s1000.medianPool, null);
    assert.equal(s10000.subset, true);
    assert.ok(s5.gStarBpsLean !== null && s5.gStarBpsStrict !== null && s5.gStarBpsConservative !== null);
    assert.ok(s5.gStarBpsLean <= s5.gStarBpsStrict && s5.gStarBpsStrict <= s5.gStarBpsConservative);
    assert.ok(s5.lean !== null && s5.lean.fixedBps > 0 && s5.lean.venueFeesBps > 0);
    // Fixed term: ceil(M × 10,000 / (30 × t × x)) with M = ceil($10 / $150 × 10^9) = 66,666,667 lamports.
    assert.equal(usdMonthlyToLamports(10, 150), 66_666_667n);
    assert.equal(s5.fixedTermBps.usd10['10'], Math.ceil((66_666_667 * 10_000) / (30 * 10 * 33_333_333)));
    assert.equal(s5.fixedTermBps.usd12['10'], 81);                                  // ceil(80,000,000 × 10,000 / (300 × 33,333,333))
    assert.equal(s5.sensitivityBps, 125);
    const csv = renderPhase0Csv(r).hurdle.split('\n');
    assert.equal(csv.length, 1 + 5 * 3 + 1);
    // No SOL/USD for D1: no hurdle, said in the caveats.
    const none = phase0Report(input({ solUsdD1: null }));
    assert.deepEqual(none.hurdle.bySize, []);
    assert.ok(none.caveats.includes('No recorded SOL/USD for D1: the hurdle by size is not computed.'));
    assert.throws(() => usdMonthlyToLamports(10, 0));
  });

  it('the median-depth state of each pool is the lower-middle min(real, effective) over its good-day snapshots', () => {
    const one = pools(1);
    // Only days 0-3 good: the states at 200, 210, 220, 230 SOL → lower middle 210 SOL; $5 passes and $20 (133 M) needs 26.7 SOL.
    const r = phase0Report(input({ poolStates: one, days: days((k) => k < 4 || k > 6) }));
    assert.equal(r.hurdle.bySize[0]?.poolsInSet, 1);
    assert.equal(r.hurdle.bySize[0]?.medianPool, 'pool-0');
    assert.equal(r.hurdle.bySize[3]?.poolsInSet, 0);
  });

  it('A-48: compressed bytes per stream per day, the ratio where decoded is known, the 30-day projection against 50 GB', () => {
    const r = phase0Report(input());
    assert.deepEqual(r.a48, [
      { stream: 'discovery', codec: 'gzip', bytesPerDayCompressed: 1_000, ratio: null },
      { stream: 'pool_snapshot', codec: 'gzip', bytesPerDayCompressed: 1_100_000_000, ratio: 8 },
    ]);
    assert.equal(r.diskProjection30dBytes, 30 * 1_100_001_000);
    assert.equal(r.diskWithinMinimum, true);
    const big = phase0Report(input({ streams: [{ dayUtc: day(0), stream: 'pool_snapshot', codec: 'zstd', compressedBytes: 2_000_000_000, decodedBytes: 1 }] }));
    assert.equal(big.diskWithinMinimum, false);
    assert.equal(big.a48[0]?.codec, 'zstd');
    assert.deepEqual(r.wB.excludedDays, r.window.days);
  });
});

describe('A-M13-01 branch cases', () => {
  it('ties order by pool and day; an unpriceable pool or bad slippage leaves the set; the above-minimum line renders', () => {
    const twin = (id: string): PoolState[] => [0, 1].map((k) => ({ poolId: id, dayUtc: day(k), minDepthLamports: 1_000n * SOL, pricing: pricingOf(atMinDepth(archPool(1_000n)), flatFees(30)) }));
    const broken: PoolState = { poolId: 'broken', dayUtc: day(0), minDepthLamports: 1_000n * SOL, pricing: { effectiveQuoteLamports: 1n, realQuoteLamports: 1n, quote: () => ({ ok: false, error: { code: 'E_FEE_UNKNOWN' } }) } };
    const r = phase0Report(input({ poolStates: [...twin('b'), ...twin('a'), broken] }));
    assert.equal(r.hurdle.bySize[0]?.poolsInSet, 2);
    assert.equal(r.hurdle.bySize[0]?.medianPool, 'a');
    const bad = phase0Report(input({ poolStates: twin('a'), slippage: { entryBps: -1, exitBps: 0, source: 'test' } }));
    assert.equal(bad.hurdle.bySize[0]?.poolsInSet, 0);
    const streams = ['c', 'a', 'b'].map((s) => ({ dayUtc: day(0), stream: s, codec: 'gzip' as const, compressedBytes: 30_000_000_000, decodedBytes: null }));
    const big = phase0Report(input({ streams }));
    assert.deepEqual(big.a48.map((x) => x.stream), ['a', 'b', 'c']);
    assert.ok(renderPhase0Markdown(big).includes('(above)'));
  });
});

describe('A-M13-01 median-depth order', () => {
  it('states in any depth order give the same lower-middle state', () => {
    const st = (k: number, q: bigint): PoolState => ({ poolId: 'p', dayUtc: day(k), minDepthLamports: q * SOL, pricing: pricingOf(atMinDepth(archPool(q)), flatFees(30)) });
    const a = phase0Report(input({ poolStates: [st(0, 900n), st(1, 300n), st(2, 600n), st(3, 1_200n)] }));
    const b = phase0Report(input({ poolStates: [st(3, 1_200n), st(2, 600n), st(1, 300n), st(0, 900n)] }));
    assert.deepEqual(a.hurdle, b.hurdle);
    // Lower middle of 300, 600, 900, 1,200 SOL is 600 SOL: $20 (133 M lamports) needs 26.7 SOL, $1,000 needs 1,333 SOL.
    assert.deepEqual(a.hurdle.bySize.map((h) => h.poolsInSet), [1, 1, 1, 0, 0]);
  });
});

describe('A-M13-01 weighted median-depth state', () => {
  it('a state counts once per poll it stood for; a bad weight counts once', () => {
    const st = (k: number, q: bigint, weight?: number): PoolState => ({ poolId: 'p', dayUtc: day(k), minDepthLamports: q * SOL, pricing: pricingOf(atMinDepth(archPool(q)), flatFees(30)), ...(weight === undefined ? {} : { weight }) });
    // 300 SOL held for 10 polls, 2,000 SOL for 1 and 3,000 SOL for 1: the median state is 300 SOL, so $100 (666.7 M lamports, 133 SOL) passes, $1,000 does not.
    const a = phase0Report(input({ poolStates: [st(0, 300n, 10), st(1, 2_000n, 1), st(2, 3_000n, 0)] }));
    assert.deepEqual(a.hurdle.bySize.map((h) => h.poolsInSet), [1, 1, 1, 0, 0]);
    const b = phase0Report(input({ poolStates: [st(0, 300n, 1), st(1, 2_000n, 5), st(2, 3_000n, 1.5)] }));
    assert.deepEqual(b.hurdle.bySize.map((h) => h.poolsInSet), [1, 1, 1, 1, 0]);
  });
});
