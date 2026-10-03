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
    insiders: () => ({ knownAtMs: 0, funded: [], devCluster: [] }), ...over,
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
    ['H8', { migrationQuote: 4_000_000_000n }, 'H8:dust-at-migration'],
    ['H9', { graduateAfter: 4 * MIN }, 'H9:instant-graduation'],
    ['H5 tail', { tail: { after: 30 * MIN, hex: '0100000000000000' } }, 'H5:event-tail'],
    ['H1-H4 unknown', { noCreateRaw: true }, 'H1:missing'],
  ] as const)('%s: the gate rejects with its reason in the log', (_, patch, code) => {
    const { r } = run([{ ...SETUP, ...patch }]);
    expect(decisions(r.records).filter((d) => d.reasons[0] === 'enter')).toHaveLength(0);
    expect(rejects(r.records)).toContain(code);
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

  it('identifies each pre-registered configuration by its content', () => {
    expect(configId(STUDY_CONFIG, 'U2')).toMatch(/^U2-[0-9a-f]{16}$/);
    expect(configId(STUDY_CONFIG, 'U1')).not.toBe(configId(STUDY_CONFIG, 'U2'));
    const changed = { ...STUDY_CONFIG, universes: STUDY_CONFIG.universes.map((u) => (u.universe === 'U2' ? { ...u, medianTargetBps: u.medianTargetBps + 1 } : u)) };
    expect(configId(changed, 'U2')).not.toBe(configId(STUDY_CONFIG, 'U2'));
    expect(configId(changed, 'U1')).toBe(configId(STUDY_CONFIG, 'U1'));
    expect(STUDY_CONFIG.universes.map((u) => u.universe)).toEqual(['U1', 'U2']);
  });
});
