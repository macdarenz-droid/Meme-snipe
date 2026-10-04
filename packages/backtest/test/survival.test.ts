import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import type { AmmSwapRow, DatasetRow } from '../src/dataset/rows.ts';
import { collectCandidates, PLAN_DRIVE, solUsdAsOf } from '../src/research/candidates.ts';
import { PLAN_BARRIERS, scoreCandidates } from '../src/research/outcome.ts';
import { HoldoutWallError, type PracticeWindow } from '../src/research/practice.ts';
import { collectSurvival, SURVIVAL_FEATURES, type SurvivalFeature } from '../src/research/survival.ts';
import { dayBootstrap, featureTests, type LabelledDecision, mhRiskDifference, splitDays, tradeMeasures, wilson } from '../src/research/survival-analysis.ts';
import { freezeRule, passesFeatures, passesSurvival } from '../src/research/survival-compare.ts';
import { LabelTimeError, SURVIVAL_RULE, survivalLabel } from '../src/research/survival-label.ts';
import { labelDecisions } from '../src/research/survival-outcome.ts';
import type { Features } from '../src/research/tracker.ts';
import { S_T0, SURV_SOL_USD, survivalRows } from './survival-fixture.ts';
import { SOL_USD, syntheticRows, T0 } from './synthetic.ts';

const SRC = join(import.meta.dirname, '..', 'src', 'research');
const W: PracticeWindow = { decisionFrom: '2026-09-01', decisionTo: '2026-10-01', holdoutFrom: '2026-09-23', embargoDays: 1, confirmedBy: 'test' };
const H = 3_600_000;
const fx = survivalRows([
  { name: 'A', creator: 'X', fate: 'survive', createdAtH: 0 },
  { name: 'B', creator: 'Y', fate: 'die', createdAtH: 0.1 },
  { name: 'C', creator: 'Z', fate: 'rug', createdAtH: 0.2 },
  { name: 'D', creator: 'X', fate: 'survive', createdAtH: 26 },
], 52);
const opts = { window: W, policy: TRIAL_POLICY, solUsd: solUsdAsOf(SURV_SOL_USD, 3 * H) };
const drive = collectSurvival(fx.rows, opts);
const targets = drive.decisions.map(({ id, pool, labelAtMs }) => ({ id, pool, labelAtMs }));
const labels = new Map(labelDecisions(fx.rows, targets, W).map((x) => [x.id, x.label]));
const of = (name: string, ageMin: number) => drive.decisions.find((d) => d.mint === fx.mints[name]!.mint && d.ageMs === ageMin * 60_000)!;

describe('label rule', () => {
  const base = { labelAtMs: 10 * H, nowMs: 10 * H, migrationPrice: 1, priceAtT: 0.6, quoteVaultAtT: 40_000_000_000n, lastSwapMs: 10 * H - 60_000 };
  test('liquidity, price and activity must all hold; rug is price at or below a tenth', () => {
    expect(survivalLabel(base)).toEqual({ survived: true, rug: false });
    expect(survivalLabel({ ...base, quoteVaultAtT: SURVIVAL_RULE.minQuoteLamports - 1n })!.survived).toBe(false);
    expect(survivalLabel({ ...base, priceAtT: 0.49 })!.survived).toBe(false);
    expect(survivalLabel({ ...base, lastSwapMs: 10 * H - H })!.survived).toBe(false);
    expect(survivalLabel({ ...base, priceAtT: 0.1 })).toEqual({ survived: false, rug: true });
    expect(survivalLabel({ ...base, migrationPrice: null })).toBeNull();
  });
  test('a label time after now is refused', () => {
    expect(() => survivalLabel({ ...base, nowMs: 10 * H - 1 })).toThrow(LabelTimeError);
  });
  test('the label is read 24 h after migration, or 48 h for the 24 h decision', () => {
    expect(SURVIVAL_RULE.horizonMs(60 * 60_000)).toBe(24 * H);
    expect(SURVIVAL_RULE.horizonMs(24 * H)).toBe(48 * H);
    for (const d of drive.decisions) expect(d.labelAtMs - d.decisionMs).toBeGreaterThanOrEqual(20 * H - 1000);
  });
});

