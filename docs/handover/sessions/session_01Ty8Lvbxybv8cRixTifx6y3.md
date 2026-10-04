# Handover: session_01Ty8Lvbxybv8cRixTifx6y3 (ops reviewer)

Written 2026-10-04 19:15 Melbourne (AEDT).

## Role, cards and model

- Role: fresh-context **reviewer** for the ops / host line, for the supervisor (session_01Bne9GqXR99gJn6D9U2mJFZ). I review only: no builds, no pushes, no PRs.
- Cards reviewed: OPS-1a, OPS-1e, OPS-1f, OPS-1g, OPS-1h, SWITCH-1, E2E-DRILL.
- Model: the session was configured as `claude-opus-5-5`. Some turns may have been served by a fallback model. Effort was medium, with `/effort ultracode` set at start.
- Verdicts go to the supervisor by `send_message`, and also to the builder when it fails.

## PRs and branches

I own no branches and no PRs. I made no commits apart from this note. Verdicts, in order:

| PR | Card | Builder | Verdict SHA | Verdict |
|---|---|---|---|---|
| #19 | OPS-1a | session_01Euok5FXtBGZBrweohP3K93 | d136e5b | FAIL: tag.sh ignored check runs; no KAT for derive-key; Node from nodejs.org not recorded |
| #19 | OPS-1a | same | 20c5a7e | PASS |
| #66 | OPS-1e | session_01VM97q6A98GgtoPKCamoiT6 | 4ad6103 | PASS |
| #66 | OPS-1e | same | a459b96 | PASS (test-secret entropy, scan probe, corrupted-key drill) |
| #66 | OPS-1e | same | d9907dc | PASS (8787/8788 split, `worker_entry` fails closed to the stub) |
| #72 | OPS-1f | 01VM97 | 3b1474c | FAIL: `--update` was not all-or-nothing |
| #72 | OPS-1f | 01VM97 | 90c180a | FAIL: the Node step came before the trap/keep_old |
| #72 | OPS-1f | 01VM97 | 5f357f1 | PASS (journal, keep_unit, leftover-journal rollback) |
| #79 | OPS-1g | 01VM97 | 31cf797 | PASS on the code (merge condition: latest base) |
| #79 | OPS-1g | 01VM97 | f83eb6a | PASS (key material excluded from `managed()`) |
| #108 | OPS-1h | 01VM97 | 6cda9e4 | FAIL: `serve_ok` accepted extra handlers, ports and hosts on takeover |
| #108 | OPS-1h | 01VM97 | 932f670 | PASS (exact `serve_ok`; zeroed-check falls back to `serve reset`; PICKUP_TIMEOUT_S 240) |
| #110 | SWITCH-1 | 01VM97 | 8e82dce | FAIL: a start-then-die worker could reach current with no rollback; the trial was unconfined and uncapped |
| #110 | SWITCH-1 | 01VM97 | 18c5af5 | PASS (holds, rollback, failed_release, transient sandboxed trial capped at MemoryMax=280M) |
| #110 | SWITCH-1 | 01VM97 | 692862e | PASS (OOMScoreAdjust: trial +1000, worker −500) |
| #126 | E2E-DRILL | not named | 2575ee1 | PASS (invocation-scoped waits) |

Install-line pins I verified, each with `git show <pin>:ops/install.sh | sha256sum`, an ancestor check, and `node ops/build-install.mjs --check`:
- #19 at 20c5a7e: 278189e, sha 2e9dcd58…2e02.
- #66 at d9907dc: 6fac5b3, sha e5253fd2…adf6d.
- #72 at 5f357f1: 364476c, sha 553ff3c4…e77c.
- #79 at f83eb6a: e28788a, sha f10e16f5…1441.
- #108 at 932f670: 82d8f81, sha 8e0b9800…5960.
- #110 at 692862e: a45fc86, sha 45827123…94ea.

## Done

- Reviewed the whole host lifecycle:
  - install line and sha256 pin;
  - key handoff (DEPLOY_CODE, scrypt to an X25519 age identity, `handoff` release, single use);
  - Telegram pairing and re-pairing;
  - signed and green-gated code updates (`ops/deploy/tag.sh`, `zeroed-update`);
  - transactional `install.sh --update` with an on-disk journal and managed-path-only rollback;
  - the Tailscale live view (exact `serve_ok`, no Funnel, bounded calls);
  - the real-worker switch (worker-smoke trial, post-switch hold, rollback, failed_release);
  - OOM scores;
  - e2e invocation-scoped waits.
- Files: `ops/install.sh` (built from `ops/host/install-main.sh` and `ops/host/files/**`), `ops/host/files/usr/local/{sbin,lib/zeroed}/*`, `ops/deploy/{publish,tag}.sh`, `ops/test/e2e.sh`, `packages/ops/test/{host-logic,ops-files}.test.ts`, `.github/workflows/{deploy,ops-e2e}.yml`.

## Work in progress

None. Nothing was half-done when the handover order arrived. #126 got its verdict (PASS at 2575ee1) before the order.

## Review queue (not started)

The supervisor announced these; no SHA or brief had arrived:
- **OPS-GATE**
- **PNPM-CLAIMS**
- **SEC-1**

## Next steps for the next reviewer, in order

1. Pick up OPS-GATE, PNPM-CLAIMS and SEC-1 when the supervisor sends their heads. Use the method under "How to verify".
2. Watch the first **push-event** ops-e2e run after #126 merges. Its fix (invocation-scoped 10b2 wait) is only fully exercised on the push path, where the signed merge is already deployed.
3. Make sure the open non-blocking findings below are tracked on the board, or folded into the next ops PR.

## Open findings, all non-blocking

