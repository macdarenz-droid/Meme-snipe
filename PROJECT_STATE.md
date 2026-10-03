# Project state

## Owner goals
- An intelligent, precise, fast sniper that is above all risk aware and trades like a disciplined professional.
- Consistency. Risk aware, data aware. Research based on what actually matters in the market.
- No guessing: the bot acts only when the data proves the setup. Unknown or stale evidence means no trade.
- Bankroll $20, entries $2 default and $5 max, paper mode first. This is the trial setting only: capital and trade size are configuration and will scale once the bot proves itself.
- Easy deposit and withdraw in AUD. Stripe's onramp does not serve Australia (US and EU only). Deposit and Withdraw screens offer two exchanges to choose from, Independent Reserve and Kraken, with steps and costs; the bot only sends to the owner's saved wallet. Banxa in-app buying is possible later if a business (ABN) is registered.
- Dashboard: P&L calendar, trade history with full details, profit charts and the other visuals needed to see what the bot is doing. Smooth UI: motion, transitions, blurred backdrops behind opened panels.
- Two themes only: Paper (light) and Silent Black (dark); first open follows the device, then the owner's choice is remembered.
- UI words read as written by a person: no AI wording anywhere (see `AGENTS.md`).
- App name: Zeroed. Logo: "Slot" (a solid zero with a Z cut into it), files in `brand/`, rules in `docs/BRAND.md`.

## Phase
Wave 1 merged; from wave 2, FEED-1, TX-1, FUND-1, LEDGER-REPLAY and LEDGER-1b are merged. Risk, gates, backtester, installer and watchdog are in fix rounds; TEST-2 is building. Historical data is limited by the archive's rate limit (DATA-1 is looking for a legitimate source). The whale test result is due about 03:05 AEDT on 4 Oct.

