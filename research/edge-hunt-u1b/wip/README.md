# EDGE-HUNT-U1-B work in progress (stopped 2026-10-07 about 9:20 PM Melbourne, owner: project migration)

No outcome was read. Restore with `mkdir -p data && cp wip/*.jsonl wip/*.json data/ && tar xzf wip/bars.tar.gz -C data`
(rename `migration_sigs_ok.jsonl` to `migration_sigs.jsonl`), then `./resume.sh` continues the pull.
- `migration_sigs_ok.jsonl`: all 74,703 successful pump.fun migrations 2026-08-02T14:00Z to the wall (step 1 complete).
- `migrations.jsonl`: decoded so far (step 2, hash order, about 11,100 of 74,703).
- `activity.jsonl`: step 3 so far. `bars.tar.gz`: step 4 so far. `sol_usd_hour.json`: SOL/USD.
