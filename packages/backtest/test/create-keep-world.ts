// OOM-MINT: one backtest coin whose migration follows its create by a given number of slots (create-keep tests).
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import type { LogRecord } from '../../core/src/engine/index.ts';
import { CREATE_KEEP_MS } from '../../core/src/gates/index.ts';
import { runStudy } from '../src/study/run.ts';
import { STUDY_CONFIG } from '../src/strategy/config.ts';
import type { StudyStrategy } from '../src/strategy/study.ts';
import { type MintPlan, POOL_ACCOUNTS, studyWorld, W0 } from './study-world.ts';
import { SOL_USD } from './synthetic.ts';

const MIN = 150;
export const KEEP_SLOTS = CREATE_KEEP_MS / 400;
const sol = { ...SOL_USD, bars: Array.from({ length: 24 * 20 }, (_, k) => ({ start: W0 - 16 * 86_400_000 + k * 3_600_000, close: '120.00' })) };

/** One coin created at slot 10 whose migration follows `afterSlots` later; its checks and the strategy's funnel. */
export const backtestCoin = (afterSlots: number) => {
  const plan: MintPlan = { label: 'a', createSlot: 10, graduateAfter: afterSlots, migrationQuote: 400_000_000_000n, buyBias: () => 0.5, swapEvery: 600, buySize: 3e9, sellDivisor: 8 };
  const { rows, ownerPrograms } = studyWorld({ leadInDays: 15, slots: 10 + afterSlots + 260 * MIN, mints: [plan] });
  let st: StudyStrategy | null = null;
  const r = runStudy({
    rows: () => rows[Symbol.iterator](), series: [sol], seed: 'e2', scenario: 'conservative', policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG,
    windowEnd: W0 + 18 * 3_600_000, study: STUDY_CONFIG, mode: 'strategy', entriesFrom: W0, entriesTo: W0 + 17 * 3_600_000, sampleRate: 1,
    insiders: () => ({ knownAtMs: 0, funded: [], devCluster: [] }), poolAccounts: POOL_ACCOUNTS, delegatesComplete: true, regime: 'assume-on', holders: { ownerPrograms },
    onStrategy: (x) => { st = x; },
  });
  const decisions = r.records.filter((x): x is Extract<LogRecord, { type: 'decision' }> => x.type === 'decision');
  return { decisions, funnel: (st as unknown as StudyStrategy).funnel.summary() };
};

/** Every judgement of a check (the `candidate` line only names it). */
export const judgedIn = (d: ReturnType<typeof backtestCoin>['decisions']) => d.filter((x) => x.reasons[0] !== 'candidate');
export const expiredIn = (d: ReturnType<typeof backtestCoin>['decisions']) => d.filter((x) => x.reasons[0] === 'reject' && x.reasons.includes('worker:create-expired'));