## Done
- Owner rules in `AGENTS.md` and `CLAUDE.md`; the starting brief and the research in `docs/`.
- TypeScript workspace (pnpm, TypeScript 7, Vitest 5); CI on every PR.
- Brand files and guide (`brand/`, `docs/BRAND.md`).
- Merged: WEB-1 (PR #1), CORE-2 (PR #2), CORE-1 (PR #3), APP-1 (PR #5), DOCS-1 (PR #6: architecture, RESEARCH.md, DECISIONS.md, build plan), CORE-1b (PR #7), APP-1b (PR #12: pinned actions, no backup, safe APK swap, verified on the live release), CFG-1 (PR #13: versioned policy, session lock, tighten-only, baselines), DOCS-1b (PR #15), DEC-1 (PR #11: chain decoders with mainnet golden vectors), CORE-2b (PR #14: typed no-quote reasons, coin guard, v2 vault accounting, Global as a checked input), ENG-1 (PR #10: engine core, blind-to-future proofs, purity guard and runtime trap), LEDGER-1 (PR #9: append-only SQLite ledger, atomic reservations, separate scoring store), STATS-1 (PR #8: labels, day-block bootstrap, e-process, sealed holdout, Holm), UI-2 (PR #17: dashboard data screens, strict report schema), FEED-1 (PR #21: live feed, provider adapters, quota scheduler, recorded release order for parity, coverage gap facts), LEDGER-REPLAY (PR #23: `pnpm ledger:replay` checks a ledger against the reducer; versioned strict book detail; orphan rows refused), TX-1 (PR #20: unsigned builders, signer policy, landing client with node-skew guard), FUND-1 (PR #25: Deposit and Withdraw screens; QR via qrcode-generator), LEDGER-1b (PR #27: several positions per entry intent, so a late BUY landing is stored).
- Android preview APK at a fixed link: https://github.com/macdarenz-droid/Meme-snipe/releases/download/preview/zeroed-preview.apk (sample data only). Real backtest results will show in its Backtest view once BT-1 publishes its first report (UI-2 loads it from the `backtest` release).
- All four API keys checked from CI: they work.

## Board
Builders run as separate sessions; a fresh reviewer session checks each PR; the supervisor merges into `ccr-14987baf-i6lrsl` when review passed and CI is green on a head with the latest base.

| Task | What | Session | Model | State | Estimate |
|---|---|---|---|---|---|
| DATA-1 | Historical on-chain data (14-day lead-in + 30 days), schema 2, one-lane scan workflow | session_01XHH3k24fjmkpmmt28xSaYv | Opus 5.5 ultracode | PR #16 in review (session_01ChuzxLS5wmgJTFJLX5mzz6); then the supervisor dispatches data-scan.yml (one lane, ≤ 80 MB/s, stop on 429) | first day ~2.5 h after dispatch; 44 days ~4 days |
| RES-2 | Whale copy-trading study on real data (owner's idea) | session_01RXNoLW48c8Xj7FYScEujRg | Opus 5.5 ultracode | PR #4, pre-registered forward test running | result about 03:05 AEDT |
| OPS-1 | OPS-1a installer (PR #19); OPS-1b watchdog (PR #26) | session_01Euok5FXtBGZBrweohP3K93 | Opus 5.5 ultracode | 1a fix round (update gate checks CI, KAT vectors, Node deviation); 1b FAIL round queued (heartbeat replay, fetch timeouts); reviewers session_01Ty8Lvbxybv8cRixTifx6y3 (1a), session_014sAJeKrjaBBodUyrSeGuGN (1b) | installer 3:00–4:30 AM AEDT |
| RISK-1 | Risk policy and sizing (§8, R1–R16), Melbourne-day limits, exits never blocked | session_0135ruSv84BVjo7knvmTCPPK | Opus 5.5 ultracode | PR #18 fixing 3 blocking items (stale-snapshot double entry, exit trips dropped, 108 surviving mutants) | 1–2 h |
| GATE-1 | Evidence gates: hard rejects H1–H16, regime gate, as-of only | session_01MeeF4VytwgP5sqyAkqM2NS | Opus 5.5 ultracode | PR #22 round-3 re-review at c053da8 (session_01UhbBj5bHiTC8AUMzp5db7L); GATE-1b next | 15–30 m |
| TEST-2 | Dry-run transaction simulation (pre-funding item 4); stand-in accounts for the unfunded wallet | session_012vSUH8KvV8wbiagSK8KbP8 | Opus 5.5 ultracode | building | 1.5–2 h |
| BT-1 | Transaction-level backtester and paper fill model | session_016KSN98NC2xQxetiZkpCVtT | Opus 5.5 ultracode | PR #24 round 3 PASS; adding Ledger.recordBookEvent, LEDGER-1b merge, nits (reviewer session_012efQfLAwWStK3PT6ZW2PHz); real-data run when the 2 Oct day lands | 30–60 m, then real-data run |
| Queued | Build plan in docs/ARCHITECTURE.md §20 (PR #6): Wave C EXIT-1; Wave D BT-2, WORKER-1, RUN-1; Wave E TEST-1..3; later SIGN-1 | — | — | by dependency | about 37–47 h of build, 15–20 h wall time |

## Follow-ups
- Android: cover a stop between the two asset renames, the "fixed name plus .prev" state, and a failed final delete (APP-1b review notes).
- Money scanner: aliased unit constants and a regex right after `)` (CFG-1 review notes; defence in depth).
- Chain: i16 0x8000/0x7fff and u32 0x80000000 boundary vectors (DEC-1 review note).
- Quotes: a test for the initialVirtualSolReserves ≤ 0 refusal (CORE-2b review note).
- BT-2: record and burn every holdout run in the STATS-1 registry, so a holdout can't be rerun into a new file (PR #24 review).
- GATE-1b: read FEED-1's coverage facts as history; an open gap (toSlot null) is uncovered until its bounded gap or resume (matched by via + fromSlot).
- FUND-1 → SIGN-1: re-check the destination and balance after the step-up; persisting the 24 h saved-wallet change is a new saved-data shape (owner approval).
- Runbook (RUN-1/WORKER-1): a v1 ledger must be opened once by a writer (migrates to 2) before `ledger:replay` or `openReader`.
- Data: the owner may ask Triton (Old Faithful operators) for a bulk allowance; draft in DATA-1's PR #16. Paid fallback (Dune Plus, about US$399/month, unverified) only if the free lane fails, and only with the owner's approval.
- TX-1 → SIGN-1: maxSolOut needs about 1.5M lamports of PumpSwap headroom; the policy charges Token-2022 ATAs at 170 bytes.
- Repo tidy-up: branch `claude/ledger-replay-schema-v1` duplicates PR #23's 611a4bb; the safety check refused its deletion, so the owner may delete it.

## Owner setup
- Hosting approved by the owner (2026-10-03): about US$6/month, Vultr High Performance in Frankfurt; Hetzner as backup.
- API keys are in GitHub repository secrets and verified: `HELIUS_API_KEY`, `ALCHEMY_API_KEY`, `JUPITER_API_KEY`, `TELEGRAM_BOT_TOKEN` (bot @Zeroed_alerts_bot). Never in chat or in the repo.
- Vultr: server `zeroed` running (vhp-1c-1gb, Frankfurt, Ubuntu 24.04.5, no backups, US$6/month), created 2026-10-03. Next owner step when OPS-1a merges: console login, one install line, DEPLOY_CODE secret, Telegram /pair.
- Cloudflare: Account API token (Edit Cloudflare Workers template, 1-year expiry) is in GitHub secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`, verified active from CI. Renew before 2027-10-03.
- Domain: none, and none will be bought (owner rule in CLAUDE.md). Watchdog on the free `workers.dev` address; live dashboard access later through Tailscale's free personal plan.
- Telegram bot display name: change with /setname in BotFather (optional).

## Open questions
- Owner: check "Zeroed" on IP Australia before public launch; check the chosen exchange on AUSTRAC's register.
