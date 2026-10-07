# Red team: migration map

Target: `docs/MIGRATION.md` on `claude/blueprint-migration` at `72c1bc17`. Read against the code at the same commit; `git diff 5d7260f7 72c1bc17 -- packages apps ops` and `git diff cd4d7a64 72c1bc17 -- packages apps ops` are both empty, so the code is the code the map read. Red team sources: `claude/redteam-a` @ `37637052`, `claude/redteam-b` @ `30aae66b`, `claude/redteam-c` @ `5fb491f0`. No network except git and `pnpm install`. Nothing in the repo was changed except this file.

Line numbers below ("L") are lines of `docs/MIGRATION.md` at `72c1bc17`.

## Summary

| Severity | Round 1 (`72c1bc17`) | Round 2 (`cb2a1458`) | Open now |
|---|---|---|---|
| BLOCKER | 2 | 0 | 2 |
| MAJOR | 13 | 5 | 17 (M02 closed at `cb2a1458`) |
| MINOR | 16 | 8 | 24 |

Round 2 is at the end of this file. It covers the "Research addendum" section, the ticket-order changes and the new DECISIONS rows, all at `cb2a1458`. `cb2a1458` changes only the addendum line, the new section, the M0 and M1 cards, DECISIONS and HANDOVER, so every round 1 finding except M02 still stands.

The two blockers:
- the bug table leaves out open red team A and B bugs, including fail-open bugs in modules the map marks **adapt**;
- the opening line allows Zeroed code to be deleted on terms weaker than the owner's "Paper and backtest removal" rule.

What held up:
- the verdict counts (63 group A tickets: 33 adapt, 7 replace, 23 missing);
- every focused test count re-run;
- the M0 and M1 ticket coverage;
- most code citations;
- the numbers taken from FACTS and ARCH.

## What was checked

**Citations.** About 140 file:line citations were read at `72c1bc17`: about 110 in `packages/`, `ops/` and `apps/`, plus HANDOVER, PROJECT_STATE, FACTS.json and ARCH lines. Most are right. The wrong or weak ones are findings m01–m04.

**Tests.** `pnpm install --frozen-lockfile` passed (pnpm 10.28.0). Each run below used `pnpm vitest run <path>` at `72c1bc17`, and every result matches the map:

| Run | Map | Re-run |
|---|---|---|
| `packages/core/test/ledger` | 8 files, 100 tests | 8 / 100 |
| `packages/core/test/risk` | 6 / 255 | 6 / 255 |
| `packages/core/test/tx` | 7 / 86 | 7 / 86 |
| `packages/ops/test` | 10 / 240 | 10 / 240 |
| `packages/core/test/gates` | 17 / 704 | 17 / 704 |
| `packages/core/test/chain` | 13 / 732 | 13 / 732 |
| `packages/core/test/amm` | 2 / 693 | 2 / 693 |
| `apps/web/test/copy-guard.test.ts` | 1 / 7 | 1 / 7 |

The group B sum of 1,321 tests is right (100 + 255 + 86 + 521 + 82 + 240 + 37). The 521 and 82 runs were not re-run.

**Coverage of M0 and M1.**
- The M0 cards Z00–Z06 cover all 24 M0 ticket IDs in INTEGRATION.
- The M1 cards Z07–Z09 cover all 25 M1 ticket IDs.
- No ticket is missing from these cards. Order problems are in M06, M07 and m12.

**Numbers checked and found right:**
- 305,033 credits in 3 h 31 min ≈ 87k an hour;
- 1M credits a month ≈ 1.4k an hour;
- 23 GB a day against 55 GB ≈ 2 days;
- the P-9 floors $200, $334, $1,833 and $1,967;
- 13,333 SOL of depth for a $10,000 trade at a 0.5% cap;
- the B1 arithmetic: 40 s against 25 s, and 22.5 s at 150 slots;
- the D09 ladder values;
- the O6 Blueprint limits (ARCH lines 2044–2071);
- LD-08: 250 ms, epoch 1037, about 267 ms measured;
- LD-27, LD-31, LD-33;
- the deep-pool and runner research figures, at `1baca138`.

## Findings

### BLOCKER

