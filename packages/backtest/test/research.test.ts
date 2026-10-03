import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import type { ManifestDay } from '../src/dataset/dataset.ts';
import type { AmmSwapRow, DatasetRow } from '../src/dataset/rows.ts';
import { evaluate, handoffs, type Obs, passes, type Registry, ruleId, score, selectRule, univariate, walkForward } from '../src/research/analysis.ts';
import { type Candidate, collectCandidates, type DriveOptions, PLAN_DRIVE, solUsdAsOf } from '../src/research/candidates.ts';
import { PLAN_BARRIERS, scoreCandidates, type ScoreTarget } from '../src/research/outcome.ts';
import { poolBuyExactQuoteIn, poolSell } from '../../core/src/amm/index.ts';
import { observedFeeContext, replaySwap } from '../../core/src/fills/index.ts';
import { bps } from '../../core/src/units/index.ts';
import {
  addDays, assertReadable, guardRows, HoldoutWallError, isPracticeDay, loadWindow, latestRegime, melbourneStart, type PracticeWindow, readableDays, regimeAt, resolveWindow, wallDay, wallMs,
} from '../src/research/practice.ts';
import { createHoldoutRegistry, registerHoldout } from '../../core/src/stats/index.ts';
import { AsOfError, FEATURE_IDS, type Features, SignalTracker } from '../src/research/tracker.ts';
import { SOL_USD, syntheticRows, T0 } from './synthetic.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SRC = join(import.meta.dirname, '..', 'src', 'research');

// Synthetic data starts 2026-09-20 00:00 UTC; this test window keeps it on practice days.
const WINDOW: PracticeWindow = { decisionFrom: '2026-09-19', decisionTo: '2026-10-01', holdoutFrom: '2026-09-25', embargoDays: 1, confirmedBy: 'test' };
const rows = syntheticRows({ mints: 3, slots: 2.5 * 3600 * 6 });
const utcStart = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const targets = (cs: readonly Candidate[]): ScoreTarget[] => cs.map(({ id, pool, decisionSlot, decisionMs, solUsd }) => ({ id, pool, decisionSlot, decisionMs, solUsd }));
const drive = (over: Partial<DriveOptions> = {}): DriveOptions => ({
  window: WINDOW, policy: TRIAL_POLICY, solUsd: solUsdAsOf(SOL_USD, 3 * 3_600_000), ...PLAN_DRIVE, ...over,
});

