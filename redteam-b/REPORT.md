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