describe('feature stage', () => {
  test('three decisions per graduate, 15 features each, strata from cap and quote at the decision', () => {
    expect(drive.decisions.length).toBe(12);
    for (const d of drive.decisions) {
      expect(Object.keys(d.features).sort()).toEqual([...SURVIVAL_FEATURES].sort());
      expect(d.stratum.startsWith(`${d.ageMs / 60_000}m|`)).toBe(true);
    }
    expect(SURVIVAL_FEATURES.length).toBeLessThanOrEqual(15);
  });

  test('creator history and the market rate use only labels that matured before the decision, never the graduate itself', () => {
    // A (creator X) survives; its label matures at its migration + 24 h. D (same creator) graduates 26 h later.
    expect(of('A', 60).features.s_creator_surv).toBeNull();
    expect(of('D', 60).features.s_creator_surv).toBe(1);
    expect(of('A', 60).features.s_market_surv).toBeNull();
    // At A's own 24 h decision only A's label has matured, and it is left out; B and C mature minutes later.
    expect(of('A', 1440).features.s_market_surv).toBeNull();
    // At D's 60 min decision, A (survived), B and C (dead) have matured: one in three.
    expect(of('D', 60).features.s_market_surv).toBeCloseTo(1 / 3, 12);
  });

  test('a planted future swap changes no feature of an earlier decision', () => {
    const cut = of('A', 240);
    const i = fx.rows.findIndex((r) => r.slot > cut.decisionSlot);
    const planted = fx.rows.map((r, k): DatasetRow => (k > i && r.kind === 'amm' && r.side === 'buy' ? { ...r, amount: r.amount * 40n } as AmmSwapRow : r));
    const other = collectSurvival(planted, opts);
    const early = (ds: typeof drive.decisions) => ds.filter((d) => d.decisionSlot <= cut.decisionSlot).map((d) => [d.id, d.features, d.stratum]);
    expect(early(other.decisions)).toEqual(early(drive.decisions));
    const late = (ds: typeof drive.decisions) => ds.filter((d) => d.decisionSlot > cut.decisionSlot).map((d) => d.features);
    expect(late(other.decisions)).not.toEqual(late(drive.decisions));
  });

  test('the feature stage never imports an outcome stage', () => {
    for (const f of ['survival.ts', 'survival-analysis.ts', 'survival-compare.ts']) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src, f).not.toMatch(/from '\.\/survival-outcome\.ts'/);
      expect(src, f).not.toMatch(/from '\.\/outcome\.ts'/);
    }
  });
});

describe('outcome stage', () => {
  test('labels match each graduate\'s fate; a label past the data is censored', () => {
    for (const age of [60, 240, 1440]) {
      expect(labels.get(of('A', age).id)).toEqual({ survived: true, rug: false });
      expect(labels.get(of('B', age).id)!.survived).toBe(false);
      expect(labels.get(of('C', age).id)).toEqual({ survived: false, rug: true });
    }
    // D's 24 h decision is labelled at its migration + 48 h, past the 52 h of data.
    expect(labels.get(of('D', 1440).id)).toBeNull();
  });

  test('both stages stop at a row on or after the holdout wall', () => {
    const wall: PracticeWindow = { ...W, holdoutFrom: '2026-09-12' };
    expect(() => collectSurvival(fx.rows, { ...opts, window: wall })).toThrow(HoldoutWallError);
    expect(() => labelDecisions(fx.rows, targets, wall)).toThrow(HoldoutWallError);
  });

  test('a decision whose label would fall at or after the wall is skipped and counted', () => {
    // Wall at the start of Melbourne 11 Sep = 10 Sep 14:00 UTC; rows after it are cut, like a real loader.
    const wall: PracticeWindow = { ...W, holdoutFrom: '2026-09-12' };
    const cut = fx.rows.filter((r) => r.blockTime * 1000 < Date.parse('2026-09-10T14:00:00Z'));
    const d = collectSurvival(cut, { ...opts, window: wall });
    expect(d.decisions).toEqual([]);
    expect(d.labelPastWall).toBeGreaterThan(0);
  });
});