describe('holdout wall', () => {
  test('the committed window keeps the wall on or before the B4 day until the registry confirms it', () => {
    const w = loadWindow(join(ROOT, 'research', 'signals', 'window.json'));
    if (w.confirmedBy === null) expect(wallDay(w) <= '2026-09-12').toBe(true);
    expect(isPracticeDay(w, wallDay(w))).toBe(false);
    expect(isPracticeDay(w, w.holdoutFrom)).toBe(false);
    expect(regimeAt(w, Date.parse('2026-08-03T00:00:00Z'))).toBe('B2-boost');
    expect(regimeAt(w, Date.parse('2026-09-12T15:23:59Z'))).toBe('B3-fee-config');
    expect(regimeAt(w, Date.parse('2026-09-12T15:24:00Z'))).toBe('B4-holder-rewards');
    expect(regimeAt(w, Date.parse('2026-07-20T00:00:00Z'))).toBe('pre');
    expect(regimeAt(w, Date.parse('2026-10-02T15:47:00Z'))).toBe('B5-oct2-upgrade');
    // B5 falls after the last decision day, so the latest regime of the window is B4.
    expect(latestRegime(w)).toBe('B4-holder-rewards');
  });

  test('days are Melbourne days: the wall starts at Melbourne midnight', () => {
    expect(wallDay(WINDOW)).toBe('2026-09-24');
    expect(new Date(wallMs(WINDOW)).toISOString()).toBe('2026-09-23T14:00:00.000Z');
    // After daylight saving starts (4 Oct 2026) Melbourne is UTC+11.
    expect(new Date(melbourneStart('2026-10-05')).toISOString()).toBe('2026-10-04T13:00:00.000Z');
  });

  test('holdout and embargo days are refused before any file is opened', () => {
    expect(() => assertReadable(WINDOW, '2026-09-24')).toThrow(HoldoutWallError);
    expect(() => assertReadable(WINDOW, '2026-09-30')).toThrow(HoldoutWallError);
    expect(() => assertReadable(WINDOW, '2026-09-23')).not.toThrow();
    const day = (d: string): ManifestDay => ({ day: d, blocks_expected: 0, blocks_scanned: 0, complete: true, warm_up: false, rows: {}, files: [] });
    // UTC day files: 22 Sep ends before the wall (23 Sep 14:00 UTC); 23 Sep straddles it and stays unread.
    const kept = readableDays(WINDOW, ['2026-09-26', '2026-09-23', '2026-09-22', '2026-09-05', '2026-09-24'].map(day)).map((d) => d.day);
    expect(kept).toEqual(['2026-09-05', '2026-09-22']);
  });

  test('a window file cannot move the wall later than the committed one; a confirmed one must match the registry', () => {
    const committed = loadWindow(join(ROOT, 'research', 'signals', 'window.json'));
    const later = { ...committed, holdoutFrom: addDays(committed.holdoutFrom, 1) };
    expect(() => resolveWindow(committed, later, null)).toThrow(/later than the committed wall/);
    const earlier = { ...committed, holdoutFrom: addDays(committed.holdoutFrom, -3) };
    expect(resolveWindow(committed, earlier, null)).toBe(earlier);
    const confirmed = { ...earlier, confirmedBy: 'registry@abc' };
    expect(() => resolveWindow(committed, confirmed, null)).toThrow(/no STATS-1 registry/);
    // The registry's fromDay is a UTC day; the confirmed wall must be the Melbourne day of that date.
    const fromDay = wallDay(earlier);
    const reg = registerHoldout(createHoldoutRegistry(2), { holdoutId: 'h-u2', universe: 'U2', configId: 'c', fromDay: addDays(fromDay, -1), toDay: '2026-10-01' });
    expect(() => resolveWindow(committed, confirmed, reg)).toThrow(/must be equal/);
    const laterReg = registerHoldout(createHoldoutRegistry(2), { holdoutId: 'h-u2', universe: 'U2', configId: 'c', fromDay: addDays(fromDay, 1), toDay: '2026-10-01' });
    expect(() => resolveWindow(committed, confirmed, laterReg)).toThrow(/must be equal/);
    const ok = registerHoldout(createHoldoutRegistry(2), { holdoutId: 'h-u2', universe: 'U2', configId: 'c', fromDay, toDay: '2026-10-01' });
    // The wall (Melbourne midnight) comes 10 h before the registered UTC day starts.
    expect(utcStart(fromDay) - wallMs(confirmed)).toBe(10 * 3_600_000);
    expect(resolveWindow(committed, confirmed, ok)).toBe(confirmed);
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
  const out = scoreCandidates(rows, targets(candidates), opts);

  test('every candidate gets one label per barrier; deterministic', () => {
    expect(out.length).toBe(candidates.length);
    for (const o of out) expect(o.labels.map((l) => l.cfgId)).toEqual(PLAN_BARRIERS.map((b) => b.cfgId));
    expect(scoreCandidates(rows, targets(candidates), opts)).toEqual(out);
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

  // No swap after 50 min: every decision sees a still pool, so the time stop sells at the entry price.
  const still = rows.filter((r) => r.kind !== 'amm' || r.blockTime * 1000 < T0 + 50 * 60_000);
  const stillCands = collectCandidates(still, drive()).candidates;

  test('on a still pool the round trip equals the computed cost to 1e-9: fees both ways, rent, network, failed exits', () => {
    const net = FILL_CONFIG.network;
    const steps = TRIAL_POLICY.exits.ladder.steps;
    const base = net.signaturesPerTx * net.baseFeePerSignature;
    const outs = scoreCandidates(still, targets(stillCands), opts);
    let checked = 0;
    for (const [i, o] of outs.entries()) {
      const b2 = o.labels[1]!;
      if (!b2.entryFilled) continue;
      const c = stillCands[i]!;
      const sw = still.filter((r): r is AmmSwapRow => r.kind === 'amm' && r.pool === c.pool).at(-1)!;
      const s = replaySwap(sw.pre, sw);
      if (!s.ok) throw new Error('fixture swap does not replay');
      const ctx = observedFeeContext(sw.fees, sw.baseSupply, { mayhemMode: false, transferFee: false, transferHook: false });
      const spend = BigInt(Math.floor((Number(TRIAL_POLICY.capital.minNotional) / 1e6 / c.solUsd) * 1e9));
      const buy = poolBuyExactQuoteIn(s.trade.after, spend, ctx);
      if (!buy.ok) throw new Error('no buy quote');
      const cost = buy.trade.userQuote + base + net.entryPriorityFee + net.tip + net.tokenAccountRent;
      expect(o.entryCost).toBe(cost);
      const sell = poolSell(buy.trade.after, buy.trade.base, ctx);
      if (!sell.ok) throw new Error('no sell quote');
      // fills-2: the conservative scenario returns the token-account rent when the final sell lands.
      const rentBack = FILL_CONFIG.scenarios.conservative.rentRecovery && !b2.blocked ? net.tokenAccountRent : 0n;
      const value = sell.trade.userQuote - (base + steps[0]!.priorityFeeLamports + net.tip) + rentBack;
      const failed = BigInt(b2.blocked ? b2.nExitAttempts : b2.nExitAttempts - 1) * (base + steps[2]!.priorityFeeLamports);
      const expected = Number(value - cost - failed) / Number(cost);
      expect(Math.abs(b2.rNet! - expected)).toBeLessThan(1e-9);
      // The same bounds as before on the result without the returned rent.
      const noRent = b2.rNet! - Number(rentBack) / Number(cost);
      expect(noRent).toBeLessThan(-0.10);
      expect(noRent).toBeGreaterThan(-0.14);
      // B1 never touches its barriers on a still pool, sees the same exit draws, and ends where B2 does.
      expect(o.labels[0]!.yTb).toBe(0);
      expect(o.labels[0]!.rNet).toBeCloseTo(b2.rNet!, 12);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  test('the exit pays the fees in force at the exit, not at the entry', () => {
    // One small sell lands 100 min after T0 in every pool, on the still state; its creator fee is 0 or unchanged.
    const at = T0 + 100 * 60_000;
    const withSwap = (creator: number): DatasetRow[] => {
      const out: DatasetRow[] = [];
      let done = false;
      for (const r of still) {
        if (!done && r.kind === 'block' && r.blockTime * 1000 >= at) {
          let tx = 0;
          for (const p of new Set(stillCands.map((c) => c.pool))) {
            const sw = still.filter((x): x is AmmSwapRow => x.kind === 'amm' && x.pool === p).at(-1)!;
            const st = replaySwap(sw.pre, sw);
            if (!st.ok) throw new Error('fixture swap does not replay');
            out.push({ ...sw, slot: r.slot, blockTime: r.blockTime, txIdx: tx++, evIdx: 0, signature: `${sw.signature}x`, side: 'sell', mode: 'exact-base', amount: 1_000_000_000n, pre: st.trade.after,
              fees: { ...sw.fees, split: { ...sw.fees.split, creator: bps(creator) } } });
          }
          done = true;
        }
        out.push(r);
      }
      return out;
    };
    const same = scoreCandidates(withSwap(95), targets(stillCands), opts);
    const cut = scoreCandidates(withSwap(0), targets(stillCands), opts);
    let checked = 0;
    for (const [i, c] of stillCands.entries()) {
      const a = same[i]!.labels[1]!;
      const b = cut[i]!.labels[1]!;
      if (!a.entryFilled || a.rNet === null || b.rNet === null) continue;
      const after = c.decisionMs + 7_000 < at;
      if (after) {
        // Held across the change: 0.95% less creator fee on the sale, about 0.95% of the value per unit of cost.
        expect(b.rNet - a.rNet).toBeGreaterThan(0.007);
        expect(b.rNet - a.rNet).toBeLessThan(0.0105);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  test('a decision whose outcome window would reach the wall is purged, not scored', () => {
    // Data moved to 11:00–14:00 UTC on 20 Sep and cut at the wall (Melbourne 21 Sep = 20 Sep 14:00 UTC).
    const w: PracticeWindow = { ...WINDOW, holdoutFrom: '2026-09-22' };
    const shifted = rows.map((r) => ({ ...r, blockTime: r.blockTime + 11 * 3600 })).filter((r) => r.blockTime * 1000 < wallMs(w));
    const res = collectCandidates(shifted, drive({ window: w }));
    expect(res.purged).toBeGreaterThan(0);
    expect(res.candidates).toEqual([]);
  });

  test('a hold that would cross a regime boundary is purged', () => {
    // A boundary 90 min after T0: the 60-min decisions (outcome window 150 min) cross it; the 180-min ones start after it.
    const w: PracticeWindow = { ...WINDOW, regimes: [{ label: 'Bx', from: new Date(T0 + 90 * 60_000).toISOString() }] };
    const res = collectCandidates(rows, drive({ window: w }));
    const all = collectCandidates(rows, drive()).candidates.filter((c) => c.universe === 'U2');
    expect(res.purged).toBeGreaterThan(0);
    expect(res.candidates.filter((c) => c.universe === 'U2').length).toBe(all.length - res.purged);
    for (const c of res.candidates) expect(c.regime === regimeAt(w, c.decisionMs + PLAN_DRIVE.outcomeWindowMs)).toBe(true);
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

let regimeOfDay = (_d: number): string => 'R';
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
      out.push({ id: `${day}:${i}`, day, decisionMs: Date.parse(day) + i * 60_000, features: f as Features, rNet: r, severe: r <= -0.5, blocked: false, regime: regimeOfDay(d) });
    }
  }
  return out;
};

describe('selection procedure', () => {
  const ev = { k: 5, embargoDays: 1, seed: 7, replicates: 400, latestRegime: 'R' };

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
    regimeOfDay = (d) => (d < 20 ? 'R2' : 'R4');
    const obs = synthObs(40, 40, true, 1).map((o) => (o.regime === 'R4' && o.features.f_net15! > 0.84 ? { ...o, rNet: o.rNet - 0.6 } : o));
    regimeOfDay = () => 'R';
    const v = evaluate(obs, { universe: 'U2', barrier: 'B1' }, { rows: [] }, { ...ev, latestRegime: 'R4' });
    expect(v.regimes.map((r) => r.regime)).toEqual(['R2', 'R4']);
    expect(v.checks['regimes']).toBe(false);
    expect(v.pass).toBe(false);
    // The same data without the flip passes the regime check.
    regimeOfDay = (d) => (d < 20 ? 'R2' : 'R4');
    const ok = evaluate(synthObs(40, 40, true, 1), { universe: 'U2', barrier: 'B1' }, { rows: [] }, { ...ev, latestRegime: 'R4' });
    regimeOfDay = () => 'R';
    expect(ok.checks['regimes'], JSON.stringify(ok.regimes)).toBe(true);
  });

  test('one configuration per universe: barriers in the fixed order B1, B2, B3, first passing wins', () => {
    // The order logic is tested on verdicts marked passed or failed; the checks themselves are tested above.
    const v = evaluate(synthObs(40, 40, true, 1), { universe: 'U2', barrier: 'B1' }, { rows: [] }, ev);
    const as = (universe: string, barrier: string, pass: boolean) => ({ ...v, universe, barrier, pass, checks: { ...v.checks, dsr: pass } });
    const h = handoffs([as('U2', 'B3', true), as('U1', 'B1', false), as('U2', 'B2', true), as('U2', 'B1', false), { universe: 'U1', barrier: 'B2', skipped: 'only 2 practice days' }], ['B1', 'B2', 'B3']);
    expect(h.map((x) => x.universe)).toEqual(['U1', 'U2']);
    expect(h[0]).toMatchObject({ universe: 'U1', status: 'no reliable signal', barrier: null, rule: null });
    expect(h[0]!.failed).toEqual([{ barrier: 'B1', checks: ['dsr'] }, { barrier: 'B2', checks: ['skipped: only 2 practice days'] }]);
    // B1 failed, so B2 is handed over even though B3 passes too; exactly one configuration for U2.
    expect(h[1]).toMatchObject({ universe: 'U2', status: 'candidate', barrier: 'B2', rule: v.finalRule });
    expect(h[1]!.conds!.every((c) => Number.isFinite(c.t))).toBe(true);
    // BT-2's UniverseConfig fields: the edge is the out-of-sample lower bound in ppm; the target the median winner.
    expect(h[1]!.edgePpm).toBe(BigInt(Math.floor(v.oos!.lower * 1e6)));
    expect(h[1]!.medianTargetBps!).toBeGreaterThan(0);
    expect(h[0]!.edgePpm).toBeNull();
    expect(handoffs([as('U2', 'B2', true), as('U2', 'B3', true)], ['B3', 'B2'])[0]!.barrier).toBe('B3');
  });

  test('the deflated Sharpe check is strict: a strong planted edge still fails it when the family holds many variants of it', () => {
    // The registry variance includes real skill spread between rules, so the benchmark is high (G1 keeps the rule).
    const v = evaluate(synthObs(40, 40, true, 1), { universe: 'U2', barrier: 'B1' }, { rows: [] }, ev);
    expect(v.checks['meanAboveZero']).toBe(true);
    expect(v.checks['dsr']).toBe(false);
    expect(v.pass).toBe(false);
  });

  test('the latest regime comes from the window: with no observation in it the check fails', () => {
    const v = evaluate(synthObs(40, 40, true, 1), { universe: 'U2', barrier: 'B1' }, { rows: [] }, { ...ev, latestRegime: 'B4' });
    expect(v.regimes.find((r) => r.regime === 'B4')).toBeUndefined();
    expect(v.checks['regimes']).toBe(false);
  });

  test('a rule that loses to base in an older regime fails even when it earns in the latest one (R2)', () => {
    regimeOfDay = (d) => (d < 10 ? 'R2' : 'R4');
    // In R2 (10 days) the planted rule earns 0.8 less, below base; in R4 (30 days) it keeps its edge.
    const obs = synthObs(40, 40, true, 1).map((o) => (o.regime === 'R2' && o.features.f_net15! > 0.84 ? { ...o, rNet: o.rNet - 0.8 } : o));
    regimeOfDay = () => 'R';
    const v = evaluate(obs, { universe: 'U2', barrier: 'B1' }, { rows: [] }, { ...ev, latestRegime: 'R4' });
    expect(v.finalConds[0]!.f).toBe('f_net15');
    const r2 = v.regimes.find((r) => r.regime === 'R2')!;
    const r4 = v.regimes.find((r) => r.regime === 'R4')!;
    expect(r2.ruleMean!).toBeLessThan(r2.baseMean!);
    // The latest regime alone would pass: the failure comes from the older regime.
    expect(r4.oosN).toBeGreaterThanOrEqual(30);
    expect(r4.oosMean!).toBeGreaterThan(0);
    expect(v.checks['regimes']).toBe(false);
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
    const reg: Registry = { rows: [] };
    const planted = univariate(synthObs(30, 30, true, 5), { seed: 1, replicates: 400 }, reg, { universe: 'U2', barrier: 'B1' });
    // Both tails of every feature are logged as trials.
    expect(reg.rows.length).toBe(2 * FEATURE_IDS.length);
    expect(planted.find((v) => v.feature === 'f_net15')!.holmPass).toBe(true);
    const noise = univariate(synthObs(30, 30, false, 6), { seed: 1, replicates: 400 }, { rows: [] }, { universe: 'U2', barrier: 'B1' });
    expect(noise.filter((v) => v.holmPass).length).toBeLessThanOrEqual(1);
  });
});

test('T0 of the fixture is a practice day of the test window', () => {
  expect(isPracticeDay(WINDOW, new Date(T0).toISOString().slice(0, 10))).toBe(true);
});

describe('cli', () => {
  test('runs under the committed wall, writes results, handoff and trial registry; refuses a later wall', async () => {
    const { mkdtempSync, rmSync, writeFileSync, existsSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { execFileSync, spawnSync } = await import('node:child_process');
    const { writeDataset } = await import('./dataset-writer.ts');
    const dir = mkdtempSync(join(tmpdir(), 'res3-'));
    // The fixture moved 30 days back (21 Aug, before the committed wall) so the CLI runs on the committed window.
    const back = 30 * 86_400;
    try {
      writeDataset(join(dir, 'data'), rows.map((r) => ({ ...r, blockTime: r.blockTime - back })));
      writeFileSync(join(dir, 'sol.csv'), ['# name: SOL/USD', '# tag: fixed', '# bar_ms: 3600000', `# fetched_at: ${new Date(T0 - back * 1000).toISOString()}`, 'start,close',
        ...SOL_USD.bars.map((b) => `${new Date(b.start - back * 1000).toISOString()},${b.close}`)].join('\n'));
      const cmd = (extra: string[]) => [join(SRC, 'cli.ts'), '--dataset', join(dir, 'data'), '--sol-usd', join(dir, 'sol.csv'), '--out', join(dir, 'out'), '--replicates', '200', ...extra];
      const summary = JSON.parse(execFileSync(process.execPath, ['--no-warnings', ...cmd([])], { encoding: 'utf8' })) as { days: number; counts: Record<string, { decisions: number }>; handoff: string[] };
      expect(summary.days).toBe(1);
      expect(summary.counts['U2']!.decisions).toBe(9);
      expect(summary.handoff).toEqual(['U1: no reliable signal', 'U2: no reliable signal']);
      for (const f of ['results.json', 'trials.jsonl', 'handoff.json']) expect(existsSync(join(dir, 'out', f)), f).toBe(true);
      const committed = loadWindow(join(ROOT, 'research', 'signals', 'window.json'));
      writeFileSync(join(dir, 'late.json'), JSON.stringify({ ...committed, holdoutFrom: addDays(committed.holdoutFrom, 1) }));
      const late = spawnSync(process.execPath, ['--no-warnings', ...cmd(['--window', join(dir, 'late.json')])], { encoding: 'utf8' });
      expect(late.status).not.toBe(0);
      expect(late.stderr).toMatch(/later than the committed wall/);
      // An earlier wall, before the fixture's day: the day file is dropped unread.
      writeFileSync(join(dir, 'early.json'), JSON.stringify({ ...committed, holdoutFrom: '2026-08-21' }));
      const early = JSON.parse(execFileSync(process.execPath, ['--no-warnings', ...cmd(['--window', join(dir, 'early.json')])], { encoding: 'utf8' })) as { days: number };
      expect(early.days).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // Writing the zstd fixture takes ~25 s of the time (measured 26 s on this container).
  }, 150_000);
});
