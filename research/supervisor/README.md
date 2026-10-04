# Supervisor measurement scripts

Records of past runs, kept for reference. They cannot be re-run as they are:
- `audit/analyze_allin.py` (lines 13–14) and `audit/recompute.py` (line 4) hard-code another session's `/tmp` scratchpad paths, which are not in the repo.
- `data-measurements/lag.mjs` reads `pp_events.json` from the working directory, and no such file is committed beside it. A file of that name is kept in `docs/handover/sandbox/supervisor/files/`; whether it was this run's input is not verified.

Outputs that were kept sit beside them (for example `audit/results/` and `audit/allin_stdout.txt`).
