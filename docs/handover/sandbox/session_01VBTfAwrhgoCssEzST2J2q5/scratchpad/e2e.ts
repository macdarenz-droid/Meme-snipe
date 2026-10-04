import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '/home/user/Meme-snipe/packages/core/src/config/index.ts';
import { runStudy } from '/home/user/Meme-snipe/packages/backtest/src/study/run.ts';
import { STUDY_CONFIG } from '/home/user/Meme-snipe/packages/backtest/src/strategy/config.ts';
import { studyWorld, W0, SLOT_MS } from '/home/user/Meme-snipe/packages/backtest/test/study-world.ts';
import { SOL_USD } from '/home/user/Meme-snipe/packages/backtest/test/synthetic.ts';
import { tradesOf } from '/home/user/Meme-snipe/packages/backtest/src/trades.ts';
const MIN = 150;
const bias = (since: number) => since < 5 * MIN ? 0.5 : since < 50 * MIN ? 0.15 : 0.55;
const { rows, mints } = studyWorld({ leadInDays: 15, slots: 10 + 20 * MIN + 260 * MIN, mints: [{ label: 'a', createSlot: 10, graduateAfter: 20 * MIN, migrationQuote: 400_000_000_000n, buyBias: bias, swapEvery: 10, buySize: 3e9, sellDivisor: 8, noCreateRaw: process.argv[3] === 'noraw' }] });
const sol = { ...SOL_USD, bars: Array.from({ length: 24 * 20 }, (_, k) => ({ start: W0 - 16 * 86_400_000 + k * 3_600_000, close: '120.00' })) };
const t0 = Date.now();
const r = runStudy({ rows: () => rows[Symbol.iterator](), series: [sol], seed: 'e', scenario: 'conservative', policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG,
  windowEnd: W0 + rows.length, study: STUDY_CONFIG, mode: process.argv[2] === 's0' ? 's0' : 'strategy', entriesFrom: W0, entriesTo: W0 + 10 * 3_600_000, sampleRate: 1,
  insiders: () => ({ knownAtMs: 0, funded: [], devCluster: [] }) });
console.log('ms', Date.now() - t0, r.stats);
const counts = new Map<string, number>();
for (const x of r.records) if (x.type === 'decision') { const k = x.reasons.slice(0, 1).concat(x.reasons.slice(3, 5)).join(' | '); counts.set(k, (counts.get(k) ?? 0) + 1); }
for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 40)) console.log(v, k.slice(0, 200));
const { trades } = tradesOf(r, FILL_CONFIG);
console.log(trades.map((t) => ({ id: t.id, net: t.net.toString(), entry: t.entrySol.toString(), exit: t.exitSol.toString(), reason: t.exitReason })));
console.log(r.facts?.counts);
