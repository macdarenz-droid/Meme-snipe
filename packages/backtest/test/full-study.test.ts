// The whole BT-2 study on a synthetic multi-day market: walk-forward, S0, G1, registration, the sealed holdout run
// once, G2 "not proven" with the seals closed, G0 proofs and the ledger replay check.
import { statSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import type { DatasetRow } from '../src/dataset/rows.ts';
import { STUDY_CONFIG, configId } from '../src/strategy/config.ts';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { readStudyRegistry } from '../src/study/registry.ts';
import { runSealedHoldout } from '../src/study/sealed.ts';
import { runFullStudy, type StudyInputs } from '../src/study/study.ts';
import { type MintPlan, studyWorld, W0 } from './study-world.ts';
import { SOL_USD } from './synthetic.ts';
import { POOL_ACCOUNTS } from './study-world.ts';

vi.setConfig({ testTimeout: 900_000 });
const dir = mkdtempSync(join(tmpdir(), 'study-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MIN = 150;
const DAY = 24 * 60 * MIN;
const reclaim = (since: number) => (since < 5 * MIN ? 0.5 : since < 50 * MIN ? 0.15 : 0.55);
const plan = (label: string, day: number): MintPlan => ({
  label, createSlot: day * DAY + 2 * 60 * MIN, graduateAfter: 20 * MIN, migrationQuote: 400_000_000_000n, buyBias: reclaim, swapEvery: 10,
  buySize: 3e9, sellDivisor: 8, swapsFor: 300 * MIN,
});
const { rows } = studyWorld({ leadInDays: 15, blockEvery: 25, slots: 3 * DAY, mints: [plan('d0', 0), plan('d1', 1), plan('d2', 2)] });
const dayOf = (r: DatasetRow) => new Date(r.blockTime * 1000).toISOString().slice(0, 10);
const sol = { ...SOL_USD, bars: Array.from({ length: 24 * 20 }, (_, k) => ({ start: W0 - 16 * 86_400_000 + k * 3_600_000, close: '120.00' })) };
const config = { ...STUDY_CONFIG, frozen: true, window: { decisionFrom: '2026-09-20', decisionTo: '2026-09-22', leadInDays: 14 }, folds: 2, holdout: { fromDay: '2026-09-22', entryCutoff: '2026-09-22T21:00:00Z', tailDays: 0 }, s0SeedsWalkForward: 2, s0SeedsHoldout: 2 };
const decisionDays = ['2026-09-20', '2026-09-21', '2026-09-22'];

const inputs = (over: Partial<StudyInputs> = {}): StudyInputs => ({
  config, policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG, availableDays: decisionDays,
  rows: (from, to) => () => rows.filter((r) => dayOf(r) >= from && dayOf(r) <= to)[Symbol.iterator](),
  firstDay: '2026-09-05', series: [sol], sampleRate: 1, insiders: () => ({ knownAtMs: 0, funded: [], devCluster: [] }), poolAccounts: POOL_ACCOUNTS, delegatesComplete: true,
  registryPath: join(dir, 'registry.json'), outDir: dir,
  ledgerReplay: (p) => { const r = replayLedgerFile(p); return { ok: r.ok, detail: JSON.stringify(r) }; }, seed: 'study', replays: 2, runHoldout: false, startedAt: '2026-10-04T00:00:00Z', ...over,
});

describe('BT-2 study', () => {
  const first = runFullStudy(inputs());

  it('runs the walk-forward cleanly through the real engine and scores it outside', () => {
    expect(first.walkForward.stats).toMatchObject({ crashes: 0, illegalStates: 0, unreconciledIntents: 0, mirrorMatches: true });
    expect(first.walkForward.ledgerReplay.ok).toBe(true);
    expect(first.walkForward.ledgerReplay.detail).toContain('"purpose":"backtest"');
    expect(first.walkForward.s0Seeds).toBe(2);
    expect(first.plan.walkForward.days).toEqual(['2026-09-20', '2026-09-21']);
    expect(first.plan.holdout).toMatchObject({ fromDay: '2026-09-22', toDay: '2026-09-22' });
    // Every walk-forward trade opened and closed inside the walk-forward days.
    for (const t of first.walkForward.trades) expect(t.closedAt).toBeLessThan(Date.parse('2026-09-22T00:00:00Z'));
    expect(first.walkForward.trades.length).toBeGreaterThan(0);
    // S0 ran under the same deployment constraints, and the SPA panel holds every variant on one calendar.
    expect(first.deployment.control).toHaveLength(config.s0SeedsWalkForward);
    for (const x of first.deployment.control) expect(x.stats).toMatchObject({ crashes: 0, illegalStates: 0, unreconciledIntents: 0 });
    expect(first.deployment.spa).not.toBeNull();
    expect(first.deployment.spa!.variants.map((v) => v.variant)).toEqual(['U1', 'U2', 'S0-U1 seed 0', 'S0-U2 seed 0', 'S0-U1 seed 1', 'S0-U2 seed 1']);
    for (const v of first.deployment.spa!.variants) expect(v.daily).toHaveLength(first.deployment.spa!.calendar.length);
    // The deployment replay ran on the same days, at the real size, cleanly.
    expect(first.deployment.stats).toMatchObject({ crashes: 0, illegalStates: 0, unreconciledIntents: 0 });
    expect(first.deployment.trades).toBeLessThanOrEqual(first.walkForward.trades.length + first.walkForward.purged + first.walkForward.embargoed);
  });

  it('proves the engine blind and deterministic on the study data', () => {
    expect(first.proofs.leak).toEqual({ ok: true, violations: [] });
    expect(new Set(first.proofs.replayHashes).size).toBe(1);
    expect(first.gates.G0.checks.find((c) => c.name === 'leak test')!.passed).toBe(true);
    expect(first.gates.G0.checks.find((c) => c.name === 'ledger replay')!.passed).toBe(true);
    // Parity (TEST-1) and second-source coverage are not BT-2's evidence: G0 fails on them until they exist.
    expect(first.gates.G0.status).toBe('fail');
  });

  it('registers one configuration per universe before any holdout run, and G1 is not proven on 2 days', () => {
    const reg = readStudyRegistry(join(dir, 'registry.json'));
    expect(reg.holdouts.familySize).toBe(2);
    expect(reg.holdouts.entries.map((e) => [e.universe, e.configId, e.seal])).toEqual([['U1', configId(config, 'U1'), 'registered'], ['U2', configId(config, 'U2'), 'registered']]);
    expect(reg.trials.map((t) => t.trialId).sort()).toEqual([configId(config, 'U1'), configId(config, 'U2')].sort());
    // Reported per regime (here every trade is after B4) and pooled under its own label; 2 days are too few.
    expect(Object.keys(first.gates.G1)).toEqual(expect.arrayContaining(['U1 all regimes (pooled)', 'U2 all regimes (pooled)', 'U2 regime B4']));
    for (const k of Object.keys(first.gates.G1)) expect(k).toMatch(/^U[12] (regime B\d|all regimes \(pooled\)(, sensitivity: no rent recovery)?)$/);
    for (const g of Object.values(first.gates.G1)) expect(g.status).toBe('not-proven');
    expect(first.holdoutRegime).toBe('B4');
    expect(first.gates.G2.status).toBe('not-proven');
    expect(first.holdout.ran).toBe(false);
    // Funnel first: every check in the entry window is counted once, research sample and deployment replay apart.
    for (const side of [first.funnel.research, first.funnel.deployment]) {
      expect(Object.keys(side).length).toBeGreaterThan(0);
      for (const f of Object.values(side)) {
        expect(Object.values(f.checksAt).reduce((t, c) => t + c.adverse + c.notCovered, 0)).toBe(f.checks);
        expect(Object.values(f.mintsAt).reduce((t, c) => t + c.adverse + c.notCovered, 0)).toBe(f.mints);
      }
    }
  });

  it('runs the holdout once into read-only sealed files; G2 stays "not proven" and nothing is opened', () => {
    const second = runFullStudy(inputs({ runHoldout: true }));
    expect(second.holdout.ran).toBe(true);
    const reg = readStudyRegistry(join(dir, 'registry.json'));
    expect(reg.runs).toHaveLength(1);
    expect(reg.runs[0]!.status).toBe('sealed');
    for (const e of reg.holdouts.entries) {
      expect(e.seal).toBe('sealed');
      expect(Object.keys(e.counts!).sort()).toEqual(['candidates', 'entries', 'entryDays']);
      expect(e.burned).toBe(false);
    }
    const ledger = join(dir, 'holdout-2026-09-22-2026-09-22.db');
    expect(statSync(ledger).mode & 0o777).toBe(0o400);
    expect(statSync(`${ledger}.outcomes.json`).mode & 0o777).toBe(0o400);
    expect(second.gates.G2.status).toBe('not-proven');
    expect(second.gates.G2.reasons.join(' ')).toMatch(/sealed entries/);
    // The seals open only after a G1 pass (review consensus); G1 is not proven on 2 days, so they stay closed.
    expect(second.gates.G2.reasons.join(' ')).toMatch(/G1 did not pass: the seal stays closed/);
    // The run is attempt 1 of the shared error budget, at family α 0.04.
    expect(reg.runs[0]).toMatchObject({ attempt: 1, alpha: 0.04 });
    // Asking again does not run it again.
    const third = runFullStudy(inputs({ runHoldout: true }));
    expect(readStudyRegistry(join(dir, 'registry.json')).runs).toHaveLength(1);
    expect(third.holdout.sealHash).toBeNull();
  });

  it('with configurations not frozen, nothing is registered and the holdout refuses to run', () => {
    const other = join(dir, 'unfrozen.json');
    const r = runFullStudy(inputs({ config: { ...config, frozen: false }, registryPath: other }));
    expect(readStudyRegistry(other).holdouts.entries).toEqual([]);
    expect(r.gates.G2.reasons.join(' ')).toMatch(/not frozen/);
    expect(() => runFullStudy(inputs({ config: { ...config, frozen: false }, registryPath: other, runHoldout: true }))).toThrow(/not frozen/);
  });

  it('a second holdout run into a new file is refused and burns the holdout', () => {
    const regPath = join(dir, 'registry.json');
    expect(() => runSealedHoldout(regPath, join(dir, 'again.db'), {
      rows: () => [][Symbol.iterator](), series: [sol], seed: 'x', scenario: 'conservative', policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG,
      windowEnd: 0, study: config, entriesFrom: 0, entriesTo: 0, sampleRate: 1,
    }, { byUniverse: ['U1', 'U2'].map((u) => ({ universe: u, holdoutId: `${u}-2026-09-22-2026-09-22`, configId: configId(config, u) })), required: {} }, [], FILL_CONFIG, 't')).toThrow(/refused and burned/);
    const reg = readStudyRegistry(regPath);
    expect(reg.holdouts.entries.every((e) => e.burned && e.burnReason === 'reconfigured')).toBe(true);
    const after = runFullStudy(inputs());
    expect(after.gates.G2.status).toBe('not-proven');
    expect(after.gates.G2.reasons.join(' ')).toMatch(/burned/);
  });
});
