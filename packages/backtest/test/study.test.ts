// BT-2 study runs on a synthetic market through the real engine: gates, setup, RISK-1 sizing, EXIT-1 exits, S0.
import { describe, expect, it, vi } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import type { LogRecord } from '../../core/src/engine/index.ts';
import { runStudy, type StudyRunOptions } from '../src/study/run.ts';
import { STUDY_CONFIG, configId } from '../src/strategy/config.ts';
import { tradesOf } from '../src/trades.ts';
import { mintHashFraction } from '../src/sim/facts.ts';
import { key, type MintPlan, studyWorld, W0 } from './study-world.ts';
import { SOL_USD } from './synthetic.ts';
import { POOL_ACCOUNTS } from './study-world.ts';

vi.setConfig({ testTimeout: 300_000 });

const MIN = 150;
/** A U2 setup: an even first minutes, a dump to a flush, then a slow reclaim on more buyers than sellers. */
const reclaim = (since: number) => (since < 5 * MIN ? 0.5 : since < 50 * MIN ? 0.15 : 0.55);
const SETUP: MintPlan = { label: 'a', createSlot: 10, graduateAfter: 20 * MIN, migrationQuote: 400_000_000_000n, buyBias: reclaim, swapEvery: 10, buySize: 3e9, sellDivisor: 8 };
const SLOTS = 10 + 20 * MIN + 260 * MIN;
const sol = { ...SOL_USD, bars: Array.from({ length: 24 * 20 }, (_, k) => ({ start: W0 - 16 * 86_400_000 + k * 3_600_000, close: '120.00' })) };

const run = (plans: readonly MintPlan[], over: Partial<StudyRunOptions> = {}) => {
  const { rows, mints } = studyWorld({ leadInDays: 15, slots: SLOTS, mints: plans });
  const r = runStudy({
    rows: () => rows[Symbol.iterator](), series: [sol], seed: 'e', scenario: 'conservative', policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG,
    windowEnd: W0 + 12 * 3_600_000, study: STUDY_CONFIG, mode: 'strategy', entriesFrom: W0, entriesTo: W0 + 10 * 3_600_000, sampleRate: 1,
    insiders: () => ({ knownAtMs: 0, funded: [], devCluster: [] }), poolAccounts: POOL_ACCOUNTS, delegatesComplete: true, ...over,
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
    // fills-2: the final sell landed, so the conservative scenario returns the token-account rent with it.
    expect(trades[0]!.exitReason).toBe('time-stop');
    expect(trades[0]!.rentReturned).toBe(FILL_CONFIG.network.tokenAccountRent);
    // The exit came from EXIT-1's rules, booked under a lifecycle reason.
    expect(decisions(r.records).some((d) => /^exit (time_flat|time_max|price_stop|take_profit|negative_flow|trailing_stop|break_even|liquidity_drop)/.test(d.reasons[0]!))).toBe(true);
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

  it('charges the read latency: with reads landing 2 min after the check, the entry is 2 min later, at that moment\'s prices', () => {
    const now = run([SETUP]);
    const late = run([SETUP], { readLatencyMs: 120_000 });
    const t0 = tradesOf(now.r, FILL_CONFIG).trades[0]!;
    const t1 = tradesOf(late.r, FILL_CONFIG).trades[0]!;
    expect(t1.openedAt - t0.openedAt).toBeGreaterThanOrEqual(120_000);
  });

  it('a spent read budget leaves the candidate "not evaluated", never a pass', () => {
    const r = run([SETUP], { readBudget: () => false });
    expect(decisions(r.r.records).filter((d) => d.reasons[0] === 'enter')).toHaveLength(0);
    expect(decisions(r.r.records).some((d) => d.reasons[0] === 'not evaluated' && d.reasons[3] === 'read budget spent')).toBe(true);
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
    const dep = run(two, { mode: 'deployment', onStrategy: (x) => { stats = x.deployment; } });
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

  it('deployment replay: S0 runs under the same one-position rule, under its own tags', () => {
    const four = ['a', 'b', 'c', 'd'].map((label) => ({ ...SETUP, label, creator: label }));
    let bound = false;
    for (const seed of ['d0', 'd1', 'd2', 'd3']) {
      const overlap = (ts: readonly { openedAt: number; closedAt: number }[]) => ts.some((t, i) => i > 0 && t.openedAt < ts[i - 1]!.closedAt);
      const research = tradesOf(run(four, { mode: 's0', seed }).r, FILL_CONFIG).trades;
      const dep = run(four, { mode: 'deployment-s0', seed });
      expect(dep.r.stats).toMatchObject({ crashes: 0, illegalStates: 0, unreconciledIntents: 0 });
      const trades = tradesOf(dep.r, FILL_CONFIG).trades;
      expect(trades.every((t) => t.id.startsWith('p:S0-U'))).toBe(true);
      expect(overlap(trades)).toBe(false);
      if (overlap(research)) bound = true;
    }
    // On at least one seed the research S0 held two at once, so the rule was binding there.
    expect(bound).toBe(true);
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
