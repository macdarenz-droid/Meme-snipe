### Afternoon decisions (2026-10-04, owner and supervisor)

Owner decisions (the owner's words, recorded by the supervisor):
- **G1 gates on the SPA test** (2:33 PM, "Spa"). The clamped per-trade DSR is still reported, but no longer gates. STATS-1f (#109) makes G1's test a registered choice (`g1Test`), fixed per attempt; a registration without it fails G1.
- **A G1 test switch is a later upgrade, not now** (2:36 PM): the owner may later choose SPA or DSR in a setting. Both paths stay implemented and tested; no switch is built.
- **Code-only Deploy runs** (2:45 PM): the supervisor may run the Deploy workflow to move the server to new code, never to send keys.
  - The `DEPLOY_CODE` secret was deleted by the owner at 2:47 PM, because the old code had been shown in chat.
  - A run must log "No DEPLOY_CODE secret: code update only, no keys sent." The first run, 37174740782, did.
- **CI-2 allowed** (#104): feature branches run CI through their PR only, drafts wait, and a newer PR head cancels the older run.

Supervisor rulings:
- **Never remove a guard.** A change that drops an existing guard is reverted, even if the reviewer calls it redundant: guards are cheap and their absence is found only by the failure they prevent. Applied three times: `hardAllowsEntry` (#106), the deployer-check max-guard (#99) and the `#lifecycle` waiting line (#107).
- **A halt raised before the restore keeps both layers:** the worker's restart ordering (#82) and the strategy's restore gate (#102). Neither replaces the other.
- **Deployer rug checks (WORKER-1c item 1):**
  - one cached answer per creator;
  - a slot guard on every answer (an older answer never overwrites a newer one);
  - at most one check in flight per creator;
  - roll forward only;
  - the credit budget reserved before the read.
- **Executable marks (RISK-MARK):**
  - Each open position is marked at the worst executable rung, with a fresh SOL price.
  - Without a mark, the exit fallback value applies.
  - An entry whose marking throws is caught and refused, never booked unmarked.
  - Of #99 and #103, whichever merges second takes the day and week boundary marks from the marked account.
- **A restored position keeps its clock (EXIT-1f).**
  - Its open time is the exact timestamp of its ledger open event.
  - The slot-time bound is only a fallback.
  - A time stop can never restart after a restart.
- **G3 observation tail:**
  - The tail is at least the maximum hold plus the exit ladder.
  - Decisions are cut at the evaluation time, and outcomes are read up to the cut plus the tail.
  - Censoring is symmetric for taken and vetoed candidates.
- **Observation delay re-stamps receipt time only.** `GateContext.observedTip` is required in live and in the backtest (live uses the feed tip), never backtest-only, with a test that live decisions stay byte-identical.
- **BT-2's funder cluster comes from the funding supplement.** A missing supplement fails G2; it never passes by default.
- **The real-worker switch waits for #82, #99 and #103,** so the dry run cannot latch the weekly limit on unmarked positions. The switch (`ops/host-config.json` `"worker": "release"`) is its own reviewed PR, followed by a code-only Deploy.
- **`zeroed-tailscale` never calls Funnel** (OPS-1h #108). `tailscale funnel … off` first runs Funnel's capability check, which can block forever on a tailnet that never enabled Funnel.
  - The script checks first that HTTPS certificates and the `https` capability are present.
  - It bounds every call and never hides a prompt.
  - It accepts only the exact serve config: TCP 443 HTTPS, one web host proxying `/` to 127.0.0.1:8788, and no Funnel.
  - The tailnet's DNS name is kept out of the repo.
- **Stored data:** `account.json` marks, `deployer-state.json` and `fill-budget.json` hold only the bot's own state and public market data. The supervisor approved them under the stored-data ruling.
- **No merge without CI.** While GitHub Actions is locked (owner billing, from 3:20 PM), nothing merges, whatever local runs show. The merge rule needs green checks on the exact head.

