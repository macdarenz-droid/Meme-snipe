# OF-ARM: arming the Old Faithful chain

Review log for the arming change (`research/historical/ci/archive-limits.conf`: `ARCHIVE_ARM`, `ARCHIVE_REARM_AT`, `ARCHIVE_RETENTION`, each with its DECISIONS record). The OF chain OF-1..OF-7 and the `-k3` producer (#319) are merged at `90bac78d`. The arm checklist is `research/z-h-estimate/OLD-FAITHFUL.md` "Arm checklist", items 1–6.

## Arm-checklist facts (9 Oct about 7:42 PM, read only, base `90bac78d`)

- `archive-limits.conf`: `ARCHIVE_ARM=""`, `ARCHIVE_REARM_AT="2026-10-07T22:30:00Z"`, `ARCHIVE_RETENTION=""`, `ARCHIVE_DAYS="2026-07-22..2026-08-21"`. The B10-PULL id `ARCHIVE_ARM` must equal is `b10pull-of-1` (DECISIONS.md line 132). `archive-guard.sh local 2026-07-22` refuses: not armed (rc 2).
- **Item 1, unguarded refs.** `unguarded-refs.sh` could not run here: the agent proxy refuses the numeric-ID repository paths that `gh api --paginate` uses for its second page (HTTP 403, "Use repos/{owner}/{repo}/... endpoints instead"). The supervisor ran the script's same tests over every branch and tag fetched with git (340 refs): **304 are unguarded**, 302 branches (every `claude/*` and `ccr-*` branch cut before OF-2 merged) and the tags `deploy` (`27043969`) and `preview` (`13cdf32a`). Each can read the archive without the guard only if someone with write access dispatches its `data-scan.yml` or `archive-check.yml` (scheduled runs use the default branch only).
- **Item 2, old runs.** Last 35 days: `data-scan.yml` 13 runs, `archive-check.yml` 17; none queued or in progress. 29 of 30 are from commits without `archive-guard.sh` (all on the default branch, attempt 1; created 3–8 Oct). Re-run window 30 days per the repo docs (**VERIFY**), so the last closes about 7 Nov. By `ag_history` (`AG_FOREIGN`), a re-run (attempt > 1) after `ARCHIVE_REARM_AT` stops the chain; the 29 runs as they stand do not.
- **Item 3, log retention.** Refused by the agent proxy ("Access to this GitHub Actions path is not permitted through this proxy", HTTP 403). Not re-routed: the owner reads it.
- **Item 4, YAML parser.** Checked by the guard on the runner at arm time (it logs the parser); no owner step.
- **Item 5, progress cache.** The fork-PR approval setting and the cache list were refused by the agent proxy (same 403); not re-routed. The guard reads the cache list in Actions at arm time and holds while any unsealed `data-scan-*`/`data-rpc-*` entry remains (they expire 7 days after last use).
- **Item 6.** Runs after batches 1–2 (no owner step).

## Supervisor recommendations put to the owner (9 Oct about 7:45 PM)

1. Items 1–2: keep the branches, tags and runs (some branches hold unfinished work; the runs are the record of 3–5 Oct). Standing rule: no one dispatches `data-scan.yml` or `archive-check.yml` on any ref but the default branch, and no one re-runs an old run of either; a run that breaks this stops the chain through the guard. The held Deploy moves `deploy` to a guarded commit. Option B (owner's OK needed): bulk-delete merged branches and the `preview` tag.
2. Item 3: the owner reads the retention days (Settings → Actions → General → Artifact and log retention); recommended 90, the guard reads 35 days back.
3. Item 5: the owner sets fork pull request workflows to the strictest approval option, and does not rotate `DATA_STORE_TOKEN` while the download runs. Unsealed caches: wait for them to expire (no action); the arm run reports any that hold it.
- The data builder prepares the arming change as a draft meanwhile; it merges only after the owner's answers, with a fresh review and red team.
