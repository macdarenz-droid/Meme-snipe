# Red team B report: sizing and risk

Commit attacked: `959d80178b72faf59e6421b4350041a5425eec08` (integration HEAD, merge of #266). Probes are on branch `claude/redteam-b`. Each finding test asserts the safe behaviour, so it **fails** at 959d801. The pass-expected checks pass.

**Verdict: 2 CRITICAL, 1 HIGH, 2 MEDIUM (notes, not reproduced), and the planned resume config is safe.** With S0, the diagnostic set on and edge 0, no paper entry happens. However, RB-1 can still latch the kill switch while the bot is idle.

Run: `npx vitest run packages/core/test/redteam-b packages/worker/test/redteam-b-*.test.ts` (7 fail by design, 4 pass).

## CRITICAL

### RB-1: a fall in SOL/USD alone trips and latches R10 (and resizes)
- **Where:** `packages/core/src/risk/evaluate.ts:318-325` (the kill check on `s.nav` against `navHighWaterMark`, both in micro-USD), `evaluate.ts:139-159` (economic NAV is the wallet's SOL × SOL/USD), and `packages/worker/src/run/worker.ts:2134-2167` (`#markAccount` latches every valuation trip). `account.ts:234-237` records the NAV peak in USD.
- **Scenario:** the paper wallet is idle, with no candidate, no position and no trade, so its SOL stays the same. If SOL/USD falls 31% from the recorded NAV peak, `evaluateExit` returns `trips: ['kill_switch']` and `#markAccount` writes `killTrippedAtMs` to control.json. Only the owner can re-arm it. This happens under the planned resume config too, because no entry is needed. The peak also rises when SOL/USD rises, so a normal pullback from a SOL rally latches it. Separately, an 11% fall in SOL/USD forces the R2 drawdown reset to the minimum size (step-up approved), with the SOL quantity unchanged.
- **Tests:** `packages/worker/test/redteam-b-sol-kill.test.ts` "RB-1w" (worker, end to end); `packages/core/test/redteam-b/sol-usd.test.ts` "RB-1a", "RB-1b".
- **Note:** `packages/worker/test/kill-latch.test.ts:26` asserts this behaviour as intended (a 44% SOL drop with no position latches R10). That test was written before the owner's SOL rule of 2026-10-05, so it needs updating with the fix.
- **Smallest fix:** land SOL-BOOKS #197, which values NAV, the high-water mark and the kill line in lamports with the SOL bankroll fixed at session start. Until then, take the USD NAV path out of the latch (`navBelow` must not latch) and use `capital = equity` without `walletEquity` for the R2 reset.

### RB-2: a rise in SOL/USD hides SOL losses from R7, R8 and R15
- **Where:** `packages/worker/src/run/account.ts:336`. `netPnl = tradeUsd(l, pxIn, pxOut).net` values the entry leg at the entry price and the exit leg at the close price. `evaluate.ts:34` `isLoss` reads `netPnl`, and `evaluate.ts:186-188` marks open positions in USD against the USD notional.
- **Scenario:**
  - (a) A trade pays 1 SOL and gets 0.95 SOL back, a 5% loss in SOL after fees. If SOL/USD rose 6% during the trade, it is booked as a dollar win.
  - (b) After two such trades, R8 `loss_cooldown` does not fire, and R15 "no larger size after a loss" is not applied.
  - (c) An open $5 position is down 25% in SOL while SOL/USD is up 34%. Its USD mark is at or above the notional, so the marked loss counts as 0. The R7 day loss misses it, and so do the weekly and kill checks.
  - The reverse also happens: a trade that gained SOL during a SOL/USD fall counts as a loss and trips R8 wrongly.
- **Tests:** `packages/core/test/redteam-b/sol-usd.test.ts` "RB-2a", "RB-2b", "RB-2c".
- **Smallest fix:** SOL-BOOKS #197, with closed-trade results, marks, day and week loss and the loss streak all in lamports. The minimal stop-gap is to classify `isLoss` and R15 by `netLamports < 0`.
- **Severity in practice:** no money moves while edge is 0, because there are no entries. Every entry after an edge is registered is affected.

## HIGH

### RB-5: a blocked exit with its bounded retries spent never sells again, and nothing can release it
- **Where:** `packages/core/src/exits/rules.ts:350-352` returns `hold('exit blocked: retries used')` for ever. `close_position` is listed in `packages/core/src/ledger/migrations.ts:20` (`OPERATOR_COMMANDS`), but no code handles it.
- **Scenario:** a fast-falling coin makes all 5 ladder attempts and the 5 blocked retries fail on slippage or landing. The pool then recovers or stays tradeable, and the market is fresh and healthy a day later, long past `time_max`. The position is still held for ever: no exit is ever priced again. While it is held, R3 (`maxOpen` 1) refuses every future entry, so the bot stops trading until someone edits the state by hand.
- **Test:** `packages/core/test/redteam-b/exits.test.ts` "RB-5a".
- **Note:** the retry bound is documented (DECISIONS 2026-10-03, "Ladder"). The defect is that there is no later path at all: ARCHITECTURE §9 says "show 'Exit blocked' and keep watching".
- **Smallest fix:** after the retries are spent, allow one last-rung retry per `blockedRetryMs × k` (back-off) whenever a fresh quote passes the existing "least proceeds cover the attempt" check. Alternatively, implement the owner command `close_position`.

## MEDIUM (notes: found in the code, no running reproduction yet)

### N1: paper fills land on whatever pool state was read last, of any age
- **Where:** `packages/worker/src/run/paper-world.ts:333-338` and `worker.ts:1958-1961`. `PaperMarket` carries no `atMs`, and `#land` does not check freshness.
- **Risk:** during a feed or stream gap, an attempt landing at slot S fills at the pre-gap price, possibly a pre-rug price. The fill is optimistic exactly when conditions are worst, and the paper P&L overstates.
- **Fix:** pass `atMs` (or the read's slot) through `PaperMarket`. If the state is older than `maxQuoteAgeMs` at landing, or its slot is earlier than the landing slot, defer the landing or fail it ("pool state stale").

### N2: live paper fills are easier than the backtest's fill model
- **Where:** `paper-world.ts:276` calls `drawAttempt(rng, scenario, venue)` without `congested`. It also has no provider-down windows and does not apply `exitRetryHaircutPpm` (50,000 ppm in the conservative scenario). The backtest applies all three (`packages/backtest/src/sim/world.ts:76,155,228`).
- **Risk:** live dry-run exits land more often and get more than the backtest assumes. This works against pre-funding item 6, which requires the live dry run to stay consistent with the backtest.
- **Fix:** share the backtest's `NetworkState` and retry haircut in the paper world.

## Confirmed safe (pass-expected probes)
- **RB-3w (worker):** the planned resume config (`ZEROED_STRATEGY=S0`, `ZEROED_S0_DIAGNOSTIC=on`, no `ZEROED_PAPER_EDGE_PPM`, so edge 0) runs on a market that passes every gate. It produces no `enter` decision and no position, and the refusal names `expected_net_not_positive`. The control, the same boot at 400,000 ppm, does enter, so the market really reaches risk. Test: `packages/worker/test/redteam-b-edge0.test.ts`.
- **RB-3a (core):** 3,000 random cases with edge 0 are all refused. They cover bankrolls of $5, $20, $100, $1,000 and $10,000, step-up on and off, stops of 100–2000 bps, and pools of 1–5,000 SOL with signed `virtual_quote_reserves` from −60% to +10% of the vault. The route is `costs/index.ts:340`: v0 is at least the rounding allowance, which is at least 1, so `edgePpm <= v0`. Test: `sizing-fuzz.test.ts`.
- **RB-4a (core):** at real edges, every allowed entry across the same grid stayed within all of these:
  - notional ≤ the maximum;
  - round-trip impact ≤ `maxImpactBps`;
  - R12 notional ≤ liquidity / 1000;
  - expected net > 0 at the chosen size, cross term included;
  - reservation ≤ `maxHeld`.

## Not covered in this pass
- Double fills or double exits across a restart, and the ladder replace path, beyond reading the code; it has extensive existing tests (EXIT-KEEP, restart-keep).
- Fully reconciling the ledger against the wallet across late settlements; PAPER-2 tests exist.

# Round 2 (same commit 959d801)

**Verdict: 1 new CRITICAL (RB-8). Items 2, 3 and 5 show no defect; item 4 shows no new defect.**

Run: `npx vitest run packages/worker/test/redteam-b-crash.test.ts packages/core/test/redteam-b/melbourne-dst.test.ts packages/core/test/redteam-b/ladder-scale.test.ts`. The RB-8 variant fails by design; everything else passes.

## How the crash fuzz works (items 1–3)
`packages/worker/test/redteam-b-crash.test.ts` runs a whole paper trade: entry, an optional partial take-profit, then the stop exit. It snapshots the state folder after every durable state-file write (`StateFile.write`: ledger-adjacent files, exits.json, paper.json, account.json and so on). A snapshot taken there is exactly what a SIGKILL between two writes leaves on disk.

Each snapshot is restarted (`start()`, the host's reconcile and start) and driven to the end. Then four things are checked:
1. **No position is lost or left without an exit:** every position is closed and no intent is still live.
2. **No fill is double-booked:** each landed paper attempt (paper.json, the simulated chain) is exactly one book fill, and the other way round.
3. **The wallet reconciles with the chain to the lamport.** The expected balance is W0 + exit SOL − entry SOL − every landed attempt's fee (base + priority + tip on a fill) − entry rent + rent back on the closing sell. The scenario has no dust and closes always succeed, so rent is deterministic.
4. **Trade records are consistent:** one trade record per entered position, and all of them closed.

## CRITICAL

### RB-8: a restart while an exit has a dropped or expired paper attempt never reconciles, so the worker exits with code 3 on every start and the position gets no exits
- **Where:**
  - `packages/worker/src/run/paper-world.ts:190-194` (`#heightFor`), `:391` (`#reconcile` returns early) and `#status` (reports nothing). For an attempt whose paper outcome is `dropped` or `expired` (not lost in a restart), these use `this.#height`, which stays null until the feeds start.
  - `worker.ts:2315` runs `reconcile()` before the sources start (`:2324`, `:2339`), so no height ever arrives during the start reconcile.
  - The start loop also never asks again for a status or balance read. A `reconcile_balances` answer refused because it raced the status (it arrives "from unknown") is not retried until feed ticks, which only start after the reconcile.
- **Scenario:**
  - An exit has an earlier attempt that the paper world drew as never landing (`dropped`, about 8.8% of attempts in the conservative scenario), or one that expired. The worker is killed before the exit intent resolves.
  - On every start, the reconcile can't prove that attempt dead. The intent stays `unknown`, `failed`, `expired_unfilled` or `confirmed_fill`. After 60 s the start returns `EXIT.reconcileFailed`.
  - The host unit runs the same reconcile in `ExecStartPre=... --reconcile`, with `Restart=always`, `StartLimitBurst=10` and `StartLimitIntervalSec=600`. So after 10 tries the unit stays failed, with the position in `exit_pending`: no stops, no exits, no account marks.
- **Evidence:**
  - The test variant "RB-8 30% land, up then stop (ladder pressure)": 239 of 364 crash images refuse to start, every one with "Reconcile failed: intents left unresolved".
  - The variants at 100%, 70% and 50% landing (180 images) all restart, close, and reconcile to the lamport.
  - A local check that was not committed: making `#heightFor` treat `dropped` and `expired` as dead (`lastValid + 1`) cut the failures from 239 to 47. The remaining 47 are the second cause above: one `reconcile_balances` answer refused "from unknown" and never asked again. Product code was restored afterwards (`git diff` is clean).
- **Smallest fix (two parts):**
  - (a) In `#heightFor`, the paper world's own terminal fates prove the attempt dead: `dropped` or `expired` → `lastValid + 1`, as `lostInRestart` already does.
  - (b) During the start reconcile, ask again for status and balances of intents that are still open on each loop. One way is to emit an intent `tick` at the paper height. Another is to persist the paper world's last height in paper.json and run `onSlot`/`tick` from it at start.
- **Regression test:** the RB-8 variant must pass.

## No defect found
- **Item 1 (restart mid-entry or mid-exit, partial fills, pending intents):** 180 crash images across 3 variants (all land / half land with failed attempts, replacements and rungs / 70% land with a partial take-profit) all restart to closed positions. No position was lost, double-counted or left without an exit.
- **Item 2 (double fills and double exits):** across every image, book fills equal paper landings one for one. Duplicate and late reconciles at restart are refused by the lifecycle ("reconcile follows a confirmed, failed or expired outcome") and change nothing. Core's own `lifecycle.random.test.ts` already models fork noise, hidden landings and orphans, so I did not duplicate it.
- **Item 3 (ledger reconciliation and rounding):** the wallet equals the chain-derived balance to the lamport on every image. Rounding as written in the code:
  - AMM fees use ceil (`feeOf`), outputs use floor, and exact-out quotes use ceil, matching the programs (the golden tests);
  - `tradeUsd` uses up for amounts paid and down for amounts received;
  - paper slippage uses `withSlippage` with the shortfall rounded up against us.
  - Two LOW notes: `paper-world.ts:347` reports a buy's slippage cost rounded down, and `account.ts` `soldBasis` can overstate a partial's gain by at most 1 lamport (the whole trade sums exactly at close). Neither affects the wallet.
- **Item 4 (ladder at $1k and $10k):** `planAttempt` min-out is a ratio of the full-size trigger value. Rung choice is identical at $5, $1k and $10k, fees stay capped lamports, and the liquidation value is quoted at the real size, below spot × quantity. Test: `ladder-scale.test.ts`. The size-related exit risk at scale is RB-5 (a stuck blocked exit), not the ladder.
- **Item 5 (Melbourne day and week across DST):** `melbourneTime` matches the tz database (Intl `Australia/Melbourne`) every 15 minutes within ±48 h of every change from 2008 to 2040. Day starts are local midnight, change days last 23 h and 25 h, and weeks start Monday 00:00 local. On 4 Oct 2026, a $1.60 loss at 23:59 Sunday (AEST start) counts toward Sunday's R7, and the day resets at Monday 00:00 AEDT (Sun 13:00Z). R9 and R11 use the same functions. Test: `melbourne-dst.test.ts`.

# Round 3 (fix heads: #275 cb1fb7a, #197 fcb6fc7, and a local merge of both = 6a7c920)

**Verdict: 1 new CRITICAL (RB-11, #275) and 1 new HIGH (RB-10, #197 migration). Every round 1–2 finding is closed on its fix head except RB-8, which is closed for start-up but whose end state is held open by RB-11. With no edge, nothing moves money. With an edge (test only), the ledger is exact to the lamport at $5, $100 and $10k, and P&L is in SOL.**

The probes are in `redteam-b/round3/` because they compile only against the fix heads. Copy them into these places on the head named in the folder:
- `eff/` → #275: `haircut.test.ts` goes to `packages/core/test/redteam-b/`, `redteam-b-crash.test.ts` goes to `packages/worker/test/`.
- `sb/` → #197: `redteam-b-migrate.test.ts` goes to `packages/worker/test/`.
- `both/` → the merge of #197 and #275: both files go to `packages/worker/test/`. Run `redteam-b-scale.test.ts` with `RB_SCALE=1|5|500` and, for the failed-entry path, `RB_LAND=80000`.

## Re-verification

| Finding | Head | State | Evidence |
|---|---|---|---|
| RB-1 (latched on an idle SOL/USD fall) | #197 fcb6fc7 | closed | `redteam-b-sol-kill.test.ts` RB-1w verbatim passes. Core risk takes no SOL/USD price at all now. |
| RB-1b (drawdown reset from SOL/USD) | #197 | closed | `redteam-b-sol.test.ts` RB-1b passes |
| RB-1m (deploy onto an old file) | #197 | closed, but see RB-10 | RB-1m passes; the new probe RB-10a (no trades, dollar marks and NAV peak, −30%) passes |
| RB-2a/b/c (SOL loss hidden by a USD rise) | #197 | closed | Adapted probes pass. My original core probes fail only because their inputs are typed in dollars. Risk now reads `netPnl: Lamports` and marks in lamports, so the attack on dollar inputs no longer applies. |
| M2 (NAV peak after a clock step back) | #197 | closed | `account-marks.test.ts` "red team C M2" passes |
| RB-5 (stuck after blocked retries) | #275 cb1fb7a | closed in the rules, defeated in paper by RB-11 | `exits.test.ts` RB-5a passes (slow retries resume) |
| N1 (fills on stale reads) | #275 | closed | `#land` fails an attempt whose read is older than `maxQuoteAgeMs` (paper-world.ts, N1 block); confirmed by reading the code, no separate probe |
| N2 (fill parity) | #275 | closed, with a regression: RB-11 | Congestion, provider-down and the haircut are applied. The haircut has no time window. |
| RB-8 (start reconcile never finishes) | #275 | closed (start-up) | All 364 images in the RB-8 variant now start (0 exit-3s, was 239). 224 of them end `exit_blocked` because of RB-11. |
| Round 1–2 passes (RB-3, RB-4, RB-6, RB-7, RB-9) | #275 and the merge | still pass | Same probes, same results |

## CRITICAL

### RB-11 (#275): the repeated-exit haircut has no time window, so a paper exit can never fill after about the 6th send
- **Where:** `packages/worker/src/run/paper-world.ts`:
  - `#broadcast` sets `exitRetry` to every earlier exit send on the position, with no time limit;
  - `#land` applies `exitRetry × exitRetryHaircutPpm` (conservative scenario: 5%) through `executeSellIn`.
- **Scenario:** at an unchanged pool, on the last rung (min-out 25% under the quote), send 6 onward always fails on slippage. The 5 ladder attempts and 5 fast retries use 10 sends, so every RB-5 slow retry also fails. The position is blocked for ever in paper, and R3 then refuses every entry.
- **Evidence:**
  - Unit probe: `round3/eff/haircut.test.ts` RB-11a says "first send that can never fill: 6".
  - Crash fuzz on cb1fb7a: 224 of 364 restart images end `exit_blocked`, with attempts failing "slippage: out 3277199 below min 3511284" at retry 6 and 8 on the same pool.
- **Fix:** the announced delta, counting only sends within the last 10 minutes. Slow retries are ≥ 64 min apart, so each one goes out with no haircut. After the delta, re-run RB-11a with the window applied, and run the crash fuzz with a drive longer than the first slow retry (> 64 min).

## HIGH

### RB-10 (#197): migration converts the old dollar day/week marks at the opening price, which gives phantom day/week losses
- **Where:** `packages/worker/src/run/account.ts` `#open`, lines 262–265: `dayMark`/`weekMark` (dollars) are multiplied up at the opening price.
- **Why it is wrong:** an old mark holds B + Σ netPnl_usd, and each trade's dollar result was valued at its own SOL/USD price. Converting at the opening price over-states SOL by Σ(netPnl_usd / P_open − netLamports) for trades closed at other prices. Gains made while SOL/USD was high become a phantom loss; losses made then are partly hidden.
- **Evidence** (`round3/sb/redteam-b-migrate.test.ts`, deploy at SOL/USD −30%):
  - RB-10b: a +35% B trade at SOL/USD +30% → false `daily_loss`;
  - RB-10c: a +75% B trade → R9 latched (`weeklyTrippedAtMs` set);
  - RB-10a (no trades) and RB-10d (a real loss still shows) pass.
- **Exposure:** only an old file with closed trades. Check the host's account.json before the deploy; with no trades this cannot happen.
- **Fix:** drop `dayMark`/`weekMark` on migration, as `navPeak` already is. They are re-recorded in lamports at the next marked valuation, and the realized measure still covers the day. Alternatively, rebuild each mark as funded SOL + Σ booked before its boundary.

## Item 2: the money path as the resume runs it (on the local merge of #197 and #275)
- **RB-12a, no trade, no money:** S0, the diagnostic set on, edge 0, a market that passes the gates. The run covers about 26 h of event time across a Melbourne midnight while SOL/USD steps through −40% to +40% every hour. Results:
  - wallet unchanged (131,987,133 lamports);
  - no trade, no entry, no intent, no position;
  - stray fees and the setup cost unchanged;
  - R10 and R9 not latched;
  - the daily limit unchanged (9,999,999 lamports);
  - the day loss equals the one-time setup rent on its own day and resets to 0 the next day;
  - the refusal names `expected_net_not_positive`.
- **RB-13, one trade with an edge (test only):** entry, fill, a 30% fall, the stop exit, then settlement. Checked against the paper chain (paper.json): the wallet equals W0 + exit SOL − entry SOL − every landed attempt's fee, to the lamport, and `netLamports` is exactly that change.

| Size | Spent (lamports) | Received (lamports) | netLamports | Wallet = chain |
|---|---|---|---|---|
| $5 trial | 13,333,334 | 9,363,193 | −4,030,141 | 127,956,992 |
| $100 (×5) | 66,666,667 | 46,797,209 | −19,929,458 | 645,391,008 |
| $10k (×500) | 6,666,666,667 | 4,458,472,607 | −2,208,254,060 | 64,457,066,406 |

  With an 8% landing rate the entry never fills, which exercises the failed-entry fee path. Its stray fee is booked once, and the wallet equals the chain at ×1 and ×500.
  - The ×5 and ×500 policies are built in the test only. Their depth limits are opened so the harness's single 245-SOL pool can take the size: this probes the money path, not the gates.
  - A late fee (an attempt landing after its trade closed) did not occur in these draws and was not forced. PAPER-2's own tests cover it.

# Round 4: integration attack (local merge, not pushed)

**Verdict: 1 new CRITICAL (RB-17, RC-STATE × SOL-BOOKS: the worker can't start while account.json holds an unpriced stray fee). 2 new HIGH: RB-15 (the first start after #268 comes up with the kill switch latched and entries paused, which confirms red team C's r4-upgrade-latch) and RB-10 (still open on the merge). 2 new MEDIUM: RB-14 (the backup leaves out the regime series and its holes) and RB-16 (RB-5's slow-retry fees are outside R6's reservation). Typecheck passes; 47 of 7,146 tests fail, all attributed below. On the merge, the ledger is exact to the lamport and edge 0 is refused by risk.**

## Merge
Base `ccr-14987baf-i6lrsl` 9f7cf812, then in order:
- rc-state 10347648
- rc-fixes 99309169
- mem-fixes 2f7409b1
- exit-fill-fixes 1de9be63 (with fills-4, the haircut window)
- sol-books fcb6fc7a
- late-log c752a6d5
- a-facts-fixes b5875f91
- a2-gate-fixes 5540c2c3
- pool-first-read-2 e225f112
- resume-worker 25c4d9bf

Result: local commit 4fe63e9e, never pushed.

Heads that moved after the merge was built, and so are not tested here: base cd4d7a64, rc-state 5bfc993d, rc-fixes 3810ca3f, exit-fill 2720ee8b, a2-gate 58eb1422. RB-17's `isFee` is unchanged on rc-state 5bfc993d. Scripts: `round4/mergeloop2.sh` and `round4/keepboth.py`.

### Conflicts
| Step | File | Kind | Resolution |
|---|---|---|---|
| rc-state onto base | `ops/README.md` (install.sh commit and SHA-256 pin) | obvious, but must be regenerated | rc-state's pin taken. No pin can be right on an unpushed merge: `ops-files.test.ts` "SHA-256 in the README is current" fails on the merge for this reason only. The real merge must re-pin. |
| rc-state onto base | `worker/src/run/recorder.ts` (fs imports) | obvious | union |
| rc-fixes, mem-fixes, exit-fill, late-log, a-facts, a2-gate, resume-worker | `docs/DECISIONS.md` | obvious (both appended) | kept both |
| sol-books | `worker/src/run/account.ts` (`#save()` vs `this.#file.write` and `seen`) | obvious textually, **semantic** next to it | `if (moved || folded || seen) this.#save()`. Also, by hand: SOL-BOOKS' `priceLate` writes with `this.#file.write` (line 494), which bypasses RC-FIXES' counts and `present`; changed to `#save()`. |
| sol-books | `worker/test/worker-contract.test.ts` (imports) | obvious | union |
| pool-first-read-2 | `core/src/facts/producer.ts` | **semantic** | Two hunks. The book shape takes both `dropped: false` (pfr-2) and `newestSlot: null` (late-log or mem). The hole fetch keeps `#capHeals` (HEAD) plus pfr-2's RT-A5 pre-read of a hole transaction for a pool with no book yet. The pre-read buffer is bounded (`PRE_READ_POOLS` 64 × `PRE_READ_KEEP` 64). |
| pool-first-read-2 | `core/test/facts/trade-heal.test.ts` (imports) | obvious | union |
| resume-worker | `ops/test/host-logic.test.ts` | **semantic** | #268's test expects an unreadable host-config to fall back to the stand-in. The base's RC-M4 refuses it (and a dangling link) instead. Kept the refusal checks plus #268's `"worker": "release"`. The merged `logic.sh` refuses. |

## Full test run on the merge
`pnpm typecheck` passes. `vitest run`: 47 failed, 7,097 passed, 2 skipped (7,146 tests, 318 files, 46 min).

Each failure was attributed by running the 20 failing files after each merge step, then on single heads and on pairs:

| Failing tests | Cause |
|---|---|
| `ops-files` README SHA (1) | merge artefact: the pin |
| backtest `run.test.ts` "exit failure responds to congestion" (1) | **#275 by itself** (fails on 1de9be63 alone). Re-check on 2720ee8b. |
| about 26 tests: facts-landing, facts-source, funnel-truth (14 reject sites against 13 classified), paper-settlement M4, position-market, read-coherent ×3, rec-same-event, retire ×2, worker-1e, worker-api, worker-flow ×5, core producer candles and graduate survival ×7, LATE-LOG survival | **#272 late-log by itself**: its head c752a6d fails the same tests alone |
| redteam-b-sol RB-1b and RB-2a/b, RB-2c, size-step-up ×5, write-order ACCOUNT-RATE ×2, paper-settlement F2 | **RC-STATE × SOL-BOOKS**: they pass on sol-books alone and with rc-fixes, mem-fixes or exit-fill; they fail with rc-state. Two causes: (a) SOL-BOOKS' fixtures seed account.json with trades and no ledger, which RC-STATE refuses as a lost ledger (test-only, fixtures need a ledger); (b) **RB-17**, below (product). |
| red team C entry-evidence | starts failing at the late-log step (late-log is red by itself) |
| red team C state-backup-restore | starts failing at the exit-fill step on the merge; passes on rc-state 5bfc993 + exit-fill. Not pinned to a pair. |

## Red team probes on the merge (70 tests, 27 fail)
- **B pass:**
  - the crash-anywhere fuzz (all 4 variants, including 30% landing): RB-8 and RB-11 closed, wallet = chain on every image;
  - RB-12a: no-trade money path, with edge 0 refused as `expected_net_not_positive`;
  - RB-13: one trade, exact to the lamport;
  - RB-5 (original), RB-9, RB-11b (haircut window).
- **B fail, real:** RB-14, RB-15a/b, RB-16, RB-10b/c (with a ledger added to the fixture), RB-17.
- **B fail, stale probe, not a finding:** these use risk inputs from before SOL-BOOKS (`market.solPrice`, dollar helpers), or the 959d801 boot fixture that no longer reaches risk on the merge:
  - RB-3w edge0 (its own control at 400k doesn't enter either);
  - RB-4a (no entries allowed in the old helpers);
  - RB-6c.
  The edge-0 guarantee is covered on the merge by RB-12a instead.
- **A fail:** unstamped-swap-skipped, volume-one-missing-day, curve-tail-parity, creates-reconnect-14-days. These are red team A's; not re-attributed here.
- **C fail:**
  - r3-resume-sequence R3-1 to R3-4: a probation rollback or failed switch hold lands on the stand-in while the release holds an open paper position. This is the RC-STATE/#271 probation × #268 switch interaction, still open on the merge.
  - r4-cut-at-kill ×2, r4-refusal-visible, r4-upgrade-latch (= RB-15), state-navpeak (a BigInt TypeError in the probe against SOL-BOOKS).

## Findings
### CRITICAL: RB-17 (RC-STATE × SOL-BOOKS), the worker can't start while account.json holds an unpriced stray fee
- **Where:**
  - SOL-BOOKS `account.ts` `settle` books a stray entry fee by its lamports with `cost: null` when no SOL price is known (line 554 on the merge: a restart reconcile, or a stale price). `priceLate` values it later.
  - RC-STATE's `checkAccount` `isFee` requires `cost` to be a non-negative bigint, for `strayFees` and `strayFolded` alike. So the whole file is refused.
  - `new PaperAccount` throws on the next start, and the unit restarts into the same refusal, with any open position unmanaged.
- **Evidence:**
  - Probe `round4/account-check-stray.test.ts` RB-17a/b.
  - write-order "a restart whose first price is stale charges the fee no second time" fails on the merge ("account.json is not a valid state file") and passes on each head alone.
- **Fix:** `isFee` accepts `cost: null` (SOL-BOOKS' `StrayFee.cost: MicroUsd | null`). Keep every account write going through `#save()`.

### HIGH: RB-15 (RC-STATE × #268 switch), the resume's first start comes up latched and paused
- Confirms red team C's r4-upgrade-latch, and adds the stand-in's ledger.
- **Why:** RC-STATE treats "ledger there, control.json missing" as lost controls: it latches the kill switch, pauses, and raises a critical alert. Workers before RC-STATE wrote control.json only on a latch or a pause, and the host stand-in never writes it. Both leave a `ledger.sqlite`; the stand-in creates its own with a `host_events` table.
- **Effect:** the first start of the merged worker on the live host comes up latched and paused, with nothing lost. Entries stay blocked until the owner re-arms and resumes.
- **Probes:** `round4/control-first-start.test.ts` RB-15a (an older worker's ledger) and RB-15b (the stand-in's ledger).
- **Fix:** treat a missing control.json as lost only when the ledger records an earlier start of a release that writes it (for example, a start marker that RC-STATE writes into the ledger or account.json), not whenever a ledger exists. Otherwise, write control.json once in the deploy.

### HIGH: RB-10 (#197), still open on the merge
The migration's dollar day/week marks give a phantom loss: a false `daily_loss`, and R9 latched. Retested on the merge with a ledger and control.json in the fixture (`round4/redteam-b-migrate-merge.test.ts`). RB-10a and RB-10d pass; RB-10b and RB-10c fail.

### MEDIUM: RB-14 (A2-GATE × RC-STATE backup), a restore loses the regime series and its holes
- **Where:** RC-STATE's `zeroed-backup` leaves out `deployer-state.json` (with the deployer index). That file also holds the regime's graduates series and A2-GATE's saved restart holes (`unobserved`, PERSIST-2).
- **Effect:** after a host-loss restore the regime has no survival history and must rebuild it before any entry is judged. This fails closed: the bot can't trade until then, and the rebuild time was not measured.
- **Probe:** `round4/backup-graduates.test.ts`.
- **Fix:** back up the graduates series, which is small, separately from the deployer index. Or include `deployer-state.json` and leave out only `deployers.jsonl`.

### MEDIUM: RB-16 (SOL-BOOKS × EXIT-FILL), slow retries spend outside R6's reservation
- **Where:** R6 reserves q + C, where C's exit part is (`ladder.maxAttempts` + `blockedRetryAttempts`) attempts. RB-5's slow retries are unbounded in count (log2 of the blocked time, then one per 1,024 × `blockedRetryMs`).
- **Size:** a week blocked is about 12 slow retries, 6,120,000 lamports, about 4.6% of the trial bankroll, none of it reserved. The fees are booked in lamports when paid, so the limits see them afterwards, but not in advance.
- **Probe:** `round4/slow-retry-cost.test.ts`.
- **Fix:** cap slow retries per position (for example, as many as the fee room C holds), or reserve a bounded number of them in C.

## Interactions asked for
1. **SOL-BOOKS lamport books × EXIT-FILL slow retries and haircut:** the books stay exact. The crash fuzz on the merge (including 30% landing, slow retries and the haircut window) gives wallet = chain on every image. Finding: RB-16.
2. **MEM-FIXES store collapse × LATE-LOG late frames and A-FACTS re-reads:**
   - No new defect found. The store refuses any record older than its newest (`asof.ts` record: "must be recorded in time order"), so a late frame can never slip under the collapsed newest entry.
   - The pfr-2 × mem pre-read buffer is bounded (64 pools × 64 events).
   - Red team A's late-frame and re-read probes that fail on the merge (curve-tail-parity, creates-reconnect-14-days) are A's to attribute.
   - Late-log's own head is red by itself, with about 26 tests.
3. **RC-STATE refusal × #271 probation × #268 switch:** RB-15 (above). Red team C's R3-1 to R3-4 also fail on the merge: a probation rollback or failed switch hold lands on the stand-in while the release holds an open paper position.
4. **A2-GATE saved holes × RC-STATE backup and restore:** RB-14.
