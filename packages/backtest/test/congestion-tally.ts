// Tallies for the "exit failure responds to congestion" test, run as its own Node process: the replays are the same
// engine code, without the test runner's per-call runtime trap (test/setup.ts), which makes these 48 replays about
// ten times slower inside Vitest. Purity is proven by the trapped tests; this one measures behaviour only.
// Prints one JSON line: { [scenario]: { [mode]: { blocked, exits, failed } } }, `blocked` being exits booked blocked.
import { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } from '../../core/src/config/index.ts';
import { runBacktest } from '../src/run.ts';
import { SOL_USD, syntheticRows, T0 } from './synthetic.ts';

type Mode = 'always' | 'real' | 'none';
const RESEARCH = { ...RESEARCH_CONFIG, holdout: { ...RESEARCH_CONFIG.holdout, fromDay: '2026-09-20', entryCutoffDay: '2026-09-21', tailEndDay: '2026-09-21' } };
const fillsFor = (mode: Mode): typeof FILL_CONFIG => ({
  ...FILL_CONFIG,
  scenarios: Object.fromEntries(Object.entries(FILL_CONFIG.scenarios).map(([k, s]) => [k, mode === 'real' ? s : {
    ...s, congestion: mode === 'always'
      ? { ...s.congestion, network: { ...s.congestion.network, enterPpm: 1_000_000n, maxEnterPpm: 1_000_000n, stayPpm: 1_000_000n } }
      : { ...s.congestion, landFactorPpm: 1_000_000n, extraLandingSlots: 0 },
  }])) as unknown as typeof FILL_CONFIG.scenarios,
});
const crowd = syntheticRows({ mints: 30, slots: 2.5 * 3600 * 8, swapEvery: 60, seed: 'crowd' });
const out: Record<string, Record<string, { blocked: number; exits: number; failed: number }>> = {};
for (const scenario of ['conservative', 'base'] as const) {
  out[scenario] = {};
  for (const mode of ['always', 'real', 'none'] as const) {
    let blocked = 0;
    let exits = 0;
    let failed = 0;
    for (let k = 0; k < 8; k++) {
      const r = runBacktest({ rows: () => crowd[Symbol.iterator](), series: [SOL_USD], seed: `s${k}`, scenario, policy: TRIAL_POLICY, fills: fillsFor(mode), research: RESEARCH, windowEnd: T0 + 8 * 3_600_000 });
      // Exits booked blocked (one critical exit_blocked alert each), not positions still blocked when the data ends: since
      // fills-4 a blocked exit recovers on a slow retry, so the end state undercounts what congestion did (EXIT-FILL-FIXES).
      blocked += r.stats.alerts['exit_blocked'] ?? 0;
      const ex = r.attempts.filter((a) => a.purpose === 'exit');
      exits += ex.length;
      failed += ex.filter((a) => a.outcome !== 'filled').length;
    }
    out[scenario][mode] = { blocked, exits, failed };
  }
}
console.log(JSON.stringify(out));
