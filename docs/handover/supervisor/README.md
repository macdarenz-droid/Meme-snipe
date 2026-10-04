# Supervisor materials (first account)

- `supervisor-log.md`: the supervisor's full running log for 3–4 Oct. It covers every dispatch, review verdict, merge, ruling and owner message, with UTC times. One redaction: the tailnet name.
- `tools/`: the queue helpers used all day. Each one polls the public GitHub API (repo `macdarenz-droid/Meme-snipe`) and needs no token.
  - `wait_any.sh <pr>...`: exits when CI on any listed PR's current head has fully completed, and prints the check results.
  - `wait_commit.sh <sha>`: exits when every check run on a commit has completed, for example a merge commit's push run (CI, `Ops end-to-end`).
  - `wait_run.sh`, `wait_head.sh`, `wait_pr.sh` and `wait_unlock.sh`: older single-purpose variants (a workflow run, a head change, PR state, the billing-lock clearing).
  - Run them as background shells with a long timeout (2 h). Never `pkill -f` a pattern that matches the waiting shell.
- `map/`: the "how the bot works" poster sent to the owner on 4 Oct.
  - `spec.json` is the content and `poster.html` the layout.
  - `render.mjs` renders PNG and PDF with Playwright. It needs Chromium (`/opt/pw-browsers` in cloud sessions) and `NODE_PATH` pointing at a global Playwright, and it uses the brand font from `brand/` when present.
- Research scripts the supervisor ran (an independent check of the empirical study, the sample-size simulation, data measurements, a transaction-sample probe) are in `research/supervisor/`. The research docs now cite those paths instead of the old scratchpad paths.
- Not committed: downloaded third-party pages (provider pricing, docs, papers), raw block dumps and throwaway one-off probes. What mattered from them is in `docs/research/*.md` with sources cited. They can be fetched again from the URLs given there.