describe('RENT-1 in the outcome stage', () => {
  test('RENT-1 (#114) in the outcome stage the comparison uses: rent back on a landed close, one failed exit on a failed close, nothing with dust', () => {
    // Research's 0.4-s-slot market with no swap after 50 min: every trade round-trips on a still pool.
    const still = syntheticRows({ mints: 1, slots: 2.5 * 3600 * 6 }).filter((r) => r.kind !== 'amm' || r.blockTime * 1000 < T0 + 50 * 60_000);
    const win: PracticeWindow = { decisionFrom: '2026-09-19', decisionTo: '2026-10-01', holdoutFrom: '2026-09-25', embargoDays: 1, confirmedBy: 'test' };
    const c = collectCandidates(still, { window: win, policy: TRIAL_POLICY, solUsd: solUsdAsOf(SOL_USD, 3 * H), ...PLAN_DRIVE }).candidates[0]!;
    const t = [{ id: c.id, pool: c.pool, decisionSlot: c.decisionSlot, decisionMs: c.decisionMs, solUsd: c.solUsd }];
    const sc = FILL_CONFIG.scenarios.conservative;
    const fills = (closeSuccessPpm: bigint, dustPpm: bigint) => ({ ...FILL_CONFIG, scenarios: { ...FILL_CONFIG.scenarios, conservative: { ...sc, closeSuccessPpm, dustPpm } } });
    const run = (f: typeof FILL_CONFIG) => scoreCandidates(still, t, { window: win, policy: TRIAL_POLICY, fills: f, scenario: 'conservative', barriers: PLAN_BARRIERS.slice(1, 2), seed: 'land', entryMinOutBelowBps: RESEARCH_CONFIG.s0.entryMinOutBelowBps })[0]!;
    const dust = run(fills(1_000_000n, 1_000_000n));
    expect(dust.labels[0]!.entryFilled).toBe(true);
    expect(dust.labels[0]!.censored).toBe(false);
    const cost = Number(dust.entryCost);
    const failedExit = Number(FILL_CONFIG.network.signaturesPerTx * FILL_CONFIG.network.baseFeePerSignature + TRIAL_POLICY.exits.ladder.steps[2]!.priorityFeeLamports);
    expect(run(fills(1_000_000n, 0n)).labels[0]!.rNet! - dust.labels[0]!.rNet!).toBeCloseTo(Number(FILL_CONFIG.network.tokenAccountRent) / cost, 9);
    expect(run(fills(0n, 0n)).labels[0]!.rNet! - dust.labels[0]!.rNet!).toBeCloseTo(-failedExit / cost, 9);
  });
});

// ---------- analysis ----------

const mk = (day: string, stratum: string, f: number, survived: boolean, i: number): LabelledDecision => ({
  id: `${day}:${stratum}:${i}`, day, ageMs: 60 * 60_000, stratum,
  features: Object.fromEntries(SURVIVAL_FEATURES.map((k) => [k, k === 's_net60' ? f : 0])) as Record<SurvivalFeature, number>, survived,
});

