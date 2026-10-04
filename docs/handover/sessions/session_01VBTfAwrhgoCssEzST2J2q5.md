# Handover: BT-2 builder (session_01VBTfAwrhgoCssEzST2J2q5)

Written 2026-10-04, about 19:40 AEDT, on the owner's handover order. All work is pushed and no work is in progress locally.

## Role, cards, model

- **Role:** builder for BT-2: the historical backtest and strategy study (ARCHITECTURE §20, §7–§9, §13, §14, §16.3).
- **Cards:**
  - BT-2;
  - BT-2e (early-look runner);
  - RES-4 integration (a)–(e);
  - the supervisor rulings listed below.
- **Supervisor:** session_01Bne9GqXR99gJn6D9U2mJFZ.
- **Model:** `claude-opus-5-5`, configured in this session (the serving model was not separately verified).

## PRs and branches

| PR | Branch | Head | State | Reviews |
|---|---|---|---|---|
| #41 | `claude/backtest-2` → `ccr-14987baf-i6lrsl` | `ac003d4` | open, draft (kept a draft until real-day runs exist) | 012efQ: **FAIL at dd19015** (B1 and B2 blocking, three non-blocking; see "Open risks"). Earlier pass/fail history is in 012efQ's notes. Nothing reviewed since ac003d4. |

The base was last merged at e430dc9: STATS-1c #62, GATE-2 #94, STATS-1f #109 and DATA-2 #111 are all in. The base has moved since (669de71 or later), so merge it with a merge commit before review.

## What is done (main files: `packages/backtest/src/...`)

- Engine path:
  - fact projector `sim/facts.ts`;
  - market and observation delay `sim/market.ts`;
  - study strategy `strategy/study.ts` (U1, U2, S0, features rules; staged gates; regime first; deployment mode);
  - study runner `study/run.ts`.
