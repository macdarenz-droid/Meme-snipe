import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import type { ManifestDay } from '../src/dataset/dataset.ts';
import type { AmmSwapRow, DatasetRow } from '../src/dataset/rows.ts';
import { evaluate, type Obs, passes, type Registry, ruleId, score, selectRule, univariate, walkForward } from '../src/research/analysis.ts';
import { collectCandidates, type DriveOptions, PLAN_DRIVE, solUsdAsOf } from '../src/research/candidates.ts';
import { PLAN_BARRIERS, scoreCandidates } from '../src/research/outcome.ts';
import { assertReadable, guardRows, HoldoutWallError, isPracticeDay, loadWindow, type PracticeWindow, readableDays, regimeOf, wallDay } from '../src/research/practice.ts';
import { AsOfError, FEATURE_IDS, type Features, SignalTracker } from '../src/research/tracker.ts';
import { SOL_USD, syntheticRows, T0 } from './synthetic.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SRC = join(import.meta.dirname, '..', 'src', 'research');

// Synthetic data starts 2026-09-20 00:00 UTC; this test window keeps it on practice days.
const WINDOW: PracticeWindow = { decisionFrom: '2026-09-19', decisionTo: '2026-10-01', holdoutFrom: '2026-09-25', embargoDays: 1, confirmedBy: 'test' };
const rows = syntheticRows({ mints: 3, slots: 2.5 * 3600 * 6 });
const drive = (over: Partial<DriveOptions> = {}): DriveOptions => ({
  window: WINDOW, policy: TRIAL_POLICY, solUsd: solUsdAsOf(SOL_USD, 3 * 3_600_000), ...PLAN_DRIVE, ...over,
});

describe('holdout wall', () => {
  test('the committed window keeps the wall at or before 2026-09-17 until BT-2 confirms it', () => {
    const w = loadWindow(join(ROOT, 'research', 'signals', 'window.json'));
    if (w.confirmedBy === null) expect(wallDay(w) <= '2026-09-17').toBe(true);
    expect(isPracticeDay(w, wallDay(w))).toBe(false);
    expect(isPracticeDay(w, w.holdoutFrom)).toBe(false);
    expect(regimeOf(w, '2026-08-03')).toBe('B2-boost');
    expect(regimeOf(w, '2026-09-11')).toBe('B3-fee-config');
    expect(regimeOf(w, '2026-09-12')).toBe('B4-holder-rewards');
  });

  test('holdout and embargo days are refused before any file is opened', () => {
    expect(wallDay(WINDOW)).toBe('2026-09-24');
    expect(() => assertReadable(WINDOW, '2026-09-24')).toThrow(HoldoutWallError);
    expect(() => assertReadable(WINDOW, '2026-09-30')).toThrow(HoldoutWallError);
    expect(() => assertReadable(WINDOW, '2026-09-23')).not.toThrow();
    const day = (d: string): ManifestDay => ({ day: d, blocks_expected: 0, blocks_scanned: 0, complete: true, warm_up: false, rows: {}, files: [] });
    const kept = readableDays(WINDOW, ['2026-09-26', '2026-09-23', '2026-09-24', '2026-09-05', '2026-09-25'].map(day)).map((d) => d.day);
    expect(kept).toEqual(['2026-09-05', '2026-09-23']);
  });

  test('a planted holdout-day row stops both stages', () => {
    const planted: DatasetRow = { kind: 'block', slot: 999_999_999n, blockTime: Date.parse('2026-09-25T00:00:00Z') / 1000, parentSlot: 999_999_998n };
    const bad = [...rows, planted];
    expect(() => [...guardRows(WINDOW, bad)]).toThrow(HoldoutWallError);
    expect(() => collectCandidates(bad, drive())).toThrow(HoldoutWallError);
    expect(() => scoreCandidates(bad, [], { window: WINDOW, policy: TRIAL_POLICY, fills: FILL_CONFIG, scenario: 'conservative', barriers: PLAN_BARRIERS, seed: 's', entryMinOutBelowBps: 300 })).toThrow(HoldoutWallError);
  });
});

