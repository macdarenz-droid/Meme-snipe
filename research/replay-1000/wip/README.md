# REPLAY-1000 work in progress (stopped 7 Oct, owner's order)

Not reviewed; scratch scripts and results kept so the work can be picked up.

- `scripts/`: one-off analysis scripts (paths inside point at the session's worktrees and scratchpad; adjust before reuse).
- `results/F-A-959d801`: 47-coin funnel at 959d801 (S0, diagnostic on, no paper edge), window 5 Oct 00:00Z – 6 Oct 14:55Z; `cut-creates.json` lists every cut create log an H14 refusal named, with its fetch time.
- `results/AF-A-d5f3be15`: the same funnel at d5f3be15 (A-FACTS-FIXES).
- `results/B2-h5-e138ad2`: the same 47 coins at e138ad2 (paper edge 178092), Mode B.
- `results/full-day-sample-coins.json`: the 123 seeded-sample coins of the full 6 Oct UTC day (1,259 canonical graduates, rebuilt from the Foundation endpoint after the 20-minute refresh had overwritten the list with a partial one).
- The full-day run at 957fe181 (Mode A, window 5 Oct 00:00Z – 7 Oct 04:00Z) was stopped at virtual 6 Oct 12:59Z; it has no results here. Its inputs and cache are in the session's scratchpad and `data/` (git-ignored), not committed.