- Holders come from BT-1d's HolderBook (`sim/facts.ts` `#feedBook`, `holdersAsOf`). Abstentions are counted by reason and never imputed.
- One holdout registry (`holdout.ts`, BT-1d's), which the study writes through:
  - `setHoldoutPlan` (plan from `study/plan.ts` `holdoutPlanOf`);
  - `registerAttempt` with the frozen requirement (STATS-1c);
  - `recordHoldoutG1`;
  - `sealThroughStore` (new, shared with `runAndSealHoldout`);
  - `recordHoldoutG2` (new; only sealed → opened or burned, opening needs a G1 pass);
  - `recordTrials` (new; the experiment registry is a section of the store and refuses trials outside the pre-registered family).
- Sealed run: `study/sealed.ts`. Scoring: `study/score.ts`. G3 summary: `study/summary.ts`. Funnel: `study/funnel.ts`. Reads and latency parity: `study/reads.ts`. Completeness: `study/completeness.ts`.
- Observation delay (supervisor ruling): projector facts, checks and landings go through the delay queue.
  - Values keep their chain slots, and `tip:observed` moves in chain order.
  - Core `GateContext.observedTip` is required, and `Evidence` judges staleness against it. Live passes `ctx.now.slot`.
  - Test `worker/test/observed-tip.test.ts` pins a live digest.
- G2 funder cluster: the dev's first funder from the insider supplement (`score.ts` `devFunderOf`). Missing means no label, and G2 fails.
- RES-4:
  - hypothesis ids as tags (`strategy/config.ts` `configTag`, `configId(c, tag)`);
  - pre-registration loader `strategy/preregistration.ts` (sha256 pin `STUDY_CONFIG.preregistration`, still null);
  - SPA selection `study/select.ts` plus core `spaTest` `s0Of` (`packages/core/src/stats/spa.ts`);
  - study integration in `study/study.ts` (step 1d).
- BT-2e early look: `study/early.ts` and the `cli.ts early` command. U2 only, labelled "early look, not proof".
- CLI: `study/cli.ts`, with commands `day`, `trial`, `early` and `study`.
- Docs:
  - `docs/DECISIONS.md` (many dated BT-2 entries; search for "BT-2");
  - `docs/evidence/BT2.md`;
  - `docs/research/signals.md` (holdout wall wording).

## Work in progress

None started locally; ac003d4 is clean and pushed. Three batches of rulings arrived just before the handover and are **not started**. Next steps lists them in order.

## Next steps, in order

1. Merge `origin/ccr-14987baf-i6lrsl` into `claude/backtest-2` with a merge commit. Resolve conflicts by taking base for anything the base owns.
2. **External audit (supervisor order: before RES-4 (b)/(c) and before any `cli.ts early` run).** Reproduce each defect in a test that fails first. Order: B5, B1, B3, B2, B4, S2.
   - **B5:** failed-entry costs are dropped (`study/score.ts` around :56–59, the study deployment block). Carry every timestamped attempt cost into portfolio results, the daily SPA series and promotion inputs.
   - **B1:** S0 passes universe "S0" into the hard gates (`strategy/study.ts` `#gates`, `universe: this.#s0 ? 'S0' : u.universe`). S0 must run the parent U1/U2 gates and only randomise the entry.
   - **B3 / 012efQ B2:** holder growth (`strategy/study.ts` `walletHolders`, around :750–777) counts token accounts. It must count distinct owners with summed balance > 0 among class 'wallet', pool vault excluded (pool from the tape), complete coverage at both times, else null, following #115's `definitions.holderGrowth`. Add tests for each case. Must land before the pre-registration sha is pinned.
   - **B2:** staged gate passes carry forward. Mirror FACTS-1f #106 (d06ebdb): every entry decision re-runs every stage from stage 1 in one call at one `ctx.now`; reads only stage to save requests. Add a parity test against the live gate on the same facts.
   - **B4:** rename "independent buying" to "non-creator-user flow" everywhere (code, reports, DECISIONS), unless point-in-time funding attribution is added (`strategy/tape.ts`, `strategy/study.ts`).
   - **S2:** RETURN_CAP = 3 (`study/summary.ts`) isn't a bound on uncapped runners. Agree an estimand with 01FHfb first (for example capped P&L reported as such), then code it.
3. **012efQ B1:** add a worker test where a chain fact or stream head is more than maxStateSlotLag behind the clock slot. It must abstain 'stale', and fail if `observedTip` is lowered (for example to `0n`) in `worker/src/engine/strategy.ts`.
4. **012efQ non-blocking:**
   - early-CLI tests for refusing non-practice and incomplete days;
   - `study` must refuse `--preregistration` (today it ignores it).
5. **01FHfb binding stats rulings for RES-4 (b)/(c):**
   - The SE floor 0.0005 of the capital base per day, stored as a fraction, frozen in the registered plan with g1Test per attempt, never changed from practice ω. Add one calibration case at that floor on the real layout: k = 6 plus per-universe S0, zero edge, including a sparse variant and an all-costs variant, global size ≤ α.
   - Pick rule:
     - rank by **min(zVsZero, zVsS0)**, ties by file order;
     - before ranking, drop any passing variant whose practice entries per day × 28 < max(300, n_power at the plan's α);
     - holdout **familySize stays 2** whatever is picked: a universe without a pick is registered as "no configuration" with p = 1 in Holm, and the result is "not proven".
   - Fix `holdoutPlanOf`, which derives familySize from `c.universes.length`. Test: drop a universe before registration and still get 2.
   - `s0Of` is required for the k = 6 family: H1, H2, H3 and H6 use S0-U1; H4 and H5 use S0-U2.
6. **Early look:** `cli.ts early` must report engine validity, the funnel and descriptive figures only, with no G1 or SPA verdict and no wording implying one. Add a test that the report contains none. Run it on 2026-09-21, then 09-20, once DATA-2's pull lands (about 14 h after #119 merged around 07:45 UTC on 4 Oct) and only after steps 2–6 are reviewed.
7. Pin `STUDY_CONFIG.preregistration.sha256` to #115's file once #115 and step 2 (B3) have merged.
8. 09-21 funnel count, plus the Helius credit estimate for the funding backfill: creators reaching H13 × (signature pages + transactions at MINT_HISTORY_CAPS) × credits per call. Report it to the supervisor and **do not run the backfill**.
9. Follow-up PR after #41: move the row derivations into core/facts.

## Findings and results

- No real-day results exist yet: no practice or holdout day has been run, and every run so far is on the synthetic world.
- Engine cost: a full `pnpm check` takes about 19–20 min in this container (160 files, 4,548 tests at ac003d4, exit 0). The heaviest file is `backtest/test/full-study.test.ts`, about 6–8 min.
- Observed-tip digest (`worker/test/observed-tip.test.ts`):
  - At 0a8fca9 it was `843c354d…` (16 decisions).
  - After merging base e430dc9 it is `677234af…`, retaken with Evidence forced to `tip = now.slot`; the current code reproduces it.
  - Base commits that changed it: the base merges in 501200d and e430dc9 brought changes to `packages/worker/src/engine/strategy.ts` from `claude/risk-mark`, `claude/worker-1b`, `claude/watch-1` (EXIT-1e/1d #102) and `claude/stats-1c`. List them with `git log --oneline 0a8fca9..e430dc9 -- packages/worker/src/engine/strategy.ts`. The tip did not change it: with Evidence forced to `now.slot`, the merged code gives the same digest as the code under test. Still to be stated in the PR, per the supervisor.
- Synthetic world, delayed vs recorded (scratch probe, 2-day U2 world): delayed facts with the observed tip give the same decision mix as recorded; without the tip they reject `H12:stale` or `H11:stale`. Covered by the tests listed in DECISIONS.

## Rulings received (all in docs/DECISIONS.md under their dates)

- Holdout:
  - E = 2026-10-20 cutoff, one observation tail day, B5 as a decoder boundary;
  - α 0.04 then 0.01/2^(k−1), from STATS-1c;
  - opening only after a G1 pass;
  - salted tie-break;
  - one registry (BT-1d's `holdout.ts`), with the requirement frozen at registration (STATS-1c);
  - G1's test read from the stored registry (STATS-1f).
- Gates and parity:
  - FACTS-1 staging parity, with the live read caps and latencies;
  - regime evaluated first, assume-on runs never feed G1;
  - holder abstentions counted by reason;
  - GATE-2 `complete`.
- Clusters and delay:
  - funder cluster = the dev's first funder, missing means G2 fails, no shared or singleton unknown;
  - the observation delay changes receipt only, never the chain slot; staleness against the observed tip; `observedTip` required in live too.
- RES-4 (a)–(e) and BT-2e: as built; see DECISIONS.
- 01FHfb (b)/(c) amendments, the external audit B1–B5 and S2, and 012efQ's FAIL at dd19015 are **not yet built** (Next steps).
- Do not run the Helius funding backfill before the credit estimate is cleared.

## Open risks and known gaps

- 012efQ #41 FAIL at dd19015:
  - B1: the live tip is untested; mutating it to 0n passes every worker test.
  - B2: holder growth doesn't follow #115's definition.
- The external audit defects B1–B5 and S2 bias every result. No early or study run should happen before they are fixed.
- `STUDY_CONFIG.spa` currently says "proposed". The 01FHfb rulings make 0.0005 binding, but the plan does not freeze it yet, and the pick rule in `study/select.ts` still uses zVsS0 instead of min(zVsZero, zVsS0).
- `holdoutPlanOf` familySize comes from `c.universes.length` (must be 2 regardless).
- RES-3's `--registry` expects a bare STATS-1 registry; give it the store's `registry` section.
- Synthetic tests are seed-sensitive (fill draws). A change in timing can drop all entries for a seed; check the cause before changing a seed.

## How to verify

- `pnpm install --frozen-lockfile && pnpm check` (about 20 min).
- Focused files:
  - `pnpm vitest run packages/backtest/test/{study,full-study,registry,early,select,preregistration,replay,facts}.test.ts`;
  - `packages/core/test/stats-math.test.ts`;
  - `packages/core/test/gates/hard.test.ts`;
  - `packages/worker/test/observed-tip.test.ts`.
- CLI: `node packages/backtest/src/study/cli.ts early --dataset <dir> --sol-usd <file> --days 2026-09-21`. `study` needs a clean tree because it writes the holdout registry on the `holdout-registry` branch.

## Remaining time (rough, ±50%)

- Audit fixes B1–B5 and S2: about 6–8 h, plus about 1 h of review per round.
- 012efQ B1 and the non-blocking items: about 1 h.
- 01FHfb amendments including the calibration case: about 3–4 h.
- Early-look report trim plus the run on two days: about 1 h plus the run time (unknown on real data; on synthetic data about 2 min per configuration per day).
- Funnel count and credit estimate: about 1–2 h once 09-21 is available.
