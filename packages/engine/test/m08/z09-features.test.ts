// A-M08-02 features (card Z09): hand-computed vectors, the acceptance cases, sign and determinism properties. The
// one-day bars fixture of the spec (`fx/md/one_day_bars.ndjson.gz`) does not exist yet; the day here is SYNTHETIC.
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';
import fc from 'fast-check';
import type { Lamports, SignedLamports, UnixMs } from '@bot/types';
import { renderSpot, type Bar } from '../../src/m08/bars.ts';
import { checkFeatureConfig, createFeatures, FEATURE_DEFAULTS, lowerMedian, MAD_CONSISTENCY, type FeatureEngine } from '../../src/m08/features.ts';
import { createRng, nextBelow } from '../../src/m10/rng.ts';

const T0 = Date.UTC(2026, 9, 16);
const BAR = 15_000;
const price = (x: number): string => renderSpot(BigInt(Math.round(x * 1e12)) * 10n ** 12n);
const bar = (poolId: string, startMs: number, close: number): Bar => ({
  poolId, startMs: startMs as UnixMs, durationMs: 15_000, open: price(close), high: price(close), low: price(close), close: price(close),
  depthLamportsClose: 0n as Lamports, depthChangeBps: 0, netQuoteFlowLamports: 0n as SignedLamports, snapshots: 15, missing: 0,
});
/** Feeds `n` bars from T0 whose 15 s log returns are `ret(i)` (i = 1..n−1). */
function series(f: FeatureEngine, poolId: string, n: number, ret: (i: number) => number, skip: (i: number) => boolean = () => false): number {
  let lnP = 0;
  for (let i = 0; i < n; i++) {
    if (i > 0) lnP += ret(i);
    if (!skip(i)) f.onBar(bar(poolId, T0 + i * BAR, Math.exp(lnP)), true);
  }
  return T0 + (n - 1) * BAR;
}
/** An alternating ±a series: MAD of the returns is a (median of ±a, lower middle, is −a; deviations 0 and 2a…). */
const alt = (a: number) => (i: number): number => (i % 2 === 0 ? a : -a);
const SIX_H_BARS = 1_440;

describe('A-M08-02 acceptance', () => {
  it('a −5σ 15 s return 10 minutes ago → dump; 31 minutes ago → clear', () => {
    for (const [minsAgo, want] of [[10, 'dump'], [31, 'clear']] as const) {
      const f = createFeatures();
      const rng = createRng(7);
      const noise = (): number => (nextBelow(rng, 2_001) - 1_000) / 1e6;            // ±0.1%
      const n = SIX_H_BARS + 10;
      const k = n - 1 - (minsAgo * 60_000) / BAR;
      series(f, 'p', n, (i) => (i === k ? -0.05 : noise()));
      assert.equal(f.dumpFlagState('p'), want);
      assert.equal(f.dumpFlag('p'), want === 'dump');
    }
  });

  it('40% of the expected returns in the 6 h window → madScale and robustZ are null; 60% → not null', () => {
    for (const [keep, isNull] of [[0.4, true], [0.6, false]] as const) {
      const f = createFeatures();
      // Keep a run of bars at the end so the returns are consecutive pairs: about keep × 1,440 returns.
      const n = SIX_H_BARS + 1;
      const first = Math.ceil(n * (1 - keep));
      series(f, 'p', n, (i) => [0.001, -0.002, 0.003][i % 3] as number, (i) => i < first);
      assert.equal(f.madScale('p', 21_600_000) === null, isNull);
      assert.equal(f.robustZ('p', 60_000) === null, isNull);
    }
  });

  it('2 qualifying pools → basketReturn null; 3 → their mean', () => {
    const f = createFeatures();
    series(f, 'a', 5, () => 0.01);
    series(f, 'b', 5, () => 0.02);
    f.setWatched(['a', 'b']);
    assert.equal(f.basketReturn(60_000), null);
    series(f, 'c', 5, () => 0.03);
    f.setWatched(['a', 'b', 'c', 'tail-not-watched']);
    const b = f.basketReturn(60_000) as number;
    assert.ok(Math.abs(b - 0.08) < 1e-9, `${b}`);                                    // mean of 0.04, 0.08, 0.12
  });
});

