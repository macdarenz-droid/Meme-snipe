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
Wave D, plus fixes from an outside review (4 Oct 2026, Melbourne). All 20 findings are assigned; each must reproduce before it is fixed.
- **Server:** live and paired.
- **History:** the download waits on DATA-1's final data-shape PR (#46: full curve and canonical-pool rows, raw records for every create and migration, owner-resolved token movements, regimes).
- **Building:** the worker, gate-fact producers, start-up seed, rug check, backtest study, signal research, live app view, server extras, and the review fixes.

## Done
- Owner rules in `AGENTS.md` and `CLAUDE.md`; the starting brief and the research in `docs/`.
- TypeScript workspace (pnpm, TypeScript 7, Vitest 5); CI on every PR.
- Brand files and guide (`brand/`, `docs/BRAND.md`).
- Merged: WEB-1 (PR #1), CORE-2 (PR #2), CORE-1 (PR #3), APP-1 (PR #5), DOCS-1 (PR #6: architecture, RESEARCH.md, DECISIONS.md, build plan), CORE-1b (PR #7), APP-1b (PR #12: pinned actions, no backup, safe APK swap, verified on the live release), CFG-1 (PR #13: versioned policy, session lock, tighten-only, baselines), DOCS-1b (PR #15), DEC-1 (PR #11: chain decoders with mainnet golden vectors), CORE-2b (PR #14: typed no-quote reasons, coin guard, v2 vault accounting, Global as a checked input), ENG-1 (PR #10: engine core, blind-to-future proofs, purity guard and runtime trap), LEDGER-1 (PR #9: append-only SQLite ledger, atomic reservations, separate scoring store), STATS-1 (PR #8: labels, day-block bootstrap, e-process, sealed holdout, Holm), UI-2 (PR #17: dashboard data screens, strict report schema), FEED-1 (PR #21: live feed, provider adapters, quota scheduler, recorded release order for parity, coverage gap facts), LEDGER-REPLAY (PR #23: `pnpm ledger:replay` checks a ledger against the reducer; versioned strict book detail; orphan rows refused), TX-1 (PR #20: unsigned builders, signer policy, landing client with node-skew guard), FUND-1 (PR #25: Deposit and Withdraw screens; QR via qrcode-generator), LEDGER-1b (PR #27: several positions per entry intent, so a late BUY landing is stored), GATE-1 (PR #22: hard rejects H1–H16, regime gate, lockers count as holders), BT-1 (PR #24: transaction-level backtester, paper fill model, `Ledger.recordBookEvent`), OPS-1a (PR #19: one-line installer, 6-word key handoff, update gate deploys only signed all-green commits), CI-1 (PR #31: heavy test suites isolated, timeouts sized from measurement), OPS-1b (PR #26: Cloudflare watchdog on workers.dev, route-bound HMAC heartbeat, off-site backup off), DATA-1 (PR #16: historical dataset schema 2, one-lane scan workflow, strict QA, DEC-1 parity), RUN-1 (PR #32: dry-run runner for the VPS and an Actions rehearsal, worker process contract), OPS-1c (PR #36: the server sets the Telegram webhook after pairing), GATE-1b (PR #29), TEST-2 (PR #28: dry-run simulation; Helius smoke run recorded in PR #38), BT-1b (PR #30), EXIT-1 (PR #33: exit engine; attempt budget from the book), RES-2 (PR #4: copy-trading not usable), RUG-1 (PR #34: as-of rug labeller; H14 fails safe), DATA-1 per-day publish (PR #35), RUN-1b (PR #37: item-4 block), RISK-1 (PR #18: risk policy R1–R16; exit retry cost counted), LEDGER-1c (PR #40: account version, one-transaction snapshot, fails closed), UPG-1 (PR #39) and UPG-1b (PR #44: regime boundaries B2–B5), GATE-1c (PR #42: event-tail gate).
- Android preview APK at a fixed link: https://github.com/macdarenz-droid/Meme-snipe/releases/download/preview/zeroed-preview.apk (sample data only). Real backtest results will show in its Backtest view once BT-1 publishes its first report (UI-2 loads it from the `backtest` release).
- All four API keys checked from CI: they work.

## Board
Builders run as separate sessions; a fresh reviewer session checks each PR; the supervisor merges into `ccr-14987baf-i6lrsl` when review passed and CI is green on a head with the latest base.

| Task | What | Session | Model | State | Estimate |
|---|---|---|---|---|---|
| DATA-1 | Final data shape (PR #46), then run 1 (1 Oct back to 16 Sep), run 2, run 3; 60 decision days | session_01XHH3k24fjmkpmmt28xSaYv | Opus 5.5 | #46 adding migrations raw, token movements, regimes; then re-review (session_01DKMnUiqVLxVjHbaqdoBnJD) | scan restart after merge; newest 14 days about 30–35 h later |
| WORKER-1 | Worker, recorder, API (loopback), persistence and downtime fill | session_01F7UFCa8r4aee38kW7687Y3 | Opus 5.5 | building | PR about 11 AM–1 PM |
| FACTS-1 | Shared fact producers (live and backtest), funding lookup, holders by owner, on-chain regime volume | session_01GDycboQzFrFWxVniy6B6Ps | Opus 5.5 | building | 3–5 h |
| SEED-1 | Start-up seed and downtime fill (PR #45) | session_013LeD4RMaJMybRnPVRn4LXM | Opus 5.5 | fixing 5 review items; reviewer session_01NZwyB8decLbgxKJoG2cAbP | 1 h |
| RUG-1b/1c | Traded non-rug fixture; on-demand per-deployer rug check; label kinds; collapse-size validation | session_01WGpxEWFacSgAuXL5KAzrKc | Opus 5.5 | building | 1c about 11 AM–1 PM |
| GATE-1d | Holder check by owner with a worst-case bound; "observed distinct owners" | session_01MeeF4VytwgP5sqyAkqM2NS | Opus 5.5 | building | 1–2 h |
| RISK-1b, EXIT-1b | Unitized drawdown; stressed-loss reporting; risk simulation; partial-sell quote; retry affordability | session_0135ruSv84BVjo7knvmTCPPK | Opus 5.5 | building; risk reviewer session_017PBUwcGJWG4DJpJKVBcAas | 2–3 h |
| BT-1c | Canonical G0, holdout authorisation, observation delays, harsher fills, all-in expectancy, currency split, operating costs | session_016KSN98NC2xQxetiZkpCVtT | Opus 5.5 | building | 3–4 h |
| BT-2 | Backtest study (PR #41): deployment replay, frozen definitions, ablations, completeness manifest, trial view | session_01VBTfAwrhgoCssEzST2J2q5 | Opus 5.5 | building on fixtures; holdout boundary pending | 4–6 h, then data |
| RES-3 | Signal research (PR #47), practice days only | session_018esLCVLp9yCExK5cdnzCz8 | Opus 5.5 | re-review (session_01FHfbJwz7sbf2eVDNRxMigZ) | data from about Tue 6 Oct |
| STATS-1b | G3 veto bias and post-upgrade "agrees" criteria; cluster sensitivity; effective-trials DSR | session_01J9yEWHRunNxvo5CaTbuYSe | Opus 5.5 | building | 2–3 h |
| TX-1b | One supported-transaction-shape check for gates, backtest and builders | session_011NPXb9ohcgyccEx2RLgZn1 | Opus 5.5 | building | 1–2 h |
| RUN-1c | Quota, coverage and worker-down exposure in the dry-run report | session_01VgCLpHWaM7FjpwofRcgrwM | Opus 5.5 | building | 1–2 h |
| APP-2 | Live screens in the app over Tailscale (PR #43) | session_01HxjfFhpHEFghtBnZkTjnFB | Opus 5.5 | building | 3–4 h |
| OPS-1d | PR A: webhook retry, key-mismatch alerts, re-pair, `--update` hook. PR B: RUN-1 units, evidence relay, Tailscale serve | session_01Euok5FXtBGZBrweohP3K93 | Opus 5.5 | building | A about 1.5 h; B about 3 h |
| Next | TEST-1 parity and TEST-3 fault injection after WORKER-1; SIGN-1 later | — | — | by dependency | — |

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
- WORKER-1 restart drill: rebuild the exit attempt budget from the book, and restore trail, peak, flatMet and partials (save per step or replay as-of); a reset trail is a looser stop (EXIT-1 review).
- OPS-1d: install RUN-1's zeroed-dryrun units and runner flags through code updates, hold deploys during a qualifying run, and give the VPS evidence a path into the repo.
- Runbook (RUN-1/WORKER-1): a v1 ledger must be opened once by a writer (migrates to 2) before `ledger:replay` or `openReader`.
- Data: the owner declined asking Triton for a faster download (4 Oct); the scan stays at 80 MB/s on one lane.
- Owner, before live (RISK-1): worst-case cost per trade C ≈ $0.79 after EXIT-1's retry budget; $5 entries stay blocked until week-start equity reaches $29; new entries stop at about 84% of the peak.
- Workflows: pinned actions target Node 20 and run forced on Node 24; re-pin when workflows are next touched (supervisor, `.github`).
- RUN-1b: a negative quoteAgeSlots passes the decimal check (display only).
- TX-1 → SIGN-1: maxSolOut needs about 1.5M lamports of PumpSwap headroom; the policy charges Token-2022 ATAs at 170 bytes.
- Repo tidy-up: branch `claude/ledger-replay-schema-v1` duplicates PR #23's 611a4bb; the safety check refused its deletion, so the owner may delete it.

## Owner setup
- Hosting approved by the owner (2026-10-03): about US$6/month, Vultr High Performance in Frankfurt; Hetzner as backup.
- API keys are in GitHub repository secrets and verified: `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN` (bot @Zeroed_alerts_bot). Never in chat or in the repo.
- Vultr: server `zeroed` running (vhp-1c-1gb, Frankfurt, Ubuntu 24.04.5, no backups, US$6/month), created 2026-10-03. Set up on 2026-10-04 from the PR #36 line: keys stored (4), Telegram paired, signer active. One re-paste of OPS-1d's line comes later; after it, host changes arrive by update.
- Cloudflare: Account API token (Edit Cloudflare Workers template, 1-year expiry) is in GitHub secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, verified active from CI. Renew before 2027-10-03.
- Domain: none, and none will be bought (owner rule in CLAUDE.md). Watchdog on the free `workers.dev` address; live dashboard access later through Tailscale's free personal plan.
- Telegram bot display name: change with /setname in BotFather (optional).

## Open questions
- Owner: check "Zeroed" on IP Australia before public launch; check the chosen exchange on AUSTRAC's register.
