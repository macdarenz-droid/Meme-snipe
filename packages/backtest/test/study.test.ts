// BT-2 study runs on a synthetic market through the real engine: gates, setup, RISK-1 sizing, EXIT-1 exits, S0.
import { describe, expect, it, vi } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import type { LogRecord } from '../../core/src/engine/index.ts';
import { runStudy, type StudyRunOptions } from '../src/study/run.ts';
import { STUDY_CONFIG, configId } from '../src/strategy/config.ts';
import { tradesOf } from '../src/trades.ts';
import { devFunderOf, NO_CLUSTER, scoreRun } from '../src/study/score.ts';
import { mintHashFraction } from '../src/sim/facts.ts';
import { key, type MintPlan, studyWorld, W0, WSLOT0 } from './study-world.ts';
import { SOL_USD } from './synthetic.ts';
import { oneTimeRent } from '../../worker/src/run/settings.ts';
import { ASSUMPTIONS } from '../../worker/src/facts/budget.ts';
import { HOLDER_SCANS_PER_DAY } from '../../worker/src/facts/readers.ts';
import { DEFAULT_LIVE_FEED } from '../../worker/src/providers/live-feed.ts';
import { READ_LATENCY, READ_LIMITS } from '../src/study/reads.ts';
import { POOL_ACCOUNTS } from './study-world.ts';

vi.setConfig({ testTimeout: 300_000 });

const MIN = 150;
/** A U2 setup: an even first minutes, a dump to a flush, then a slow reclaim on more buyers than sellers. */
const reclaim = (since: number) => (since < 5 * MIN ? 0.5 : since < 50 * MIN ? 0.15 : 0.55);
const SETUP: MintPlan = { label: 'a', createSlot: 10, graduateAfter: 20 * MIN, migrationQuote: 400_000_000_000n, buyBias: reclaim, swapEvery: 10, buySize: 3e9, sellDivisor: 8 };
const SLOTS = 10 + 20 * MIN + 260 * MIN;
const sol = { ...SOL_USD, bars: Array.from({ length: 24 * 20 }, (_, k) => ({ start: W0 - 16 * 86_400_000 + k * 3_600_000, close: '120.00' })) };

// Seed 'e2': its entry draws land under BT-1c's conservative fill model (with 'e' a provider-outage window drops the
// one entry; the mechanics under test need it to land).
const run = (plans: readonly MintPlan[], over: Partial<StudyRunOptions> = {}) => {
  const { rows, mints, ownerPrograms } = studyWorld({ leadInDays: 15, slots: SLOTS, mints: plans });
  const r = runStudy({
    rows: () => rows[Symbol.iterator](), series: [sol], seed: 'e2', scenario: 'conservative', policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG,
    windowEnd: W0 + 12 * 3_600_000, study: STUDY_CONFIG, mode: 'strategy', entriesFrom: W0, entriesTo: W0 + 10 * 3_600_000, sampleRate: 1,
    // No regime inputs in the synthetic world: runs assume it on (labelled diagnostic) unless a test evaluates it.
    insiders: () => ({ knownAtMs: 0, funded: [], devCluster: [] }), poolAccounts: POOL_ACCOUNTS, delegatesComplete: true, regime: 'assume-on', holders: { ownerPrograms }, ...over,
  });
  return { r, mints };
};
const decisions = (records: readonly LogRecord[]) => records.filter((x): x is Extract<LogRecord, { type: 'decision' }> => x.type === 'decision');
const rejects = (records: readonly LogRecord[]) => decisions(records).filter((d) => d.reasons[0] === 'reject').flatMap((d) => d.reasons.slice(3));

