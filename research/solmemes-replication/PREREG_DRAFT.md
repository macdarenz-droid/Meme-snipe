<!-- Draft from the advisor-six-ideas workflow (2026-10-08), adversarially reviewed and corrected. The builder commits the final PREREG.md before any data pull. -->

# SOLMEMES replication: does creation-time text add out-of-time net return? (pre-registration, 2026-10-08; corrected after adversarial review)

Idea 6 from the outside reviewer, in the reviewer family (k = 10). Committed now, before the shared tape exists, so neither the model nor the thresholds can be fitted to data already seen.

## Looked at before writing
- **The paper:** Carneiro Alves de Lima, Cabral Pinheiro, 'SOLMEMES: Do SPL Token Descriptions and Symbols Have Predictive Power?', Proc. AICCC 2025, ACM, pp. 320-328, DOI 10.1145/3789982.3790023 (Crossref; issued 2025-12-20, online 2026-05-04).
  - The full text is closed (ACM returned 403).
  - Abstract (Semantic Scholar): about 9k graduates, the first 15 minutes, minute averages, transformer embeddings, 'modest' predictive power, and positive out-of-time returns for a naive strategy.
  - The 6-day out-of-time window, the execution method and the variant results come from the reviewer and are UNVERIFIED.
- **Hugging Face rucyfer/solmemes (Apache-2.0):** each row's name, symbol and description belong to a different coin than the row's mint. 0 of 30 matched GeckoTerminal, and 2 IPFS checks confirmed the mismatch. Unusable.
- **Code:** github.com/brurucy/solmemes returns 404.
- No graduate text, flow or price in any test window was looked at.

## Question
On out-of-time graduates, does a model that adds creation-time text and copy saturation to a time and market baseline pick trades with a higher mean net SOL return than the baseline? Trades use our delay, our costs and a $50 size.

## Data
- **Shared tape:** C (name, symbol, uri, creator), G (migrations) and S (curve and canonical swaps).
- **Descriptions:** read from the uri JSON only when the uri contains an IPFS CID, whose content is fixed at creation.
  - Fetched through public gateways at no more than 50% of each gateway's documented limit, or 1 request a second where none is documented.
  - Retry-After is honoured; a gateway is dropped after 3 consecutive failures; every failure is logged.
  - Never from a pump.fun host.
  - Any other uri is 'mutable' and gives no description.

## Universe and windows
- **Eligible graduate:** a canonical migration (from G) that meets both conditions:
  - its token was created at least 48 h after the start of its tape block, so copy saturation and every curve-phase feature are complete;
  - its exit (migration + 15 min; + 60 min for the secondary) falls inside the tape.
- **Train:** graduations 2026-09-04 to 09-11 of tokens created from 09-04 00:00Z. Days 09-02 and 09-03 are lookback.
- **Futility split:** fit on 09-04 to 09-08, check on 09-09 to 09-11.
- **Test:** Phase 2 graduations 10-24 to 11-04 of tokens created from 10-24 00:00Z, with outcomes through the 11-05 tail. Read once.
- **Fallback block:** if Phase 2 uses the pre-wall block (08-19 to 09-01), the test runs earlier than the training data. It can then only KILL or stay UNRESOLVED, never PASS.
- **Later start:** if Phase 1 starts later, the same rules shift: the first 2 days are lookback and the last 3 days the check.

## Decision, execution and costs
- **Decision:** at the migration slot. Every feature must be known then.
- **Entry:** buy $50 at the first canonical-pool swap after migration + d, priced at that swap's pre-trade reserves at our size. d = 10 s, with sensitivity runs at 2 s and 60 s.
- **Exit:** sell at the first swap after migration + 15 min. If no swap comes, sell at the pool's reserves at that moment.
- **Costs:** the conservative scenario, in SOL. $50 = 419,252,054 lamports at SOL $119.26 (packages/backtest/src/research/edge-costs.ts).
  - Fees come from each event's own fields and the fee-config tiers.
  - 414,009 lamports of expected fixed cost per round trip, rent loss and failed exits included.
  - Adverse move as in edge.md §1.
- **Sizes:** $50 is the primary. The primary report also gives $5, $20, $100, $1,000 and $10,000, with gross return, fixed costs, percentage fees and impact from real reserves shown separately (owner, 2026-10-07).

## Features
- **(a) baseline:**
  - hour of day and weekday;
  - minutes from creation to migration;
  - curve-phase successful trade count, curve SOL volume and distinct curve buyers;
  - all graduations in the previous hour.
