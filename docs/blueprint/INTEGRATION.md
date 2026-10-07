# Integration report

Edited in Meme-snipe from 2026-10-07 (card Z0D); source commit `74e7258` of `macdarenz-droid/Snipe-solana` `main`.

Integration audit of the Solana meme-coin trading bot design, run on 2026-10-06 against four files in this directory: `ARCH.md` (architecture, source of truth), `SPEC-A.md` (group A tickets, modules M01-M14), `SPEC-B.md` (group B tickets, modules M15-M30) and `UI.md` (dashboard design and UI tickets). All fixes were made in place with targeted edits; each file keeps its structure. Originals were kept outside this directory for comparison.

Scope and limits of this audit:

- Design and build documents only. No code was written, no service was called, no package was installed and nothing was sent anywhere.
- Nothing here, and nothing in the four files, shows that the bot will make money. ARCH section 0 and A-23 state that the register holds **no evidence of an after-cost edge** for MR-01 or PM-01. Most of the plan below exists so that a strategy can fail cheaply (Phase 0 study, gates CS/B/R/P) before real funds are used.
- Numbers were spot-checked against the fact register IDs cited in `ARCH.md` (rent figures 650,240 / 1,488,440 / 1,513,840 lamports, the 68,195,507-lamport signer example, the B-M21-02 stressed-loss example, landing limits [LD-18, LD-22, LD-27], Jupiter limits [EX-29, DA-30], fee tiers [EX-07], the 625,000-lamport signer exit cap). They agree. Facts in `UI.md` that are not in the verified register are labelled VERIFY (see the register below). Where a needed third-party detail is not in the register (for example how Helius Sender selects SWQOS-only mode, and the unit of Jupiter's `/execute` limit) this report and the edited tickets say VERIFY rather than supplying a value.

Ticket counts after integration: **63** group A tickets, **79** group B tickets (78 plus the new B-M21-06), **32** UI tickets: **174** in total. After the 2026-10-07 splits (B-M19-06 from B-M19-03, B-M29-05 from B-M29-04): **81** group B tickets, **176** in total. The graph was re-checked by script on 2026-10-07 over the dependency tables of SPEC-A, SPEC-B and UI.md (63 + 81 + 32 tickets): no unknown ticket IDs, no cycles, and no ticket depends on a ticket in a later milestone. The script was mutation-tested: an injected cycle and an injected backward milestone dependency were both reported. The full dependency graph (internal and cross-group, using ticket IDs only) was checked by script: **no cycles**, and no ticket depends on a ticket in a later milestone.

## Global build plan - milestones

Milestones follow ARCH section 18's gated phases (CB-14). A milestone starts only when the previous milestone's exit condition is met; M4 is blocked by a **gate result** (stage `paper_passed`), never by the calendar. Within a milestone, tickets may start as soon as their own dependencies are merged.

| ID | Name | ARCH phase | Goal | Tickets | Exit condition (or stop) |
|---|---|---|---|---|---|
| M0 | Foundations | 0 | Shared contracts, CI, persistence, config, logging and the read path that every later ticket needs; design-system UI work starts | A-M01-01, A-M02-01, A-M02-02, A-M02-03, A-M07-01, A-M10-01, A-M13-03, A-M14-01, A-M14-02; B-M15-01, B-M19-01, B-M24-01, B-M24-02, B-M25-01, B-M27-01, B-M28-01, B-M30-01; UI-T01, UI-T02, UI-T03, UI-T04, UI-T05, UI-T06, UI-T07 (24) | `@bot/types` and `@bot/contract` frozen with fixture tests; CI enforces the dependency policy; the `node:sqlite` VERIFY result (A-45) is recorded; schema with group A tables migrates; two free providers answer reads; PumpSwap accounts decode from fixtures; the clean transaction-level history days held are counted for B-10 (Meme-snipe card Z-H, 2026-10-07), and the credit estimate and cap for the owner's capped Helius download (option (b), owner 2026-10-08) are put to the owner before any credit is spent; the estimate may go early, but no download credit is spent until a strategy has survived Phase 0 and the owner has ruled on C-76, and the owner is told this with the estimate |
| M1 | Recording and the Phase 0 decision | 0 | Record PumpSwap market data without a key and measure whether MR-01 is worth writing | A-M01-02, A-M01-03, A-M01-04, A-M01-05, A-M02-04, A-M02-05, A-M03-01, A-M03-02, A-M03-03, A-M03-04, A-M04-01, A-M04-02, A-M04-03, A-M05-01, A-M05-02, A-M05-03, A-M07-02, A-M07-03, A-M08-01, A-M08-02, A-M08-03, A-M10-03, A-M13-01, A-M14-03, A-M14-05 (25) | Recorder runs 48 h unattended with ≥ 95% snapshot coverage; A-24 / A-24b / A-48 report accepted. **Stop MR-01** if fewer than 10 eligible pools on more than half of the days (and M4b is not justified) or typical moves do not exceed the cost hurdle, or on the kill-only check of its two configurations (A-M13-01 step 9, C-48; owner, 2026-10-07) |
| M2 | Research and the engine core in simulation | 1 | Screening, simulation, strategy and the engine's own order, position, risk and ledger code, so backtest and replay gates run on the code that would trade | A-M06-01..A-M06-06, A-M09-01, A-M09-02, A-M09-03 (optional PM track), A-M10-02, A-M10-04, A-M10-05, A-M11-01..A-M11-05, A-M13-02, A-M13-04, A-M13-05, A-M13-06, A-M13-08; B-M15-03, B-M16-01, B-M16-02, B-M16-03, B-M16-05, B-M19-02, B-M19-03, B-M19-04, B-M19-05, B-M29-05, B-M20-01, B-M20-02, B-M20-03, B-M20-04, B-M21-01, B-M21-02, B-M21-03, B-M21-06, B-M22-01, B-M22-02, B-M22-05, B-M23-01, B-M23-02, B-M23-03 (46) | Stage `replay_passed` (gates B on `W_B`, R on `W_R`), plus the owner's pre-funding items 1 (10 identical replays, B-9), 2 (forward M07 data, plus the required transaction-level replay of ≥ 30 days of clean history, B-10; **DECIDED** by the owner on 2026-10-08: a capped 30-day download on the Helius Developer plan, no credit spent before the owner sees the estimate and cap, days outside B3 and `W_R` only; B-10 fails closed until card Z-H's report exists), 5 (the ARCH 16.5 failure-injection cases pass on the engine build) and 6 (rules fixed in advance, walk-forward, the `W_R` holdout with ≥ `n_R` = max(300, `n_80`) trades, `n_80` from the lower bound of `S_B`'s interval, and a 95% CI above zero, R-1 and R-2; with `S_low` ≤ 0 or above 90 days of `W_R` the owner decides), and the leak and parity tests (ARCH 16.4); or the strategy is `failed` and work stops (D08: by 31 Dec 2026 if both strategies fail). B-9 and B-10 inputs are injected **in M2** by A-M13-06's bundle-backed implementation (A-M11-01's 10-replay run record; card Z-H's report, both through A-M13-08), not by B-M26-04 in M3. **Owner wait:** A-M06-03's holder checks fail closed until the owner rules on the holder-index provider (D30, C-75), which blocks every backtest entry, so `backtest_passed` cannot be reached before that ruling |
| M3 | Paper | 2 | Run the full engine on live data with simulated fills and the operator dashboard; **first milestone producing paper-trading results** | A-M02-06, A-M12-01, A-M12-02, A-M13-07; B-M15-02, B-M20-05, B-M21-04, B-M21-05, B-M22-03, B-M23-04, B-M23-05, B-M24-03, B-M24-04, B-M25-02, B-M25-03, B-M26-01..B-M26-05, B-M27-02, B-M28-02, B-M28-03, B-M28-04, B-M28-05; UI-T08..UI-T31 (49) | Gates P-1..P-6, P-9 and P-10 pass (stage `paper_passed`), including the owner's items 3 (48 h dry run, ≥ 99% uptime, drills; P-5), 4 (every paper leg shadowed; `okShare` ≥ 9,500 bps over all legs; P-6), 5 (fault injection on the promoted build; P-10) and 6's dry-run consistency (P-3); or stop. Paper results are simulated; they do not show that live trading would be profitable |
| M4 | Live path to live-small | 3 | Custody, landing, expiry proofs, the sentinel and host hardening; then live-small under the go-live checklist | A-M14-04; B-M16-04, B-M16-07, B-M16-10, B-M17-01..B-M17-08, B-M18-01..B-M18-05, B-M22-04, B-M22-06, B-M19-06, B-M29-01..B-M29-04, B-M30-02, B-M30-03; UI-T32 (27) | All six owner pre-funding items passed (ARCH 3.4), gates P-7 and P-8, the go-live checklist (ARCH 16.7) and the owner → `live_small`. Promotion to `live` needs the LS gates and D26 option (ii) or (iii) (LS-7) and adds no tickets |
| M4b | Raydium (conditional) | 3b | Only if M1 shows the PumpSwap-only universe is too small (D01, D18) | A-M01-06, A-M02-07, B-M16-09, plus Raydium additions inside B-M17-04/05 and B-M29-02 (3) | Raydium venue spec accepted; gate P-6 on Raydium pools |
| Deferred | Research-only adapters | any | Built only when a research or PM-01 paper ticket needs them | B-M16-06, B-M16-08 (2) | — |

**Critical path (ticket count; calendar time is dominated by data windows, not by engineering).** The longest dependency chain to the M2 exit is 21 tickets:
B-M30-01 → B-M19-01 → B-M24-02 → B-M25-01 → A-M14-01 → A-M14-02 → A-M01-02 → A-M01-03 → A-M01-04 → A-M04-01 → A-M04-02 → A-M05-01 → A-M05-02 → B-M20-01 → B-M20-02 → B-M20-03 → B-M20-04 → A-M11-02 → A-M11-05 → A-M13-08 → A-M13-06.
It continues into M3 through B-M28-03 → B-M28-04 → UI-T08 → UI-T09 → UI-T10 → UI-T11 → UI-T14 → UI-T17 → UI-T31 (30 tickets in all), and into M4 through UI-T13 → UI-T32. Calendar waits on top of engineering: about 15 days of Phase 0 recording before A-M13-01 can report; `W_B` of at least 30 days of M07 data (D17) and `W_R` of at least 14 days after it (R-1); at least 21 days of paper (P-1); at least 14 days of live-small (LS-1). The UI chain is not on the true critical path in practice: UI-T08..UI-T31 can be built against `@bot/contract` fixtures from M0 onward and only their contract and e2e tests wait for B-M28-03/04.

**Parallelism.**

- M0: 24 tickets, but only B-M30-01 has no predecessor; after B-M30-01 and B-M19-01 (one to two days) three tracks run in parallel: persistence and config (B-M24-01 → B-M24-02 → B-M25-01, B-M27-01, B-M28-01), RPC and decoders (A-M14-01 → A-M14-02 → B-M15-01; A-M02-01 → A-M02-02/03 → A-M01-01), and pure maths (A-M10-01, A-M13-03, A-M07-01). The UI design-system track (UI-T01..UI-T07) is independent of the backend after B-M30-01.
- M1: 8 tickets can start at once; two tracks (venue and pool state: A-M01-02..05 → A-M04-* → A-M05-*; data capture: A-M03-*, A-M07-02/03, A-M08-*).
- M2: 11 tickets can start at once; four tracks: screening (A-M06-*), simulation and drivers (A-M10-02/04/05, A-M11-*), statistics and stages (A-M13-02/04/05/06/08), and the engine core (B-M19/B-M20/B-M21/B-M22/B-M23 tickets; B-M16-01/02/03/05 and B-M15-03 for simulation-only builds). A-M11-02/03 are the join point.
- M3: 12 tickets can start at once; tracks: paper port (A-M12-*), control plane (B-M26-*), API and dashboard (B-M28-*, UI-T08..T31), books and storage (B-M22-03, B-M23-04/05, B-M24-03/04, B-M25-02/03).
- M4: custody (B-M17-01..08, one engineer, never mixed with engine work in the same PR), landing (A-M14-04, B-M18-*), live builders (B-M16-04/07/10), safety net (B-M29-*), hosting (B-M30-02/03, UI-T32).

**First milestone producing paper-trading results: M3.** M2 produces backtest and replay results only (simulated, on recorded data); M4 is the first milestone that can trade real funds, and only at live-small caps after every P gate and the go-live checklist pass.

## Traceability matrix

Every requirement, risk rule, decision branch, state machine, gate and revision-log resolution in `ARCH.md` maps to at least one ticket. Tickets added or re-pointed by this audit are in **bold**.

### Functional requirements (ARCH 1.1)

| Requirement | Tickets |
|---|---|
| FR-01 Discover candidates, bounded watchlist, current pool state | A-M03-01..04, A-M04-01..03, A-M05-01..03, A-M01-02..04 |
| FR-02 Screen every token on-chain; unknown = reject | A-M06-01..06, B-M16-05, A-M05-01 (prefilters) |
| FR-03 Strategy plugins; same code in every mode | A-M09-01..03, **B-M21-06** (one entry path in every mode), A-M11-02/03, A-M12-01 |
| FR-04 Size and risk-check every entry; all limit families | B-M21-01..05, **B-M21-06**, B-M19-02 (PERTOKEN), B-M17-06 (signer caps) |
| FR-05 Build, sign, send, confirm with bounded slippage and idempotent retries | B-M16-01..05, B-M16-07, B-M16-10, B-M17-01..08, B-M18-01..05, B-M19-02..05, A-M14-04 |
| FR-06 Exits incl. liquidity collapse, authority change, cannot-sell, emergency | B-M20-01..05, B-M19-05, B-M29-02 |
| FR-07 Reconcile against the chain | B-M22-01..06, B-M19-04, B-M26-05 |
| FR-08 Append-only journal, tax-style reporting | B-M23-01..05, B-M24-02, B-M24-03, A-M07-02 (`order_event`, `fill`, `decision` records via **B-M19-02**, **B-M21-06**) |
| FR-09 Record market data for replay | A-M07-01..03, A-M05-03, A-M08-03, B-M30-03 |
| FR-10 After-cost performance with CIs; promotion gates | A-M13-02..08, A-M10-03, B-M23-03, **B-M26-04 (ExternalGateInputs adapter)** |
| FR-11 Serve VM-01..VM-21 and VM-19 commands | B-M28-01..05, B-M26-02/03, UI-T08..UI-T31 |
| FR-12 Kill switch independent of dashboard and engine | B-M17-08, B-M29-01..04, B-M26-01, UI-T14 |

### Risk rules (ARCH 8)

| Rule | Tickets |
|---|---|
| 8.1 `MAXPOS` | B-M21-01, B-M21-02, B-M21-05, B-M17-06 (signer per-tx cap) |
| 8.1 `MAXRISK`, `MAXRISK_PF` (correlated bucket) | B-M21-02 (stressed gap from **A-M10-04 `stressedGapBps`**) |
| 8.1 `DEPTHPCT` | B-M21-02 |
| 8.1 `MAXOPEN`, `MAXEXP` | B-M21-02, B-M21-05 |
| 8.1 `ENTRYRATE`, `REGIME` | B-M21-03 (basket from A-M08-02; SOL/USD from B-M23-03) |
| 8.1 `PERTOKEN`, per-token daily entries | B-M19-02, B-M24-02 (partial unique indexes), B-M21-02 |
| 8.1 Strategies live at once (`MAXSTRAT`) | B-M26-04 |
| 8.1 `HOTCAP`, sweeps | B-M22-04, B-M17-06, B-M26-04 |
| 8.1 `SIGNERDAY` | B-M17-03, B-M17-06 |
| 8.2 `DAYLOSS`, `WEEKLOSS`, `DDHALF`, `DDKILL` (flow-adjusted) | B-M21-04 with **A-M13-04 `flowAdjustedStep`** |
| 8.2 `LOSSRUN`, execution-error, landing and cost breakers | B-M21-04, B-M23-02, B-M23-03, B-M18-03 |
| 8.2 Reconciliation breaker | B-M22-03, B-M21-04 |
| 8.2 `FEEDAY` (entries only), fixed-cost burden | B-M21-05, B-M23-03 |
| 8.3 Entry and exit slippage, `minOut` | B-M21-02, B-M16-04, B-M20-04, A-M01-03 |
| 8.3 Priority fee and tip caps, rung-4 total, CU limit | B-M16-01, B-M16-07, B-M17-06, B-M21-02 |
| 8.3 Observation-lag caps (decision ≤ 12, build ≤ 8, exits never blocked) | A-M04-02, **B-M21-06**, B-M21-03, B-M16-04, B-M20-02 |
| 8.4 Mint, Token-2022 and metadata checks (`mint_owner_program` … `identity_by_mint`, `mayhem_or_special`) | A-M06-02 |
| 8.4 Holder checks (`top10_holders`, `single_holder`, `creator_balance`) | A-M06-03 |
| 8.4 `insider_network` and other vendor soft checks | A-M06-06 |
| 8.4 Pool and venue checks (`pool_canonical`, `lp_withdrawable_max`, `fee_ceiling`, `min_depth`, `real_vs_effective_quote`, `pool_age`, `venue_enabled`, `fee_config_known`, `dump_flag`, `usdc_quote`, `venue_specified`) | A-M06-04, A-M05-01 (prefilters), A-M01-05, A-M08-02 |
| 8.4 `honeypot_sim` | A-M06-05, B-M16-05 |
| 8.5 Freshness guards (decision lag, fresh read, exit reads, provider lag, blockhash age, screen age, bar completeness, clock offset) | A-M04-02, A-M14-02, B-M15-01, B-M15-02, A-M06-01, A-M08-01, B-M21-03, **B-M21-06** |
| 8.6 Stop, target, trailing, time stop | B-M20-02 |
| 8.6 Liquidity collapse, authority/extension change, venue change | B-M20-03 (events fixed at integration: `pool.lp_changed`, `token.authority_changed`, `venue.fee_schedule_changed`, `venue.status_changed`) |
| 8.6 Cannot-sell detection | B-M20-04 (with **A-M06-05 `withSellSim`**) |
| 8.6 HALT, flatten all, engine down, emergency liquidation | B-M26-01, B-M26-02, B-M20-05, B-M29-01, B-M29-02 |
| 8.7 Exit ladder rungs 1-5, supersession, chunking | B-M20-04, B-M19-05, B-M16-07, B-M18-05 |
| 8.8 Enforcement layers | B-M21-02 (`evaluate`), B-M21-05 (`preSendCheck`), B-M17-06 (signer), B-M16-04 (on-chain `minOut`), B-M29-02 (sentinel), B-M20-* |

### Decision branches (ARCH 6)

| Branch | Tickets |
|---|---|
| D01 Direct adapters vs aggregator | B-M16-03, B-M16-06, B-M16-07, B-M16-09, A-M01-06; switch alert **B-M27-02** |
| D02 Landing path | B-M18-01, B-M18-02, A-M14-04 |
| D03 Polling vs WebSocket vs gRPC | A-M04-01, A-M04-03 (transport seam), A-M14-05 (credit metering for the switch) |
| D04 RPC providers | A-M14-01, A-M14-02, A-M14-05 |
| D05 Language and runtime | B-M30-01, B-M19-06 (`build_sign_segment_ms`); switch alert **B-M27-02** |
| D06 Database | B-M24-01; switch alert **B-M27-02** |
| D07 Hosting | B-M30-02; switch alert **B-M27-02** |
| D08 Strategy family | A-M13-05, A-M13-06, A-M09-02, A-M09-03 |
| D09 Exit execution method | B-M20-04, B-M19-05 |
| D10 Transaction format | B-M16-01, A-M02-03 |
| D11 Key custody | B-M17-02 |
| D12 Discovery source | A-M03-01, A-M03-02 |
| D13 Token-safety data source | A-M06-06 |
| D14 Commitment level | A-M14-01, A-M04-01 |
| D15 Priority-fee oracle | B-M15-03 |
| D16 Sandwich protection | B-M16-01, B-M18-02, B-M23-05 |
| D17 Historical data | A-M07-*, A-M11-01, A-M11-04 |
| D18 Venue universe | A-M01-06, A-M06-04, B-M16-09 |
| D19 Dashboard exposure | B-M28-02, UI-T32 |
| D20 SOL/USD reference | B-M23-03 |
| D21 Position sizing | A-M09-01, B-M21-02 |
| D22 Token-account and wSOL lifecycle | B-M16-02, B-M16-10, B-M22-04 |
| D23 Blockhash vs durable nonce | B-M15-02 |
| D24 HALT semantics | B-M26-01, UI-T14 |
| D25 Process model | B-M30-02 |
| D26 Signer availability after reboot | B-M17-02, B-M29-01, A-M13-06 (LS-7) |
| D27 Out-of-band alert channel | B-M29-03, B-M27-02 |
| D28 Clearing a sentinel or CLI latch | B-M17-08, B-M29-04, UI-T14 |
| D29 Where research runs | A-M11-*, A-M13-08, B-M28-05, B-M29-05, UI-T23 |
| D30 Enumerating established pools | A-M03-03 |
| D31 Simulation payer | A-M06-05, B-M16-05, B-M22-01 |

### State machines and protocols (ARCH 7)

| Item | Tickets |
|---|---|
| 7.3 Order intent and attempt state machine | B-M19-02, B-M19-03, B-M19-04, B-M19-05, B-M19-06; port states in A-M11-02, A-M12-01 (single `ExecutionPort`) |
| 7.3a On-chain failure taxonomy | B-M18-03 (classify), B-M19-05, B-M20-04 (act), A-M10-02 (simulated mix) |
| 7.4 Position state machine | B-M20-01, B-M20-03, B-M20-05 |
| 7.5 Token candidate state machine | A-M05-01 (inputs `position.terminal` from B-M20-01 and `risk.decision` from **B-M21-06**) |
| 7.6 Crash and restart recovery | B-M26-05, B-M24-04, B-M22-06, B-M17-07 |
| 7.7 System mode and trading-state machines | B-M26-01, B-M26-03, B-M26-04 |
| 3.4 Strategy stage machine | A-M13-05 (called by B-M26-04) |
| Signer lock states, latch, leases | B-M17-02, B-M17-08 |

### Promotion and live gates (ARCH 3.4)

| Gates | Tickets |
|---|---|
| CS-1 | A-M11-04, A-M13-06 |
| B-1..B-8 | A-M11-02, A-M13-02, A-M13-03, A-M13-06 |
| B-9 (owner item 1), B-10 (owner item 2) | A-M11-01 (10-replay run record, B-9), A-M11-03, A-M11-05 and A-M13-08 (bundle import, M2), card Z-H's report (B-10), A-M13-06 |
| R-1..R-6 | A-M11-03, A-M10-04, A-M13-06 |
| P-1..P-6, P-2b, P-9, P-10 | A-M12-01, A-M12-02 (P-6, owner item 4), B-M26-04 (P-5 owner item 3, P-10 owner item 5), A-M13-04, A-M13-06, B-M22-05 (P-5), B-M23-03 (P-9 via **B-M26-04 adapter**) |
| P-7, P-8 | B-M26-01, B-M29-04 (drills), B-M26-04 (checklist), A-M13-06 |
| LS-1..LS-7, LS-3b | A-M13-06; inputs B-M23-03 (LS-2), B-M18-03 (LS-4), B-M22-03 (LS-5), B-M17-02 (LS-7) through **B-M26-04** |
| L-1 (CUSUM, live-small and live) | A-M13-07, B-M21-04 |
| L-2 (`DDKILL`), L-3 (cost), L-4 (venue regime) | B-M21-04, B-M23-03, A-M01-05, A-M02-05 |

### Revision-log resolutions (ARCH 20)

| Item | Tickets |
|---|---|
| CA-01 | B-M29-01, B-M29-02, B-M29-03 |
| CA-02 | B-M16-04, B-M16-02, B-M16-10, A-M12-01 |
| CA-03 | B-M16-04, B-M17-07, B-M19-05 |
| CA-04 | B-M18-04, B-M19-04, B-M20-01 |
| CA-05 | B-M17-05, B-M17-06, A-M02-06, B-M26-04 |
| CA-06 | B-M17-05 |
| CA-07 | B-M17-01, B-M17-03, B-M17-08 |
| CA-08 | B-M21-05, B-M22-01, B-M19-05, B-M20-04 |
| CA-09 | B-M19-04, B-M20-03 |
| CA-10 | A-M14-03, B-M19-05 |
| CA-11 | A-M14-04, B-M18-01 |
| CA-12 | B-M18-03 |
| CA-13 | B-M17-08, B-M20-05, B-M29-02 |
| CA-14 | B-M22-02, B-M22-03, B-M20-01, B-M22-04 |
| CA-15 | B-M19-02, B-M20-01, B-M22-02, A-M05-01 |
| CA-16 | B-M16-02, B-M16-10, B-M22-01 |
| CA-17 | A-M13-04, B-M21-04, B-M22-01, B-M22-03 |
| CA-18 | B-M21-02, B-M21-03 |
| CA-19 | B-M26-01, B-M26-03, A-M13-05, A-M13-06 |
| CA-20 | A-M06-04, A-M01-06 |
| CA-21 | A-M11-04, A-M13-06 (CS-1), A-M07-* |
| CA-22 | A-M13-04, A-M13-05 |
| CA-23 | A-M13-06 (LS-1, LS-3), A-M13-07 |
| CA-24 | A-M13-02, B-M25-01 |
| CA-25 | A-M05-02, A-M10-04 |
| CA-26 | A-M13-08, B-M28-05, B-M29-05 |
| CA-27 | A-M01-04, B-M16-09 |
| CA-28 | A-M13-04, B-M22-06 |
| CA-29 | B-M22-04 |
| CA-30 | A-M14-01, A-M03-01, B-M18-02 |
| CA-31 | A-M06-01, B-M20-03 |
| CA-32 | B-M25-02, B-M26-02, UI-T22 |
| CA-33 | B-M24-01, B-M30-03 |
| CB-01 | A-M14-04, B-M18-01 |
| CB-02 | A-M06-05, B-M22-01 |
| CB-03 | B-M21-05, B-M23-03, A-M13-04 |
| CB-04 | A-M04-02 (lag in slots), B-M19-06 (`build_sign_segment_ms`), B-M27-02 (D05 alert) |
| CB-05 | A-M14-05, B-M27-02 |
| CB-06 | A-M03-03, A-M03-04 |
| CB-07 | A-M01-06, B-M16-06, B-M16-09 |
| CB-08 | A-M11-01, A-M11-04, A-M14-03 |
| CB-09 | A-M13-02, A-M13-03 |
| CB-10 | A-M13-08, B-M28-05, B-M29-05, UI-T23 |
| CB-11 | B-M19-01, B-M28-01 (`ExitReason` contract test), UI-T18 |
| CB-12 | B-M28-03, A-M06-02 |
| CB-13 | A-M10-05, B-M23-05 |
| CB-14 | this milestone plan; A-M13-01 |
| CB-15 | A-M08-03, A-M13-04 |
| CB-16, CB-18, CB-22 | Documentation corrections only (cost tables and wording in ARCH 0, 2, D02, D03); no implementation needed |
| CB-17 | A-M04-03 (D03 seam), A-M14-05 (credit metering) |
| CB-19 | B-M18-02 (Sender key VERIFY A-40), A-M02-04 (guarded log fallback), A-M06-02 (TH-28 caveat) |
| CB-20 | A-M04-02, B-M21-03, B-M16-04, **B-M21-06** |
| CB-21 | B-M18-04 |
| CB-23 | B-M16-01, B-M16-04, B-M18-02, A-M10-02 |
| CB-24 | B-M28-01, B-M28-03, A-M06-01 |
| CB-25 | A-M13-01, A-M09-02 |
| CB-26 | A-M07-01..03, B-M30-03 |
| CB-27 | A-M13-03, A-M13-06 |

### Dashboard contract changes (ARCH 19, applied to `UI.md` at integration)

| Change | `UI.md` location edited | Backend ticket | UI ticket |
|---|---|---|---|
| UC-01 exit-reason enum, `source`, `shadow` | VM-06, S-03 | B-M19-01, B-M28-01, B-M23-02 | UI-T18 |
| UC-02 `stops[]`, `targets[]` | VM-05, S-02 | B-M20-02, B-M28-03 | UI-T17 |
| UC-03 `entry_unconfirmed`, armed stops in `opening` | VM-05, S-02 | B-M20-01 | UI-T17 |
| UC-04 `action_on_breach` enum | VM-12 | B-M21-01 | UI-T22 |
| UC-05 `display_unit`, `limit_value_display`, phrase in display unit, UI-T22 AC1 restated | VM-12, VM-19 preview, Safety UX, UI-T22 | B-M25-02, B-M21-01 | UI-T22 |
| UC-06 actor types `sentinel`, `cli` | VM-03, VM-17 | B-M26-01, B-M24-03 | UI-T14, UI-T28 |
| UC-07 `exits_only`, latch and lease fields, C04 states | VM-03, C04 | B-M26-01, B-M17-08 | UI-T14 |
| UC-08 RESUME blocked until host latch cleared | Safety UX, UI-T14 | B-M26-02, B-M29-04 | UI-T14 |
| UC-09 VM-18 `ratio`, stage fields, new gate IDs | VM-18, S-13 | A-M13-06, B-M26-04 | UI-T23 |
| UC-10, UC-11, UC-21 | no UI change (backend resolution) | B-M28-03, B-M28-05 | UI-T19, UI-T12, UI-T18, UI-T28 |
| UC-12 VM-21 imported runs; launcher removed; `sim_clock` null | VM-01, VM-03, new VM-21, S-01, S-13, UI-T23, Q-14 | A-M13-08, B-M28-05 | UI-T08, UI-T23 |
| UC-13 `token_class`, reserve wallets, `E` | VM-04, S-02 | B-M22-02, B-M28-03 | UI-T17 |
| UC-14 `write_off_position`, `close_unsolicited`, `book_not_flat` | VM-19, S-02 | B-M26-02, B-M22-04, B-M20-05 | UI-T17, UI-T26 |
| UC-15 restart copy | Safety UX "Apply configuration", UI-T26 | B-M25-03 | UI-T26 |
| UC-16 U-15 copy | U-15 row | — | UI-T26 |
| UC-17 `safety[]`, `projected_month_end_bps`, Safety net panel | VM-13, S-08 | B-M27-02, A-M14-05 | UI-T24 |
| UC-18 no 15 s bars; flow-adjusted equity | VM-10 | A-M08-03, A-M13-04 | UI-T15, UI-T21 |
| UC-19 S-06 after-fixed-cost line; Wilson CI | VM-09, S-06 | A-M13-04, A-M13-06 | UI-T21 |
| UC-20 out-of-band line | S-11 | B-M27-02, B-M29-03 | UI-T27 |

## Changes made during integration

### Interface decisions (where group A and group B disagreed)

| # | Conflict | Decision | Why |
|---|---|---|---|
| 1 | `ExecutionPort`: A had `status(): AttemptStatus` plus separate sim/paper sub-interfaces with `onResult`/`onNotLanded` (C-29); B had `status(): AttemptState` and `onResult` only (CL-27) | One port: `submit`, `status(): AttemptState`, `onResult`, `onNotLanded`; intent read through `OrderManager.intent` | Exit supersession needs `onNotLanded` in every mode; "same states as live" (ARCH M12) includes building and signing states |
| 2 | Gap-through-stop accessor: A `stressedGapBps` (C-24) vs B `gapThroughStopP99Bps` (CL-38) | A's `stressedGapBps(strategyId): { p99Bps, samples, source }` | M10 owns the prior and freezes the empirical value at `replay_passed`, so trial identity does not change mid-window; B no longer keeps its own prior |
| 3 | `rpc.context_slot` payload: A without `method`, B with | B's superset `{ providerLabel, contextSlot, method, atMs }` | Extra field is harmless to A and lets M15 attribute lag per method |
| 4 | LP-distribution event: A `pool.lp_changed`, B `token.lp_changed` | `pool.lp_changed { poolId, mint, maxWithdrawableBps, previousBps, atMs }` | LP withdrawability is a pool property; the producer (A-M06-04) already publishes it |
| 5 | Flow-adjusted equity: two formulas (A-M13-04 with an `E`-boundary rule; B-M21-04 treating sweeps and refills as always external) and two instances | One pure formula (A's boundary rule) in A-M13-04; one live/paper instance in B-M21-04 that writes `equity_point` through `EquitySeries.recordMinute` | With the cold wallet inside `E`, B's rule would have counted a sweep as a flow and A's would not, so VM-10 drawdown and the `DDKILL` breaker could disagree |
| 6 | `freshRead` semantics: A finite = entry grade with internal re-read, `Infinity` = exit grade; B called `freshRead(pool, 8)` then re-read itself, and `freshRead(pool, 40)` for exits with a fallback | A's semantics (C-09) everywhere | Single meaning; exits are never blocked by construction |
| 7 | VM-12 meter thresholds: B 50% / 80%; UI C28 70% / 90% | 70% / 90% / 100% (server-computed) | The UI component and the server must show the same state; the UI never re-derives it |
| 8 | Fixed-cost items risk direction: B `neutral` (A2) | `decreases_risk` on increase, so lowering a recorded fixed cost is A3 | Lowering fixed cost can unlock gate P-9 and the fixed-cost ceiling; the stricter class is chosen |
| 9 | Stage change for demotions: B asked for a new call (CL-57); A already had `StageMachine.onDemotion` | Use A-M13-05's `onDemotion` / `onModeCommand` | Existing interface covers the need |
| 10 | Canonical JSON, base58, priority-fee formula and segment pulls were each specified twice | One implementation each: `canonicalJson` and `priorityFeeLamports` in `@bot/types` (B-M19-01); base58 in A-M02-01's zero-dependency core (used by the signer, B-M17-04); segment pull and receipts in A-M07-03 (scheduled by B-M30-03) | Duplicate implementations of hashing and encoding would make manifests, trial keys and audit hashes disagree |

### Edits by file

| File | What changed | Why |
|---|---|---|
| `ARCH.md` | New section **5.0b Integration amendments (binding)**, rows I-01..I-28, each with producer and consumer ticket IDs | Records every interface addition and every A/B conflict resolution in the source of truth |
| `ARCH.md` | M12 `ExecutionPort` rewritten (decision 1); M14 `acquireSend` `side` extended with `janitor`/`sweep`, `grantId`, plus `beginExitWork`/`endExitWork`; M15 `BlockhashInfo.providerLabel`, `blockhash(): BlockhashInfo \| null`, `fresh`, `entriesAllowed`; M18 `LandingPath` adds `jupiter_execute`; M19 `OrderManager` adds `intent`, `openIntentsFor`, `onIntentTerminal`, `submitMaintenance`; M29 heartbeat adds `positions[]`, `halt_notice`/`halt_ack`, `critical_alert`; 14.1 adds 403 `class_changed` | Producers' definitions in ARCH must match what consumers were specified against |
| `ARCH.md` | Section 18: phase 0 now includes the group B foundations; phase 1 includes the engine core in simulation (M19-M23, M16 simulation-only builds, M15 rent oracle); phase 2 lists the remainder; group B phase column and cross-group contract row updated; pointer to this milestone plan | Gate runs B and R drive the engine's own code (ARCH 9.2), and Phase 0 recording needs persistence, config, logging and the slot clock; the earlier phase table could not be executed in order |
| `ARCH.md` | Section 19 preface notes that UC-01..UC-21 have been applied to `UI.md` | Accuracy |
| `SPEC-A.md` | A-M11-02 and A-M12-01 use the single `ExecutionPort`; A-M12-01 publishes `fill.events` with empty events; A-M11-02 drives entries through B-M21-06 | Decision 1; one entry path in every mode (FR-03) |
| `SPEC-A.md` | A-M14-01 `rpc.context_slot` includes `method`; A-M14-04 adds the `jupiter_execute` bucket with the limit's unit marked VERIFY and documents `LandingPath`; A-M01-05 names the `fill.events` producers; A-M10-03 imports `priorityFeeLamports`; A-M13-04 exports `flowAdjustedStep` and replaces `onMinute` with `recordMinute`; A-M13-06 states that `ExternalGateInputs` is B-M26-04's adapter (no build edge to group B); A-M13-07, A-M10-04, A-M06-04 name their consumer tickets and the fixed event payload | Decisions 2-6 and 10; cross-group references by ticket ID |
| `SPEC-A.md` | Milestone note mapping MA-* to the global milestones; dependency table gains "B tickets, hard" and "Global milestone" columns; the hard-serialisation paragraph names B tickets; 24 clarification rows annotated with their integration outcome | Task requirements: ticket-level cross-group dependencies and resolved clarifications |
| `SPEC-B.md` | New ticket **B-M21-06 Entry pipeline orchestration** | No ticket owned proposal → screen → fresh read → quote → `evaluate` → decision record → `submit` → `open`; A-M05-01 also needed an accept/reject signal (`risk.decision`) |
| `SPEC-B.md` | B-M19-01 `ExecutionPort` adds `onNotLanded`, package gains `canon.ts` and the fee helper; B-M15-01 notes the agreed payload; B-M16-04 and B-M20-02 use A's `freshRead` grades; B-M18-02 adds a VERIFY step for selecting Sender's SWQOS-only mode; B-M18-03 publishes `fill.events`; B-M19-02 and B-M21-06 append order, fill and decision records to the recorder; B-M19-05 calls `beginExitWork`/`endExitWork`; B-M20-03 uses `pool.lp_changed` and named topics; B-M20-04 requests `withSellSim` and asserts the ladder fits the configured float; B-M21-01 thresholds 70/90; B-M21-02 uses `stressedGapBps`; B-M21-04 uses the shared formula, writes `equity_point`, runs the CUSUM in live-small and live and depends on B-M23-02 | Decisions 1-7, C-36, C-41, C-43; ARCH M07 says our own order and fill events are recorded but no ticket appended them |
| `SPEC-B.md` | B-M22-01 reads the float per position from config instead of building against B-M20-04 | Removes a dependency cycle (B-M22-01 → B-M20-04 → B-M20-03 → B-M19-04 → B-M22-02 → B-M22-01) |
| `SPEC-B.md` | B-M23-03 fixed-cost risk direction (decision 8); B-M24-02 adds group A tables (C-14, C-32); B-M24-03 uses the shared canonicaliser; B-M25-02 adds cross-key rules (C-44, C-35); B-M26-01 heartbeat carries `positions[]` (CL-61); B-M26-04 implements `ExternalGateInputs` and calls the stage machine; B-M26-05 refuses start on a failed constants self-check; B-M27-02 raises info alerts for the D01, D05, D06, D07 switch triggers with the ARCH 6 thresholds; B-M28-03 names its producing tickets; B-M30-03 delegates segment pulls to A-M07-03; B-M17-04 uses A-M02-01's base58 | Coverage gaps (D01/D05/D06/D07 triggers had no implementing ticket; C-39 had no implementer), duplicates (decision 10), and consistency |
| `SPEC-B.md` | Milestone table replaced by the global milestones; dependency table gains "group A tickets, hard" and "Global milestone" columns and the B-M21-06 row; B-M21-03 depends on B-M23-03 and B-M21-04 on B-M23-02; parallel tracks updated; cross-group interface table rewritten with producing ticket IDs; 21 clarification rows annotated (CL-33, CL-35, CL-37, CL-38, CL-47 changed) | Task requirements; phase restructuring |
| `UI.md` | UC-01..UC-21 applied to VM-01, VM-03, VM-04, VM-05, VM-06, VM-09, VM-10, VM-12, VM-13, VM-17, VM-18, VM-19, the new VM-21, screens S-01, S-02, S-03, S-06, S-07, S-08, S-11, S-13, component C04, Safety UX (RESUME latch dialog, raising a limit, apply configuration) and tickets UI-T08, UI-T14, UI-T17, UI-T18, UI-T21, UI-T22 (acceptance criterion 1 restated: `MAXPOS` 0.066666667 SOL → 0.30 SOL is 4.5×, phrase `RAISE MAXPOS 0.30`, preview "0.30 SOL = 300000000 lamports"; 3.0 rejected above the 0.35 SOL ceiling), UI-T23 (launcher removed), UI-T24, UI-T26, UI-T27 | ARCH section 19 is mandatory for the contract to match what the backend serves |
| `UI.md` | VM-05 `state` keeps its enum and documents the backend mapping (`stuck` → `close_failed` + reason, `orphan` → `open` + flag) | Matches B-M20-01 / B-M28-03; no UC changed this enum |
| `UI.md` | S-07 mock-up: daily loss "On breach" changed from "halt" to "block entry"; UI-T14 acceptance criterion 5 now uses a manual-reset limit or breaker (the daily loss stop only blocks entries) and new criterion 6 covers the host-latch RESUME | ARCH 8.2 |
| `UI.md` | Dependency summary gains a "Backend tickets (integration)" column; U-10, U-14, U-15 updated (U-14 and U-15 resolved); open questions gain a resolution column from ARCH 14.5; fact-register note marks the UI-F build facts as VERIFY; VM-18 phrase example labelled illustrative against ARCH's live-small `MAXPOS` | Task requirements 2 and 6 |

## Remaining issues

| Severity | Issue | Owner / next step |
|---|---|---|
| High | There is no evidence of an after-cost edge for MR-01 or PM-01 (A-23). The plan is built so that a failing strategy stops at M1 (Phase 0 study) or M2 (gates B, R); M3 and M4 may never be reached. No ticket, gate or result in these files implies profit | Product owner; gates in A-M13-06 |
| High | The live path cannot be completed until several third-party interface details are verified: PumpSwap pool-authority PDA seeds (U-A01; until then every pool is rejected), PumpSwap fee placement and rounding (U-A03; PumpSwap not quotable for live), Sender tip accounts (A-30), Sender key placement and per-region counting (A-40), how Sender selects SWQOS-only mode (integration item), the unit of Jupiter `/execute` limits (integration item), Jupiter router program ID (A-14), Compute Budget control-account placement (A-16), temporary-wSOL size fit (A-46) | Owning tickets in the register; go-live checklist item 11 |
| Medium | Moving the engine core into M2 shifts roughly a third of group B's effort (B-M19/B-M20/B-M21/B-M22/B-M23 tickets) from Phase 2 to Phase 1. ARCH 18's effort split (A-33) was not re-estimated, and group B may now be the bottleneck of M2 | Leads re-estimate at the M0 exit |
| Resolved (2026-10-07) | B-M19-03 spanned two milestones, and B-M29-04's `import-run` was needed in M2 while the rest of `botctl` is M4 | Split in SPEC-B: B-M19-03 (simulation and paper wiring, M2) and B-M19-06 (live build, sign, persist, send, M4); B-M29-05 (`botctl import-run`, M2) and B-M29-04 (the rest of `botctl`, M4) |
| Medium | Topic names and payloads `risk.decision`, `fill.events`, `pool.lp_changed` and the heartbeat `positions[]` were defined by this audit (ARCH 5.0b). They are internal contracts, not third-party facts, but they have not been reviewed by the two spec writers | Both leads review ARCH 5.0b before the `@bot/types` freeze (B-M19-01) |
| Medium | The dashboard (UI-T08..UI-T31) sits at the end of the longest dependency chain because B-M28-03's projections need A-M13-06 gate evaluations. Fixture-first development removes most of the delay, but contract and end-to-end tests cannot pass until B-M28-03/04 merge | UI lead; build against `@bot/contract` fixtures from M0 |
| Medium | `UI.md` mock-ups and examples still show 0.25 SOL position sizes and `LIVE-SMALL 0.25`, while ARCH 8.1 live-small `MAXPOS` is min(1.0% E, 66,666,667 lamports) ≈ 0.0667 SOL. VM-18 and UI-T22 now say the numbers are illustrative; the S-07 and S-13 drawings were not redrawn | UI lead; the UI never hard-codes limits (UI-T23 DoD), so this is cosmetic |
| Low | Every VM changed by UC-01..UC-21 needs a `schema_version` bump and a matching `ui_supported` entry (VM-01); the version numbers are not enumerated in either spec | B-M28-01 and UI-T08 |
| Low | VM-03 `kill.halted_by.type` now also allows `scheduler` (from ARCH 5.0a `Actor`), beyond UC-06; VM-03 `kill.latch_set_by` projects ARCH's `operator_cli` as `cli` — B-M28-03 must implement that mapping, which only `UI.md` states | B-M28-03 |
| Low | VM-05 maps M20 `stuck` to `close_failed` and `orphan` to `open` + flag, so the state pill cannot show `stuck` directly | Consider a future UC; no safety impact because `close_failed_reason` and the flag are shown |
| Low | The flow-adjusted series is written only while the engine runs; engine downtime appears as gaps in VM-10 (A-M13-04 records them) | Accepted; documented |
| Low | SPEC-A keeps its MA-* milestone table for traceability alongside the binding global plan, which could confuse readers | Note added in SPEC-A; remove MA-* after M0 |

## Unverified items register

Every VERIFY, UNVERIFIED, ASSUMPTION and open vendor claim across the four files, consolidated, with the ticket that owns its resolution. ARCH items appear once (the specs' copies of A-xx rows were merged here); SPEC-A `U-A` rows are kept even where they restate an ARCH item, because they name the precise behaviour until verified. A ticket that depends on an item may not be marked done until the item is resolved in `VERIFY.md` with source, date and result (SPEC-B rule; go-live checklist item 11 for live-path items).

| # | Source | Item | Status | Owning ticket(s) |
|---|---|---|---|---|
| 1 | ARCH A-01 | `P_SOL` = $150 for tables | PARAMETER | B-M23-03 |
| 2 | ARCH A-02 | CU limit 200,000 per swap; CU price scenarios 25,000 and 1,000,000 µlamports/CU | ASSUMPTION | B-M16-01, A-M10-05 |
| 3 | ARCH A-03 | On-chain failure rate 20%, expiry 5%, sandwich probability 10% | ASSUMPTION | A-M10-02, A-M10-05 |
| 4 | ARCH A-04 | Latency prior (median 1.5 s, p95 5 s decision → confirmed) | ASSUMPTION | A-M10-01, A-M10-05 |
| 5 | ARCH A-05 | Network latency from Frankfurt to leaders and endpoints | UNVERIFIED (excluded claims) | B-M18-01..03 (gate LS-4) |
| 6 | ARCH A-06 | `getMultipleAccounts` maximum accounts per call: 100 per the Solana docs as reported by a reviewer (not in the register), plus any lower provider cap | VERIFY | A-M04-01, A-M03-03, B-M29-02 |
| 7 | ARCH A-07 | Shyft Free "unlimited credits" fair-use limits | UNVERIFIED | A-M14-02, A-M14-05 |
| 8 | ARCH A-08 | Helius Sender and Jito accept v1 transactions | UNVERIFIED (excluded) | B-M16-01 (only if D10 switches) |
| 9 | ARCH A-09 | PumpSwap sell output larger than the real quote vault balance | UNVERIFIED [EX-V01] | A-M01-03, A-M06-04, B-M16-03, B-M20-03 |
| 10 | ARCH A-10 | PumpSwap buy/sell needing buyback-recipient remaining accounts | UNVERIFIED (excluded) | B-M16-03, B-M17-04 |
| 11 | ARCH A-11 | PumpSwap buyback carved out of the protocol fee (as on the curve [EX-06]) | UNVERIFIED (excluded) | B-M23-01 |
| 12 | ARCH A-12 | Mayhem-mode, holder-rewards and cashback coin behaviour | UNVERIFIED | A-M06-02 |
| 13 | ARCH A-13 | Raydium AMM v4 and CPMM reserve formulas, fee fields, creator-fee flag and withdraw denominator | UNVERIFIED | A-M01-06, B-M16-09 |
| 14 | ARCH A-14 | Jupiter DEX label strings for `dexes`; Jupiter program ID for the signer allowlist | VERIFY | B-M16-06, B-M17-06 |
| 15 | ARCH A-15 | Jupiter `/order` 50 bps fee on tokens < 24 h with a taker | UNVERIFIED (excluded) | B-M16-07, B-M23-01 |
| 16 | ARCH A-16 | Compute Budget program accepts an extra read-only control account (Harmonic placement [LD-V02]) | VERIFY | B-M16-01 |
| 17 | ARCH A-17 | Effectiveness of `jitodontfront` / `mev-protect` on small swaps | UNVERIFIED [LD-16, LD-22] | B-M23-05 |
| 18 | ARCH A-18 | Node.js LTS version, built-in Ed25519, built-in SQLite stability, KDF/cipher availability | VERIFY | B-M17-02, A-M07-02, A-M11-05, B-M30-01 |
| 19 | ARCH A-19 | Codama 1.11.0 consumes the pump Anchor IDL | VERIFY | A-M02-02 |
| 20 | ARCH A-20 | Token-2022 ATA size for pump mints is 170 bytes | ASSUMPTION (excluded claim says exact size unverified) | B-M16-02, B-M15-03 |
| 21 | ARCH A-21 | `user_volume_accumulator` closability | UNVERIFIED | B-M16-03, B-M22-01 |
| 22 | ARCH A-22 | Post-BOOST migration dynamics | UNVERIFIED (excluded) | A-M09-03 |
| 23 | ARCH A-23 | Any edge for MR-01 on Solana DEX meme pools | Negative sub-hour proxy evidence; MR-01's 15 s signal untested (C-46) | A-M13-01 kill-only check (C-48); A-M13-06 (gates B, R, P) |
| 24 | ARCH A-24 | Correct number of eligible MR pools (fee ≤ 30 bps, depth ≥ 300 SOL, age ≥ 24 h) | UNVERIFIED | A-M05-03, A-M13-01 |
| 25 | ARCH A-24b | Short-horizon moves in eligible pools are large relative to a 0.6-0.75% round-trip cost plus the fixed-cost term | ASSUMPTION | A-M13-01 |
| 26 | ARCH A-25 | RugCheck rate-limit window and terms for automated use | UNVERIFIED [TH-21] | A-M06-06 |
| 27 | ARCH A-26 | Vendor flag accuracy (RugCheck, GoPlus, Birdeye, Jupiter) | UNVERIFIED (excluded) | A-M06-06 |
| 28 | ARCH A-27 | DigitalOcean disk size and backup pricing for the $12 droplet | UNVERIFIED | B-M30-02 |
| 29 | ARCH A-28 | Tailscale free plan terms | Vendor claim (UI-F41) | B-M28-02, B-M29-03, UI-T32 |
| 30 | ARCH A-29 | AWS KMS Ed25519 per-request price and latency | UNVERIFIED [TH-43] | B-M17-02 (only if D11 switches) |
| 31 | ARCH A-30 | Helius tip-account list for Sender | VERIFY | B-M16-01, B-M17-06, B-M18-02 |
| 32 | ARCH A-31 | `getLatestBlockhash`, `getSignatureStatuses` history search, `getTokenAccountsByOwner` filters, ATA create-idempotent instruction, `accountSubscribe` | VERIFY (standard Solana RPC/program interfaces not in the register) | B-M15-02, B-M16-02, B-M17-04, B-M22-03, A-M04-03 |
| 33 | ARCH A-32 | DexScreener terms for storing data in a private database | Open question (DA researchers) | A-M03-04 |
| 34 | ARCH A-33 | Effort estimates in section 18 | ASSUMPTION | planning only (re-estimate at the M0 exit; integration moved about one third of group B effort into M2) |
| 35 | ARCH A-34 | SPL Token `CloseAccount`: non-native accounts close only at zero balance; native (wSOL) accounts close with any balance and send all lamports to the destination; partial unwrap is not possible | VERIFY (reviewer-reported, not in the register) | B-M16-02, B-M16-10 |
| 36 | ARCH A-35 | `getSignatureStatuses` without `searchTransactionHistory` searches only the recent status cache (about 300 rooted slots) | VERIFY (reviewer-reported) | B-M17-07, B-M18-03, B-M18-04 |
| 37 | ARCH A-36 | `getEpochInfo` returns slot and block height together; `getTokenAccountBalance`, `getLatestBlockhash` field names; `SyncNative` instruction name | VERIFY | B-M15-01, B-M16-02, B-M19-04, B-M22-02 |
| 38 | ARCH A-37 | `getBlockTime` returns whole seconds | VERIFY (reviewer-reported) | B-M15-01 |
| 39 | ARCH A-38 | `SO_PEERCRED` (or equivalent peer-user check) is available to Node on the chosen LTS without third-party code | VERIFY | B-M17-01 |
| 40 | ARCH A-39 | systemd `OOMScoreAdjust`, restart limits, encrypted credentials; droplet TPM availability; sudoers/polkit rule for `systemctl stop engine` | VERIFY | B-M17-02, B-M29-02, B-M30-02 |
| 41 | ARCH A-40 | Where a keyed Helius Sender request carries its key, and whether the global HTTPS endpoint's 50 req/s is counted per region | VERIFY | B-M18-02, A-M14-03, A-M14-04 |
| 42 | ARCH A-41 | Jupiter `/build` parameter that controls SOL wrapping and unwrapping | VERIFY (UNVERIFIED name) | B-M16-06 |
| 43 | ARCH A-42 | Provider support for `getProgramAccounts` on the PumpSwap program (and Raydium), `dataSlice`, and the pool account size and field offsets | VERIFY | A-M03-03 |
| 44 | ARCH A-43 | Number of canonical PumpSwap pools (50,000 used for budgeting) | ASSUMPTION | A-M03-03 |
| 45 | ARCH A-44 | The exact MinBTL expression (quoted from the paper in the M13 ticket) | UNVERIFIED (outside the register; it reproduces the register's two examples) | A-M13-03 |
| 46 | ARCH A-45 | `node:sqlite` supports transactions, WAL and online backup on the chosen LTS | VERIFY | B-M24-01 |
| 47 | ARCH A-46 | Swap transactions with the temporary-wSOL instructions fit 1,232 bytes | VERIFY | B-M16-02, B-M16-04 |
| 48 | ARCH A-47 | Operator response time to an out-of-band alert (8 h overnight used in D26) | ASSUMPTION (operator sets it) | B-M29-03 |
| 49 | ARCH A-48 | zstd compression ratio 3-5× on decoded snapshots | ASSUMPTION | A-M07-02, A-M13-01 |
| 50 | SPEC-A U-A01 | Seeds of the pump pool-authority PDA used for the canonical-pool rule [EX-08] | VERIFY / UNVERIFIED | A-M01-01, A-M03-03, A-M06-04 |
| 51 | SPEC-A U-A02 | `@solana/kit` 8.x program-derived-address helper (name, signature) | VERIFY / UNVERIFIED | A-M01-01 |
| 52 | SPEC-A U-A03 | PumpSwap fee placement (input vs on top), rounding, fee-program market-cap input (vault vs effective), threshold inclusivity | VERIFY / UNVERIFIED | A-M01-02, A-M01-03, A-M10-03 |
| 53 | SPEC-A U-A04 | PumpSwap sells whose computed output exceeds the real quote vault (A-09, [EX-V01]) | VERIFY / UNVERIFIED | A-M01-03, A-M06-04 |
| 54 | SPEC-A U-A05 | Whether PumpSwap `BuyEvent`/`SellEvent` carry post-trade pool reserves, and exact field names beyond those in [EX-37] | VERIFY / UNVERIFIED | A-M01-04, A-M02-03 |
| 55 | SPEC-A U-A06 | PumpSwap `GlobalConfig.disable_flags` bit layout; README says the field is unused while documenting `disable()` [TH-19, TH-V04] | VERIFY / UNVERIFIED | A-M01-05, A-M06-04 |
| 56 | SPEC-A U-A07 | Pump events emitted by self-CPI (an inference [DA-16]) and/or as `Program data:` logs (excluded claim) | VERIFY / UNVERIFIED | A-M02-03, A-M02-04 |
| 57 | SPEC-A U-A08 | SPL Token / Token-2022 base layouts: byte offsets and `COption` encoding | VERIFY / UNVERIFIED | A-M02-02 |
| 58 | SPEC-A U-A09 | Full commit SHA of the pinned pump-public-docs IDLs (the register could not confirm it [DA-11]) | VERIFY / UNVERIFIED | A-M02-01 |
| 59 | SPEC-A U-A10 | IDL argument and field names not listed in [EX-10, EX-37] | VERIFY / UNVERIFIED | A-M02-03, A-M02-06 |
| 60 | SPEC-A U-A11 | PumpPortal: whether the free subscriptions need an API key; subscription and notice message shapes; the ban signal [DA-01, DA-02] | VERIFY / UNVERIFIED | A-M03-01 |
| 61 | SPEC-A U-A12 | Provider support for `getProgramAccounts` on PumpSwap, `dataSlice`, response caps; PumpSwap pool account size and quote-mint offset; Helius `getProgramAccountsV2` parameters [DA-21]; real pool count (A-42, A-43) | VERIFY / UNVERIFIED | A-M03-03 |
| 62 | SPEC-A U-A13 | Maximum accounts per `getMultipleAccounts` (100 per a reviewer; provider caps) (A-06) | VERIFY / UNVERIFIED | A-M03-03, A-M04-01 |
| 63 | SPEC-A U-A14 | DexScreener `chainId` value for Solana and response field names [DA-26]; terms for private storage (A-32) | VERIFY / UNVERIFIED | A-M03-04 |
| 64 | SPEC-A U-A15 | `jsonParsed` field names for Token-2022 extensions; deployed RPC version lag [TH-28] | VERIFY / UNVERIFIED | A-M06-02 |
| 65 | SPEC-A U-A16 | Metaplex metadata account derivation [TH-13] | VERIFY / UNVERIFIED | A-M06-02 |
| 66 | SPEC-A U-A17 | Where mayhem, holder-rewards and cashback flags live for established pools (A-12) | VERIFY / UNVERIFIED | A-M06-02 |
| 67 | SPEC-A U-A18 | Burn / incinerator addresses to exclude from holder counts | VERIFY / UNVERIFIED | A-M06-03 |
| 68 | SPEC-A U-A19 | PumpSwap LP withdraw denominator | VERIFY / UNVERIFIED | A-M06-04 |
| 69 | SPEC-A U-A20 | `simulateTransaction` config field names; whether post-simulation balances already deduct the fee; expected token remainder after the round trip [TH-46] | VERIFY / UNVERIFIED | A-M06-05, A-M12-02 |
| 70 | SPEC-A U-A21 | RugCheck `insiders/graph` response shape and rate window (A-25, [TH-21, TH-V03]); Jupiter Tokens API v2 path and key requirement [TH-27] | VERIFY / UNVERIFIED | A-M06-06 |
| 71 | SPEC-A U-A22 | Node LTS: built-in zstd in `node:zlib`, Ed25519 in `crypto`, `node:sqlite` features (A-18, A-45) | VERIFY / UNVERIFIED | A-M07-02, A-M07-03, A-M11-05, A-M13-08 |
| 72 | SPEC-A U-A23 | CoinGecko on-chain OHLCV path, Solana network id, timeframe parameters, Demo history depth, monthly allowance conflict [DA-27, DA-28] | VERIFY / UNVERIFIED | A-M11-04, A-M14-03 |
| 73 | SPEC-A U-A24 | Birdeye OHLCV V3 on Lite and its CU cost [DA-23, DA-24] | VERIFY / UNVERIFIED | A-M11-04 (optional D17 (e)) |
| 74 | SPEC-A U-A25 | Exact MinBTL expression (A-44) and DSR formula [ST-29, ST-31]; continuous-time Kelly approximation | VERIFY / UNVERIFIED | A-M13-03, A-M13-02, A-M09-01 |
| 75 | SPEC-A U-A26 | Helius Sender key placement and whether the global endpoint's 50 req/s is per region (A-40) | VERIFY / UNVERIFIED | A-M14-03, A-M14-04 |
| 76 | SPEC-A U-A27 | Provider billing month boundaries; Shyft Free fair-use limits (A-07) | VERIFY / UNVERIFIED | A-M14-05, A-M14-02 |
| 77 | SPEC-A U-A28 | WebSocket `accountSubscribe` method details and per-message metering (A-31, [LD-V01]) | VERIFY / UNVERIFIED | A-M04-03 |
| 78 | SPEC-A U-A29 | Pool coin-creator field name for `creator_balance` | VERIFY / UNVERIFIED | A-M06-03 |
| 79 | SPEC-A U-A30 | ARCH assumptions that drive group A outputs: simulation priors (A-03, A-04), universe size (A-24), move sizes (A-24b), compression ratio (A-48), and the absence of any evidence of an edge (A-23) | VERIFY / UNVERIFIED | A-M10-*, A-M13-01, A-M09-02 |
| 80 | SPEC-A U-A31 | Post-BOOST migration dynamics (A-22, [ST-06]) | VERIFY / UNVERIFIED | A-M09-03 |
| 81 | SPEC-B | Jupiter `/order` parameters (taker, slippage) and response fields; `/execute` body and response; presence of `lastValidBlockHeight` | VERIFY (only `/order` + `/execute` existence and fees are in the register [EX-25, EX-26, EX-27, EX-29]) | B-M16-07, B-M18-05 |
| 82 | SPEC-B | Jito `sendTransaction` request path and body | VERIFY (endpoints and limits in [LD-17, LD-18]) | B-M18-02 |
| 83 | SPEC-B | Helius `getPriorityFeeEstimate` request and response field names | VERIFY (method and levels in [LD-12]) | B-M15-03 |
| 84 | SPEC-B | `getRecentPerformanceSamples` field names | VERIFY (method used in [LD-08]) | B-M15-01 |
| 85 | SPEC-B | Compute Budget instruction byte order (little-endian integers) | VERIFY (discriminators and types in [LD-03]) | B-M16-01, B-M17-04 |
| 86 | SPEC-B | v0 message wire format and address-lookup-table account layout | VERIFY | B-M17-04 |
| 87 | SPEC-B | SPL Token / Token-2022 instruction discriminators (`SyncNative`, `CloseAccount`, `Burn`, `Approve`, `SetAuthority`, transfers) | VERIFY | B-M16-02, B-M16-10, B-M17-04 |
| 88 | SPEC-B | PumpSwap `buy_exact_quote_in`/`sell` argument names, minimum-output semantics and `track_volume` behaviour | VERIFY (account counts in [EX-10]) | B-M16-03, B-M17-04/05 |
| 89 | SPEC-B | Pump curve fee-recipient lists and whether `spendable_quote_in` includes fees | VERIFY | B-M16-08 |
| 90 | SPEC-B | Simulation `accounts` option semantics for pre/post state | VERIFY (option exists [TH-46]) | B-M17-05 |
| 91 | SPEC-B | `getBlock` parameters for full transactions in block order | VERIFY | B-M23-05 |
| 92 | SPEC-B | CoinGecko simple-price endpoint and parameters | VERIFY (plan limits in [DA-27]) | B-M23-03 |
| 93 | SPEC-B | WebAuthn server library choice (or built-in verification) and Level 3 assertion format | VERIFY | B-M28-02 |
| 94 | SPEC-B | zod version and licence for `@bot/contract` | VERIFY | B-M28-01 |
| 95 | SPEC-B | Package-manager flag for disabling lifecycle scripts; host firewall hostname allowlisting method | VERIFY | B-M30-01, B-M30-02 |
| 96 | SPEC-B | Operator OS notification command for the watcher; sentinel status binding to the tailnet interface | VERIFY | B-M29-03 |
| 97 | SPEC-B | Self-hosted push software for D27 (b) | UNVERIFIED | B-M29-03 option (b) |
| 98 | UI U-01 | Any Height design trait (typography, colour, motion, keyboard model) | UNVERIFIED | none (design reference only) |
| 99 | UI U-02 | Height shutdown date (24 Sep 2025) and March 2025 announcement | UNVERIFIED | none (design reference only) |
| 100 | UI U-03 | Licence terms of Berkeley Mono, Domaine, Arcadia | UNVERIFIED | none (fonts not used) |
| 101 | UI U-04 | That each named Lucide icon exists in `lucide-react` 1.52.0 | UNVERIFIED | UI-T04 |
| 102 | UI U-05 | Whether the Lightweight Charts `attributionLogo` loads any external resource (CSP impact) | UNVERIFIED | UI-T15 |
| 103 | UI U-06 | Whether `Secure` / `__Host-` cookies work on plain `http://localhost` in every browser | UNVERIFIED | UI-T32 |
| 104 | UI U-07 | Playwright 1.63 virtual-authenticator support for WebAuthn tests | UNVERIFIED | UI-T09 |
| 105 | UI U-08 | How NVDA, JAWS and VoiceOver read U+2212 and the subscript-zero price notation | UNVERIFIED | UI-T31 |
| 106 | UI U-09 | Browser Notification API delivery when the tab is in the background | UNVERIFIED | UI-T27 |
| 107 | UI U-10 | Cloudflare Zero Trust free-plan limits | UNVERIFIED | UI-T32 (only if D-UI Option D is chosen) |
| 108 | UI U-11 | Licences of Next.js, Vitest, Playwright, axe-core, Storybook, ESLint, typescript-eslint | UNVERIFIED | UI-T01 |
| 109 | UI U-12 | Maintenance pace of uPlot (last npm publish 2025-03-14) and cmdk (2025-08-27) | UNVERIFIED | UI-T12, UI-T15 |
| 110 | UI U-13 | Tailscale Personal plan terms | UNVERIFIED | UI-T32, B-M28-02 |
| 111 | UI U-14 | An out-of-band (host CLI) kill command exists **Resolved** | RESOLVED at integration | resolved (B-M29-04, UI-T14) |
| 112 | UI U-15 | "Open positions stay protected by server-side stops during a restart" **Resolved: false** | RESOLVED at integration | resolved: false (UC-15/UC-16 copy, UI-T26) |
| 113 | UI U-16 | Solana fee figures (5,000 lamports per signature; priority-fee formula) remain current | UNVERIFIED | B-M23-01 (actual fees from meta), UI-T25 |
| 114 | UI U-17 | All performance budgets, freshness thresholds, rate limits, timeouts and warning thresholds marked PROPOSED | UNVERIFIED | UI-T08..UI-T31 (tune in M3 paper) |
| 115 | UI U-18 | Reference-site counts (durations, radii, fonts) represent each brand's *product* UI | UNVERIFIED | none (design reference only) |
| 116 | UI facts | npm package versions and licences (UI-F32 table), including zod, React, Vite, TanStack, Lightweight Charts, uPlot, cmdk, Lucide | VERIFY (not in the verified register) | UI-T01, B-M28-01 |
| 117 | UI facts | React and Vite release dates and support windows | VERIFY | UI-T01 |
| 118 | UI facts | WebAuthn Level 3 status and assertion format | VERIFY | UI-T09, B-M28-02 |
| 119 | UI facts | Tailscale plan terms (UI-F41) | VERIFY (vendor claim) | UI-T32, B-M28-02 |
| 120 | UI facts | Solana fee figures in UI copy (UI-F30: 5,000 lamports per signature) | VERIFY at build; UI never hard-codes them | B-M23-01, UI-T25 |
| 121 | Integration | How a Helius Sender request selects SWQOS-only mode (needed for the 5,000-lamport minimum tip of the Lean scenario [LD-22]) | VERIFY (not in the register) | B-M18-02, B-M16-01 |
| 122 | Integration | Unit of Jupiter `/execute` limits (20 keyless / 50 free [EX-29]): per second or per 60 s window; sets the `jupiter_execute` bucket | VERIFY | A-M14-04, B-M18-05 |
| 123 | Integration | Property-testing library (fast-check or equivalent) version and licence (ARCH 16.2) | VERIFY | B-M30-01 |
| 124 | Integration | Type-test tool (`tsd`-style) version and licence | VERIFY | B-M19-01 |

Total: 124 items (2 of them resolved at integration and kept for the record).