describe('feature stage is blind to the future', () => {
  const base = collectCandidates(rows, drive());

  test('U2 decisions at 60, 120 and 180 min after each migration, every feature present in the record', () => {
    const u2 = base.candidates.filter((c) => c.universe === 'U2');
    expect(u2.length).toBe(9);
    for (const c of u2) expect(Object.keys(c.features).sort()).toEqual([...FEATURE_IDS].sort());
    // No CreateEvent in the synthetic data: creation is unknown, so H9 rejects (abstain on unknown evidence).
    expect(u2.every((c) => !c.eligible && c.rejects.includes('H9 creation unknown'))).toBe(true);
  });

  test('a planted future swap changes no feature of any earlier decision', () => {
    const cut = base.candidates[3]!;
    // A huge buy in every pool right after that decision: if any feature could see it, values would move.
    const after = rows.findIndex((r) => r.slot > cut.decisionSlot);
    const plant = rows.slice(after).flatMap((r): DatasetRow[] => (r.kind === 'amm' && r.side === 'buy' ? [{ ...r, amount: r.amount * 50n } as AmmSwapRow] : [r]));
    const other = collectCandidates([...rows.slice(0, after), ...plant], drive());
    const early = (cs: typeof base.candidates) => cs.filter((c) => c.decisionSlot <= cut.decisionSlot).map((c) => [c.id, c.features] as const);
    expect(early(other.candidates)).toEqual(early(base.candidates));
    // ...and the planted swaps did move later decisions, so the test can see a leak.
    const late = (cs: typeof base.candidates) => cs.filter((c) => c.decisionSlot > cut.decisionSlot).map((c) => c.features);
    expect(late(other.candidates)).not.toEqual(late(base.candidates));
  });

  test('flow features match a direct count over the rows of the window', () => {
    const c = base.candidates.find((x) => x.universe === 'U2')!;
    const swaps = rows.filter((r): r is AmmSwapRow => r.kind === 'amm' && r.pool === c.pool && r.slot <= c.decisionSlot && r.blockTime * 1000 > c.decisionMs - 15 * 60_000);
    expect(c.features.f_trades15).toBeCloseTo(Math.log1p(swaps.length), 12);
    const t = new SignalTracker({ solUsd: () => 120 });
    let buy = 0;
    let all = 0;
    for (const r of rows) {
      if (r.slot > c.decisionSlot) break;
      t.push(r);
    }
    // Buy share from the exact replays the tracker stored.
    for (const p of [...t.trackedPools()].filter((x) => x.pool === c.pool)) {
      for (const x of p.trades) if (x.ms > c.decisionMs - 15 * 60_000 && x.ms <= c.decisionMs) {
        all += Number(x.sol);
        if (x.buy) buy += Number(x.sol);
      }
    }
    expect(c.features.f_bsr15).toBeCloseTo(buy / all, 12);
    expect(c.features.f_dd!).toBeLessThanOrEqual(0);
    expect(c.features.f_age).toBeCloseTo(Math.log1p((c.decisionMs - t.pools.get(c.pool)!.migratedAtMs!) / 60_000), 12);
  });

  test('asking about a moment already passed throws', () => {
    const t = new SignalTracker({ solUsd: () => 120 });
    for (const r of rows.slice(0, 20_000)) t.push(r);
    const pool = [...t.trackedPools()][0]!.pool;
    expect(() => t.features(pool, t.nowMs, t.slot - 1n)).toThrow(AsOfError);
    expect(() => t.features(pool, t.nowMs - 1000, t.slot)).toThrow(AsOfError);
    expect(() => t.features(pool, t.nowMs, t.slot)).not.toThrow();
    expect(() => t.push({ kind: 'block', slot: t.slot - 5n, blockTime: 0, parentSlot: 0n })).toThrow(AsOfError);
  });

  test('the feature and selection stages never import the outcome stage', () => {
    for (const f of ['tracker.ts', 'candidates.ts', 'analysis.ts', 'practice.ts']) {
      expect(readFileSync(join(SRC, f), 'utf8'), f).not.toMatch(/from '\.\/outcome\.ts'/);
    }
  });
});

