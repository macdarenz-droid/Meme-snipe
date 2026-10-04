# Sandbox manifest: session_01Wh1trUafgBq5CjrGuLYkGj (PAPER-1)

Files this session made outside the repo checkout (scratchpad and background-task outputs). No secrets, provider data or third-party content.

| Path | Size | sha256 | State |
|---|---|---|---|
| scratchpad/check.log | 7958 | 3ed23e2b8b8e9456c67dbf2028fa7df800f0275accfe76ac720c24821094ba88 | committed |
| scratchpad/check2.log | 6124 | a6b1c2f76ff460fc4361842a2e812359072d3f7857289f3fc1db00726855a387 | committed |
| scratchpad/dbg.patch | 0 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | excluded: empty file (unused debug placeholder) |
| scratchpad/mut.py | 2396 | fe5847e72df1f5e3b9992ac03dfd197870fd25dde6e7b7d2b65ffe7de2d81c2b | committed |
| tasks/bcplznd8t.output | 0 | e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 | excluded: empty file (unused debug placeholder) |
| tasks/bn70mvo09.output | 596 | cbcf24ae01950b94022bf805fda193f6a2fc97aabadf5a936ad9543d73284ff9 | committed |
| tasks/bnun36km5.output | 316 | 8c145c1bef50a1becc8103ae7d46537f5dbe192c6e2559ac023dd2bb1f495137 | committed |
| tasks/bpg9shd91.output | 91 | 039739a4636297ccacf7be7d86518982c47b67ac092a64b2f7c51d205779aa17 | committed |
| tasks/bpjiu14pl.output | 596 | cbcf24ae01950b94022bf805fda193f6a2fc97aabadf5a936ad9543d73284ff9 | committed |
| tasks/bzyk18z3b.output | 91 | 039739a4636297ccacf7be7d86518982c47b67ac092a64b2f7c51d205779aa17 | committed |

- `mut.py` (also copied to this folder's root) is the mutant runner: `python3 mut.py <test files>`, run from the repo root at claude/paper-1.
- `check.log` is the first `pnpm check`, before two test fixes (2 failures). `check2.log` is the final run at 65283f8: 155 files, 4537 tests, all passed.
- `tasks/*.output` are background test-run outputs. Some are empty because their output was piped to the logs.
- Excluded and not listed: the repo's node_modules (regenerate with `pnpm install --frozen-lockfile`). The temporary git worktree of the base was already removed (recreate with `git worktree add <dir> 4f2ba07`).
