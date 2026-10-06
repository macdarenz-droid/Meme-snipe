# Project state

## Owner goals
- An intelligent, precise, fast sniper that is above all risk aware and trades like a disciplined professional.
- Consistency. Risk aware, data aware. Research based on what actually matters in the market.
- No guessing: the bot acts only when the data proves the setup. Unknown or stale evidence means no trade.
- Bankroll $20, entries $2 default and $5 max, paper mode first. This is the trial setting only: capital and trade size are configuration and will scale once the bot proves itself. The owner intends to fund $100–200 once the bot is proven profitable (2026-10-04); the owner sets the new limits then.
- Easy deposit and withdraw in AUD. Stripe's onramp does not serve Australia (US and EU only). Deposit and Withdraw screens offer two exchanges to choose from, Independent Reserve and Kraken, with steps and costs; the bot only sends to the owner's saved wallet. Banxa in-app buying is possible later if a business (ABN) is registered.
- Dashboard: P&L calendar, trade history with full details, profit charts and the other visuals needed to see what the bot is doing. Smooth UI: motion, transitions, blurred backdrops behind opened panels.
- Two themes only: Paper (light) and Silent Black (dark); first open follows the device, then the owner's choice is remembered.
- UI words read as written by a person: no AI wording anywhere (see `AGENTS.md`).
- App name: Zeroed. Logo: "Slot" (a solid zero with a Z cut into it), files in `brand/`, rules in `docs/BRAND.md`.

## Phase
Wave D, 4 Oct about 7:45 PM Melbourne. The project is being handed to a new Claude account (owner, about 7:15 PM). Every first-account session pushed its work and wrote its notes to `docs/handover/sessions/`, then paused. Start from `HANDOVER.md` §0. 76 PRs merged since midnight on 4 Oct.
- **Server:** code-only Deploy run 37189025276 moved the deploy tag to 7d5e203 (SWITCH-1, WORKER-1e, the e2e fix) at about 7:28 PM. The push e2e on that commit is green. The server switches to the real paper worker within about 5 min. Online is still to be confirmed by the owner (app or Telegram /status).
- **Practice trades:** WORKER-1e #117 is merged, so the S0 shakedown with the labelled diagnostic set starts once the real worker runs. Practice P&L stays rough until PAPER-1 (audit M4, M5, M8) merges.
- **External audit (Report 1):** real defects were found in paper accounting, latches, stale snapshots, recovery, research and statistics. Every finding is a card (HANDOVER §4; DECISIONS "External audit 1"). The verdict stands: paper and research mode only.
- **History:** Helius free only (about 2–3 practice days a month alongside the live worker). 09-21 is downloading (run 37185822426, about 14 h). The proof needs about 50 practice days plus 28 holdout days, which is impossible on free alone; the paid month (about US$94) waits for the owner's decision after seeing a finished product.
- **Research:** RES-4 (cost math; break-even 4.4–5.0% at $2 and 2.2–3.1% at $20 per trade, as scored) is in review. RES-5's selection failed calibration and is being fixed. An early look on free days reports descriptive numbers only (SPA needs at least 10 days).
- **Owner's estimate:** under about 2% chance of proof today (judgement). No deposit before all six pre-funding items pass.

