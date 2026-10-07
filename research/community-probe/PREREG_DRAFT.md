<!-- Draft from the advisor-six-ideas workflow (2026-10-08), adversarially reviewed and corrected. The builder commits the final PREREG.md before any data pull. -->

# Community crossing among graduate buyers (pre-registration, 2026-10-08; corrected after adversarial review)

Idea 5 from the outside reviewer, in the reviewer family (k = 10). Stage 1 asks only about future buying flow. A trade test needs a stage-1 PASS and its own registration.

## Looked at before writing
- **Weng, Menczer, Ahn:**
  - 2013, Sci Rep 3:2522 (doi:10.1038/srep02522; PMC3755286);
  - 2014, ICWSM 8:535-544 (arXiv 1403.6199);
  - both read by the scout on 2026-10-07.
  - Finding: early spread of a hashtag across communities predicted its popularity (Twitter 2012; communities from the follower graph; random 10-fold cross-validation).
  - Limits: the outcome is popularity, not price. Their communities are exposure networks; ours are co-purchase behaviour. The support is by analogy only.
- No wallet, graph, flow or price data in any window was looked at.

## Question (stage 1)
Some graduates' first 50 post-migration buyers come from many previously separate wallet communities. Do those graduates attract more net SOL buying over the next 6 h, after our delay, than comparable graduates whose early buyers come from one recurring circle? The difference must be large enough to matter against the round-trip cost. Comparisons are within the same half-day and matched on net SOL inflow, price move and buyer pace.

## Data and windows
- **Shared tape:** S, C and G, plus W if Phase 0 keeps it.
- **Lookback L = 3 days.** L = 7 would leave 3 Phase 1 and 7 Phase 2 decision days, below MIN_DAYS = 10.
- **Phase 1 decision days:** 2026-09-05 to 09-11, for gates and futility only.
  - A candidate counts only if its outcome window ends by 09-11 24:00Z (decision slot by about 17:59:30Z on 09-11).
  - Later candidates are dropped by time.
- **Phase 2 decision days:** 2026-10-25 to 11-04, with 11-05 read as the outcome tail. This is the primary.
- **Fallback block:** if Phase 2 uses it, decision days are 08-22 to 09-01 (11 days), with lookback from 08-19.

## Community graph
Built once per day at cutoff c = 00:00Z of day D, from rows with slot before c.
- **Edges:** successful buys of at least 0.01 SOL on bonding curves and canonical pools in [c − 3 d, c). The wallet is the owner (user_token_owner), never the signer.
- **Tokens:**
  - exclude tokens created in [c − 24 h, c);
  - keep tokens with 5 to 5,000 distinct buyers;
  - remove each token's creator and its creation-slot buyers from that token's edges.