describe('A-M08-02 hand-computed vectors', () => {
  it('madScale = MAD / 0.67449; robustZ = L-period log return / (scale × sqrt(L / 15 s)), or × 1 with scaling none', () => {
    for (const scaling of ['sqrt_time', 'none'] as const) {
      const f = createFeatures({ ...FEATURE_DEFAULTS, robustZScaling: scaling });
      series(f, 'p', SIX_H_BARS + 1, alt(0.001));
      // Returns alternate ±0.001: lower-middle median −0.001, deviations {0, 0.002}: lower-middle MAD 0 → null…
      assert.equal(f.madScale('p', 21_600_000), null);
    }
    const f = createFeatures();
    const rets = (i: number): number => [0.001, -0.002, 0.003][i % 3] as number;
    series(f, 'p', SIX_H_BARS + 1, rets);
    // Returns cycle {0.001, −0.002, 0.003} (i % 3 = 1, 2, 0): median 0.001; deviations {0, 0.003, 0.002}: MAD 0.002.
    const scale = f.madScale('p', 21_600_000) as number;
    assert.ok(Math.abs(scale - 0.002 / MAD_CONSISTENCY) < 1e-12);
    const z = f.robustZ('p', 45_000) as number;                                     // 3 bars back: one full cycle = +0.002
    assert.ok(Math.abs(z - 0.002 / (scale * Math.sqrt(3))) < 1e-9, `${z}`);
    const g = createFeatures({ ...FEATURE_DEFAULTS, robustZScaling: 'none' });
    series(g, 'p', SIX_H_BARS + 1, rets);
    assert.ok(Math.abs((g.robustZ('p', 45_000) as number) - 0.002 / scale) < 1e-9);
  });

  it('rollingMedian is the exact lower-middle close; a gap breaks the return chain; invalid windows are null', () => {
    const f = createFeatures();
    [5, 1, 4, 2].forEach((c, i) => f.onBar(bar('p', T0 + i * BAR, c), true));
    assert.equal(f.rollingMedian('p', 60_000), price(2));
    assert.equal(f.rollingMedian('p', 30_000), price(2));                           // closes 4 and 2 → lower middle 2
    assert.equal(f.rollingMedian('q', 60_000), null);
    assert.equal(f.rollingMedian('p', 10_000), null);
    assert.equal(f.robustZ('p', 7_000), null);
    assert.equal(f.madScale('p', 0), null);
    assert.equal(f.basketReturn(1), null);
    // A missing bar between two: the return across it is not used. Bars 0..5 with bar 3 missing give 3 returns, below
    // 70% of the 5 a 75 s window expects; the same bars with bar 3 present give 5.
    const rets = (i: number): number => [0, 0.01, 0.03, 0, 0.5, 0.06][i] as number;
    const gap = createFeatures({ ...FEATURE_DEFAULTS, minCoverageBps: 7_000 });
    series(gap, 'p', 6, rets, (i) => i === 3);
    assert.equal(gap.madScale('p', 75_000), null);
    const full = createFeatures({ ...FEATURE_DEFAULTS, minCoverageBps: 7_000 });
    series(full, 'p', 6, rets);
    assert.notEqual(full.madScale('p', 75_000), null);
  });

  it('incomplete bars are gaps; 60 s bars are ignored; price 0 gives no feature; forget restarts the windows', () => {
    const f = createFeatures();
    f.onBar(bar('p', T0, 1), true);
    f.onBar(bar('p', T0 + BAR, 2), false);
    assert.equal(f.robustZ('p', 15_000), null);
    f.onBar({ ...bar('p', T0 + 2 * BAR, 1), durationMs: 60_000 }, true);
    f.onBar({ ...bar('p', T0 + BAR, 0), close: '0' }, true);
    assert.equal(f.rollingMedian('p', 15_000), null);                               // now = T0 + 15 s: no complete bar there
    f.forget('p');
    assert.equal(f.rollingMedian('p', 60_000), null);
    assert.equal(f.dumpFlagState('p'), 'insufficient');
  });

  it('config checks', () => {
    assert.equal(checkFeatureConfig(FEATURE_DEFAULTS), null);
    for (const c of [{ robustZScaling: 'x' }, { minCoverageBps: 0 }, { basketMinPools: 31 }, { medianWindowMs: 10_000 }, { dumpWindowMs: 21_600_000 }, { medianWindowMs: 21_615_000 }]) {
      assert.notEqual(checkFeatureConfig({ ...FEATURE_DEFAULTS, ...c } as never), null, JSON.stringify(c));
    }
    assert.throws(() => createFeatures({ ...FEATURE_DEFAULTS, basketMinPools: 0 }));
    assert.equal(lowerMedian([3, 1, 2, 4]), 2);
  });
});

describe('A-M08-02 properties', () => {
  it('robustZ has the sign of the L-period return', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100 }), fc.array(fc.integer({ min: -500, max: 500 }), { minLength: 40, maxLength: 40 }), (lBars, steps) => {
      const f = createFeatures({ ...FEATURE_DEFAULTS, minCoverageBps: 1 });
      const n = SIX_H_BARS + 1;
      series(f, 'p', n, (i) => (steps[i % steps.length] as number) / 1e5 + (i % 7) / 1e6);
      const z = f.robustZ('p', lBars * BAR);
      if (z === null) return;
      // The same L-period return, read from the fed closes.
      let ln = 0;
      for (let i = n - lBars; i < n; i++) ln += (steps[i % steps.length] as number) / 1e5 + (i % 7) / 1e6;
      if (Math.abs(ln) > 1e-12) assert.equal(Math.sign(z), Math.sign(ln));
    }), { numRuns: 60 });
  });

  it('determinism: two runs over the same synthetic day are bitwise equal', () => {
    const run = (): number[] => {
      const f = createFeatures();
      const rng = createRng(11);
      for (const p of ['a', 'b', 'c', 'd']) series(f, p, 5_760, () => (nextBelow(rng, 2_001) - 1_000) / 1e5);
      f.setWatched(['d', 'c', 'b', 'a']);
      return ['a', 'b', 'c', 'd'].flatMap((p) => [f.madScale(p, 21_600_000), f.robustZ(p, 300_000), f.dumpFlagState(p) === 'dump' ? 1 : 0]).concat(f.basketReturn(3_600_000)).map((x) => x ?? Number.NaN);
    };
    const a = new Float64Array(run()), b = new Float64Array(run());
    assert.deepEqual(Buffer.from(a.buffer), Buffer.from(b.buffer));
  });
});

describe('A-M08-02 branch cases', () => {
  it('rollingMedian with equal closes', () => {
    const f = createFeatures();
    [3, 3, 3].forEach((c, i) => f.onBar(bar('p', T0 + i * BAR, c), true));
    assert.equal(f.rollingMedian('p', 45_000), price(3));
  });
});