describe('outcome stage', () => {
  const { candidates } = collectCandidates(rows, drive());
  const opts = { window: WINDOW, policy: TRIAL_POLICY, fills: FILL_CONFIG, scenario: 'conservative' as const, barriers: PLAN_BARRIERS, seed: 'res3', entryMinOutBelowBps: RESEARCH_CONFIG.s0.entryMinOutBelowBps };
  const out = scoreCandidates(rows, candidates, opts);

  test('every candidate gets one label per barrier; deterministic', () => {
    expect(out.length).toBe(candidates.length);
    for (const o of out) expect(o.labels.map((l) => l.cfgId)).toEqual(PLAN_BARRIERS.map((b) => b.cfgId));
    expect(scoreCandidates(rows, candidates, opts)).toEqual(out);
  });

  test('a filled entry is charged its spend, base and priority fee, tip and unreturned rent', () => {
    const net = FILL_CONFIG.network;
    const filled = out.filter((o) => o.labels[0]!.entryFilled);
    expect(filled.length).toBeGreaterThan(0);
    const lamports = (TRIAL_POLICY.capital.minNotional * 1000n) / 120n; // $2 at about $120
    for (const o of filled) {
      const fixed = net.signaturesPerTx * net.baseFeePerSignature + net.entryPriorityFee + net.tip + net.tokenAccountRent;
      expect(o.entryCost - fixed).toBeGreaterThan(0n);
      expect(Number(o.entryCost - fixed)).toBeLessThanOrEqual(Number(lamports) * 1.05);
    }
  });

  test('on a pool that stops trading, a round trip loses exactly fees, rent and network costs (about 11% at $2)', () => {
    // No swap after 50 min: every decision sees a still pool, so the time stop sells at the entry price.
    const still = rows.filter((r) => r.kind !== 'amm' || r.blockTime * 1000 < T0 + 50 * 60_000);
    const cs = collectCandidates(still, drive()).candidates;
    const o2 = scoreCandidates(still, cs, opts).filter((o) => o.labels[1]!.entryFilled);
    expect(o2.length).toBeGreaterThan(0);
    for (const o of o2) {
      const b1 = o.labels[0]!;
      const b2 = o.labels[1]!;
      // 2 x 1.2% venue fees + rent 1,513,840 of ~16.7M lamports + 2 x 30,000 lamports of fees and tips.
      expect(b2.rNet!).toBeLessThan(-0.10);
      expect(b2.rNet!).toBeGreaterThan(-0.13);
      expect(b1.yTb).toBe(0);
      expect(b1.rNet).toBeCloseTo(b2.rNet!, 9);
    }
  });

  test('an entry that does not land costs its fee and nothing else', () => {
    const net = FILL_CONFIG.network;
    for (const o of out.filter((x) => !x.labels[0]!.entryFilled && !x.noQuote)) {
      const r = o.labels[0]!.rNet!;
      expect(r).toBeLessThanOrEqual(0);
      expect(r).toBeGreaterThan(-Number(net.signaturesPerTx * net.baseFeePerSignature + net.entryPriorityFee) / 1e7);
    }
  });
});

// ---------- selection on planted and on null data ----------

const mkRng = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0;
    return s / 4294967296;
  };
};
const gauss = (u: () => number) => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());

let regimeAt = (_d: number): string => 'R';
const synthObs = (days: number, perDay: number, signal: boolean, seed: number): Obs[] => {
  const u = mkRng(seed);
  const out: Obs[] = [];
  for (let d = 0; d < days; d++) {
    const day = new Date(Date.UTC(2026, 7, 3 + d)).toISOString().slice(0, 10);
    for (let i = 0; i < perDay; i++) {
      const f = Object.fromEntries(FEATURE_IDS.map((k) => [k, gauss(u)])) as Record<string, number>;
      // Planted: only the top fifth of f_net15 earns +30% on average; everything else loses 10%.
      const mu = signal && f['f_net15']! > 0.84 ? 0.3 : -0.1;
      const r = Math.max(-1, mu + 0.3 * gauss(u));
      out.push({ id: `${day}:${i}`, day, decisionMs: Date.parse(day) + i * 60_000, features: f as Features, rNet: r, severe: r <= -0.5, blocked: false, regime: regimeAt(d) });
    }
  }
  return out;
};

