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
Builders run as separate sessions; a fresh reviewer session checks each PR; the supervisor merges into `ccr-14987baf-i6lrsl` when review passed and CI is green on a head with the latest base. The merge queue, open cards and sessions are in `HANDOVER.md` §4–5 (one place, kept current).

| Task | What | State | Estimate (Melbourne) |
|---|---|---|---|
| Merge queue | #114, #116, #118 (delta), #106, #107, #98, #123, then the audit-fix PRs (see HANDOVER §4) | moving one at a time | about 10 min each plus reviews |
| Online | deployed (7d5e203, run 37189025276); the owner confirms Online | waiting for the owner's check | now |
| Audit fixes | PAPER-1, RISK-LATCH #124, RISK-PARTIAL, WATCH-1c #121 / 1d, EXIT-1g #128 / 1h, PERSIST-2 #125 / 3, EXIT-ROUTE #130, WORKER-ORDER #123, STATS-1g #129, OPS-GATE, PNPM-CLAIMS, SEC-1, DATA-4 #127, DATA-5 | building or in review | about 2–3 days (±1) |
| BT-2 #41 | audit B1–B5 and S2, then RES-4 (b)/(c) under the stats rulings; early-look runner ready | building and in review | early look about Tue 6 – Wed 7 Oct |
| Historical data | 09-21 free day running; DATA-4 ledger after it | free plan only (owner) | 09-21 about Mon 8 AM; more days as credits allow |

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

## Owner setup
- Hosting approved by the owner (2026-10-03): about US$6/month, Vultr High Performance in Frankfurt; Hetzner as backup.
- API keys are in GitHub repository secrets and verified: `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN` (bot @Zeroed_alerts_bot). Never in chat or in the repo.
- Vultr: server `zeroed` running (vhp-1c-1gb, Frankfurt, Ubuntu 24.04.5, no backups, US$6/month), created 2026-10-03. Tailscale key expiry disabled for it by the owner (4 Oct, about 4:27 PM). Set up on 2026-10-04: keys stored (4), Telegram paired, signer active. Re-installed by the owner at pin e28788a (OPS-1g) on 4 Oct, with Tailscale (HTTPS on, `tailscale serve` to the tailnet only) and the holdout-registry ruleset, all done at 2:31 PM. Host code changes arrive through code-only Deploy runs (the supervisor may run them; `DEPLOY_CODE` stays deleted) and the server's update gate. The app shows "Server error" until the real worker runs.
- Cloudflare: Account API token (Edit Cloudflare Workers template, 1-year expiry) is in GitHub secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, verified active from CI. Renew before 2027-10-03.
- Domain: none, and none will be bought (owner rule in CLAUDE.md). Watchdog on the free `workers.dev` address; live dashboard access later through Tailscale's free personal plan.
- Telegram bot display name: change with /setname in BotFather (optional).

## Open questions
- Owner: check "Zeroed" on IP Australia before public launch; check the chosen exchange on AUSTRAC's register.
