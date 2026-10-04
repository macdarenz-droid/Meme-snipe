// Audit B1: S0 is its universe's random control, so it runs that universe's hard gates (U2's chase check, U1's
// liquidity floor) and differs only in which check it enters at. Every gate request a run makes is recorded here.
import { describe, expect, it, vi } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { runStudy } from '../src/study/run.ts';
import { STUDY_CONFIG } from '../src/strategy/config.ts';
import { type MintPlan, POOL_ACCOUNTS, studyWorld, W0 } from './study-world.ts';
import { SOL_USD } from './synthetic.ts';

const seen = vi.hoisted(() => [] as string[]);
vi.mock('../../core/src/gates/index.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../../core/src/gates/index.ts')>();
  return {
    ...m,
    evaluateHardRejects: (...a: Parameters<typeof m.evaluateHardRejects>) => {
      seen.push(a[2].universe);
      return m.evaluateHardRejects(...a);
    },
  };
});

vi.setConfig({ testTimeout: 300_000 });

const MIN = 150;
const reclaim = (since: number) => (since < 5 * MIN ? 0.5 : since < 50 * MIN ? 0.15 : 0.55);
const SETUP: MintPlan = { label: 'a', createSlot: 10, graduateAfter: 20 * MIN, migrationQuote: 400_000_000_000n, buyBias: reclaim, swapEvery: 10, buySize: 3e9, sellDivisor: 8 };
const SLOTS = 10 + 20 * MIN + 260 * MIN;
const sol = { ...SOL_USD, bars: Array.from({ length: 24 * 20 }, (_, k) => ({ start: W0 - 16 * 86_400_000 + k * 3_600_000, close: '120.00' })) };

describe('S0 runs its universe\'s gates (audit B1)', () => {
  it('every gate request of S0-U2 names U2, never S0', () => {
    const { rows, ownerPrograms } = studyWorld({ leadInDays: 15, slots: SLOTS, mints: [SETUP] });
    const u2 = { ...STUDY_CONFIG, universes: STUDY_CONFIG.universes.filter((u) => u.universe === 'U2') };
    seen.length = 0;
    const r = runStudy({
      rows: () => rows[Symbol.iterator](), series: [sol], seed: 's0-1', scenario: 'conservative', policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG,
      windowEnd: W0 + 12 * 3_600_000, study: u2, mode: 's0', entriesFrom: W0, entriesTo: W0 + 10 * 3_600_000, sampleRate: 1,
      insiders: () => ({ knownAtMs: 0, funded: [], devCluster: [] }), poolAccounts: POOL_ACCOUNTS, delegatesComplete: true, regime: 'assume-on', holders: { ownerPrograms },
    });
    expect(r.stats).toMatchObject({ crashes: 0, illegalStates: 0, unreconciledIntents: 0 });
    expect(seen.length).toBeGreaterThan(0);
    expect([...new Set(seen)]).toEqual(['U2']);
  });
});
