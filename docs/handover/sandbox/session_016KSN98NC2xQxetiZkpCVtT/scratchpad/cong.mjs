const root = '/home/user/Meme-snipe';
const { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } = await import(`${root}/packages/core/src/config/index.ts`);
const { runBacktest } = await import(`${root}/packages/backtest/src/run.ts`);
const { SOL_USD, syntheticRows, T0 } = await import(`${root}/packages/backtest/test/synthetic.ts`);
const RESEARCH = { ...RESEARCH_CONFIG, holdout: { ...RESEARCH_CONFIG.holdout, fromDay: '2026-09-20', entryCutoffDay: '2026-09-21', tailEndDay: '2026-09-21' } };
const fillsFor = (mode) => ({ ...FILL_CONFIG, scenarios: Object.fromEntries(Object.entries(FILL_CONFIG.scenarios).map(([k, s]) => [k, mode === 'real' ? s : { ...s, congestion: mode === 'always' ? { ...s.congestion, network: { ...s.congestion.network, enterPpm: 1_000_000n, maxEnterPpm: 1_000_000n, stayPpm: 1_000_000n } } : { ...s.congestion, landFactorPpm: 1_000_000n, extraLandingSlots: 0 } }])) });
const [mints, hours, seeds] = process.argv.slice(2).map(Number);
const crowd = syntheticRows({ mints, slots: 2.5 * 3600 * hours, swapEvery: 60, seed: 'crowd' });
const t0 = Date.now();
for (const scenario of ['conservative', 'base']) {
  const out = {};
  for (const mode of ['always', 'real', 'none']) {
    let blocked = 0, exits = 0, failed = 0;
    for (let k = 0; k < seeds; k++) {
      const r = runBacktest({ rows: () => crowd[Symbol.iterator](), series: [SOL_USD], seed: `s${k}`, scenario, policy: TRIAL_POLICY, fills: fillsFor(mode), research: RESEARCH, windowEnd: T0 + hours * 3_600_000 });
      blocked += Object.values(r.book.positions).filter((p) => p.status === 'exit_blocked').length;
      const ex = r.attempts.filter((a) => a.purpose === 'exit'); exits += ex.length; failed += ex.filter((a) => a.outcome !== 'filled').length;
    }
    out[mode] = `${blocked}b ${(failed / exits).toFixed(3)}`;
  }
  console.log(mints, hours, seeds, scenario, JSON.stringify(out));
}
console.log('ms', Date.now() - t0);