- **Owners:** keep owners with 2 to 200 distinct tokens. Above 200 → labelled 'heavy' and left out.
- **Token-token weights:** w(a,b) = Σ over shared owners of 1 / ln(1 + that owner's token count).
- **Partition:** Leiden (modularity, resolution 1.0, seed 20261008).
- **Owner's community:** the one holding the largest share of the owner's lookback buy SOL; ties go to the lowest id.
- **Unknown owners:** owners outside the graph stay UNKNOWN. They are counted, never assigned.

## Candidates (as of the decision slot)
- **Universe:** every migration on decision day D of a token created at or after c − 24 h.
- **Eligible buyer:** owner ≠ creator, not a creation-slot buyer, first buy of at least 0.01 SOL on the canonical pool after the migration slot. Protocol flow (boost_buy_and_burn, buyback authorities) is excluded.
- **Funding clusters (only if W is kept):** owners whose first SOL funder in [c − 3 d, decision) is the same count as one buyer. Unknown funding stays unknown.
- **Decision slot:** the slot of the 50th eligible buyer, if it comes within 2 h of migration; otherwise the token is not a candidate.
- **Known buyers:** K = how many of the 50 are in the graph. K < 10 → not a candidate.

## Signal X (known at the decision slot)
- **Entropy:** H = −Σ p_k ln p_k over the known buyers' communities.
- **Null:** 200 draws of K owners from the known owners who bought any other graduate's canonical pool in the same UTC hour, up to the decision slot. The candidate's own buyers are excluded.
- **Signal:** X = (H − null mean) / null sd.

## Matching (coarsened exact matching)
- **Strata:** calendar 12-hour UTC block (00-12Z or 12-24Z of each day) × terciles of:
  - net SOL inflow (migration → decision);
  - log price change (migration → decision);
  - minutes from migration to decision.
  - That is 27 cells per block, about a dozen candidates per cell at an estimated 600 candidates a day.
- **Covariates outside the strata:** distinct curve-phase buyers and the known share K/50 enter the regression-adjusted secondary only.
- **Cutoffs:** all cut points (these terciles and the X terciles) come from Phase 1 candidates and are frozen before Phase 2 is pulled.
- **Comparison:** within each stratum, the top X tercile against the bottom X tercile. Strata missing an arm are dropped, and their count is reported.

## Outcome (separate scoring stage)
Y = (canonical-pool buy SOL − sell SOL by non-wash owners in (t_dec + d, t_dec + d + 6 h]) / quote reserve at t_dec. Protocol flow is excluded.
- **Delay d = 30 s.** Only a larger measured value may replace it.
- **Wash flag:** a buy and a sell within 60 s with a net token change of at most 5% of the gross. Outcome only.

## Gates (counts only)
- **Pre-gate** (Step A days 09-10 and 09-11; no graph needed): at least 50% of graduates reach 50 eligible buyers within 2 h.
- **Full gates** (decision days 09-10 and 09-11, after Step B):
  - the median known share of the 50 is at least 30%;
  - the daily graph builds in under 2 h on 4 cores.
- **If any gate fails:** stop, UNRESOLVED (most buyers are unknown, or the method is too slow to run live).

## Futility (Phase 1, all 7 decision days, outcomes)
- Δ is computed on Phase 1.
- Δ ≤ 0 → stop; Phase 2 is not used for this idea.
- Phase 1 can never produce a PASS.

## Primary test (Phase 2)
- **Statistic:** Δ = stratum-size-weighted mean Y of the top X tercile minus that of the bottom tercile.
- **Interval:** studentized day-block bootstrap over decision days, following dayBlockMeanDiffInterval in packages/core/src/stats/bootstrap.ts (the wider of bootstrap-t and t_{N−1}); 95%, two-sided.
- **Materiality (fixed now):** 2Δ ≥ c̃, where c̃ = the median estimated $50 round-trip cost at the decision slot over top-tercile candidates. Under constant product, an inflow ΔY moves the price by about 2ΔY.
- **PASS:** the CI lies above 0, N ≥ 10, at least 200 candidates per arm after dropping strata, and materiality holds.
- **KILL:** Δ ≤ 0, or the CI lies above 0 but the effect is immaterial.
- **UNRESOLVED:** anything else, including Phase 2 never being pulled. This counts as not supported for the bot.
- **Fallback block:** the same rule applies. A pass there needs a post-B5 check before any strategy registration.

## Secondary (descriptive)
- Regression-adjusted: OLS of Y on X with the matching variables, curve-phase buyers, known share and calendar 4-hour fixed effects; day-clustered.
- Recurring-circle share.
- L = 7 where it fits.
- An Infomap partition.
- A 1-hour horizon.
- New distinct buyers as the outcome.
- Funding-cluster versus owner-level counting.

## Stage 2 (registered before Phase 2; runs only after a Phase 2 stage-1 PASS)
- **Trade:** for top-tercile X, buy at the first canonical-pool swap after t_dec + d; exit at the first swap after +6 h.
- **Benchmark:** 10 matched random candidates (same stratum, same day).
- **PASS needs:** at least max(300, n_power at the family level) trades on at least 10 days, and family-level CIs (99.5% two-sided, Bonferroni k = 10) above 0, both for the absolute return and against matched random. 95% CIs are also reported.
- **Sizes:** $50 is the primary. Also $5, $20, $100, $1,000 and $10,000, with gross return, fixed costs, percentage fees and impact shown separately.
- **Costs:** the conservative scenario, in SOL. $50 = 419,252,054 lamports at SOL $119.26 (packages/backtest/src/research/edge-costs.ts; 414,009 lamports fixed per round trip, rent loss included).

## Look-ahead guards
- **Graph:** built only from [c − 3 d, c). Tokens are excluded by creation time, never by a later outcome such as 'graduated later'.
- **Wallets:** a wallet first seen after c stays UNKNOWN.
- **Funding:** clusters use only transfers before the decision slot.
- **Measures:** matching variables and X use only trades up to the decision slot.
- **Outcome:** starts at decision + d and ends inside the tape.
- **Universe:** from on-chain migrations (no GeckoTerminal or DexScreener list).
- **Days:** no sealed-window or U1-B-holdout day is read. Regime effects between Phase 1 and Phase 2 are reported.
- **Leak test:** a planted future buyer one slot after the decision must not change X or the strata.

## Budget
- 0 extra Helius credits.
- Builder: about 2-3 days.
- Dependency: Leiden via igraph/leidenalg, with networkx Louvain as the declared fallback, in a scratch venv with the supervisor's OK.

## Executor notes

One builder (Opus 5.5), branch claude/community-probe. Commit research/community-probe/PREREG.md before Step A.

Before any code: the supervisor's OK for the graph library (scratch venv, outside the lockfile).

Order of work:
1. After Step A: the reach-rate pre-gate, recorded in RESULTS.md.
2. After Step B: the full gates.
3. If they pass and Step C is read: the futility statistic.
4. Freeze and commit the terciles, the X cut points and the hash of the null draws.
5. Commit the stage-2 registration. Steps 4 and 5 happen before Phase 2.

Rules:
- Phase 2 is read once. The outcome script stays separate from the feature code.
- A fresh reviewer and a red team check the code against this PREREG before futility is read, and again before the Phase 2 read.
- No pump.fun requests; python3 -I.
- Time the graph build: live use needs a daily rebuild in under 2 h.
