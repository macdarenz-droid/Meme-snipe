import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '/home/user/Meme-snipe/packages/core/src/config/index.ts';
import { runStudy } from '/home/user/Meme-snipe/packages/backtest/src/study/run.ts';
import { STUDY_CONFIG } from '/home/user/Meme-snipe/packages/backtest/src/strategy/config.ts';
import { studyWorld, W0 } from '/home/user/Meme-snipe/packages/backtest/test/study-world.ts';
import { SOL_USD } from '/home/user/Meme-snipe/packages/backtest/test/synthetic.ts';
const MIN = 150, DAY = 24 * 60 * MIN;
const reclaim = (since: number) => (since < 5 * MIN ? 0.5 : since < 50 * MIN ? 0.15 : 0.55);
const plan = (label: string, day: number) => ({ label, createSlot: day * DAY + 2 * 60 * MIN, graduateAfter: 20 * MIN, migrationQuote: 400_000_000_000n, buyBias: reclaim, swapEvery: 10, buySize: 3e9, sellDivisor: 8, swapsFor: 300 * MIN });
let t = Date.now();
const { rows } = studyWorld({ leadInDays: 15, blockEvery: 25, slots: 2 * DAY, mints: [plan('d0', 0), plan('d1', 1)] });
console.log('world', Date.now() - t, rows.length); t = Date.now();
const sol = { ...SOL_USD, bars: Array.from({ length: 24 * 20 }, (_, k) => ({ start: W0 - 16 * 86_400_000 + k * 3_600_000, close: '120.00' })) };
const r = runStudy({ rows: () => rows[Symbol.iterator](), series: [sol], seed: 'e', scenario: 'conservative', policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG,
  windowEnd: W0 + 2 * 86_400_000, study: STUDY_CONFIG, mode: 'strategy', entriesFrom: W0, entriesTo: W0 + 40 * 3_600_000, sampleRate: 1, insiders: () => ({ knownAtMs: 0, funded: [], devCluster: [] }) });
console.log('run', Date.now() - t, r.stats.events, r.records.length, r.facts?.counts);
