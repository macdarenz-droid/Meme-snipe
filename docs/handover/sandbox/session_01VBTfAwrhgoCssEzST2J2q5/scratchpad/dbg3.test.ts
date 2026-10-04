import { it } from 'vitest';
import { appendFileSync } from 'node:fs';
const log = (x: string) => appendFileSync('/tmp/claude-0/-home-user-Meme-snipe/406edd36-7a5c-567a-b0c4-521cf6e925a4/scratchpad/dbg3.out', x + '\n');
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '/home/user/Meme-snipe/packages/core/src/config/index.ts';
import { runStudy } from '/home/user/Meme-snipe/packages/backtest/src/study/run.ts';
import { STUDY_CONFIG } from '/home/user/Meme-snipe/packages/backtest/src/strategy/config.ts';
import { studyWorld, W0 } from '/home/user/Meme-snipe/packages/backtest/test/study-world.ts';
import { SOL_USD } from '/home/user/Meme-snipe/packages/backtest/test/synthetic.ts';
const MIN = 150;
const reclaim = (since: number) => (since < 5 * MIN ? 0.5 : since < 50 * MIN ? 0.15 : 0.55);
it('dbg', () => {
  const { rows } = studyWorld({ leadInDays: 15, slots: 10 + 280 * MIN, mints: [{ label: 'a', createSlot: 10, graduateAfter: 20 * MIN, migrationQuote: 400_000_000_000n, buyBias: reclaim, swapEvery: 10, buySize: 3e9, sellDivisor: 8 }] });
  const sol = { ...SOL_USD, bars: Array.from({ length: 24 * 20 }, (_, k) => ({ start: W0 - 16 * 86_400_000 + k * 3_600_000, close: '120.00' })) };
  const r = runStudy({ rows: () => rows[Symbol.iterator](), series: [sol], seed: 'e', scenario: 'conservative', policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG,
    windowEnd: W0 + 12 * 3_600_000, study: STUDY_CONFIG, mode: 'strategy', entriesFrom: W0, entriesTo: W0 + 10 * 3_600_000, sampleRate: 1, insiders: () => ({ knownAtMs: 0, funded: [], devCluster: [] }) });
  log('STATS ' + JSON.stringify(r.stats, (k, v) => typeof v === 'bigint' ? String(v) : v) + JSON.stringify(r.facts?.counts) + r.records.length);
  for (const x of r.records) if (x.type === 'decision' && x.action === null) log(x.reasons.join(' | ').slice(0, 300));
}, 300000);