describe('matched strata', () => {
  test('Simpson: a feature that looks good overall but does nothing within look-alike strata gets a matched difference of 0', () => {
    // Stratum big: 90% survive, feature mostly high. Stratum small: 10% survive, feature mostly low. Within each, no effect.
    const xs: LabelledDecision[] = [];
    let i = 0;
    for (let k = 0; k < 100; k++) xs.push(mk('2026-09-01', 'big', k < 80 ? 1 : 0, k % 10 !== 0, i++));
    for (let k = 0; k < 100; k++) xs.push(mk('2026-09-01', 'small', k < 20 ? 1 : 0, k % 10 === 0, i++));
    const hi = xs.filter((x) => x.features.s_net60! > 0.5);
    const lo = xs.filter((x) => x.features.s_net60! <= 0.5);
    const crude = hi.filter((x) => x.survived).length / hi.length - lo.filter((x) => x.survived).length / lo.length;
    expect(crude).toBeGreaterThan(0.4);
    expect(mhRiskDifference(xs, 's_net60', 0.5)).toBeCloseTo(0, 12);
  });

  test('Mantel–Haenszel weights: n_hi·n_lo / n per stratum, hand-computed', () => {
    // Stratum a: 10 high (all survive), 90 low (half survive) → diff 0.5, weight 10·90/100 = 9.
    // Stratum b: 50 high, 50 low, both 20% → diff 0, weight 25. MH = 9·0.5 / 34.
    const xs: LabelledDecision[] = [];
    let i = 0;
    for (let k = 0; k < 10; k++) xs.push(mk('d', 'a', 1, true, i++));
    for (let k = 0; k < 90; k++) xs.push(mk('d', 'a', 0, k % 2 === 0, i++));
    for (let k = 0; k < 50; k++) xs.push(mk('d', 'b', 1, k % 5 === 0, i++));
    for (let k = 0; k < 50; k++) xs.push(mk('d', 'b', 0, k % 5 === 0, i++));
    expect(mhRiskDifference(xs, 's_net60', 0.5)).toBeCloseTo((9 * 0.5) / 34, 12);
  });

  test('Wilson interval and the day split', () => {
    const w = wilson(10, 100)!;
    expect(w.rate).toBe(0.1);
    expect(w.lower).toBeCloseTo(0.0552, 3);
    expect(w.upper).toBeCloseTo(0.1744, 3);
    expect(wilson(0, 0)).toBeNull();
    expect(splitDays(['d3', 'd1', 'd2', 'd1', 'd4', 'd5', 'd6'])).toEqual({ find: ['d1', 'd2', 'd3', 'd4'], check: ['d5', 'd6'] });
  });

  const days = Array.from({ length: 12 }, (_, d) => `2026-09-${String(d + 1).padStart(2, '0')}`);
  const rnd = (seed: number) => {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
      return s / 4294967296;
    };
  };
  const synth = (effect: number, seed: number): LabelledDecision[] => {
    const u = rnd(seed);
    const xs: LabelledDecision[] = [];
    let i = 0;
    for (const day of days) {
      for (let k = 0; k < 80; k++) {
        const stratum = u() < 0.5 ? 'a' : 'b';
        const f = u();
        const p = (stratum === 'a' ? 0.15 : 0.05) + (f > 0.5 ? effect : 0);
        xs.push(mk(day, stratum, f, u() < p, i++));
      }
    }
    return xs;
  };

  test('a planted survival feature holds up on the check-days after Holm over every test; noise does not', () => {
    const planted = featureTests(synth(0.3, 1), 400, 3);
    expect(planted.length).toBe(SURVIVAL_FEATURES.length);
    expect(planted.find((x) => x.feature === 's_net60')!.heldUp).toBe(true);
    expect(planted.filter((x) => x.heldUp).map((x) => x.feature)).toEqual(['s_net60']);
    const noise = featureTests(synth(0, 2), 400, 3);
    expect(noise.filter((x) => x.heldUp).length).toBe(0);
  });

  test('the survival rule is chosen and frozen on the find-days alone; a planted signal is found, noise gives none', () => {
    const data = synth(0.3, 1);
    const rule = freezeRule(data, 400, 5);
    const { find } = splitDays(data.map((x) => x.day));
    const findMedian = (() => {
      const v = data.filter((x) => find.includes(x.day)).map((x) => x.features.s_net60!).sort((a, b) => a - b);
      return (v[v.length / 2 - 1]! + v[v.length / 2]!) / 2;
    })();
    expect(rule.ageMs).toBe(60 * 60_000);
    expect(rule.conds).toEqual([{ f: 's_net60', dir: 'gt', t: findMedian }]);
    expect(rule.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rule.trials).toBe(SURVIVAL_FEATURES.length);
    expect(freezeRule(synth(0, 2), 400, 5).conds).toEqual([]);
  });

  test('no check-day value reaches selection: a check-only signal is never chosen, and a planted check-day marker leaves the frozen rule identical', () => {
    const { check } = splitDays(days);
    const C = new Set(check);
    // Signal only on the check-days, in s_top10: selection must not see it.
    const u = rnd(9);
    const checkOnly = synth(0, 4).map((x) => {
      if (!C.has(x.day)) return x;
      const v = u();
      return { ...x, features: { ...x.features, s_top10: v }, survived: v > 0.5 };
    });
    expect(freezeRule(checkOnly, 400, 5).conds).toEqual([]);
    // A marker on every check-day decision (impossible values, flipped labels) changes nothing in the frozen rule.
    const base = synth(0.3, 1);
    const marked = base.map((x) => (C.has(x.day) ? { ...x, survived: !x.survived, features: Object.fromEntries(SURVIVAL_FEATURES.map((k) => [k, 999])) as Record<SurvivalFeature, number> } : x));
    expect(freezeRule(marked, 400, 5)).toEqual(freezeRule(base, 400, 5));
  });

  test('day-block bootstrap needs at least two days', () => {
    expect(dayBootstrap(synth(0, 3).filter((x) => x.day === days[0]), () => 0.1, 200, 1).lower).toBeNull();
  });
});