| ID | Section, line | What is wrong | Evidence | Fix |
|---|---|---|---|---|
| B-01 | "Bugs left behind" L32–44; Summary L66; Group A rows for M04, M06 and M14; Group B rows for M19, M20 and M26; "Outside the milestones" L695 | The "nine bugs" list leaves out open red team A and B bugs. Several are in code the map marks **adapt** and lists with no known bug ("—") or with fewer bugs than it has. Under Rule 1 these modules would migrate with known bugs and no fail-before test, and L695 wrongly says the parked PRs' findings "are covered by the bug tests above". The missed bugs are in the four bullets after this table. | `claude/redteam-a` `packages/worker/test/redteam/REPORT.md` L163–176, L227–253, L330–452; `claude/redteam-b` `redteam-b/REPORT.md` L18–100, L119–160, L243–275; `HANDOVER.md` §5.5 second bullet, §5.9, §5.10, §5.11 | Add every open red team A, B and C finding at `cd4d7a64` to the bug table: its ID, the Blueprint module, and either "stays behind (module not migrated)" or a fail-before test. Use the red team's own probe file as that test where one exists. Correct L695. |
| B-02 | Opening paragraph L3 against Summary L69 | L3 says Zeroed code may be deleted once the map marks it **replace** and the replacement passes "the same tests and replays". The owner's rule is stricter. Nothing paper or backtest is removed until the owner says the app is ready, and removal starts only from a reviewed plan that maps every module as paper-only, backtest-only or shared with live. L3 drops both conditions for modules the map marks replace that are paper or backtest code: M12 `paper-world.ts`, the M13 gate code, and M08 bars. L69 also contradicts L3: "not deleted". | `CLAUDE.md` "Paper and backtest removal, later only"; MIGRATION L3, L69, L182 (M12 replace), L194 (A-M13-06 replace) | Replace L3 with the owner's rule word for word: no deletion until the owner says the app is ready and a reviewed module plan exists. Keep L69. |

The bugs that B-01 finds missing:

- **Fail-open bugs in screening code marked adapt:**
  - R2-4: H15 accepts a simulation from any chain slot (`hard.ts:568`). It touches A-M06-05.
  - R2-5: the H16 cross-check passes when no source reported one of the two authorities (`hard.ts:592`). It touches A-M06-06.
  - Both are closed only on #276, which is open. A-M06-05 and A-M06-06 show "—" in the bug column.
  - Round 4 note: a batch close stamps every answer with the close time. It is a possible fail-open for the H15 and H16 freshness rules. It touches A-M04-02 and A-M06-01.
- **Exit and lifecycle bugs in code marked adapt (M19, M20):**
  - RB-5: a blocked exit never sells again (`exits/rules.ts:350-352`). Fixed only on #275, which is open.
  - RB-8: a start reconcile that never finishes leaves an open position with no exits.
  - RB-11: the repeated-exit haircut has no time window.
  - Red team A round 4 item 5: one late-landing buy halts entries for good.
  - Red team A round 4 item 6: a sell-only halt outlives its position.
  - The M20 row lists only R3-1.
- **Gates that block every coin ("never trades"), touching M06, M04, M08 and M14:**
  - RT-A1b: one late swap makes the candles partial for good, so H11 refuses.
  - RT-A2b: H5 parity.
  - NT-2: H14 holes.
  - The cut-create cap.
  - Deployer-check staleness.
  - Round 4 item 1: no batch ever lands fresh.
  - Round 4 item 7: a failed `fetch-caps.json` save spends the day's cap.
  - Round 4 item 10: BEHIND hysteresis.
  - Round 4 items 2, 8 and 11.
  - HANDOVER §5.5: H11's migration-price reference may be about 26% lower in code than in the study. This is unverified even there.
  - "Discipline, not paralysis" makes each of these a defect.
- **Paper fills and red team B integration findings:**
  - N1: paper fills land on pool state of any age.
  - N2: paper fills are easier than the backtest's fill model.
  - RB-14, RB-15, RB-16.
  - M12 is replaced, but "paper is real money" needs each of these as a test on the new paper port.

### MAJOR