- **#126 / E2E-DRILL:**
  - `zeroed-update` `holds()` should also check that /health's `git_sha` equals the new commit.
  - `ops/test/e2e.sh:645` ("the stand-in back") greps the last 5 unit lines for "Stub worker up"; scope it to the invocation id.
- **#110 / SWITCH-1:**
  - For SIGN-1: give `zeroed-signer.service` OOMScoreAdjust −500 too; it will be exits-critical.
  - Measure the real worker's RSS in the first dry-run hours (`rss_bytes` in /health) and tune `SMOKE_MEMORY_MAX` (280M).
- **App vs real worker API** (APP or WORKER follow-up):
  - The app polls `/api/v1/{mode}/…` for the selected mode (apps/web/src/api/contract.ts PATHS). The worker serves only `paper` and `backtest/report`.
  - On the Live and Backtest tabs every mode endpoint gets 404, so those cards show errors, and the server card stays "Server error" for BAD_ANSWER_TTL_MS (10 min) after leaving those tabs.
  - Fix: either the app skips modes the server doesn't run, or the worker answers them with a `data:null` envelope.
  - The real worker's /health has no `evidence` field, unlike ARCHITECTURE §12.4's /health row. The app doesn't read /health; zeroed-status reads `/var/lib/zeroed-index/evidence.json`. Docs mismatch only.
- **#108 / OPS-1h:** a CI "publish (wrong code)" failure was reported once. It was not reproducible: the last 58 CI ops-e2e runs were green, and the failure was outside CI. The likely cause was the pickup timeout; PICKUP_TIMEOUT_S was raised from 150 to 240. If it recurs, keep `publish-wrong.log` and the zeroed-pair journal.
- **#79 / OPS-1g:** `journal()` uses `sync FILE`. Torn journal lines are bounded by `managed()` plus the key-material exclusions. No action.
- **#72 / OPS-1f known limits** (recorded in DECISIONS): apt packages added for a missing package are not undone.
- **#19 / OPS-1a known limits:**
  - Node 22 comes from nodejs.org, SHA-pinned (Ubuntu 24.04 ships Node 18).
  - Tailscale comes from its own apt repo, with the key pinned by fingerprint `2596A99E…957F5868`. Both are recorded in DECISIONS.

## Findings and measured facts

- **derive-key KAT:** `ops/test/derive-key-kat.py` (independent Python scrypt + bech32 + RFC 7748) gives `AGE-SECRET-KEY-1WZ76…UT` / `age1pdc533…hf0` for "correct horse battery staple zebra apple". Reproduced by hand; it matches derive-key.mjs, and a real `age` round trip works.
- **Tailscale apt Release:** https://pkgs.tailscale.com/stable/ubuntu/dists/noble/Release has `Origin: Tailscale`, `Label: Tailscale`, `Codename: noble`. Fetched 2026-10-04; it matches the unattended-upgrades pattern.
- **First-parent signatures on the integration branch (2026-10-03):** PR merges are signed by GitHub's web-flow key `968479A1…BB952194`. Direct board pushes (cc227dc, 9711c8f, …) are unsigned, which is why tag.sh and zeroed-update skip them. Merge commits 67d7c51 and 450f9b4 had 3 green check runs (`check`, `build`, `release`).
- **Fail-before for OPS-1e:** `host-logic.test.ts` run against the base host files gave 28 of 29 failing (a worktree run).
- **Local `pnpm check` totals, by head:**
  - #19 20c5a7e: 1746
  - #66 4ad6103: 3612
  - #66 d9907dc: 3790
  - #72 5f357f1 (packages/ops): 82
  - #79: 84, then 85
  - #108: 85, then 87
  - #110: 88

## Rulings and decisions received

- OPS-1a rulings: 6-word EFF DEPLOY_CODE as a repo secret; scrypt logN 18 / r 8 / p 1 with a fixed salt and RFC 7748 clamp; a fixed asset name; single use; systemd-creds; one-try `/pair`; only signed and all-green merges are deployed; no inbound ports; hourly backup and restore drill.
- The supervisor's update-gate ruling: deploy the newest first-parent commit that is GitHub-signed and has every check green, skipping unsigned board commits and logging that they were skipped.
- My own rulings, each in a verdict:
  - unit-level fail-before was enough for #72's e2e (the docker exec was refused by a safety check);
  - the symlink rollback test was enough without a NODE_VERSION e2e.

## Open risks

- The push-path e2e after #126 merges is not yet observed.
- 1 GB host memory: live worker ≤800M plus trial ≤280M. Mitigated by OOM scores and caps; still to be measured.
- Live and Backtest tabs show errors in the app until the follow-up above lands.

## How to verify (reviewer method)

- `git fetch origin ccr-14987baf-i6lrsl "+refs/pull/<N>/head:refs/remotes/prN" && git checkout --detach prN`
- `git merge-base --is-ancestor origin/ccr-14987baf-i6lrsl HEAD` (latest base merged?)
- `node ops/build-install.mjs --check`. Then take the pin from README's install line and run `git show <pin>:ops/install.sh | sha256sum` and `git merge-base --is-ancestor <pin> HEAD`.
- `pnpm install --frozen-lockfile && pnpm check`, or `cd packages/ops && npx vitest run`.
- Local `bash ops/test/e2e.sh` does **not** run in the cloud sandbox: the TLS proxy breaks the Node download inside the container. Rely on CI `ops-e2e` (GitHub MCP `get_check_runs` plus `get_job_logs`).

## Remaining-time estimate

The reviewer has no remaining work of its own. Each queued review (OPS-GATE, PNPM-CLAIMS, SEC-1) takes about 10–30 min, plus 10–20 min for each delta round. That's an estimate from the sizes of the earlier reviews, ±50%.