describe('comparison measures', () => {
  test('win rate, mean, median and profit factor', () => {
    const m = tradeMeasures([{ day: 'a', rNet: 0.2 }, { day: 'a', rNet: -0.1 }, { day: 'b', rNet: -0.1 }, { day: 'b', rNet: 0.4 }]);
    expect({ ...m, mean: null, median: null, profitFactor: null }).toEqual({ entries: 4, days: 2, winRate: 0.5, mean: null, median: null, profitFactor: null });
    expect(m.mean!).toBeCloseTo(0.1, 12);
    expect(m.median!).toBeCloseTo(0.05, 12);
    expect(m.profitFactor!).toBeCloseTo(3, 12);
    expect(tradeMeasures([{ day: 'a', rNet: 0.1 }]).profitFactor).toBeNull();
  });

  test('rule predicates: survival conditions and RES-4 feature conditions; unknown values fail', () => {
    const d = { ageMs: 60 * 60_000, features: Object.fromEntries(SURVIVAL_FEATURES.map((k) => [k, k === 's_net60' ? 0.3 : null])) as Record<SurvivalFeature, number | null> };
    const at = (conds: { f: SurvivalFeature; dir: 'gt' | 'le'; t: number }[], ageMs = 60 * 60_000) => ({ ageMs, conds });
    expect(passesSurvival(at([{ f: 's_net60', dir: 'gt', t: 0.2 }]), d)).toBe(true);
    expect(passesSurvival(at([{ f: 's_net60', dir: 'le', t: 0.2 }]), d)).toBe(false);
    expect(passesSurvival(at([{ f: 's_top10', dir: 'le', t: 1 }]), d)).toBe(false);
    expect(passesSurvival(at([]), d)).toBe(false);
    // The rule holds only at the age it was chosen for.
    expect(passesSurvival(at([{ f: 's_net60', dir: 'gt', t: 0.2 }], 240 * 60_000), d)).toBe(false);
    const f = { f_dd: -0.5, f_ret60: null } as unknown as Features;
    expect(passesFeatures([{ f: 'f_dd', dir: 'le', t: '-0.35' }], f)).toBe(true);
    expect(passesFeatures([{ f: 'f_dd', dir: 'le', t: '-0.35' }, { f: 'f_ret60', dir: 'ge', t: '-0.03' }], f)).toBe(false);
  });
});

test('fixture sanity: graduates migrate on the practice days', () => {
  expect(fx.mints['A']!.migratedAtMs).toBe(S_T0 + 600_000);
});

describe('cli', () => {
  test('runs under the committed wall and writes results labelled exploration', async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { execFileSync } = await import('node:child_process');
    const { writeDataset } = await import('./dataset-writer.ts');
    const dir = mkdtempSync(join(tmpdir(), 'res5-'));
    try {
      writeDataset(join(dir, 'data'), fx.rows);
      writeFileSync(join(dir, 'sol.csv'), ['# name: SOL/USD', '# tag: fixed', '# bar_ms: 3600000', `# fetched_at: ${new Date(S_T0).toISOString()}`, 'start,close',
        ...SURV_SOL_USD.bars.map((b) => `${new Date(b.start).toISOString()},${b.close}`)].join('\n'));
      const summary = JSON.parse(execFileSync(process.execPath, ['--no-warnings', join(SRC, 'survival-cli.ts'), '--dataset', join(dir, 'data'), '--sol-usd', join(dir, 'sol.csv'), '--out', join(dir, 'out'), '--replicates', '200'], { encoding: 'utf8' })) as { decisions: number; labelled: number };
      expect(summary.decisions).toBe(12);
      expect(summary.labelled).toBe(11);
      const res = JSON.parse(readFileSync(join(dir, 'out', 'results.json'), 'utf8')) as { label: string; trials: { featureTests: number }; comparison: { results: { rule: string }[] }[] };
      expect(res.label).toBe('exploration, not proof');
      expect(res.trials.featureTests).toBe(45);
      expect(res.comparison[0]!.results.map((r) => r.rule.split(':')[0])).toEqual(['S0 (every eligible decision)', 'survival rule', 'H1-U1-dip-reversal', 'H2-U1-quiet-accumulation', 'H5-U2-exhausted-dump', 'H6-U1-dip-reversal-sol-up']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 150_000);
});
