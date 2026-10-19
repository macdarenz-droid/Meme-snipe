// The whole BT-2 study on a synthetic multi-day market: walk-forward, S0, G1, registration, the sealed holdout run
// once, G2 "not proven" with the seals closed, G0 proofs and the ledger replay check.
import { existsSync, readFileSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import type { DatasetRow } from '../src/dataset/rows.ts';
import { STUDY_CONFIG, configId } from '../src/strategy/config.ts';
import { replayLedgerFile } from '../../core/src/ledger/replay/index.ts';
import { readHoldoutStore, registerAttempt } from '../src/holdout.ts';
import { runSealedHoldout } from '../src/study/sealed.ts';
import { runFullStudy, type StudyInputs } from '../src/study/study.ts';
import { type MintPlan, studyWorld, W0 } from './study-world.ts';
import { SOL_USD } from '../src/dataset/synthetic.ts';
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
const { rows, ownerPrograms } = studyWorld({ leadInDays: 15, blockEvery: 25, slots: 4 * DAY, mints: [plan('d0', 0), plan('d1', 1), plan('d2', 2)] });
const dayOf = (r: DatasetRow) => new Date(r.blockTime * 1000).toISOString().slice(0, 10);
const sol = { ...SOL_USD, bars: Array.from({ length: 24 * 20 }, (_, k) => ({ start: W0 - 16 * 86_400_000 + k * 3_600_000, close: '120.00' })) };
const config = { ...STUDY_CONFIG, frozen: true, window: { decisionFrom: '2026-09-20', decisionTo: '2026-09-22', leadInDays: 14 }, folds: 2, holdout: { fromDay: '2026-09-22', entryCutoff: '2026-09-23T00:00:00Z', tailDays: 1 }, s0SeedsWalkForward: 2, s0SeedsHoldout: 2 };
const decisionDays = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'];
// The research config's holdout matches the study's (the registry refuses a plan that differs).
const research = { ...RESEARCH_CONFIG, holdout: { ...RESEARCH_CONFIG.holdout, fromDay: '2026-09-22', entryCutoffDay: '2026-09-23', tailEndDay: '2026-09-24' } };
const HOLD = '2026-09-22-2026-09-23';
const storeAt = (name = 'registry.json') => readHoldoutStore(join(dir, name));
const authority = (name = 'registry.json') => ({ registryPath: join(dir, name), codeCommit: 'test', datasetId: 'synthetic' });

// Seed 'study3': under BT-1c's conservative fill model its walk-forward entries land (with 'study' and 'study2' the
// draws drop or fail every entry, leaving no trade to score).
const inputs = (over: Partial<StudyInputs> = {}): StudyInputs => ({
  config, policy: TRIAL_POLICY, fills: FILL_CONFIG, research, availableDays: decisionDays,
  rows: (from, to) => () => rows.filter((r) => dayOf(r) >= from && dayOf(r) <= to)[Symbol.iterator](),
  firstDay: '2026-09-05', series: [sol], sampleRate: 1, insiders: () => ({ knownAtMs: 0, funded: [], devCluster: [] }), poolAccounts: POOL_ACCOUNTS, delegatesComplete: true, holders: () => ({ ownerPrograms }),
  // The synthetic world produces no regime inputs: the walk-forward runs as a labelled diagnostic, the holdout as live.
  regimeGate: 'assume-on',
  holdout: authority(), outDir: dir,
  ledgerReplay: (p) => { const r = replayLedgerFile(p); return { ok: r.ok, detail: JSON.stringify(r) }; }, seed: 'study3', replays: 2, runHoldout: false, startedAt: '2026-10-04T00:00:00Z', ...over,
});

describe('BT-2 study', () => {
  const first = runFullStudy(inputs());

  it('runs the walk-forward cleanly through the real engine and scores it outside', () => {
    expect(first.walkForward.stats).toMatchObject({ crashes: 0, illegalStates: 0, unreconciledIntents: 0, mirrorMatches: true });
    expect(first.walkForward.ledgerReplay.ok).toBe(true);
    expect(first.walkForward.ledgerReplay.detail).toContain('"purpose":"backtest"');
    expect(first.walkForward.s0Seeds).toBe(2);
    expect(first.regimeGate).toBe('assumed on (diagnostic)');
    expect(first.plan.walkForward.days).toEqual(['2026-09-20', '2026-09-21']);
    expect(first.plan.holdout).toMatchObject({ fromDay: '2026-09-22', toDay: '2026-09-23' });
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

  it('a diagnostic run (regime assumed on) registers nothing, records no trial or G1, and reports G1 as descriptive only', () => {
    expect(existsSync(join(dir, 'registry.json'))).toBe(false);
    expect(first.holdoutStore).toBeNull();
    for (const g of Object.values(first.gates.G1)) {
      expect(g).toMatchObject({ passed: false, status: 'not-proven' });
      expect(g.reasons[0]).toBe('regime gate assumed on (diagnostic): these counts never feed G1');
    }
  });

  it('sets the plan; registers no attempt while the walk-forward cannot size the requirement; then one per universe, and G1 is not proven on 2 days', () => {
    // Run with the regime gate evaluated as live (the synthetic world has no regime inputs, so nothing enters).
    const evaluated = runFullStudy(inputs({ regimeGate: 'evaluate' }));
    let reg = storeAt();
    expect(reg.plan).toMatchObject({ fromDay: '2026-09-22', entryCutoffDay: '2026-09-23', tailEndDay: '2026-09-24', familySize: 2, tieSalt: config.tieSalt, alpha: { first: 0.04, laterBase: 0.01 } });
    // STATS-1c: a holdout is registered with its frozen size requirement; with no walk-forward trades there is none to
    // freeze, so nothing is registered and no α is spent.
    expect(reg.registry.entries).toEqual([]);
    expect(reg.attempts).toEqual([]);
    expect(evaluated.gates.G2.reasons.join(' ')).toMatch(/size requirement cannot be frozen/);
    // A sized walk-forward registers attempt 1 for both universes (here through the registry, as the study does with
    // the requirement it froze); the next study run finds them and records each G1 result (not a pass: 2 days).
    const requirement = { requiredTrades: 300, requiredDays: 10, nPower: 300, nPowerSeed: 1 };
    registerAttempt(authority(), { index: 1, entries: ['U1', 'U2'].map((u) => ({ holdoutId: `${u}-${HOLD}`, universe: u, configId: configId(config, u), requirement })) });
    const again = runFullStudy(inputs({ regimeGate: 'evaluate' }));
    reg = storeAt();
    expect(reg.registry.familySize).toBe(2);
    expect(reg.registry.entries.map((e) => [e.holdoutId, e.universe, e.configId, e.seal, e.alpha])).toEqual([[`U1-${HOLD}`, 'U1', configId(config, 'U1'), 'registered', 0.04], [`U2-${HOLD}`, 'U2', configId(config, 'U2'), 'registered', 0.04]]);
    expect(reg.attempts.map((a) => [a.index, a.alpha, a.holdoutIds])).toEqual([[1, 0.04, [`U1-${HOLD}`, `U2-${HOLD}`]]]);
    expect(reg.g1.map((g) => [g.holdoutId, g.passed])).toEqual([[`U1-${HOLD}`, false], [`U2-${HOLD}`, false]]);
    // The frozen requirement is the one reported.
    expect(again.holdout.required).toEqual({ U1: 300, U2: 300 });
    // The experiment registry is in the holdout registry (one log per registry, whatever the output directory).
    expect(reg.trials!.map((t) => [t.trialId, t.tag]).sort()).toEqual([[configId(config, 'U1'), 'U1'], [configId(config, 'U2'), 'U2']]);
    // Reported per regime (here every trade is after B4) and pooled under its own label (the diagnostic run has the
    // trades); 2 days are too few.
    expect(Object.keys(first.gates.G1)).toEqual(expect.arrayContaining(['U1 all regimes (pooled)', 'U2 all regimes (pooled)', 'U2 regime B4']));
    for (const k of Object.keys(first.gates.G1)) expect(k).toMatch(/^U[12] (regime B\d|all regimes \(pooled\)(, sensitivity: no rent recovery)?)$/);
    // Without a registered configuration G1 fails its pre-registration check; registered, it is not proven on 2 days.
    for (const g of Object.values(evaluated.gates.G1)) expect(g.checks.find((x) => x.name === 'pre-registration')?.passed).toBe(false);
    for (const g of Object.values(again.gates.G1)) expect(g.status).toBe('not-proven');
    // G1's test is the one stored in the holdout registry, read from the file (STATS-1f), never a constructed object:
    // a stored test G1 does not know fails G1's test check.
    for (const g of Object.values(again.gates.G1)) expect(g.checks.find((x) => x.name === 'G1 test')).toMatchObject({ passed: true, detail: `stored in the registry: ${reg.registry.g1Test}` });
    const path = join(dir, 'registry.json');
    const stored = readFileSync(path, 'utf8');
    writeFileSync(path, stored.replace(`"g1Test": "${reg.registry.g1Test}"`, '"g1Test": "bogus"'));
    const tampered = runFullStudy(inputs({ regimeGate: 'evaluate' }));
    writeFileSync(path, stored);
    for (const g of Object.values(tampered.gates.G1)) expect(g.checks.find((x) => x.name === 'G1 test')).toMatchObject({ passed: false });
    expect(evaluated.holdoutRegime).toBe('B4');
    expect(evaluated.gates.G2.status).toBe('not-proven');
    expect(evaluated.holdout.ran).toBe(false);
    // Funnel first: every check in the entry window is counted once, research sample and deployment replay apart.
    for (const side of [evaluated.funnel.research, evaluated.funnel.deployment]) {
      expect(Object.keys(side).length).toBeGreaterThan(0);
      for (const f of Object.values(side)) {
        expect(Object.values(f.checksAt).reduce((t, c) => t + c.adverse + c.notCovered, 0)).toBe(f.checks);
        expect(Object.values(f.mintsAt).reduce((t, c) => t + c.adverse + c.notCovered, 0)).toBe(f.mints);
      }
    }
  });

  it('runs the holdout once into read-only sealed files; G2 stays "not proven" and nothing is opened', () => {
    const second = runFullStudy(inputs({ runHoldout: true, regimeGate: 'evaluate' }));
    expect(second.holdout.ran).toBe(true);
    const reg = storeAt();
    // One start record and one seal per universe, written through the registry.
    expect(reg.runs.map((r) => [r.holdoutId, r.outcome])).toEqual([[`U1-${HOLD}`, 'started'], [`U2-${HOLD}`, 'started'], [`U1-${HOLD}`, 'sealed'], [`U2-${HOLD}`, 'sealed']]);
    expect(reg.attempts[0]!.ended?.outcome).toBe('sealed');
    for (const e of reg.registry.entries) {
      expect(e.seal).toBe('sealed');
      expect(Object.keys(e.counts!).sort()).toEqual(['candidates', 'entries', 'entryDays']);
      expect(e.burned).toBe(false);
    }
    const ledger = join(dir, `holdout-${HOLD}.db`);
    expect(statSync(ledger).mode & 0o777).toBe(0o400);
    expect(statSync(`${ledger}.outcomes.json`).mode & 0o777).toBe(0o400);
    expect(second.gates.G2.status).toBe('not-proven');
    expect(second.gates.G2.reasons.join(' ')).toMatch(/sealed entries/);
    // The seals open only after a G1 pass (review consensus); G1 is not proven on 2 days, so they stay closed.
    expect(second.gates.G2.reasons.join(' ')).toMatch(/G1 did not pass: the seal stays closed/);
    // Asking again does not run it again.
    const third = runFullStudy(inputs({ runHoldout: true, regimeGate: 'evaluate' }));
    expect(storeAt().runs).toHaveLength(4);
    expect(third.holdout.sealHash).toBeNull();
  });

  it('with configurations not frozen, nothing is registered and the holdout refuses to run', () => {
    const r = runFullStudy(inputs({ config: { ...config, frozen: false }, holdout: authority('unfrozen.json'), regimeGate: 'evaluate' }));
    expect(storeAt('unfrozen.json').registry.entries).toEqual([]);
    expect(storeAt('unfrozen.json').attempts).toEqual([]);
    expect(r.gates.G2.reasons.join(' ')).toMatch(/not frozen/);
    expect(() => runFullStudy(inputs({ config: { ...config, frozen: false }, holdout: authority('unfrozen.json'), runHoldout: true, regimeGate: 'evaluate' }))).toThrow(/not frozen/);
    // A diagnostic run with the regime assumed on never runs the holdout.
    expect(() => runFullStudy(inputs({ holdout: authority('registry-diag.json'), runHoldout: true }))).toThrow(/regime gate is assumed on/);
  });

  it('studies only pre-registered hypotheses: a configuration outside the family is refused before anything runs', () => {
    const family = { sha256: 'x', hypotheses: [{ ...config.universes[1]!, id: 'H4-U2-reclaim' }] };
    expect(() => runFullStudy(inputs({ preregistration: family, holdout: authority('prereg.json') }))).toThrow(/U1, U2 are not pre-registered hypotheses/);
    expect(existsSync(join(dir, 'prereg.json'))).toBe(false);
  });

  it('with RES-4\'s family: every hypothesis on its own replay and in the experiment registry; on 2 practice days the SPA picks none, so nothing is registered', () => {
    const [u1, u2] = config.universes;
    const fam = { sha256: 'f'.repeat(64), hypotheses: [{ ...u1!, id: 'H1-U1' }, { ...u2!, id: 'H4-U2' }, { ...u2!, id: 'H5-U2', medianTargetBps: u2!.medianTargetBps + 1 }] };
    const cfg = { ...config, universes: [fam.hypotheses[0]!, fam.hypotheses[1]!] };
    const r = runFullStudy(inputs({ config: cfg, preregistration: fam, holdout: authority('family.json'), regimeGate: 'evaluate' }));
    expect(r.family!.panel.map((v) => v.variant)).toEqual(['H1-U1', 'H4-U2', 'H5-U2']);
    expect(r.family!.selection).toMatchObject({ byUniverse: { U1: null, U2: null }, spa: null });
    const reg = storeAt('family.json');
    expect(reg.plan!.details['preregistration']).toEqual({ sha256: fam.sha256, ids: ['H1-U1', 'H4-U2', 'H5-U2'] });
    expect(reg.trials!.map((t) => t.tag).sort()).toEqual(['H1-U1', 'H4-U2', 'H5-U2']);
    expect(reg.attempts).toEqual([]);
    expect(r.gates.G2.reasons.join(' ')).toMatch(/not the SPA pick for U2 \(\d+ practice days on the calendar: the SPA test needs at least 10\)/);
    expect(() => runFullStudy(inputs({ config: cfg, preregistration: fam, holdout: authority('family.json'), regimeGate: 'evaluate', runHoldout: true }))).toThrow(/no configuration is the SPA pick/);
  });

  it('a second holdout run into a new file is refused and logged; the sealed holdout is untouched', () => {
    const before = storeAt();
    expect(() => runSealedHoldout(authority(), join(dir, 'again.db'), {
      rows: () => [][Symbol.iterator](), series: [sol], seed: 'x', scenario: 'conservative', policy: TRIAL_POLICY, fills: FILL_CONFIG, research,
      windowEnd: 0, study: config, entriesFrom: 0, entriesTo: 0, sampleRate: 1,
    }, { byUniverse: ['U1', 'U2'].map((u) => ({ universe: u, holdoutId: `${u}-${HOLD}`, configId: configId(config, u) })), required: {}, window: { fromDay: '2026-09-22', toDay: '2026-09-23' } }, [], FILL_CONFIG)).toThrow(/window already run/);
    const reg = storeAt();
    expect(reg.registry).toEqual(before.registry);
    expect(reg.runs.at(-1)).toMatchObject({ holdoutId: `U1-${HOLD}`, outcome: 'refused', reason: 'window already run' });
    expect(existsSync(join(dir, 'again.db'))).toBe(false);
  });
});
