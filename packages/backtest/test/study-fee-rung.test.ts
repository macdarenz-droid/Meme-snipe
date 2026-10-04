// PAPER-FEE-RUNG for BT-2: a study exit pays the rung fee StudyStrategy planned, never the top rung's fallback. The two
// ways the plan reaches World (StudyStrategy.exitFee and the `;fee=` it writes into the signed bytes) must agree.
import { describe, expect, it, vi } from 'vitest';
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { runStudy } from '../src/study/run.ts';
import { STUDY_CONFIG } from '../src/strategy/config.ts';
import type { StudyStrategy } from '../src/strategy/study.ts';
import { type MintPlan, POOL_ACCOUNTS, studyWorld, W0 } from './study-world.ts';
import { SOL_USD } from './synthetic.ts';

vi.setConfig({ testTimeout: 300_000 });

const MIN = 150;
// study.test.ts's U2 setup: an even start, a dump to a flush, then a slow reclaim; it enters once and exits on EXIT-1.
const reclaim = (since: number) => (since < 5 * MIN ? 0.5 : since < 50 * MIN ? 0.15 : 0.55);
const SETUP: MintPlan = { label: 'a', createSlot: 10, graduateAfter: 20 * MIN, migrationQuote: 400_000_000_000n, buyBias: reclaim, swapEvery: 10, buySize: 3e9, sellDivisor: 8 };
const SLOTS = 10 + 20 * MIN + 260 * MIN;
const sol = { ...SOL_USD, bars: Array.from({ length: 24 * 20 }, (_, k) => ({ start: W0 - 16 * 86_400_000 + k * 3_600_000, close: '120.00' })) };
const fees = TRIAL_POLICY.exits.ladder.steps.map((s) => s.priorityFeeLamports as bigint);
const top = fees.reduce((m, f) => (f > m ? f : m), 0n);

describe('a BT-2 exit pays its plan\'s priority fee (PAPER-FEE-RUNG)', () => {
  const planned = new Map<string, bigint | null>();
  const { rows, ownerPrograms } = studyWorld({ leadInDays: 15, slots: SLOTS, mints: [SETUP] });
  const r = runStudy({
    rows: () => rows[Symbol.iterator](), series: [sol], seed: 'e2', scenario: 'conservative', policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG,
    windowEnd: W0 + 12 * 3_600_000, study: STUDY_CONFIG, mode: 'strategy', entriesFrom: W0, entriesTo: W0 + 10 * 3_600_000, sampleRate: 1,
    insiders: () => ({ knownAtMs: 0, funded: [], devCluster: [] }), poolAccounts: POOL_ACCOUNTS, delegatesComplete: true, regime: 'assume-on', holders: { ownerPrograms },
    onStrategy: (s: StudyStrategy) => {
      const own = s.exitFee.bind(s);
      s.exitFee = (sig: string) => { const f = own(sig); planned.set(sig, f); return f; };
    },
  });
  const exits = r.attempts.filter((a) => a.purpose === 'exit');
  const refFee = (sig: string): bigint | null => {
    for (const i of Object.values(r.book.intents)) {
      const ref = i.attempts.find((a) => a.signature === sig)?.signedBytesRef;
      const m = ref === undefined ? null : /;fee=(\d+)$/.exec(ref);
      if (m !== null) return BigInt(m[1]!);
    }
    return null;
  };

  it('StudyStrategy.exitFee and the signed bytes\' fee agree for every exit, and World charges that fee', () => {
    expect(r.stats).toMatchObject({ crashes: 0, illegalStates: 0, unreconciledIntents: 0 });
    expect(exits.length).toBeGreaterThan(0);
    for (const a of exits) {
      expect(planned.get(a.signature)).not.toBeNull();
      expect(planned.get(a.signature)).toBe(refFee(a.signature));
      expect(a.priorityFee).toBe(planned.get(a.signature));
    }
  });

  it('an exit planned at rung 0 is charged rung 0, not the top rung', () => {
    expect(fees[0]).not.toBe(top);
    const first = exits[0]!;
    expect(planned.get(first.signature)).toBe(fees[0]);
    expect(first.priorityFee).toBe(fees[0]);
  });
});
