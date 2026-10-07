These two probes run only on the PR heads they name, because they import helpers that exist only there. They are stored as `.txt` so that this branch's test run skips them.

| Probe | PR | Head | Copy the file to | Command |
|---|---|---|---|---|
| RT-A1b | #272 | c752a6d | `packages/worker/test/redteam/rt-a1b-late-behind-sticky.test.ts` | `npx vitest run packages/worker/test/redteam/rt-a1b-late-behind-sticky.test.ts` |
| RT-A2b | #273 | b5875f9 | `packages/backtest/test/redteam-rt-a2b.test.ts` | `npx vitest run packages/backtest/test/redteam-rt-a2b.test.ts` |

To run one:
1. Check out the PR head.
2. Copy the file to the path in the table and drop the `.txt` ending.
3. Run the command.

Both fail on their head.