- **(b) = (a) + text:**
  - embeddings of 'name | symbol' and of the description;
  - the encoder is a frozen pre-trained sentence encoder released before 2026-09-02 (candidate: all-MiniLM-L6-v2; the builder verifies its release date);
  - each embedding is reduced to 32 dimensions by PCA fitted on train creates only.
- **(c) = (b) + copy saturation at creation time s:**
  - exact: creates in [s − 48 h, s) with the same normalised ticker;
  - semantic: creates in [s − 48 h, s) whose name|symbol cosine similarity is at least τ;
  - τ = the 99.9th percentile of cosine similarity over 100,000 random pairs of 09-02 creates, computed without any outcome.
- **Model:**
  - ridge regression of net SOL return on the standardised features;
  - α chosen from {0.1, 1, 10, 100, 1000} by forward-chaining over train days;
  - one model per feature set and no other models.
- **Selection:** model m selects a graduate when its prediction is at or above the 90th percentile of m's forward-chained out-of-fold predictions on train (not in-sample fits). The threshold is fixed; it is never a same-day ranking.
- **Description coverage rule (counts only, before any outcome):**
  - If at least 90% of train graduates have a fetched description, a missing one is embedded as the empty string.
  - Otherwise descriptions are dropped, and text means name|symbol only.
  - Availability is never a feature or a filter.

## Futility (Phase 1)
- Fit on 09-04 to 09-08 and score 09-09 to 09-11. If Δ ≤ 0, stop; Phase 2 is not used for this idea. Phase 1 never gives a PASS.
- Then refit on 09-04 to 09-11, and commit the hashes of the weights, the PCA and the thresholds before Phase 2 is pulled.

## Primary test (Phase 2)
- **Statistic:** Δ = mean net SOL return per trade selected by (c), minus the mean per trade selected by (a).
- **Interval:** studentized day-block bootstrap over test days, resampling both arms by day (dayBlockMeanDiffInterval conventions). Set at the family level: 99.5% two-sided (Bonferroni over the reviewer family, k = 10). The 95% CI is also reported.
- **PASS:** that CI lies above 0, with N ≥ 10 test days and at least 300 trades selected by (c).
- **KILL:** Δ ≤ 0, meaning text adds no out-of-time net return.
- **UNRESOLVED:** anything else, including Phase 2 never being pulled. This counts as not supported for the bot.
- **Strategy rule:** after a PASS, (c)'s own 99.5% CI of mean net return must also lie above 0 before any strategy registration. Otherwise the conclusion is 'text adds information but does not pay the toll'.

## Secondary (descriptive)
- (b) − (a) and (c) − (b).
- Exit at +60 min.
- Name|symbol only.
- The delay sensitivity runs.
- Graduates whose uri is mutable.

## Look-ahead guards
- **Copy saturation:** counts only creates strictly before s.
- **Text:** taken only from the CreateEvent and CID content.
- **Encoder:** its training cutoff comes before the window.
- **Fitting:** the PCA, the standardisation, α and the thresholds are fitted on train only.
- **Order:** cross-validation is chronological, and the test set is read once.
- **Universe:** built from on-chain migrations, never from listings of surviving coins.
- **Regimes:** B4 and B5 fall between train and test. Fees come from each event's own fields.
- **Leak test:** a planted create one second after s must not change the copy-saturation counts.

## Budget
- 0 Helius credits beyond the tape. DAS getAsset (10 credits) is used only for CID uris that every gateway failed, capped at 50k credits.
- IPFS fetching: about 3-6 h per 10k graduates at 1 request a second.
- Builder: about 2-3 days. The encoder and numpy go in a scratch venv, with the supervisor's OK for the dependency.

## Executor notes

Now: commit research/text-probe/PREREG.md before Step A, so the Phase 1 creates and graduates cannot shape the design.

Later:
- The build starts only if Step C was read for ideas 4 or 5 and Phase 2 is approved for them. Idea 6 alone justifies neither.
- One builder: Opus 5.5, or Sonnet 5.5 at medium effort for the mechanical parts. Branch claude/text-probe.

Steps:
1. Get the supervisor's OK for the encoder dependency.
2. Fetch CID descriptions under the gateway rule, logging every failure.
3. Record the coverage count before any outcome is computed.
4. Run futility on Phase 1.
5. Freeze and commit the hashes.
6. Read Phase 2 once.

Checks: a fresh reviewer and a red team check the code before futility and again before the Phase 2 read.

Rules: no GeckoTerminal calls; no pump.fun requests; python3 -I.