describe('BT-2 study runs', () => {
  const base = run([SETUP]);

  it('enters a U2 setup through every gate, RISK-1 and EXIT-1, with a clean book', () => {
    const { r } = base;
    expect(r.stats).toMatchObject({ crashes: 0, illegalStates: 0, unreconciledIntents: 0, mirrorMatches: true });
    const enters = decisions(r.records).filter((d) => d.reasons[0] === 'enter');
    expect(enters).toHaveLength(1);
    expect(enters[0]!.reasons[1]).toBe('U2');
    const { trades } = tradesOf(r, FILL_CONFIG);
    expect(trades).toHaveLength(1);
    expect(trades[0]!.exitReason).toBe('time-stop');
    // RENT-1 (base): the token-account rent comes back exactly when a sell-and-close landed, in every scenario.
    const closed = r.attempts.some((a) => a.purpose === 'exit' && a.closedAccount);
    expect(trades[0]!.rentReturned).toBe(closed ? FILL_CONFIG.network.tokenAccountRent : 0n);
    // The exit came from EXIT-1's rules, booked under a lifecycle reason.
    expect(decisions(r.records).some((d) => /^exit (time_flat|time_max|price_stop|take_profit|negative_flow|trailing_stop|break_even|liquidity_drop)/.test(d.reasons[0]!))).toBe(true);
  });

  it('labels each scored trade with its creator and the dev\'s first funder; an incomplete read leaves no funder label', () => {
    const { r } = base;
    const t = tradesOf(r, FILL_CONFIG).trades[0]!;
    const read = (wallet: string, complete: boolean, funder: string | null) => ({ wallet, asOfSlot: 1n, complete, funder, signature: null, slot: funder === null ? null : 1n, atMs: funder === null ? null : 1 });
    const creator = scoreRun(r, FILL_CONFIG)[0]!.creatorCluster;
    expect(creator).not.toBe(NO_CLUSTER);
    const rows = (dev: ReturnType<typeof read>) => new Map([[t.mint, { creator, reads: [read('buyer', true, 'x'), dev] }]]);
    expect(scoreRun(r, FILL_CONFIG, devFunderOf(rows(read(creator, true, 'F1'))))[0]).toMatchObject({ creatorCluster: creator, funderCluster: 'F1' });
    // Incomplete, funderless or absent: no label (G2 fails it), never a shared "unknown".
    expect(scoreRun(r, FILL_CONFIG, devFunderOf(rows(read(creator, false, 'F1'))))[0]!.funderCluster).toBe(NO_CLUSTER);
    expect(scoreRun(r, FILL_CONFIG, devFunderOf(rows(read(creator, true, null))))[0]!.funderCluster).toBe(NO_CLUSTER);
    expect(scoreRun(r, FILL_CONFIG)[0]!.funderCluster).toBe(NO_CLUSTER);
    expect(NO_CLUSTER).toBe('');
  });

  it('sees facts, checks and read landings after the observation delay; the delay alone makes nothing stale, and the fill pays for it', () => {
    const delayed = base.r;
    const recorded = run([SETUP], { observation: 'recorded' }).r;
    for (const r of [delayed, recorded]) expect(rejects(r.records).filter((x) => x.includes(':stale'))).toEqual([]);
    const enter = (r: typeof delayed) => decisions(r.records).find((d) => d.reasons[0] === 'enter')!;
    // Conservative uses the adverse profile: 2 + 6 slots to confirmed, 1 s to the worker.
    const slots = FILL_CONFIG.delays.adverse.eventToProcessedSlots + FILL_CONFIG.delays.adverse.processedToConfirmedSlots;
    expect(FILL_CONFIG.scenarios.conservative.delay).toBe('adverse');
    expect(enter(delayed).at.slot - enter(recorded).at.slot).toBeGreaterThanOrEqual(BigInt(slots));
    const opened = (r: typeof delayed) => tradesOf(r, FILL_CONFIG).trades[0]!.openedAt;
    expect(opened(delayed)).toBeGreaterThan(opened(recorded));
  });

  it('runs a hypothesis under its id: positions, decisions and the configuration id carry it; one configuration per universe per run', () => {
    const study = { ...STUDY_CONFIG, universes: STUDY_CONFIG.universes.map((u) => (u.universe === 'U2' ? { ...u, id: 'H4-U2-reclaim' } : u)) };
    const { r } = run([SETUP], { study });
    const enters = decisions(r.records).filter((d) => d.reasons[0] === 'enter');
    expect(enters.map((d) => d.reasons[1])).toEqual(['H4-U2-reclaim']);
    expect(tradesOf(r, FILL_CONFIG).trades.map((t) => t.id.split(':')[1])).toEqual(['H4-U2-reclaim']);
    expect(configId(study, 'H4-U2-reclaim')).toMatch(/^H4-U2-reclaim-/);
    // The same universe twice in one run is refused: hypotheses of one universe run one at a time.
    const u2 = STUDY_CONFIG.universes.find((u) => u.universe === 'U2')!;
    expect(() => run([SETUP], { study: { ...STUDY_CONFIG, universes: [{ ...u2, id: 'a' }, { ...u2, id: 'b' }] } })).toThrow(/one configuration per universe in a run/);
  });

  it('replays to the same decision log', () => {
    expect(run([SETUP]).r.logHash).toBe(base.r.logHash);
  });

  it('rejects every candidate on H13 without a funding source (the DATA-1 dataset today)', () => {
    const { r } = run([SETUP], { insiders: undefined });
    expect(decisions(r.records).filter((d) => d.reasons[0] === 'enter')).toHaveLength(0);
    const rj = decisions(r.records).filter((d) => d.reasons[0] === 'reject');
    expect(rj.length).toBeGreaterThan(0);
    expect(rj.every((d) => d.reasons.includes('H13:not-covered'))).toBe(true);
  });

  it.each([
    ['H2', { keepMintAuthority: true }, 'H2:mint-authority'],
    ['H4', { extraExtension: { kind: 'PermanentDelegate', type: 12 } }, 'H4:extension-blocked'],
    ['H9', { graduateAfter: 4 * MIN }, 'H9:instant-graduation'],
    ['H5 tail', { tail: { after: 30 * MIN, hex: '0100000000000000' } }, 'H5:event-tail'],
    ['H1-H4 unknown', { noCreateRaw: true }, 'H1:missing'],
  ] as const)('%s: the gate rejects with its reason in the log', (_, patch, code) => {
    const { r } = run([{ ...SETUP, ...patch }]);
    expect(decisions(r.records).filter((d) => d.reasons[0] === 'enter')).toHaveLength(0);
    expect(rejects(r.records)).toContain(code);
  });

  it('evaluates the regime gate first, as live: without its inputs every check stops at "regime off" (not covered)', () => {
    let st: import('../src/strategy/study.ts').StudyStrategy | null = null;
    const r = run([SETUP], { regime: 'evaluate', onStrategy: (x) => { st = x; } }).r;
    expect(decisions(r.records).filter((d) => d.reasons[0] === 'enter')).toHaveLength(0);
    expect(decisions(r.records).some((d) => d.reasons[0] === 'regime off' && d.reasons.slice(3).every((x) => x.startsWith('unknown')))).toBe(true);
    const f = (st as unknown as import('../src/strategy/study.ts').StudyStrategy).funnel.summary()['U2']!;
    expect(Object.keys(f.checksAt)).toEqual(['regime off']);
    expect(f.checksAt['regime off']).toEqual({ adverse: 0, notCovered: f.checks });
  });

  it('stages the gates (FACTS-1): a stage-1 reject asks no reads, so stage-2 gates are "not evaluated"; past stage 1, H8 rejects', () => {
    const dust = { ...SETUP, migrationQuote: 4_000_000_000n };
    // A dust pool's candles trip H11 (stage 1) first: H8 (stage 2) is never read.
    const main = run([dust]);
    const rj = decisions(main.r.records).filter((d) => d.reasons[0] === 'reject');
    expect(rj.length).toBeGreaterThan(0);
    for (const d of rj) {
      expect(d.reasons.some((x) => x.startsWith('H11:'))).toBe(true);
      expect(d.reasons.at(-1)).toMatch(/^not evaluated: .*\bH8\b/);
      expect(d.reasons).not.toContain('H8:dust-at-migration');
    }
    // With H11 ablated, stage 1 lets it through, the reads land, and H8 rejects it in stage 2.
    const past = run([dust], { ablate: ['H11'] });
    expect(rejects(past.r.records)).toContain('H8:dust-at-migration');
    expect(decisions(past.r.records).filter((d) => d.reasons[0] === 'enter')).toHaveLength(0);
  });

  it('decides an entry only when the stage-3 answers land, never at the check itself', () => {
    const { r } = base;
    const enters = decisions(r.records).filter((d) => d.reasons[0] === 'enter');
    expect(enters.length).toBeGreaterThan(0);
    for (const d of enters) expect(d.eventId).toMatch(/^r:\d{9}:.*~landed$/);
  });

  it('re-runs every stage at the decision moment (audit B2): a stage-1 gate that fails after the check stops the entry at the landing', () => {
    const one = run([{ ...SETUP, creator: 'dev' }]);
    const enter = decisions(one.r.records).find((d) => d.reasons[0] === 'enter');
    expect(enter).toBeDefined();
    const landed = Number(enter!.at.slot - WSLOT0);
    // Two more mints by the same deployer, created after the passing check and before its reads land: H14 (stage 1)
    // calls it a serial deployer at the decision moment. A stage-1 pass carried from the check would enter anyway.
    const later = run([{ ...SETUP, creator: 'dev' }, ...[0, 1].map((k) => ({ ...SETUP, label: `late${k}`, creator: 'dev', createSlot: landed - 12 + k, swapsFor: 1 }))]);
    const mint = enter!.reasons[2];
    expect(decisions(later.r.records).filter((d) => d.reasons[0] === 'enter' && d.reasons[2] === mint)).toHaveLength(0);
    expect(decisions(later.r.records).some((d) => d.reasons[0] === 'reject' && d.reasons[2] === mint && d.reasons.includes('H14:serial-deployer'))).toBe(true);
  });

  it('the holder scan budget is the live cap: spent, H12 and H13 are "not evaluated", never a pass', () => {
    const r = run([SETUP], { readLimits: { ...READ_LIMITS, holderScansPerUtcDay: 0 } });
    expect(decisions(r.r.records).filter((d) => d.reasons[0] === 'enter')).toHaveLength(0);
    expect(decisions(r.r.records).some((d) => d.reasons[0] === 'not evaluated' && d.reasons[3] === 'holder scan budget spent')).toBe(true);
  });

  it('defaults to the live read caps and conservative latencies, never kinder than live', () => {
    expect(READ_LIMITS).toEqual({ holderScansPerUtcDay: HOLDER_SCANS_PER_DAY, minReadGapMs: 60_000 / ASSUMPTIONS.evaluationsPerMinute });
    expect(READ_LIMITS).toEqual({ holderScansPerUtcDay: 100, minReadGapMs: 60_000 });
    expect(READ_LATENCY).toEqual({ accountsMs: 500, holderScanMs: 5_000, feedReleaseMs: DEFAULT_LIVE_FEED.staleReleaseMs });
  });

  it('H14: a serial deployer is rejected, and so is a deployer with a mint outside the sample', () => {
    const serial = run([0, 1, 2].map((k) => ({ ...SETUP, label: `s${k}`, creator: 'dev', createSlot: 10 + k * 20 })));
    expect(rejects(serial.r.records)).toContain('H14:serial-deployer');
    // Two mints of one deployer, the first outside the sample: the second cannot be judged on prior rugs.
    let labels: [string, string] | null = null;
    for (let k = 0; k < 50 && labels === null; k++) {
      const a = mintHashFraction(key(`w:mint:x${k}`))!;
      const b = mintHashFraction(key(`w:mint:y${k}`))!;
      if (a > b) labels = [`x${k}`, `y${k}`];
    }
    const [outside, inside] = labels!;
    const rate = (mintHashFraction(key(`w:mint:${outside}`))! + mintHashFraction(key(`w:mint:${inside}`))!) / 2;
    const two = run([{ ...SETUP, label: outside, creator: 'dev2', createSlot: 10, swapsFor: 1 }, { ...SETUP, label: inside, creator: 'dev2', createSlot: 30 }], { sampleRate: rate });
    expect(rejects(two.r.records)).toContain('H14:not-covered');
  });

  it('S0 and the setups enter only on a current SOL/USD close (at most 2 h old): a series that stops is "not covered", never an old price', () => {
    // The hourly series ends three hours before the entry window: the last close is stale for every check.
    const short = { ...sol, bars: sol.bars.filter((b) => b.start < W0 - 3 * 3_600_000) };
    for (const mode of ['strategy', 's0'] as const) {
      const r = run([SETUP], { mode, seed: 's0-1', series: [short] });
      expect(decisions(r.r.records).filter((d) => d.reasons[0] === 'enter'), mode).toHaveLength(0);
      expect(decisions(r.r.records).some((d) => d.reasons[0] === 'no entry' && d.reasons[3] === 'SOL/USD stale'), mode).toBe(true);
    }
  });

  it('S0 enters at a seeded random eligible check, with the same gates', () => {
    const a = run([SETUP], { mode: 's0', seed: 's0-1' });
    const b = run([SETUP], { mode: 's0', seed: 's0-2' });
    for (const x of [a, b]) expect(x.r.stats).toMatchObject({ crashes: 0, illegalStates: 0, unreconciledIntents: 0 });
    const first = (x: typeof a) => decisions(x.r.records).find((d) => d.reasons[0] === 'candidate')?.at.receivedAt;
    expect(first(a)).not.toBe(first(b));
    const none = run([SETUP], { mode: 's0', insiders: undefined });
    expect(decisions(none.r.records).filter((d) => d.reasons[0] === 'enter')).toHaveLength(0);
  });

  it('deployment replay: one position at a time; a simultaneous second setup is a rejected opportunity', () => {
    const two = [SETUP, { ...SETUP, label: 'b', creator: 'b' }];
    const broad = run(two);
    expect(decisions(broad.r.records).filter((d) => d.reasons[0] === 'enter')).toHaveLength(2);
    let stats: import('../src/strategy/study.ts').DeploymentStats | null = null;
    // Seed 'd3': the first deployment entry lands, so the second setup meets a busy book.
    const dep = run(two, { mode: 'deployment', seed: 'd3', onStrategy: (x) => { stats = x.deployment; } });
    expect(dep.r.stats).toMatchObject({ crashes: 0, illegalStates: 0, unreconciledIntents: 0 });
    const enters = decisions(dep.r.records).filter((d) => d.reasons[0] === 'enter');
    expect(enters.length).toBeGreaterThanOrEqual(1);
    // Never two open at once.
    const { trades } = tradesOf(dep.r, FILL_CONFIG);
    for (let i = 1; i < trades.length; i++) expect(trades[i]!.openedAt).toBeGreaterThanOrEqual(trades[i - 1]!.closedAt);
    const s = stats as unknown as import('../src/strategy/study.ts').DeploymentStats;
    expect(Object.values(s.rejected).reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    expect(s.peakEquityUsd).toBeGreaterThan(0n);
  });

  it('deployment replay books the wallet setup rent as live does: equity starts at bankroll minus the rent', () => {
    let st: import('../src/strategy/study.ts').StudyStrategy | null = null;
    run([SETUP], { mode: 'deployment', onStrategy: (x) => { st = x; } });
    const s = st as unknown as import('../src/strategy/study.ts').StudyStrategy;
    const rent = oneTimeRent(FILL_CONFIG);
    expect(rent).toBeGreaterThan(0n);
    // SOL/USD is 120.00 all day: the rent in micro-dollars, rounded up.
    const cost = (rent * 120_000_000n + 999_999_999n) / 1_000_000_000n;
    expect(s.walletSetup).toEqual({ atMs: W0, amount: cost, kind: 'wallet_setup' });
    // NAV values the wallet in lamports and back (floor both ways): at most one micro-dollar below bankroll − rent.
    const nav = s.navMarks[0]!.nav;
    expect(nav).toBeLessThanOrEqual(TRIAL_POLICY.capital.bankroll - cost);
    expect(nav).toBeGreaterThanOrEqual(TRIAL_POLICY.capital.bankroll - cost - 1n);
  });

  it('deployment replay: S0 runs under the same one-position rule, under its own tags', () => {
    const four = ['a', 'b', 'c', 'd'].map((label) => ({ ...SETUP, label, creator: label }));
    let busy = 0;
    for (const seed of ['d0', 'd1', 'd2', 'd3']) {
      const overlap = (ts: readonly { openedAt: number; closedAt: number }[]) => ts.some((t, i) => i > 0 && t.openedAt < ts[i - 1]!.closedAt);
      let stats: import('../src/strategy/study.ts').DeploymentStats | null = null;
      const dep = run(four, { mode: 'deployment-s0', seed, onStrategy: (x) => { stats = x.deployment; } });
      expect(dep.r.stats).toMatchObject({ crashes: 0, illegalStates: 0, unreconciledIntents: 0 });
      const trades = tradesOf(dep.r, FILL_CONFIG).trades;
      expect(trades.every((t) => t.id.startsWith('p:S0-U'))).toBe(true);
      expect(overlap(trades)).toBe(false);
      busy += (stats as unknown as import('../src/strategy/study.ts').DeploymentStats).rejected['R3:book busy'] ?? 0;
    }
    // The rule was binding: S0 checks were refused while its one position was open.
    expect(busy).toBeGreaterThan(0);
  });

  it('a RES-3 feature rule enters when its conditions hold on the as-of features, and never when one fails', () => {
    const withRule = (conds: { f: 'f_liq' | 'f_age'; dir: 'ge' | 'le'; t: string }[]) => ({
      ...STUDY_CONFIG,
      universes: STUDY_CONFIG.universes.map((u) => (u.universe === 'U2' ? { ...u, rules: { kind: 'features' as const, conds, stopBelowBps: 2000 } } : u)),
    });
    const holds = run([SETUP], { study: withRule([{ f: 'f_liq', dir: 'ge', t: '0' }]) });
    expect(holds.r.stats).toMatchObject({ crashes: 0, illegalStates: 0, unreconciledIntents: 0 });
    expect(decisions(holds.r.records).filter((d) => d.reasons[0] === 'enter' && d.reasons[1] === 'U2')).toHaveLength(1);
    const fails = run([SETUP], { study: withRule([{ f: 'f_liq', dir: 'ge', t: '0' }, { f: 'f_liq', dir: 'le', t: '-1' }]) });
    expect(decisions(fails.r.records).filter((d) => d.reasons[0] === 'enter' && d.reasons[1] === 'U2')).toHaveLength(0);
    expect(decisions(fails.r.records).some((d) => d.reasons[0] === 'no setup' && /f_liq .* > -1/.test(d.reasons[3] ?? ''))).toBe(true);
  });

  it('ablation: a candidate blocked only by H9 is entered on paper under its own tag; one passing every gate is not', () => {
    const blocked = run([{ ...SETUP, graduateAfter: 4 * MIN }], { ablate: ['H9'] });
    const enters = decisions(blocked.r.records).filter((d) => d.reasons[0] === 'enter');
    expect(enters.length).toBe(1);
    expect(enters[0]!.reasons[1]).toBe('U2-noH9');
    expect(decisions(blocked.r.records).some((d) => d.reasons[0] === 'ablation' && d.reasons.includes('H9:instant-graduation'))).toBe(true);
    const passing = run([SETUP], { ablate: ['H9'] });
    expect(decisions(passing.r.records).filter((d) => d.reasons[0] === 'enter')).toHaveLength(0);
    // Another failing gate keeps it out.
    const two = run([{ ...SETUP, graduateAfter: 4 * MIN, keepMintAuthority: true }], { ablate: ['H9'] });
    expect(decisions(two.r.records).filter((d) => d.reasons[0] === 'enter')).toHaveLength(0);
  });

  it('charges the fees in force at each trade\'s slot (a fee change before the entry is paid, never today\'s fees)', () => {
    const before = tradesOf(base.r, FILL_CONFIG).trades[0]!;
    // The pool's fees change 30 min after migration, well before the U2 window opens at 60 min.
    const changed = run([{ ...SETUP, feesFrom: { since: 30 * MIN, lp: 50, protocol: 20, creator: 95 } }]);
    const after = tradesOf(changed.r, FILL_CONFIG).trades[0]!;
    // Venue fees are LP + protocol on both legs: 25 bps before the change, 70 bps after it.
    const rate = (t: typeof before) => Number(t.venueFee) / Number(t.entrySol + t.exitSol);
    expect(rate(before)).toBeGreaterThan(0.002);
    expect(rate(before)).toBeLessThan(0.003);
    expect(rate(after)).toBeGreaterThan(0.006);
    expect(rate(after)).toBeLessThan(0.008);
  });

  it('identifies each pre-registered configuration by its content', () => {
    expect(configId(STUDY_CONFIG, 'U2')).toMatch(/^U2-[0-9a-f]{16}$/);
    expect(configId(STUDY_CONFIG, 'U1')).not.toBe(configId(STUDY_CONFIG, 'U2'));
    const changed = { ...STUDY_CONFIG, universes: STUDY_CONFIG.universes.map((u) => (u.universe === 'U2' ? { ...u, medianTargetBps: u.medianTargetBps + 1 } : u)) };
    expect(configId(changed, 'U2')).not.toBe(configId(STUDY_CONFIG, 'U2'));
    expect(configId(changed, 'U1')).toBe(configId(STUDY_CONFIG, 'U1'));
    expect(STUDY_CONFIG.universes.map((u) => u.universe)).toEqual(['U1', 'U2']);
  });
});