describe('selection procedure', () => {
  const ev = { k: 5, embargoDays: 1, seed: 7, replicates: 400 };

  test('finds a planted signal out of sample and passes the edge checks', () => {
    const obs = synthObs(40, 40, true, 1);
    const reg: Registry = { rows: [] };
    const v = evaluate(obs, { universe: 'U2', barrier: 'B1' }, reg, ev);
    expect(v.finalRule).toMatch(/^f_net15>=q80/);
    expect(v.folds.every((f) => f.rule.startsWith('f_net15>='))).toBe(true);
    expect(v.checks['meanAboveZero']).toBe(true);
    expect(v.checks['beatsBase']).toBe(true);
    expect(v.checks['sampleSize']).toBe(true);
    // Every rule tried is in the registry: base + 192 singles + up to 191 pairs, per fold and once on all days.
    expect(reg.rows.length).toBeGreaterThanOrEqual(5 * 193);
    expect(new Set(reg.rows.map((r) => r.trialId)).size).toBe(reg.rows.length);
  });

  test('a signal that flips sign in the latest regime fails the regime check', () => {
    // Days 0–19 one regime with the planted edge; days 20–39 a new regime where the same feature loses.
    regimeAt = (d) => (d < 20 ? 'R2' : 'R4');
    const obs = synthObs(40, 40, true, 1).map((o) => (o.regime === 'R4' && o.features.f_net15! > 0.84 ? { ...o, rNet: o.rNet - 0.6 } : o));
    regimeAt = () => 'R';
    const v = evaluate(obs, { universe: 'U2', barrier: 'B1' }, { rows: [] }, ev);
    expect(v.regimes.map((r) => r.regime)).toEqual(['R2', 'R4']);
    expect(v.checks['regimes']).toBe(false);
    expect(v.pass).toBe(false);
    // The same data without the flip passes the regime check.
    regimeAt = (d) => (d < 20 ? 'R2' : 'R4');
    const ok = evaluate(synthObs(40, 40, true, 1), { universe: 'U2', barrier: 'B1' }, { rows: [] }, ev);
    regimeAt = () => 'R';
    expect(ok.checks['regimes'], JSON.stringify(ok.regimes)).toBe(true);
  });

  test('on noise the verdict is "no reliable signal"', () => {
    const obs = synthObs(40, 40, false, 2);
    const v = evaluate(obs, { universe: 'U1', barrier: 'B1' }, { rows: [] }, ev);
    expect(v.pass).toBe(false);
    expect(v.checks['meanAboveZero']).toBe(false);
  });

  test('walk-forward trains only on days before the test block, minus the embargo day', () => {
    const obs = synthObs(20, 10, true, 3);
    const seen: string[][] = [];
    const reg: Registry = { rows: [] };
    const folds = walkForward(obs, 5, 1, reg, { universe: 'U2', barrier: 'B1' });
    for (const f of folds) {
      const first = f.testDays[0]!;
      seen.push([...f.testDays]);
      expect(f.oos.every((o) => f.testDays.includes(o.day))).toBe(true);
      expect(f.oos.every((o) => passes(f.rule, o))).toBe(true);
      expect(first > '2026-08-03').toBe(true);
    }
    expect(folds.length).toBe(4);
    // Training on fold 2 = block 1 minus its last day: selectRule saw 3 days, not 4.
    const fold2 = reg.rows.find((r) => r.fold === 'wf2' && r.rule === 'base')!;
    expect(fold2.days).toBe(3);
  });

  test('score refuses thin rules and selectRule breaks ties toward fewer conditions', () => {
    const obs = synthObs(4, 5, false, 4);
    expect(score(obs).lower).toBe(-Infinity);
    const pick = selectRule(obs, { rows: [] }, { universe: 'U1', barrier: 'B1', fold: 'x' });
    expect(ruleId(pick.rule)).toBe('base');
  });

  test('univariate view flags the planted feature after Holm and nothing on noise', () => {
    const planted = univariate(synthObs(30, 30, true, 5), { seed: 1, replicates: 400 });
    expect(planted.find((v) => v.feature === 'f_net15')!.holmPass).toBe(true);
    const noise = univariate(synthObs(30, 30, false, 6), { seed: 1, replicates: 400 });
    expect(noise.filter((v) => v.holmPass).length).toBeLessThanOrEqual(1);
  });
});

test('T0 of the fixture is a practice day of the test window', () => {
  expect(isPracticeDay(WINDOW, new Date(T0).toISOString().slice(0, 10))).toBe(true);
});

describe('cli', () => {
  test('runs on a dataset directory, writes results and the trial registry, and drops holdout days unread', async () => {
    const { mkdtempSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { execFileSync } = await import('node:child_process');
    const { writeDataset } = await import('./dataset-writer.ts');
    const dir = mkdtempSync(join(tmpdir(), 'res3-'));
    try {
      writeDataset(join(dir, 'data'), rows);
      writeFileSync(join(dir, 'sol.csv'), ['# name: SOL/USD', '# tag: fixed', '# bar_ms: 3600000', `# fetched_at: ${new Date(T0).toISOString()}`, 'start,close',
        ...SOL_USD.bars.map((b) => `${new Date(b.start).toISOString()},${b.close}`)].join('\n'));
      writeFileSync(join(dir, 'window.json'), JSON.stringify(WINDOW));
      const run = (w: string) => execFileSync(process.execPath, ['--no-warnings', join(SRC, 'cli.ts'), '--dataset', join(dir, 'data'), '--sol-usd', join(dir, 'sol.csv'), '--window', w, '--out', join(dir, 'out'), '--replicates', '200'], { encoding: 'utf8' });
      const summary = JSON.parse(run(join(dir, 'window.json'))) as { days: number; counts: Record<string, { decisions: number }> };
      expect(summary.days).toBe(1);
      expect(summary.counts['U2']!.decisions).toBe(9);
      expect(existsSync(join(dir, 'out', 'results.json'))).toBe(true);
      expect(existsSync(join(dir, 'out', 'trials.jsonl'))).toBe(true);
      // The same data behind a wall before its only day: the day is dropped unread and nothing is decided.
      writeFileSync(join(dir, 'early.json'), JSON.stringify({ ...WINDOW, holdoutFrom: '2026-09-20', decisionFrom: '2026-09-10' }));
      const none = JSON.parse(run(join(dir, 'early.json'))) as { days: number };
      expect(none.days).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Writing the zstd fixture takes ~25 s of the time (measured 26 s on this container).
  }, 150_000);
});
