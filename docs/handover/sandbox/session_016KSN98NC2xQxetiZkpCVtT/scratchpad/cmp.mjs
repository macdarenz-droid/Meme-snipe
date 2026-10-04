const root = process.argv[2];
const { FILL_CONFIG, RESEARCH_CONFIG, TRIAL_POLICY } = await import(`${root}/packages/core/src/config/index.ts`);
const { runBacktest } = await import(`${root}/packages/backtest/src/run.ts`);
const { ladderCongestion } = await import(`${root}/packages/backtest/src/stress.ts`);
const { SOL_USD, syntheticRows, T0 } = await import(`${root}/packages/backtest/test/synthetic.ts`);
const rows = syntheticRows({ mints: 30, slots: 2.5 * 3600 * 8, swapEvery: 60, seed: 'crowd' });
for (const scenario of ['conservative', 'base']) {
  let t = { allCongested: 0, allCongestedBlocked: 0, rest: 0, restBlocked: 0, congestedExitAttempts: 0, exitAttempts: 0 };
  for (const seed of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) {
    const r = runBacktest({ rows: () => rows[Symbol.iterator](), series: [SOL_USD], seed, scenario, policy: TRIAL_POLICY, fills: FILL_CONFIG, research: RESEARCH_CONFIG, windowEnd: T0 + 8 * 3_600_000 });
    const l = ladderCongestion(r);
    for (const k of Object.keys(l)) t[k] += l[k];
    const ex = r.attempts.filter((a) => a.purpose === 'exit');
    t.exitAttempts += ex.length; t.congestedExitAttempts += ex.filter((a) => a.congested).length;
  }
  const exits = t.allCongested + t.rest;
  console.log(JSON.stringify({ scenario, ...t, blockedExitRate: ((t.allCongestedBlocked + t.restBlocked) / exits).toFixed(4), congestedShareOfExitAttempts: (t.congestedExitAttempts / t.exitAttempts).toFixed(4) }));
}