| ID | Section, line | What is wrong | Evidence | Fix |
|---|---|---|---|---|
| M01 | B4 L409; A-M14-05 L206; bug row L37 | The B4 bug row says the code's 1M budget "would run out in about half a day and halt entries", and A-M14-05 says non-P0 traffic "halts at 70% (`limits.ts:15`)". The worker's Helius scheduler has **no** monthly halt: `HELIUS_WORKER` strips `budget` from `HELIUS_FREE`. Only Alchemy halts at 70%, and Helius stops only on its own 429. The map marks this "Not verified", but the code settles it. Red team C C3 also says "Helius has no halt". The B4 bug row copies the error from HANDOVER §5.2 (`HANDOVER.md:283`). | `packages/worker/src/run/sources.ts:207-214` (`const { budget: _heliusMonthly, ...HELIUS_NO_HALT } = HELIUS_FREE`); `sources.ts:408`; `docs/redteam-c/REPORT.md` C3 | Correct B4 and A-M14-05: Helius has no worker-side halt, and the spend runs until the provider refuses. B4's fail-before test should assert that the projection alert and degraded mode fire. "The budget halts" is not the mechanism. |
| M02 | "Research carried in" L349; Rules item 4 L30 | L349 says `research/BLUEPRINT_ADDENDUM.md` is not on `ccr-7fae2302-drz4co` "at 7b162ed8 (checked before this push)". It was added at `09b84865`, 2026-10-07 11:18:20Z, 13 minutes before the map's own commit `72c1bc17` at 11:31:52Z. The branch tip is now `84f572ad`. Rule 4 therefore applies now: 24 verified items, none adopted, none rejected in DECISIONS. | `git log --diff-filter=A origin/ccr-7fae2302-drz4co -- research/BLUEPRINT_ADDENDUM.md` → `09b84865 2026-10-07 11:18:20 +0000`; commit subject "Blueprint addendum from the research: 24 verified items" | Read the addendum at `84f572ad` and adopt or reject each item, with the reasons in `docs/DECISIONS.md`. Update L349. |
| M03 | A-M04-02 L112; A-M11-01 L172; A-M11-02 L173 | These are **adapt** verdicts built on foundations the map itself marks replace or missing. Each could be met only by a rewrite. | See the three bullets after this table. | Mark A-M04-02 and A-M11-02 **replace**. Name the parts that carry over: the as-of store, the leak, shift and 10-replay proofs, and the parity harness. Mark A-M11-01 **adapt** only for the clock and as-of code. |
| M04 | A-M02-06 L95 against M17 L230 | A-M02-06 (instruction decoders) is marked **missing**: "nothing decodes them for a signer". The M17 row credits `tx/policy.ts` as a reusable decoder seed that "recomputes worst-case SOL out from bytes". `policy.ts` classifies PumpSwap and curve swap instructions by discriminator, with account positions. | `packages/core/src/tx/policy.ts:1-4,57,62-63,109-114` | Mark A-M02-06 **adapt** (seed: `policy.ts` swap table), with gaps per ticket. |
| M05 | A-M07-03 L140 against Disk history L444 | A-M07-03 lists as a fail-before test "Deletion only after a verified pull", and calls Zeroed's delete "whether or not uploaded" a conflict. The Disk history row says "Keep Zeroed's cap-and-prune". These cannot both hold, and the owner rule is involved: "deletes … only after its uploaded copy is verified", and "a day of trading can never fill the disk". | `packages/worker/src/run/recorder-budget.ts:1-2`; `CLAUDE.md` "Recordings upload approved", "Disk cycle"; red team C M5 | Pick one rule. Suggested: a verified upload first, then a hard cap that halts recording and raises an alert, rather than deleting unuploaded data. Write it in both rows. This needs a ruling, because the owner rules allow both readings. |
| M06 | Ticket order Z03 L646; batches L651 | Z03 (A-M14-01, A-M14-02) "Needs: Z01" and runs in parallel with Z02. A-M14-01 has hard dependencies on B-M25-01 and B-M27-01, which are in Z02. INTEGRATION's critical path puts B-M25-01 before A-M14-01. | `docs/blueprint/SPEC-A.md:112` (A-M14-01 needs B-M19-01, B-M25-01, B-M27-01, B-M30-01); `INTEGRATION.md:28` | Z03 needs Z02. The batch order becomes Z02, then Z03, with Z05 alongside. |
| M07 | Z10 L660; Process L632; update gate L329; Deploy tag L454 | Z10 puts the Blueprint recorder on the server through "Zeroed's update gate, units and upload cycle". It is not an INTEGRATION ticket and has no acceptance criteria. INTEGRATION places the Blueprint's own hosting and deploy work in M4 (B-M30-02 needs B-M17-01 and B-M29-01). Zeroed's gate is wired to the Zeroed worker contract. The map also marks the gate **keep**, though its host e2e was "not run here", while the verdict definition needs a cited passing run (L12). | See the bullets after this table. | Write Z10 as a card with acceptance criteria. It needs: the recorder's `/health` and `open_intents` contract; the deploy branch; the unit and memory limits for 2 GB; a 48 h soak; and the ops e2e run green on the card's commit. Mark the update gate **adapt** until that e2e passes. |
| M08 | Clash "Phase 0 recording" L597; M1 exit L662; Z08, Z10 Needs | Phase 0 needs 1 Hz `getMultipleAccounts`, and no provider the bot already uses can carry it inside the owner rules. The map states the rules but does not make M1 depend on an owner decision. A builder would then reach for Helius. | See the bullets after this table. | Add "owner approval of the Phase 0 read provider (Shyft or Chainstack), or of a Helius budget" to Z07 and Z08 Needs. Show the arithmetic at ≤ 50%. |
| M09 | M3 exit L686; M2 exit L677; M4 L690 | The owner's pre-funding gate is "all required". The M3 exit adds the owner's items only "where the clash table adopts them", and the clash table only recommends (L579–586). Items 1 (10 identical replays), 2 (≥ 30 days of transaction-level history), 4 (≥ 95% simulate successfully) and 5 (fault injection) bind no card. M4 names "the paper gates, the go-live checklist and the owner", but not the six items. The owner rule stands until the owner decides (`CLAUDE.md` "Blueprint"). | `CLAUDE.md` "No deposit before proof"; MIGRATION L579–586, L686, L690 | Bind all six items into the M2, M3 and M4 exits as written, with the Blueprint gates added on top. Drop "where the clash table adopts them". |
| M10 | Clash "Sizes" L594; Z09 L659 | "Size is not the trial" means every strategy result is reported at $5, $20, $100, $1,000 and $10,000, with the cost parts shown apart. The map puts this only in a clash recommendation (A-M10-03 and A-M13-04). The cards that produce the first strategy result do not carry it: Z09 holds A-M10-03 and A-M13-01, the Phase 0 cost hurdle (A-24b), whose 0.6–0.75% round trip is at one size. | `CLAUDE.md` "Size is not the trial"; `INTEGRATION.md:329` (A-24b) | Add the size sweep, with gross, fixed, percentage fees and impact on min(real, effective) depth, to the Z09 acceptance for A-M10-03 and A-M13-01. Add it to the M2 gate reports too. |
| M11 | Rules L29; Process L629–632; Z10; M3 L686 | The owner's "Pause, fix, red-team, then resume" requires every known blocker fixed, a self-check, then **three** independent red teams with different lenses, all their findings fixed and reviewed, before a worker is switched on. The map gives each card one red team and puts the recorder (Z10) and the paper engine (M3) on the server without this step. The rule is not mentioned. | `CLAUDE.md` "Pause, fix, red-team, then resume" (2026-10-07 6:25 AM) | Add the three-red-team step to Z10 and to the M3 server deploy, or list it as a clash for the owner to rule on. |
| M12 | Ports Z01–Z05 L644–648; D05 L280 | The ports bring new dependencies into this repo: zod 4.6.5 (C02), `@solana/kit` 8.3.0 (C03), and React 19.3, Radix, TanStack, Lucide, Playwright and axe-core (C05). AGENTS.md says "No new dependency without the supervisor's OK" (`package.json`, `pnpm-lock.yaml`), and no card names that step. D05 praises Zeroed's dependency-free server packages, and INTEGRATION decision 10 needs A-M02-01's base58 to stay a zero-dependency core used by the signer. Not verified: whether C03's A-M02-01 imports `@solana/kit`, because Snipe-solana was not read. | `AGENTS.md` file table; `INTEGRATION.md:259`; MIGRATION L280, L342 | Add a dependency review to Z01–Z05, with each package and its allowlist entry. Require A-M02-01 and anything the signer imports to stay dependency-free. |
| M13 | O6 L617 | O6 takes the tighter limit of each pair "without asking", but leaves `MAXPOS` (1% E against Zeroed's 10–25% of $20) and `DEPTHPCT` out of the comparison. It also never checks the owner's "Discipline, not paralysis": "a limit that blocks every coin for hours is a defect". On the $20 trial, 1% E is a $0.20 trade, below the fixed-cost floor the map cites (§2.4, O7). A 2% daily stop is $0.40, which a single $2 trade at its stop can use up. | `docs/blueprint/ARCH.md:2044,2062`; `packages/core/src/config/policy.ts:190`; `CLAUDE.md` "Discipline, not paralysis", "Capital and trade size scale" | Add the `MAXPOS` and `DEPTHPCT` rows. Before taking any tighter value, check that the combined set still lets a gate-passing trade through at the configured bankroll. Put the result to the owner. |

Detail for M03:
- **A-M04-02.** The ticket's `freshRead` is a `getMultipleAccounts` re-read on the next provider, with 12 and 8 slot grades on the 1 Hz poller from A-M04-01. A-M04-01 is **replace**. Zeroed's `watch.ts` is a `minContextSlot` floor on log streams. Sources: `SPEC-A.md:878-905`; `worker/src/run/watch.ts:146-172`.
- **A-M11-02.** The ticket drives the engine on 15 s bars from recorded snapshots (A-M08-01, **replace**), with the daily universe manifest (A-M05-03, **missing**) and the B engine core. Zeroed replays chain transactions with its own strategy. Source: `SPEC-A.md:1761-1795`.
- **A-M11-01.** The ticket loads M07 segments. Zeroed reads the chain archive, so the loader would be new.

Detail for M07:
- `worker-start` runs the stub or the worker with `ZEROED_MODE=paper` and `--max-old-space-size=560`.
- `zeroed-update` holds on `/health` answering `.mode == "paper"` with the release `git_sha`, and reads `/var/lib/zeroed/open_intents`, which the worker writes after reconcile.
- `deploy.yml` deploys only from `ccr-14987baf-i6lrsl`.
- Sources: `ops/host/files/usr/local/lib/zeroed/worker-start:15-70`; `ops/host/files/usr/local/sbin/zeroed-update:9,38-62,168,240`; `.github/workflows/deploy.yml:26`; `INTEGRATION.md:23`; `SPEC-B.md:113-114`.

Detail for M08:
- **Helius.** Any Helius use is the spend the owner paused. The Developer headroom is off-limits until the bot can buy coins.
- **Alchemy free.** `getMultipleAccounts` costs 20 CU a call (`limits.ts:46`). One call a second is about 51.8M CU a month, against a 30M plan, or 15M at the 50% rule. This is derived from the code's constant, not measured.
- **Chainstack free.** 3M requests a month; the 50% rule allows 1.5M, below the 2.6M needed.
- **Shyft.** A new provider, which needs the owner. Its "unlimited" fair use is UNVERIFIED (A-07).
- Sources: `packages/worker/src/scheduler/limits.ts:30-47`; FACTS LD-31, LD-32, LD-33; `CLAUDE.md` "No extra data spend", "Carried from the Blueprint build"; `AGENTS.md` "Only the owner".

### MINOR

| ID | Section, line | What is wrong | Evidence | Fix |
|---|---|---|---|---|
| m01 | A-M13-04 L192 | The citation `risk/types.ts:96,103` points at `pnl: MicroUsd` and `notional: MicroUsd`, not equity or drawdown. The O-clash at L600 reuses `:96`. | `packages/core/src/risk/types.ts:96,103,270,305` | Cite `types.ts:270` (equity) and `:305` (`navHighWaterMark`). |
| m02 | M16 L229; D10 L284 | `compile.ts:35,111` for the 1,232-byte check: the constant is at `:25`, and `:35` is blank. `compile.ts:36` for v0: `V0_PREFIX` is at `:26`. `policy.ts:166` "refuses any account" is at `:167`. | `packages/core/src/tx/compile.ts:25-26`; `packages/core/src/tx/policy.ts:167` | Fix the line numbers. |
| m03 | Clash "Helius §3.2(xi)" L603 | `HANDOVER.md:555` is about SOL-ledger exactness. The §3.2(xi) line is at `:384`. | `HANDOVER.md:384,555` | Cite `:384`. |
| m04 | M21 L234; Money L427 | "Red team A round 4 item 12" uses HANDOVER's numbering (§5.10). In the report, R10 on SOL/USD is item **4**. The bug was first found by red team B as RB-1. | `claude/redteam-a` REPORT L379; `claude/redteam-b` REPORT L11 | Cite the report's item 4 and RB-1. |
| m05 | A-M03-01 L102 | The RTC test, "≤ 1 backfill per reconnect and no credit spend above budget", is put on the PumpPortal client. Red team C C3's credit burn is the Helius stream on the shared `providers/socket.ts`, and PumpPortal spends no credits. | `docs/redteam-c/REPORT.md` C3 | Move the test to A-M14-01 and A-M04-03, the transport. Keep a backoff-with-jitter test on A-M03-01. |
| m06 | B1 L406 | `worker/src/run/config.ts:84` is a deliberate upper bound for a timing guard: "p99 … 278 ms; 400 ms keeps 1.44x headroom" (`:81`). Measuring the slot time there loosens a guard. The comment in `settings.ts:50` (350 ms) is also stale against LD-08. | `packages/worker/src/run/config.ts:81-84`; `settings.ts:50-52` | List `config.ts:84` as a guard to keep as an upper bound, not a dating bug. |
| m07 | B3 L408; B4 L409; Rule 1 L23 | Rule 1 needs tests that "fail on the old code". B3's test targets Zeroed's holdout config, which does not carry over (the map's own words), and B4's replay through M04, M05 and M14 cannot run on the old code. B4 also needs "a recorded hour of the 7 Oct candidate flow". Not verified that such a recording exists, since the upload was not running at times (`HANDOVER.md:793`). | MIGRATION L408–409 | Mark B3 and B4 "stays behind; acceptance test on the new module". Name the dataset for B4, or make a synthetic one. |
| m08 | Summary L48; Group A L73; Deploy tag L454; update gate L329; guard L251 | "No module is **keep**", yet the deploy tag, the update gate and the copy guard are **keep**. | MIGRATION L48, L251, L329, L454 | Say "no Blueprint ticket is keep; three owner-rule or ops parts are kept". See M07 for the update gate. |
| m09 | Bug row B5 L43 against B5 detail L410 | L43: "#268 resumes the worker with it". L410: "#268 … removes it". | `HANDOVER.md:632` | Correct L43. |
| m10 | A-M13-05 L193 | Marked **missing**, but Zeroed has a holdout seal state machine (`stats/holdout.ts:47`, `registered`, `sealed`, `opened`) and a registry (`backtest/src/holdout.ts`). It is a partial seed. | `packages/core/src/stats/holdout.ts:47` | Note the seed. Missing stays defensible. |
| m11 | Red team C table L496–517 | Missing items: M3 (a clock far ahead locks the fill budget), R3-3, R3-4, and the note that the deployer index is left out of the backup. | `docs/redteam-c/REPORT.md` L30, L198–199, L264 | Add the rows. |
| m12 | Ticket order L643, L664–686 | (1) Z00 pulls part of B-M30-02, an M4 ticket, into M0 without flagging the change. (2) The M2 text says B-M21, B-M22 and B-M23 are all built in M2, but INTEGRATION puts B-M21-04/05, B-M22-03 and B-M23-04/05 in M3. (3) A-M09-02 and A-M09-03 are not named. (4) INTEGRATION's open item, splitting B-M19-03 and B-M29-04 across milestones, is not carried. | `INTEGRATION.md:21-23,289` | List the ticket IDs per card for M2 and M3, as M0 and M1 do. Flag the Z00 change. |
| m13 | Header L6; Snipe-solana L334, L338–340 | The header says Snipe-solana `main` is at `74e7258`, C11's merge (#2). C12 is listed as merged in #3 (`a99487d`), a later PR, so `main` cannot still be at `74e7258`. Not verified: Snipe-solana was not read. The research branch is cited at three tips: `1baca138` (L351), `7b162ed8` (L349, L388) and `9471d5bb` (HANDOVER). | MIGRATION L6, L334, L338–340 | Re-read the Snipe-solana head and pin one research tip. |
| m14 | A-M14-03 L204 | "RugCheck at 1 per 4.5 s is about 89% of its observed 15 header" assumes a 60 s window. The window is undocumented (`limits.ts:67-68`). | `packages/worker/src/scheduler/limits.ts:67-73` | Say "unknown share; the window is undocumented". Under the 50% rule, measure the window or halve the rate. |
| m15 | Process L627–633 | The owner's newest workflow rule, "Worker loop" (7 Oct 5:40 PM: at least 3 builders, 2 researchers and 1 red team), is not in the process clashes. The map uses the older "one task at a time" (8:55 PM 6 Oct) and Snipe-solana's "at most three". The logo rule (Slot mark, `docs/BRAND.md`) is not addressed for the new dashboard. | `CLAUDE.md` "Worker loop", "Name and logo" | Add both rows. |
| m16 | Rules L29; Z10 L660 | "Once M1 is reviewed" cannot mean the M1 exit, because the exit needs the recorder already running for 48 h. Z10's Needs (Z09, Z00) imply "once the recorder cards are reviewed". | MIGRATION L29, L660, L662 | Say "once Z07–Z09 are reviewed and red-teamed". |

## Not verified

- **Snipe-solana.** It was not read, because it is not in this session's scope. Not checked:
  - the C01–C05 contents, their dependency lists and C03's rulings;
  - the Toolchain row's TypeScript 6.0.3 and npm workspaces.
- **Host and server.** No host or server state was read. The 23 GB-a-day figure, the 34 restarts and the 18 h without a crash come from HANDOVER only.
- **Two figures from HANDOVER only:**
  - the 87k-an-hour burn;
  - the "about 45 creates a minute" estimate.
- **pump.fun.** Whether pump.fun Terms §21(h) reaches PumpPortal or on-chain trading. The Terms are not in the repo.
- **The 521-test and 82-test runs.** These group B runs were not re-run.

# Round 2: research addendum, ticket order, DECISIONS (`cb2a1458`)

Asked by the supervisor on 2026-10-07.

What was read:
- `docs/MIGRATION.md` and `docs/DECISIONS.md` at `cb2a1458`;
- `research/BLUEPRINT_ADDENDUM.md` at `72f1793f`. It is unchanged at the branch tip `84f572ad`: `git diff 72f1793f 84f572ad` on the file is empty.

Line numbers ("L") in this round are lines of `docs/MIGRATION.md` at `cb2a1458`.

## Rulings checked against the addendum

Each of the 24 rulings was compared with its addendum item.

Faithful, with nothing found:
- A04, A07, A08 (text), A11, A12, A13, A14, A16, A19, A20, A22, A23, A24;
- A05 and A18 (both sent to the owner, with recommendations);
- A09 (H8 marked replace);
- A21 (MR keeps the 2,000 bps prior).

Changed, correctly:
- **A17.** Dropping "paper-trades" after both strategies fail only tightens. It follows "No knowingly losing trades … not even as practice", and it is recorded in `docs/DECISIONS.md` and in HANDOVER.

Resolved, correctly:
- **A01.** The owner chose the 2 GB host.

Findings:
- A03 settles an owner question (R2-01).
- A06 is called adopted but is not carried into any card or gate (R2-02).
- A02 and the terms register narrow the pump.fun rule and settle the PumpPortal question (R2-04, R2-05).
- Smaller points are in the MINOR table.

## Findings (round 2)

### MAJOR

| ID | Section, line | What is wrong | Evidence | Fix |
|---|---|---|---|---|
| R2-01 | Research addendum A03 (L410) | The ruling calls Helius Developer a D29 research cost "while the bot stays on D04's free tiers", and says this "settles O7's Helius point". The two problems are in the bullets after this table. | `HANDOVER.md:166-168` ("Same key as before"; the code still budgets the free plan); MIGRATION O7 (L655 "Owner decides …"); ARCH 1.4; `CLAUDE.md` "Blueprint" (owner rule stands until the owner decides); `AGENTS.md` "Never … loosen a … guard" | Put A03's last sentence to the owner as part of O7. Until the owner rules, count the $49 in the bot's fixed cost for P-9, which is the stricter reading. Record the open question in DECISIONS. |
| R2-02 | A06 (L413); clash table "Pre-funding gate" (unchanged at `cb2a1458`) | A06 says items 1, 4 and 6 and blindness "All tighten, so they are adopted", but no card or gate carries them. The gaps are in the bullets after this table. | Addendum A06; `CLAUDE.md` "No deposit before proof"; `git diff 72c1bc17 cb2a1458` (clash table untouched) | Write the adopted items into the clash table as decisions, and into the M2, M3 and M4 exits and the tickets (A-M11, A-M12-02, A-M13-06). Add items 3 and 5. Keep item 6 whole. This closes round 1 M09 at the same time. |
| R2-03 | Ticket order: Z04 now "Needs Z01, Z06"; batches "then Z06, then Z04" | Z06 needs Z02, Z03 and **Z05**, the UI system port, because Z06 bundles UI-T07 with B-M15-01. The recorder queue (A-M07-01) and the statistics (A-M13-03) in Z04 now wait for the UI port. So does all of M1 capture, since Z08 needs Z04. This contradicts A01's own ruling: "Gate windows count from the first recorded day, so the recorder path … goes first". Only A-M10-01 needs A10's slot-to-time function. A-M07-01 and A-M13-03 have no dependencies beyond B-M19-01 and B-M30-01. | `SPEC-A.md:83,92,106` (A-M07-01, A-M10-01, A-M13-03: no A dependencies); `UI.md:1939` (UI-T07 needs UI-T04 and UI-T05 only); MIGRATION A01 (L408) | Split Z06 into B-M15-01 plus the A10 function (needs Z02, Z03), and UI-T07, which joins Z05. Gate only A-M10-01 on the slot-to-time function. Leave A-M07-01 and A-M13-03 needing only Z01. |
| R2-04 | A02 (L409); terms register row "pump.fun Terms §21(h)"; Z01 CI check | The owner's rule is "no **new pump.fun requests**". The register narrows it to "no pump.fun **frontend** request", and the CI check bans only "pump.fun frontend hosts". Read literally, that lets the bot or research call any other pump.fun-run host, such as an API or data host. The rule the owner set is broader. | `HANDOVER.md` §6 ("no new pump.fun requests"); `research/SUPERVISOR_MESSAGES.md:82` (`72f1793f`); `research/hype/RESEARCH.md:143` (`72f1793f`) | Word the rule and the CI check as "no request to any pump.fun-operated host". Keep the exceptions as they are: pinned IDLs on GitHub and SDK test oracles from npm are not pump.fun hosts. |
| R2-05 | Terms register row "PumpPortal": status "Used with the chain backfill on (D12)" | The round 1 map sent "PumpPortal and on-chain trading under §21(h)" to the owner (L639 at `cb2a1458`: "Put PumpPortal … to the owner"). The research branch records one pending owner decision that covers pump.fun §21(h) (`research/hype/RESEARCH.md:147`). The register now marks PumpPortal "Used", which settles that question without the owner. | MIGRATION L639; `research/hype/RESEARCH.md:145-147` (`72f1793f`) | Status: "Open with the owner (§21(h) reach); A-M03-01 is built but not run against PumpPortal until the owner rules", or cite the owner's ruling if one exists. |

Detail for R2-01:
- **The bot is not on a free tier.** It has no separate free Helius account. The only Helius key is the owner's Developer-plan key, so a bot that uses Helius at all (D04 uses Helius for `getPriorityFeeEstimate` and Sender, and D30 uses it for `getProgramAccounts`) runs on the paid plan.
- **It settles an owner question.** O7 left "whether Helius Developer counts as the bot's fixed cost" to the owner. Calling it research cost lowers the P-9 minimum live bankroll from about $1,967 to about $334. That loosens a gate on a point the owner has not decided, and DECISIONS does not record it as a decision.

Detail for R2-02:
- **No carrier.** The carrier named is the clash table, which `cb2a1458` did not change. It still says "Recommendation", and its item 6 text differs from A06: "≥ 300 holdout trades with CI lower bound > 0 … on top of B-1..B-8", against A06's "raise R-1 and P-1 to 300". No card or gate (A-M11, A-M12-02, A-M13-06) carries any of it, and the acceptance check is only "the clash table lists them".
- **Owner items left out.** Items 3 (48 h, ≥ 99% uptime, drills) and 5 (fault injection as a gate) are not in A06 at all.
- **Item 6 cut down.** A06 keeps only "300 trades at 80% power". The owner's item 6 also asks for rules fixed in advance, walk-forward testing, an untouched holdout and a 95% CI above zero.

### MINOR

| ID | Section, line | What is wrong | Evidence | Fix |
|---|---|---|---|---|
| R2-06 | A02; terms register "pump.fun" row, "Rule in force (owner)" | The limit "data collected before 2026-10-07 serves research only, never a Blueprint universe or gate" is credited to the owner. The owner said "Yes keep what we collected as is … stays in use as it is". The limit is the addendum's tightening. It also differs from the older clash row, "Use no hype Test 1 result in a gate **until the owner rules**". | `research/hype/RESEARCH.md:145` (`72f1793f`); MIGRATION L639 | Label it a supervisor tightening, and make the two rows say the same. |
| R2-07 | Terms register "DexScreener" row | The HTTP 403 is cited to `research/hype/RESEARCH.md:45`. That line says "Commercial use allowed … 2026-10-07". The 403 is at `docs/research/historical-data.md:36`. | Both files at `72f1793f` | Cite both lines. |
| R2-08 | A15 acceptance | "A golden replay reproduces `audit_results.json`". That file comes from an unfinished run (305ae388, "run in progress"), and the section's own rule says unfinished results enter only after their RESULTS.md and a fresh review. | Addendum "Provisional" and "Still running"; MIGRATION "Unfinished runs" bullet | Pin the golden to a reviewed RESULTS.md commit. |
| R2-09 | A10 acceptance | "No other slot constant exists" would also remove the deliberate upper bound in the watch-timing guard (`worker/src/run/config.ts:81-84`; round 1 m06). | `packages/worker/src/run/config.ts:81-84` | Allow a named upper-bound constant for guards, used only where a larger slot time is the stricter choice. |
| R2-10 | Z07 card; Z09 card | The A08 ruling names Z07 (creator fee per pool, CORE-2 goldens, reserve timing), but Z07's row was not changed to carry it. The Z09 row still has no size sweep (round 1 M10). | MIGRATION Z07 and Z09 rows at `cb2a1458` | Add A08 to Z07, and the size sweep to Z09's A-M10-03 and A-M13-01. |
| R2-11 | A01 acceptance; Z08 "A01 disk test on 55 GB" | A unit test cannot use "the real disk of the 2 GB host". | MIGRATION A01, Z08 | Say "the budget is sized for a 55 GB disk; the installer checks the real disk at install (D07 preflight)". |
| R2-12 | Z0D | Z0D edits `docs/blueprint/` (ARCH, FACTS, C-xx), which was copied from Snipe-solana `74e7258` (L6). No line records that the local Blueprint now differs from its source, and no fresh review is named for design-authority edits. | MIGRATION L6, Z0D | Record in L6 that the Blueprint is now edited here. Give Z0D a fresh reviewer like any other card. |
| R2-13 | DECISIONS "Blueprint addendum", A17 | The text says research goes on "within the owner's stop date and spend cap", but no values exist yet, because A17's values are still with the owner. Until then, no cap binds. | `docs/DECISIONS.md` (`cb2a1458`) "Blueprint addendum" | Add "until the owner sets them, no new research spend (owner rule 'No extra data spend')". |

## Ticket order and DECISIONS: other checks (round 2)

- **Z0D:** docs only. Its items match A02, A04, A06 (doc), A07 (q) and A20.
- **Z08 and Z09 additions:** these match A01, A03, A02, A07 and A05.
- **New DECISIONS table rows:** the Blueprint authority, the host move, "no bugs migrate" with the recorder and paper-engine exception, and the addendum row. All four match `CLAUDE.md` "Blueprint" and "Host".
- **HANDOVER:** the A17 change and the owner decisions sent (A05, A06 item 2, A17 values, A18) match the addendum's note to the supervisor. That note listed A01 too, which is resolved.