## Done
- Owner rules in `AGENTS.md` and `CLAUDE.md`; the starting brief and the research in `docs/`.
- TypeScript workspace (pnpm, TypeScript 7, Vitest 5); CI on every PR.
- Brand files and guide (`brand/`, `docs/BRAND.md`).
- Merged: WEB-1 (PR #1), CORE-2 (PR #2), CORE-1 (PR #3), APP-1 (PR #5), DOCS-1 (PR #6: architecture, RESEARCH.md, DECISIONS.md, build plan), CORE-1b (PR #7), APP-1b (PR #12: pinned actions, no backup, safe APK swap, verified on the live release), CFG-1 (PR #13: versioned policy, session lock, tighten-only, baselines), DOCS-1b (PR #15), DEC-1 (PR #11: chain decoders with mainnet golden vectors), CORE-2b (PR #14: typed no-quote reasons, coin guard, v2 vault accounting, Global as a checked input), ENG-1 (PR #10: engine core, blind-to-future proofs, purity guard and runtime trap), LEDGER-1 (PR #9: append-only SQLite ledger, atomic reservations, separate scoring store), STATS-1 (PR #8: labels, day-block bootstrap, e-process, sealed holdout, Holm), UI-2 (PR #17: dashboard data screens, strict report schema), FEED-1 (PR #21: live feed, provider adapters, quota scheduler, recorded release order for parity, coverage gap facts), LEDGER-REPLAY (PR #23: `pnpm ledger:replay` checks a ledger against the reducer; versioned strict book detail; orphan rows refused), TX-1 (PR #20: unsigned builders, signer policy, landing client with node-skew guard), FUND-1 (PR #25: Deposit and Withdraw screens; QR via qrcode-generator), LEDGER-1b (PR #27: several positions per entry intent, so a late BUY landing is stored), GATE-1 (PR #22: hard rejects H1–H16, regime gate, lockers count as holders), BT-1 (PR #24: transaction-level backtester, paper fill model, `Ledger.recordBookEvent`), OPS-1a (PR #19: one-line installer, 6-word key handoff, update gate deploys only signed all-green commits), CI-1 (PR #31: heavy test suites isolated, timeouts sized from measurement), OPS-1b (PR #26: Cloudflare watchdog on workers.dev, route-bound HMAC heartbeat, off-site backup off), DATA-1 (PR #16: historical dataset schema 2, one-lane scan workflow, strict QA, DEC-1 parity), RUN-1 (PR #32: dry-run runner for the VPS and an Actions rehearsal, worker process contract), OPS-1c (PR #36: the server sets the Telegram webhook after pairing), GATE-1b (PR #29), TEST-2 (PR #28: dry-run simulation; Helius smoke run recorded in PR #38), BT-1b (PR #30), EXIT-1 (PR #33: exit engine; attempt budget from the book), RES-2 (PR #4: copy-trading not usable), RUG-1 (PR #34: as-of rug labeller; H14 fails safe), DATA-1 per-day publish (PR #35), RUN-1b (PR #37: item-4 block), RISK-1 (PR #18: risk policy R1–R16; exit retry cost counted), LEDGER-1c (PR #40: account version, one-transaction snapshot, fails closed), UPG-1 (PR #39) and UPG-1b (PR #44: regime boundaries B2–B5), GATE-1c (PR #42: event-tail gate).
- Android preview APK at a fixed link: https://github.com/macdarenz-droid/Meme-snipe/releases/download/preview/zeroed-preview.apk (sample data only). Real backtest results will show in its Backtest view once BT-1 publishes its first report (UI-2 loads it from the `backtest` release).
- All four API keys checked from CI: they work.

## Board
Core plan re-checked by the new supervisor, Mon 5 Oct about 8:53 AM, against `docs/ARCHITECTURE.md` (read in full), the code and the live summaries. Builders run as separate sessions, a fresh reviewer checks each PR, and the supervisor merges one at a time into `ccr-14987baf-i6lrsl` (CI about 24 min per merge, the bottleneck). Details and session ids: `HANDOVER.md`.

**Where the bot really is (verified).** The whole engine exists and runs on the server in paper (S0 shakedown, release e32cd0d). It restarts often (42 boots between midnight and 8:44 AM; each boot writes two `start` lines because the `--reconcile` pre-step builds a Worker too) and has judged no coin today (508 seen, 0 refused, 0 entered). Until Deploy #4 (7:59 AM) candidates lived only in memory, so a restart dropped them before their 60-minute U2 window opened; since #170 (RESTART-KEEP, in e32cd0d) they are saved every 5 minutes and restored, so the first judgements can show from about 9:00 AM. Not verified: the exit cause of the restarts (no host access; #148 fixes the crash paths found in code; #209 records the cause).

**What gates proof and money (verified).** No historical day is published (the repo's only releases are `preview`; no `data-day-*` or `data-volume-*`). Helius free covers about 2–3 practice days a month (recorded estimate: a day about 250k of the 1M monthly credits, the live worker about 408k), and the archive scanner was last recorded as refused (not re-checked today). So pre-funding items 2 and 6 (backtest and a proven strategy) cannot finish on free data; the owner decides on paid data after seeing practice trades and the early look (HANDOVER §7). Live regime volume reads `data-volume-DAY` releases at D−3, so without them a real strategy's regime gate is unknown (off); only the S0 diagnostic waives it (DATA-5).

| Stream | What it gives the bot | PRs (merge order) | Builder | Reviewers |
|---|---|---|---|---|
| 1 Stays up | no crash loop; memory and disk bounded before the worker stays up for days (G4a needed within about 2–3 days of uptime); backups | #202, #148 → deploy and watch; #209; #164 (G4a); #139, #172; #187, #204, #192, #196, #207; #149, BACKUP-STATE, DISK-GUARD | WORKER-HARDEN; WORKER-1d; persist; ops builder 2 | worker/facts, persist, ops |
| 2 Judges coins right | coins actually reach the gates (checked from the summary after every deploy); entry size; regime inputs | #189, #177 | READ-COHERENT | EXIT, persist |
| 3 Right money | practice P&L exact, counted in SOL (owner rule) | #198, #168, #197 (SOL-BOOKS), #203, #201, #186 | PAPER, WORKER-1d (#168), risk builder (#197), practice-on, API/APP (#201) | risk, worker/facts, run/CI |
| 4 Exits work | a restart keeps the exit's evidence and resends a lost exit; the sell route is checked | #141 (closes #121), #130, #176, #171 | WATCH, persist, EXIT builders | risk, persist, EXIT |
| 5a Early look | a descriptive backtest of the free 09-21 day (owner asked to see it before deciding on paid data) | data-scan run 37220726125 (09-21, running); #154, #122, #152 | BT, data | BT, data |
| 5b Proof | the registered strategy, walk-forward and sealed holdout | waits for the owner's data decision; #115, #191, #160, #127, #138, #98 then | RES, STATS, data | stats, BT, data |

Waiting (outside the core): Telegram alerts and controls (#161, #178, #190, #199), app changes (#167, #181, #182), summaries and observability (#174, #194, #200, #175, #211, #210), drills (#193, needed later for the qualifying run), CI-SHARD (#206, blocked by the safety check), docs and supply chain (#143, #146, #135, #136), paid history storage (#150, owner decision).

## Priority hierarchy (verified 6 Oct 9:50 PM; owner picks the next task, one at a time)

This replaces the Board order for new work (CLAUDE.md "One task at a time"). It comes from the owner's Fable review (7e5aa96), re-checked against base 0f32a79a by workflow wf_281f6178-a9d: 6 adversarial verifiers, a completeness critic and a ranking. Full verdicts with file:line are in HANDOVER, 9:58 PM.

I checked everything against the current code (base 0f32a79a) on Tue 6 Oct at 9:49 PM Melbourne time. Every "True" item below was confirmed in the code. Times and figures marked "about" are estimates.

### Tier 1: the bot can't trade, or would trade with the wrong money
| ID | Problem | What fixing it does | Size | PR / branch | Status |
|---|---|---|---|---|---|
| T1-1 | Every coin fails the first check. The bot never sees the last buy that finishes a coin's launch. | Coins can get past the first check, so the bot can trade at all. | M | #255 COMPLETION-READ | In progress (in review) |
| T1-2 | The Helius data credits run out about 3 PM Wed 7 Oct (supervisor's estimate, about 46k credits an hour; not measured again) | The bot keeps its eyes open. When the credits are gone it stops buying. | Your step (new key or paid plan), plus M for a usage cut | #250 (usage cut) | **Needs you** |
| T1-3 | The disk fills about Thu 8 Oct: recordings add 4.5–7 GB a day and 13 GB is free | Recordings stay under a size limit and are uploaded, so the bot doesn't fall over. | M | #254 RECORD-BUDGET, #244 RECORD-UPLOAD | #254 in progress; #244 ready, held until after the T1-1 deploy |
| T1-4 | The SOL price feed goes quiet for a few seconds and the bot pauses as if the feed broke (about 5% of the time) | Quiet seconds no longer pause buying. | S | #256 COINBASE-LIVENESS | In progress |
| T1-5 | Two of your entry rules (the pool must hold at least $15k; the price must not already be up 5 min after launch) let through 0 of 22 sampled pools | This is not a bug: they are your rules. Easing them needs a study on past data and your OK. | Decision (the study is L) | — | **Your call.** Parked until past data exists (T4-3). |
| T1-6 | The pool-safety rule H5 may wrongly refuse pools whose trades leave small leftover amounts | Tests H5 on 200+ real trades. Any change comes to you. | M | claude/tail-proof | In progress (research) |
| T1-7 | The insider check (H13) likely refuses almost every coin that reaches it: a first buyer with more than 3,000 transactions counts as "unknown". 2 of 2 sampled coins failed. A stuck coin also uses up the hourly test-trade allowance. | Busy wallets get looked up properly, so good coins aren't all refused. | M | — | Not started. Measure on live data after T1-1 first. |
| T1-8 | Money limits are counted in dollars, not SOL | SOL's price alone can't stop the bot. Today, with no trades at all, a fall of about 6% in SOL blocks every buy, and a fall of about 22% locks the kill switch until someone edits a file by hand. | L | #197 SOL-BOOKS (needs #168 first) | Draft, out of date |
| T1-9 | The cost check counts about a quarter of the expected costs. It assumes the token-account deposit always comes back and prices failed sells at the cheapest fee. | The bot stops taking trades that lose money on costs. | M | — | Not started |

### Tier 2: paper results couldn't be trusted as proof
| ID | Problem | What fixing it does | Size | PR / branch | Status |
|---|---|---|---|---|---|
| T2-1 | Paper sells fill too easily. There is no busy network, no provider outage and no worse price on a repeated sell try; the backtest has all three. | Paper profit stops looking better than real life. | M | — | Not started |
| T2-2 | Take-profit fires on a brief price spike and ignores the "wait for slot close" setting | Sells follow the same rule as the backtest. | S | — | Not started |
| T2-3 | The bot measures a trade's risk and its cost differently live and in the backtest. A part-sell fires at 1.19x live but 1.39x in the backtest. | Exits happen at the same prices on both sides. | M | — | Not started (do after T1-9) |
| T2-4 | Live and backtest strategies are two separate programs, and no test compares them | First a test that lists every difference, then one shared strategy. | Test S–M; full fix L | — | Not started |
| T2-5 | Coins the bot never judged aren't counted: a coin's window ends unjudged, coins are lost on a restart, nothing is logged per coin during a pause (only partly true) | Every missed coin is counted, with its reason. | M | — | Not started |
| T2-6 | Pool depth is counted twice as large live as in the backtest | Same number on both sides. No decision changes today. | S | — | Not started |
| T2-7 | The median-target cap is 33% live and 10% in the backtest | Same cap on both sides. No decision changes today. | S | #225 | Draft |

### Tier 3: staying up for days
| ID | Problem | What fixing it does | Size | PR / branch | Status |
|---|---|---|---|---|---|
| T3-1 | After 10 quick crashes in 10 minutes the server stops restarting the bot, and one file write has no full-disk guard | The bot keeps retrying slowly, and a full disk pauses buying instead of crashing. | S | The guard is inside #149 | Not started |
| T3-2 | Backups copy only the trade record. They skip the paper wallet, the pause and kill locks, saved exit plans and all paper fees. | A restore brings back the whole bot, with its locks still on. | M | #149 BACKUP-STATE | Draft, changes needed |
| T3-3 | A damaged save file stops the bot completely instead of starting it in sell-only mode | The bot can still sell what it holds. | M | — | Not started |
| T3-4 | After a Helius connection drop, coin launches it missed are never filled in | The history of who launched which coins stays complete. In the strict 48-h run, one drop would otherwise block rule H14 for 14 days. | M | — | Not started |
| T3-5 | Each deploy throws away up to about 4 h of coins being watched | Space deploys apart (a habit now, no code). | S | — | Habit now |
| T3-6 | There is no off-site backup at all | One encrypted copy kept off the server. | S | — | **Needs your OK** to send it to Telegram |
| T3-7 | Tests take 26 minutes of their 30-minute limit | Fixes keep merging; one slow run can't cancel a good one. | M | #206 | Draft, blocked by a safety check |
| T3-8 | Small delays: H15 re-checks on every SOL price tick, and the stop-loss needs 14 unbroken minutes of trades | Measure after T1-1, fix only if they block. | S | — | Watch |

### Tier 4: proof, and before real money
| ID | Problem | What fixing it does | Size | PR / branch | Status |
|---|---|---|---|---|---|
| T4-1 | The dry run's mainnet test fails every buy and every sell. The spending caps are below what the safety policy counts, and an off-by-one refuses the 25% emergency sells. | Pre-funding item 4 can pass. Must land before the 48-h run counts. | S | — | Not started |
| T4-2 | Outside practice mode the network-health check can never turn green, so no real strategy can buy | Real strategies can trade once you set the limits. | S, plus your limits | — | Not started |
| T4-3 | There is no past data yet | Backtests become possible (items 2 and 6). | L, plus your choice (paid Helius about US$94 a month) | #150, #152, #214 | **Needs you** |
| T4-4 | Helius use is about 33x the free plan, and the dry-run report requires staying within it | Item 3 can pass. | Your plan choice, or a usage cut of about 94% | #250 | **Needs you** |
| T4-5 | The proof test G1 can never pass: one required statistics test isn't connected | G1 can pass. Must land before anyone freezes a strategy, or its one-shot test is wasted. | M | — | Not started |
| T4-6 | Hidden test results are written to disk before they may be opened | The "look only once" rule holds. | S | — | Not started |
| T4-7 | A registered test doesn't pin the code version and the data | A failed test can't be re-run on changed code. | S | — | Not started |
| T4-8 | There is no proven strategy; only the random practice mode can buy | A real strategy the bot can run. | L | #115, #191 | Waits on T4-3 and T4-5 |
| T4-9 | No real backtest or hidden-data test has been run | Evidence for items 2 and 6. | L | #154 | Waits on T4-3 |
| T4-10 | The check that the dry run matches the backtest (G3) isn't connected | The second half of item 6 can be judged. | M | #98 (very out of date) | Not started |
| T4-11 | The U2 exit plan has no measured results and may not reach 300 test trades by 20 Oct | Decide whether to keep U2. | S (decision) | — | Not started |
| T4-12 | The watchdog's SOL-reserve and position alarms can never fire | The alarms work before real money. | S | — | Parked (alerts) |
| T4-13 | A failed key change breaks /pause in Telegram | Your remote stop always works. | M | #161 | **Waits on your OK** to store key fingerprints |
| T4-14 | The program that will sign real transactions doesn't exist yet | Needed only before live trading. | M | — | After the proof, with your approval |
| T4-15 | Coin features that don't block trades aren't logged | Data for tuning later. | M | — | Not started |

### Tier 5: docs and housekeeping
| ID | Problem | What fixing it does | Size | PR | Status |
|---|---|---|---|---|---|
| T5-1 | PROJECT_STATE is about 39 merges out of date; the current HANDOVER is only on a side branch | Records you can trust. | S | — | Not started |
| T5-2 | Docs promise things that weren't built: R2 backups, Healthchecks, @solana/kit, the Helius 70% stop (you dropped it), a Jupiter fallback | Docs match the code. | S | #143 (out of date) | Not started |
| T5-3 | The main branch on GitHub has no protection, and AGENTS.md names a "main" branch that doesn't exist | Nobody can wipe or rewrite history. | S | — | **Needs you** (repo admin) |
| T5-4 | 3 of the package-install safety settings are missing (the others are set) | Safer installs. | S | #135 | Draft |
| T5-5 | The raw price data behind the 518-coin study isn't in the repo | The study can be checked again. | S | — | Not started |
| T5-6 | No test-coverage report and no nightly mutation run | Better test signal. | M | — | Not started |
| T5-7 | The app's Wallet screen is always empty | Shows the wallet. | S | — | Parked (app) |

### Already fixed, or not true
- **Dollars in the app headline:** fixed (#182, merged in #253). The daily-loss meter still converts dollars until T1-8.
- **Cheapest fee charged on sell retries:** fixed in #253. Draft #201 can be closed or cut down.
- **Dry-run problems changing paper trades:** not true. The dry-run results are only logged.
- **"No Helius 70% stop in the code":** the stop exists. You turned it off for Helius on 5 Oct; only the docs are out of date (T5-2).
- **"Unjudged coins not counted":** partly true. Each one is logged as "window ended" but not counted on its own (T2-5).
- **Restarts every 5–12 minutes:** these were out-of-memory crashes, fixed by #249. No crash since 1:06 PM.
- **Filling the launch history from published days:** true, but not worth doing. It stops helping after 16 Oct. Parked.

### Where (for the supervisor)
| Item | Location |
|---|---|
| T1-2 | HANDOVER 7:02 PM; `worker.ts:1584` |
| T1-3 | HANDOVER 8:03 PM; `deployer-store.ts:54`; `DECISIONS.md:2966` |
| T1-4 | HANDOVER 8:43 PM |
| T1-5 | HANDOVER 8:43 PM; `policy.ts:205` |
| T1-7 | `facts/source.ts:393`; `facts/readers.ts:782-785`, `:811-814` (rechecked) |
| T1-8 | `policy.ts:190`; `risk/evaluate.ts:118-137`, `:311-341`, `:510`; `account.ts:184`, `:197` |
| T1-9 | `costs/index.ts:175`; `run/settings.ts:39-46`; `research/edge-costs.ts:38-60` |
| T2-1 | `paper-world.ts:275`, `:334-337` vs `sim/world.ts:151-162`, `:228` |
| T2-2 | `strategy.ts:2068`; `exits/rules.ts:314-317` |
| T2-3 | `strategy.ts:2041-2043`, `:2178-2187` vs `study.ts:575`, `:630`, `:643` |
| T2-4 | `strategy.ts:616`; `study.ts:134`; `run/parity.ts:154` |
| T2-5 | `strategy.ts:2264-2286`; `worker.ts:773`, `:1414-1440` |
| T2-6 | `strategy.ts:2479` vs `study.ts:500` |
| T2-7 | `run/settings.ts:37` vs backtest `strategy/config.ts:155`, `:162` |
| T3-1 | `zeroed-worker.service:9-10` |
| T3-2 | `zeroed-backup:15` |
| T3-3 | `run/state.ts:52-56` |
| T3-4 | `sources.ts:314`; `solana-ws.ts:449`, `:551` |
| T3-5 | `seed/fill.ts:145-148` |
| T3-6 | `host-config.json:2` |
| T3-7 | `ci.yml:22-35` (run: 26 min 15 s) |
| T4-1 | `worker.ts:661-667`; `tx/policy.ts:113-116`, `:282-286`; `live-sim.ts:116`; `tx/trade.ts:153` |
| T4-2 | `main.ts:112`; `facts/producer.ts:948-953` |
| T4-4 | runner `report.ts:247` |
| T4-5 | `study/gates.ts:31-35` |
| T4-6 | `study/study.ts:394-428` |
| T4-7 | `strategy/config.ts:194-199`; `holdout.ts:309-316` |
| T4-8 | `contract.ts:203` |
| T4-10 | `stats/gates.ts:962` (no callers) |
| T4-12 | `worker.ts:2010`; watchdog `logic.ts:163` |
| T4-13 | `publish.sh:63-65`, `:88` |
| T5-2 | `ARCHITECTURE.md:121`, `:143`, `:283`, `:334`, `:336` |
| T5-3 | `AGENTS.md:57` |
| T5-7 | `App.tsx:29` |

## Follow-ups
- Android: cover a stop between the two asset renames, the "fixed name plus .prev" state, and a failed final delete (APP-1b review notes).
- Money scanner: aliased unit constants and a regex right after `)` (CFG-1 review notes; defence in depth).
- Chain: i16 0x8000/0x7fff and u32 0x80000000 boundary vectors (DEC-1 review note).
- Quotes: a test for the initialVirtualSolReserves ≤ 0 refusal (CORE-2b review note).
- BT-2: record and burn every holdout run in the STATS-1 registry, so a holdout can't be rerun into a new file (PR #24 review).
- GATE-1b: read FEED-1's coverage facts as history; an open gap (toSlot null) is uncovered until its bounded gap or resume (matched by via + fromSlot).
- FUND-1 → SIGN-1: re-check the destination and balance after the step-up; persisting the 24 h saved-wallet change is a new saved-data shape (owner approval).
- SEED-1 (WORKER-1 wave): seed the deployer index from history at start-up, or H14 rejects for 14 days after any restart and the dry run makes no entries.
- WORKER-1: fetch confirmed transactions for shortlisted mints (live H9/H12–H14 need the confirmed create).
- WORKER-1 restart drill: rebuild the exit attempt budget from the book, and restore trail, peak, flatMet and partials (save per step or replay as-of); a reset trail is a looser stop (EXIT-1 review). Store the universe with the position at entry, so a restored position rebuilds its EntryPlan without a default (CFG-2 review).
- OPS-1d: install RUN-1's zeroed-dryrun units and runner flags through code updates, hold deploys during a qualifying run, and give the VPS evidence a path into the repo.
- Runbook (RUN-1/WORKER-1): a v1 ledger must be opened once by a writer (migrates to 2) before `ledger:replay` or `openReader`.
- Data: the owner declined asking Triton for a faster download (4 Oct); the scan stays at 80 MB/s on one lane. Since then the archive refused all requests for 5 h; if that continues, the owner is asked to request bucket access or limits (about access, not speed).
- Owner, before live (RISK-1): worst-case cost per trade C ≈ $0.79 after EXIT-1's retry budget; $5 entries stay blocked until week-start equity reaches $29; new entries stop at about 84% of the peak; the daily and weekly loss count an open loss again each day (stricter; switching to marked boundaries needs the owner's yes).
- Owner, before live (third opinion): R8 "5 losses in any 20" pauses 79–97% of simulated paths within 8–11 trades, good strategy or bad; choose keep, or a threshold calibrated on practice data and validated separately (never the holdout). With C at about 40% of a $2 trade, one loss of about $0.70 ends the day.
- Live regime volume: resolved without a paid service. Live reads our own published day assets with a D−3 lag (FACTS-1d, DATA-1c).
- Proof timeline: U2 may hold fewer than 300 holdout trades (unmeasured); BT-2 counts the funnel gate by gate on practice days before any freeze, and dates follow that count. "Not proven yet" for U2 is a possible honest result.
- G1 uses the SPA test (owner, 4 Oct 2:33 PM; STATS-1f #109). Later, as the owner's upgrade idea: an owner setting to choose G1's test (SPA or DSR). Both paths are kept and tested; no switch is built now.
- Workflows: pinned actions target Node 20 and run forced on Node 24; re-pin when workflows are next touched (supervisor, `.github`).
- RUN-1b: a negative quoteAgeSlots passes the decimal check (display only).
- TX-1 → SIGN-1: maxSolOut needs about 1.5M lamports of PumpSwap headroom; the policy charges Token-2022 ATAs at 170 bytes.
- Repo tidy-up: branch `claude/ledger-replay-schema-v1` duplicates PR #23's 611a4bb; the safety check refused its deletion, so the owner may delete it.

## Last part (before funding)
Owner, Mon 5 Oct about 5:07 AM (three marked screenshots): "These are future updates, when all task is done. When we reach production area and I'm about to put money. To be done in last part." Built after every other task, before the owner funds the bot; not started earlier.
- **Stats tab.** The bottom tab "Samples" (the preview-only sample-data screen) becomes "Stats": every visual on real data (stats, charts, diagrams). The sample-data screen leaves the app.
- **Settings screen** (new). It holds:
  - the Server card (address, status, last update, access, Change and Remove), also kept on Snipe;
  - the theme choice (Paper or Silent Black), which leaves Home.
- **Header.** The "Paper" chip beside the logo reads "Zeroed".
- **App controls** (owner, Mon 5 Oct about 4:05 PM: "Put this in the future upgrade when we fix the apps main issues and intelligence. Put command on pause that trigger pause to server. When i click start, should be able to start again as new day even the risk ratio reached 3x. Before midnight").
  - When: after the app's main issues and the bot's judging are fixed. Not started before then. Owner, Tue 6 Oct about 1:00 AM: this stays with Supervisor 1, second to last in the queue (only paper and backtest removal comes after it).
  - Pause: the app's Pause button sends a pause to the server. Today it only shows the state; pausing is Telegram `/pause`, and resuming is `zeroed-resume` in the server console.
  - Start: the owner can start again as a new day before midnight, even after a daily risk limit has stopped entries (the owner's example: 3×).
  - Design first: the app sending commands changes ARCHITECTURE §12 and §5.2 (today the app sends no commands, and Telegram never resumes or raises limits). So it needs a signed-command design (the owner's paired device only, single use, logged), and the risk reviewer must pass the start-again override (owner-only, recorded in the ledger, never automatic). Related open PRs: #199 (OWNER-REVIEW b: /override), #190.
- **Cost-limit slider (RISK-DIAL)**: parked on Mon 5 Oct about 4:20 PM (owner: "park my demand about the slider %. Until i say so. Keep what we have atm."). On Tue 6 Oct about 1:00 AM the owner put it in Supervisor 2's app queue (`HANDOVER-APP.md` item 8): design first, then a risk review, then the owner's OK on the final design before any build. Until then R14's maxRoundTripBps stays 500.
  - The request: an app slider from 5% (default) to 100%, set only by the owner.
  - Found in design review, kept for when it resumes:
    - the dial also drives R5 sizing (evaluate.ts:505–506), so on the $20 trial bankroll it has effect only up to about 6–16%, depending on the stop;
    - the 33.3% median-target share and S0's expected-net limit (about 17.8%) also bind;
    - passkeys can't work in the Capacitor app without a domain, so the owner's signature would be a device-bound Android Keystore key with a biometric prompt, registered on the host only;
    - every error path must fall back to 500, and the raise is paper only.
- **Paper and backtest removal** (owner, Mon 5 Oct about 5:15 AM: "when the app is ready we gonna remove all paper based features in ui. Even all paper, backtest logics. In the future. NOT NOW. ONLY WHEN THE APP IS READY. Removal of those treat as high risk and be very careful ... before removal of these items, i need it to be architectured properly").
  - When: only after the owner says the app is ready, which is after the six pre-funding items pass (they need paper and the backtest).
  - What: every paper feature in the app, and the paper and backtest code.
  - The risk: live trading runs on the same engine, quotes, risk, fills and exits code that paper and the backtest use (only the feed and the clock differ). Deleting by name ("paper", "backtest") could delete code that live money depends on.
  - Before any removal, an architecture plan in `docs/ARCHITECTURE.md` is written and reviewed:
    - every module mapped as paper-only, backtest-only or shared with live, with its callers;
    - the order of removal in small PRs.
  - Each removal PR proves live is unchanged: recorded live data replays to identical decisions and transactions before and after, every live-path test still passes unchanged, and the risk reviewer and a fresh reviewer pass it.
  - Shared code is never deleted or changed as part of the removal.
  - The "Paper" theme is a theme name, not paper trading. It stays, and moves to Settings with Silent Black.

## Owner setup
- Hosting approved by the owner (2026-10-03): about US$6/month, Vultr High Performance in Frankfurt; Hetzner as backup.
- API keys are in GitHub repository secrets and verified: `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN` (bot @Zeroed_alerts_bot). Never in chat or in the repo.
- Vultr: server `zeroed` running (vhp-1c-1gb, Frankfurt, Ubuntu 24.04.5, no backups, US$6/month), created 2026-10-03. Tailscale key expiry disabled for it by the owner (4 Oct, about 4:27 PM). Set up on 2026-10-04: keys stored (4), Telegram paired, signer active. Re-installed by the owner at pin e28788a (OPS-1g) on 4 Oct, with Tailscale (HTTPS on, `tailscale serve` to the tailnet only) and the holdout-registry ruleset, all done at 2:31 PM. Host code changes arrive through code-only Deploy runs (the supervisor may run them; `DEPLOY_CODE` stays deleted) and the server's update gate. The app shows "Server error" until the real worker runs.
- Cloudflare: Account API token (Edit Cloudflare Workers template, 1-year expiry) is in GitHub secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, verified active from CI. Renew before 2027-10-03.
- Domain: none, and none will be bought (owner rule in CLAUDE.md). Watchdog on the free `workers.dev` address; live dashboard access later through Tailscale's free personal plan.
- Telegram bot display name: change with /setname in BotFather (optional).

## Open questions
- Owner: check "Zeroed" on IP Australia before public launch; check the chosen exchange on AUSTRAC's register.
