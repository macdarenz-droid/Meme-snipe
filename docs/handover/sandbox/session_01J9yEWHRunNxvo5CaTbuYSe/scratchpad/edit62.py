import json,sys
b=json.load(sys.stdin)["body"]
b=b.replace("Stacked on #52 (base `claude/stats-1b`); retarget to the integration branch once #52 merges.","Based on the integration branch (#52 merged).")
b=b.replace("It would need 40 days or a −12.5% detectable decay. Nothing changed; the supervisor decides.","It would need 40 days or a −12.5% detectable decay. Supervisor ruling: recorded as is, and nothing changes here. Follow-up STATS-1d: U1 adds a 40-day window and demotes on either; the risk layer's hard limits remain the backstop.")
s=b.index("## Known integration follow-up"); e=b.index("## Evidence")
b=b[:s]+"""## Backtest holdout layer on the new registry (supervisor ruling: the PR that changes an interface updates its callers)
BT-1c and BT-1d (#73, merged first) now call the STATS-1c registry. Only their call sites changed:
- Registering an attempt records the entry days [fromDay, cutoff) with today's UTC day. It freezes each holdout's size requirement and n_power seed from the walk-forward (`holdout-register --required-trades --n-power-seed`).
- Attempt, α and tail end come from the core registry. The backtest refuses an attempt index whose core α or tail differs, and `attemptAlpha` returns the core schedule.
- Runs, overlap checks and research-day guards use the run window [fromDay, tailEnd). A holdout with no frozen requirement is refused before anything runs.
- `openSealedHoldout` opens only after the tail, at the frozen requirement. `endAttempt` judges 'short' against the frozen requirement.
- Attempt k ≥ 2 starts exactly on the day after registration.
- Every BT-1c and BT-1d test is kept: setup adds the requirement and opens after the synthetic tail, and no assertion was loosened. The cutoff test moved its one entry day before the data, since an empty window is refused. A new test covers the core-owned rules.
- `endAttempt` stays in the backtest layer; moving it into core is a follow-up.

"""+b[e:]
b=b.replace("`pnpm check` passes on bf5dae8: 111 files, 3,824 tests.","`pnpm check` passes on fcdd901, which contains the latest base: 119 files, 4,037 tests. One worker test, `feed.test.ts`, failed once under full-suite load (not in this diff); it passed 5 of 5 alone and on the full re-run.")
print(b)
