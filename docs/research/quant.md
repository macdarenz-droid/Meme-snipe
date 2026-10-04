# Quant methodology for accuracy: labels, validation, calibration, sample size and promotion gates

Research date: 2026-10-03. Scope: how Meme-snipe should label outcomes, validate strategies and models, calibrate probabilities, decide when it is allowed to abstain, size an evaluation sample, simulate fills realistically, and promote a strategy from paper to a $2 live canary. Bankroll: $20, $2 default / $5 maximum per trade, one open position, paper first.

Conventions used here:
- Every claim links to its source. Source dates are shown where visible; otherwise the access date (2026-10-03) applies.
- **Preprint** means an arXiv paper that has not been peer reviewed. Most 2025–2026 memecoin literature is preprint-only. Several of the strongest results come from one independent author with published corrigenda, and I mark that.
- **Simulation** means my own seeded Monte Carlo (script `research/supervisor/quantwork/samplesize.py`, output `research/supervisor/quantwork/samplesize_out.txt`). It is a model, not market data.
- **In-house data** means the sibling empirical study in `research/empirical/results/backfill_results.json`: 167 pump.fun graduates over a 6.5-hour window on 2026-10-02, with one-minute candles. The sample is small and covers one window.
- **Unverified** means I could not confirm the fact from a primary source.

---

## 0. Summary for the builder

1. **The real target is net expectancy per trade, and the evidence bar is high.** A disciplined bracket (take profit +30%, stop −15%) with realistic 4% rug/blocked-exit and 8% gap-through-stop rates **needs a 48.7% take-profit hit rate just to break even after about 3% round-trip costs** (simulation, §5.1). Win rate is therefore meaningless unless it is shown alongside the payoff and the tail.
2. **Published memecoin predictors decay quickly.** A pre-registered pump.fun graduation model scored **AUROC 0.859 on its 15-day development cohort and 0.464 on the next 14 days**, with calibration slope 0.013 ([Kamat, arXiv 2607.02823 v4, 2026-09-10](https://arxiv.org/abs/2607.02823)). A rug model trained on one venue scored **MCC ≈ 0 or negative on another** ([Li et al., arXiv 2608.20271, 2026](https://arxiv.org/html/2608.20271v1)). Expect a regime life measured in **weeks**, and expect a break at every platform change. Design for retraining and demotion, not for a model that is fitted once.
3. **The useful signals in the literature describe flow quality, not hype.**
   - Fast accumulation of SOL in few trades ([Marino et al., arXiv 2602.14860](https://arxiv.org/html/2602.14860)).
   - Share of non-bot (UI) trades (same source).
   - Bundle/cluster-adjusted concentration: coordinated accounts hold **36.5% of supply** on average ([MELT, arXiv 2602.13480](https://arxiv.org/abs/2602.13480)).
   - Market activity in the first five minutes, which predicts a rug within one hour with **F1 0.79 and AUPRC 0.80** ([Li et al.](https://arxiv.org/html/2608.20271v1)).
   - A Telegram link: **hazard ratio 5.40** for graduation (Kamat v3), but with a documented measurement bias.

   Raw buyer counts are contaminated. Sniper cohorts lift first-30-minute buyer counts by **+16.1%** without a significant change in SOL inflow ([Kamat, arXiv 2607.02795](https://arxiv.org/abs/2607.02795)), and **17% of all pump.fun trades are wash trades** ([Szwajcok et al., arXiv 2609.10246](https://arxiv.org/html/2609.10246)).
4. **Label with an execution-aware triple barrier, then meta-label.** The rules baseline proposes; a calibrated secondary model decides whether to take the trade, which is meta-labelling ([López de Prado, *Advances in Financial Machine Learning*, Wiley 2018, ch. 3](https://oreilly.com/library/view/advances-in-financial/9781119482086)). Barriers must be evaluated on **executable liquidation value replayed slot by slot from on-chain swap events**, not on candles. In the in-house data, filling take-profits at the candle wick instead of the close moved the mean net return of one rule from **−20.5% to +0.5% per trade**.
5. **Validation should use purged, embargoed, creator-grouped walk-forward with one untouched later holdout.** Count every configuration tried, then deflate the best result. With 72 rule variants and 100 trades each, the best variant's per-trade Sharpe is expected to reach **0.24 by pure chance** (simulation of [Bailey & López de Prado 2014](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf), Eq. 1). In the in-house 6.5-hour sample, **all 72 rule variants had negative mean net return**.
6. **Calibrate before showing a probability, and abstain by rule.** Use Platt or Venn–Abers below about 1,000 labelled samples and isotonic above that ([scikit-learn 1.9.1 docs](https://scikit-learn.org/stable/modules/calibration.html)). Draw CORP reliability diagrams ([Dimitriadis et al., PNAS 2021](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7923594/)). Set the abstention threshold with conformal risk control ([Angelopoulos et al., ICLR 2024](https://arxiv.org/abs/2208.02814v4)) and adapt it under drift with ACI ([Gibbs & Candès, NeurIPS 2021](https://arxiv.org/abs/2106.00170)).
7. **Sample size is the binding constraint.** Per-trade net returns have a standard deviation of about 0.32 for a bracket strategy (simulation) and 0.20–0.69 for in-house rules. To detect a true **+5% edge** (80% power, one-sided α = 0.05) takes **about 258 trades**. A +10% edge takes about 63, and a +2% edge about 1,600. **At three live entries a day, 258 trades is 86 days.** Promotion evidence therefore has to come from **shadow trades on every eligible candidate**, scored by an anytime-valid **betting test** (median stop 282 trades, p90 802, at +5%; false-positive rate 3.6% at zero edge). The $20 canary checks mechanics only.
8. **Runner strategies with an untruncated right tail cannot be validated at this scale.** With a Pareto tail (α = 1.8), nominal 95% t- and bootstrap intervals covered the true mean only **80–84% of the time at n = 100–300**. Use partial take-profits or capped (winsorised) evaluation, and report medians and tail quantiles alongside the mean.
9. **Promotion gates are listed numerically in §8.** In short: research holdout → shadow → $2 canary → (owner decision) up to $5. Demotion is automatic on decay, calibration drift or any platform change.

---

## 1. Labelling

### 1.1 Triple-barrier method (what it is)

The method comes from [López de Prado, AFML (Wiley 2018)](https://oreilly.com/library/view/advances-in-financial/9781119482086), ch. 3.4. Each candidate event at decision time t0 gets three barriers:
- an **upper** (profit) barrier;
- a **lower** (loss) barrier;
- a **vertical** (time) barrier at t0 + H.

The label is whichever barrier is touched first, so the label depends on the price path, not just the end point. Chapter 4 of the same book adds sample weights for **overlapping label windows**: events whose windows overlap are not independent and should be down-weighted by "uniqueness".

### 1.2 Adapting it to Solana memecoins

Five changes make the method fit this market.

**1. Use executable value, not price.** A barrier is touched when the **net SOL that the bot's own position size would receive from a sell** crosses the threshold, not when the last-trade price does.
- On the pump.fun curve this is exact. The official SDK computes sell proceeds as `floor(a·S/(T+a)) − ceil(fee)`, with `S` and `T` the virtual quote and token reserves and fee basis points read from the fee program's market-cap tiers ([`@pump-fun/pump-sdk` 2.0.0, `bondingCurve.ts`/`fees.ts`, npm, modified 2026-09-13](https://registry.npmjs.org/@pump-fun/pump-sdk/-/pump-sdk-2.0.0.tgz)).
- The brief already asks for this ("Trigger protection from executable liquidation value"). The labels must use the same definition, or the model learns a different target from the one the bot trades.

**2. Replay slot by slot from swap events.** pump.fun `TradeEvent` and PumpSwap `BuyEvent`/`SellEvent` carry the post-trade reserves (sibling [venues.md](./venues.md) §2.5 and §3, citing [pump-public-docs](https://github.com/pump-fun/pump-public-docs)), so pool state can be rebuilt exactly at every slot. Candles cannot tell which barrier came first inside a bar.
- In-house: 19 of 187 "standard" tokens had internally inconsistent one-minute candles.
- For the entry "migration + 1 min" with a −30%/+50%/60-minute exit, the mean net return was **−20.5% when a take-profit counted only on a bar close** and **+0.5% when the wick counted** (`backfill_results.json`, `rule_grid[0]`). The modelling choice can therefore create a profitable-looking strategy out of a losing one.

**3. Add latency to both sides.** Entry fills at the pool state of slot `s0 + Δ_entry`, and exits at `s_touch + Δ_exit`.
- Draw Δ from the measured latency distribution, not a constant: discovery lag for Jupiter `/recent` was p50 4.9 s (sibling [data.md](./data.md) §0), and Solana slots are configured to last about 400 ms ([Solana confirmation guide](https://solana.com/developers/guides/advanced/confirmation)).
- A stop fills at the post-latency state. This produces **gap-through** losses, which the bot cannot avoid.

**4. Model failed and blocked exits.** Each exit attempt fails with probability p_fail, taken from the bot's own logs; until those exist, use the sibling sample of **34% failed transactions on PumpSwap and 51% on the pump curve**, mostly third-party bots ([execution.md](./execution.md) §4). A failed attempt still pays the base and priority fee, about $0.003 per attempt (same source).
- If the pool is drained or the transfer is blocked, the label is `blocked`, and the value is the liquidation value at the end of the escalation ladder, or 0.

**5. Express the barriers net of costs.** Use the round-trip fee for the venue's market-cap tier. That is 1.25% per side on the curve and on small PumpSwap pools ([pump.fun fees page, updated 2026-05-20, via venues.md](https://pump.fun/docs/fees)), plus Jupiter's 0.5% per side on young tokens if that path is used (brief), plus priority fees and rent.
- Sibling break-even estimate: about **+3.0% gross** on the curve ([execution.md](./execution.md) §8).

**Label set per candidate and per barrier configuration `cfg_id`:**

| Field | Definition |
|---|---|
| `y_tb` | +1 upper first, −1 lower first, 0 vertical |
| `r_net` | Realised net return incl. all fees, failed-attempt costs and rent not recovered, as a fraction of notional |
| `t_touch_slot`, `t_exit_slot` | First touch and simulated fill slot |
| `mfe`, `mae` | Maximum favourable and adverse excursion of executable value before exit |
| `blocked` | Exit impossible within the escalation ladder |
| `n_exit_attempts`, `entry_filled` | Execution realism |
| `y_meta` | 1 if `r_net > 0` (or above a cost buffer such as +1%) |
| `y_severe` | 1 if `r_net ≤ −0.5` or `blocked` |

Store several barrier configurations, for example (+30%/−15%/15 min), (+50%/−25%/60 min) and (+100%/−30%/240 min). **Every configuration counts as a trial** for the deflation in §2.4.

### 1.3 Meta-labelling (how intelligence should be added)

Meta-labelling ([AFML ch. 3.6](https://oreilly.com/library/view/advances-in-financial/9781119482086)) separates two jobs:
- A **primary** model decides the side and candidate set. Here that is the interpretable rule baseline the brief already asks for.
- A **secondary** classifier estimates P(primary trade is profitable) and decides whether to act, and later how much (within $2–$5).

This fits the brief because it keeps the rules interpretable and turns the model into a **filter**: it can only remove trades, never invent new ones. It also lets precision rise by lowering coverage, which is the "sniper" behaviour the owner wants.

- **Calibration and position sizing with meta-labels:** a published Journal of Financial Data Science series by Joubert and co-authors exists (seen in search results), but the exact titles and issues are **unverified**.
- Practical rule: the secondary model is trained **only on candidates the primary rules accepted**. Rejected candidates are still logged and labelled, so the primary rules can be audited for what they miss.

### 1.4 Survivorship and look-ahead bias in token datasets

- **Survivorship.** In a 3,904-coin sample (2014–2021), ignoring dead and delisted coins biased equal-weighted portfolio returns by **62.19% a year** (0.93% value-weighted), and overstated the size premium by about 50% ([Ammann, Burdorf, Liebi, Stöckl, "Survivorship and Delisting Bias in Cryptocurrency Markets", 2022](https://alexandria.unisg.ch/handle/20.500.14171/108037)). Memecoin attrition is far worse:
  - 76% of new H1-2025 Solana DEX tokens were labelled rug pulls, with a median life of about 35 minutes ([Chen et al., arXiv 2603.24625](https://arxiv.org/abs/2603.24625));
  - 84.1% of migrated pump.fun tokens fell into MELT's "high-risk" class ([arXiv 2602.13480](https://arxiv.org/html/2602.13480)).

  **Rule: the universe is every token observed at decision time** (creations and/or migrations from the discovery feeds), stored when observed, including tokens that later vanish.
- **Selection by aggregator listing.** DexScreener and GeckoTerminal list a pool only once it trades. Backfilling from them keeps only tokens that traded after the moment the bot would have decided. MELT itself is restricted to tokens that migrated ([MELT limitations](https://arxiv.org/html/2602.13480)), and Szwajcok et al. drop coins with more than 5M transactions ([arXiv 2609.10246](https://arxiv.org/html/2609.10246)). **Label from the bot's own on-chain discovery log, not from an aggregator's list.**
- **Look-ahead in features.** Holder lists, "top holders %" and security scores fetched **later** describe the future.
  - Every feature row must carry `as_of_slot` and `receipt_ts`, and only events with `slot ≤ as_of_slot` and `receipt_ts ≤ decision_ts` are allowed.
  - Kamat's graduation labels turned out to be an artefact of the collector's roughly 6-minute coverage window, not a platform outcome ([arXiv 2607.02823 v3 corrigendum v1.3](https://arxiv.org/html/2607.02823v3)). **Labels need a coverage audit too.**
- **Detector disagreement.** Two separately configured pump.fun pipelines from the same research programme overlapped on only **0.29–0.80%** of flagged mints ([Kamat, arXiv 2609.18975 v2, 2026-09-23](https://arxiv.org/abs/2609.18975)). Treat wallet-cluster features as noisy, and version the detector so that a detector change counts as a new feature set.

---

## 2. Validation

### 2.1 Purging, embargo and grouping

From [AFML ch. 7.4](https://oreilly.com/library/view/advances-in-financial/9781119482086):
- **Purging** removes from the training set any observation whose label window `[t0, t_exit]` overlaps a test observation's window.
- **Embargo** also drops training observations immediately **after** each test block, because serially correlated features leak backwards.

For this bot, three extra rules apply:
- **Embargo of at least H** (the longest vertical barrier), plus a regime buffer. Two hours is a reasonable starting point for H ≤ 60 min.
- **Group purging by creator cluster and funder cluster.** One "factory" produces many coins: the top 1% of creator clusters account for **58.57% of coins** ([Szwajcok et al.](https://arxiv.org/html/2609.10246)). A token from the same cluster in both train and test leaks identity. Assign clusters with the version of the clustering available at decision time.
- **Block by calendar day for uncertainty.** Candidates on the same day share SOL price, launchpad flow and the bot set. Use day-block bootstrap or cluster-robust errors, as Kamat does ([2607.02823 v4](https://arxiv.org/abs/2607.02823)).

### 2.2 Walk-forward with an untouched holdout

The protocol:
1. Order by decision time.
2. Run a rolling-origin walk-forward: train on the trailing W days, purge and embargo, then test on the next day. Repeat.
3. Reserve the **final ≥ 7 days (or ≥ 20%) as a holdout**, evaluated **once**, after all choices are frozen and written down (pre-registration).

Why this matters: the only memecoin paper I found with a true pre-registered temporal holdout saw discrimination collapse from 0.859 to 0.464 ([Kamat v4](https://arxiv.org/abs/2607.02823)). Li et al. used a temporal rolling window ("historical training, future verification", 3-month training windows), and their pump-only numbers are much lower than the 0.99 accuracies reported by older random-split scam detectors ([Mazorra et al., Mathematics 10(6):949, 2022](https://arxiv.org/abs/2201.07220v1)). **Do not compare a random-split metric with a temporal one.**

### 2.3 Combinatorial purged CV (CPCV) and probability of backtest overfitting (PBO)

**CPCV** ([AFML ch. 12](https://oreilly.com/library/view/advances-in-financial/9781119482086)):
- Split the timeline into N groups and test on every combination of k groups (purged and embargoed).
- This gives C(N,k) splits and C(N−1,k−1) full backtest paths, so the result is a **distribution** of out-of-sample performance rather than one path.
- Use it for the research phase. It does not replace the final untouched holdout.

**PBO via CSCV** ([Bailey, Borwein, López de Prado, Zhu, "The Probability of Backtest Overfitting", rev. Feb 2015](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)):
- Partition the trials-by-time performance matrix into S blocks and form all C(S, S/2) in-sample/out-of-sample splits.
- PBO is the share of splits in which the in-sample best configuration ranks **below the median** out of sample, measured with logits λ = ln(ω/(1−ω)).
- The paper discusses choosing S, for example S = 16 gives 12,870 combinations.
- Use S = 8–16 day-blocks.

### 2.4 Multiple testing and the deflated Sharpe ratio

**Probabilistic Sharpe ratio** ([Bailey & López de Prado 2012/2014](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)):
`PSR(SR*) = Φ( (SR̂ − SR*)·√(T−1) / √(1 − γ̂₃·SR̂ + (γ̂₄−1)/4·SR̂²) )`
Here γ̂₃ is skewness and γ̂₄ is kurtosis of per-trade returns.

**Deflated Sharpe ratio** ([Bailey & López de Prado, *J. Portfolio Management* 40(5):94–107, 2014](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)) is the PSR with
`SR* = √V[SR̂ₙ] · ((1−γ)·Φ⁻¹(1−1/N) + γ·Φ⁻¹(1−1/(N·e)))`,
where γ ≈ 0.5772 (Euler–Mascheroni), N is the number of independent trials and V is the variance of the trials' Sharpe ratios. The paper's appendix explains how to estimate the implied number of independent trials when trials are correlated.

**What this means here** (simulation, per-trade Sharpe, true SR = 0, V[SR̂] ≈ 1/n):

| Trades per trial | 10 trials | 72 trials | 500 trials |
|---|---|---|---|
| 100 | 0.157 | **0.241** | 0.305 |
| 300 | 0.091 | 0.139 | 0.176 |
| 1,000 | 0.050 | 0.076 | 0.097 |

A per-trade Sharpe of 0.24 corresponds, for example, to a mean of +7.7% with a standard deviation of 0.32. **After 72 configurations on 100 trades each, a best result that good is the expected outcome of pure noise.**

Corroborating literature on multiple testing:
- Of 316 published equity factors, Harvey, Liu and Zhu argue a new factor needs **t > 3.0**, not 2.0 ([*Review of Financial Studies* 29(1), 2016](https://papers.ssrn.com/abstract=2513152)).
- Across 888 Quantopian algorithms, backtest Sharpe explained **R² < 0.025** of out-of-sample Sharpe, and the gap widened the more backtests a user ran ([Wiecki et al. 2016, SSRN 2745220, via Quantpedia](https://quantpedia.com/?p=673)).
- Published equity anomalies earned **26% less out of sample and 58% less after publication** ([McLean & Pontiff, *J. Finance* 2016](https://counterpointfunds.com/wp-content/uploads/2017/07/PredictabilityMcleanPontiff.pdf)).

**Operational rule: keep an experiment registry.** Every rule variant, barrier configuration, feature set and hyperparameter setting evaluated on any data counts toward N, and the DSR is computed from that registry automatically.

---

## 3. Calibration and abstention

### 3.1 Choosing a calibrator

[scikit-learn 1.9.1](https://scikit-learn.org/stable/modules/calibration.html) gives the guidance:
- Isotonic calibration "will perform as well as or better than sigmoid when there is enough data (greater than ~1000 samples)" but "is more prone to overfitting, especially on small datasets".
- Sigmoid (Platt) is "most effective for small sample sizes".

**Below about 1,000 labelled samples, use Platt.** A further option is Venn–Abers, an isotonic-based method with a calibration guarantee under exchangeability that returns a probability interval whose width signals uncertainty ([Vovk & Petej, UAI 2014, arXiv 1211.0025](https://arxiv.org/abs/1211.0025)).

Calibrate on a time-ordered fold that comes after the training data, never on the training data.

### 3.2 Scoring

- **Scores:** Brier score and log loss are strictly proper. A lower Brier score can still mean *worse* calibration combined with better discrimination ([sklearn docs, Murphy decomposition](https://scikit-learn.org/stable/modules/calibration.html)). **Report the decomposition (reliability, resolution, uncertainty)** and the **Brier skill score against base-rate climatology**, the share of positives in the trailing window.
- **Reliability diagrams:** use the CORP method, which bins with the pool-adjacent-violators algorithm. It gives reproducible, consistent diagrams and a miscalibration measure without ad hoc bins ([Dimitriadis, Gneiting, Jordan, PNAS 118(8), 2021](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7923594/)).
- **Calibration slope and intercept:** fit a logistic regression of the outcome on logit(p). A slope well below 1 means overconfidence; Kamat's failed holdout had slope 0.013 ([2607.02823 v4](https://arxiv.org/abs/2607.02823)). **Gate on slope ∈ [0.8, 1.25].**
- **Ranking metrics for rare outcomes:** use AUPRC, and always print the class prevalence next to it. Graduation prevalence ranges from 0.2% to 1% depending on study and window ([Kamat v3: 0.198%](https://arxiv.org/html/2607.02823v3); [Marino et al.: 0.63% for Sept 2025](https://arxiv.org/html/2602.14860); [Szwajcok et al.: 1.02% all-time](https://arxiv.org/html/2609.10246)). AUROC flatters a model on rare outcomes. The decision metric is still **net expectancy at the chosen operating point**.

### 3.3 Abstention: when to say "no trade"

- **Selective classification:** trade only when confidence passes a threshold chosen so that the risk among accepted cases stays below a target with high probability ([Geifman & El-Yaniv, NeurIPS 2017](https://arxiv.org/abs/1705.08500)).
- **Conformal risk control** sets that threshold so that the expected value of a monotone loss among accepted trades is at most α, with a finite-sample guarantee under exchangeability ([Angelopoulos, Bates, Fisch, Lei, Schuster, ICLR 2024](https://arxiv.org/abs/2208.02814v4)); background in [Angelopoulos & Bates, *Foundations and Trends in ML* 2023](https://arxiv.org/abs/2107.07511v6). Use loss = `y_severe` (loss ≤ −50% or blocked) with a target such as α = 10%, on a calibration set from the latest window.
- **Drift breaks exchangeability.** Adaptive conformal inference updates the miscoverage level online, α_{t+1} = α_t + η(α − err_t), and achieves long-run coverage "irrespective of the true data generating process" ([Gibbs & Candès, NeurIPS 2021](https://arxiv.org/abs/2106.00170)).
- **Out-of-distribution guard:** abstain when any feature falls outside the 1st–99th percentile range of the calibration window, or when the venue or quote asset has not been seen in training. Sibling reports list 2026 structural changes (USDC-quoted coins, Token-2022, mayhem mode, BOOST, negative virtual reserves) in [venues.md](./venues.md) §2.6.

**What the UI should show** (this tightens the brief's rule): "P(net > 0 within 60 min) = 0.41 · calibrated 2026-10-01 on n = 1,240 · slope 0.94".

---

## 4. Literature on predicting memecoin and pump.fun outcomes (2023–2026)

All items are preprints unless marked otherwise.

| Citation | Data | Target and validation | Reported performance | Predictive features | Caveats |
|---|---|---|---|---|---|
| Marino, Naviglio, Tarantelli, Lillo, "Predicting the success of new crypto-tokens: the Pump.fun case", [arXiv 2602.14860](https://arxiv.org/abs/2602.14860) (2026-02-16) | 655,770 pump.fun tokens, 2025-09-01 to 10-01; 4,338 graduated (**0.63%**); 2.6M traders | P(graduation \| SOL in curve) estimated non-parametrically; top traders and creators identified out of sample on the first two weeks | No AUC; probability curves vs a break-even boundary P = (vSol/115)² | **Fewer trades to reach a given SOL level** is the strongest predictor; ≥70% non-bot trades raises P; top-trader presence gives a modest uplift, mostly below break-even; 92.22% of tokens with ≥30 swaps show dump events | Ignores fees in the break-even; right-censoring not modelled ([html](https://arxiv.org/html/2602.14860)) |
| Hu, Tekin, Xu, Liu, "MELT/MemeTrans", [arXiv 2602.13480](https://arxiv.org/abs/2602.13480) (v1 2026-02-13, v2 2026-05-21) | 41k+ migrated launches, 2024-12-01 to 2025-03-01; 200M+ transactions; 122 features | High / medium / low risk from minimum price ratio within 20 min of migration; **chronological 7:3 split**; features pre-migration only | Best (MLP) AUPRC 0.5729, macro-F1 0.6981; top-100 selection loss **60.71% → 26.64%** (−56.1% relative) | Market-activity and **bundle statistics** groups ranked highest; coordinated accounts hold **36.5%** of supply; 21.4% of pre-migration transactions are wash trades | Migrated tokens only; one 3-month window around the $TRUMP launch ([html](https://arxiv.org/html/2602.13480)) |
| Li, Kuznetsov, Yanovich, Nott-Whaley, Vodolazov, "Catching the Rug", [arXiv 2608.20271](https://arxiv.org/html/2608.20271v1) (2026) | 6.3M pump.fun + 98k Raydium tokens, 2024-11-30 to 2025-06-30 | Rug within 1 h (TVL −99% or idle >80% of life) from the **first 5 min**; **temporal rolling-window CV** | Fusion XGBoost F1 0.7885, MCC 0.3947, AUPRC 0.8011; RF similar; cross-platform MCC ≈ 0 or negative | 23 features: transaction counts, buy/sell ratios, volatility, liquidity | Authors say "not yet sufficient for real-world deployment"; the label is very broad |
| Kamat, "Auditing Collector-Generated Graduation Labels on Pump.fun: Measurement Error and Temporal Non-Generalization", [arXiv 2607.02823 v4](https://arxiv.org/abs/2607.02823) (2026-09-10); earlier v3 "Graduation Regime Windows" ([html v3](https://arxiv.org/html/2607.02823v3)) | 749,816 mints, 2026-05-12 to 06-10 (v4); v3: 832,941 mints, 0.198% graduated | Pre-registered logistic model; 15-day development, 14-day validation; day-cluster bootstrap | **AUROC 0.8594 → 0.4642** (95% CI [0.411, 0.520]); calibration slope 0.013, intercept +2.816; 2 of 9 checks passed. v3 Cox C-index 0.858; Telegram HR 5.40 [4.73, 6.17] | Telegram presence (v3) | Single independent author; labels shown to be collector artefacts (~6-min coverage); market-cap correction retracted |
| Kamat, "Coordinated Sniper Cohorts on Pump.fun", [arXiv 2607.02795](https://arxiv.org/abs/2607.02795) (v3 2026-08-03) | 166,098 launches, 1.58M buyer observations, 2026-06-11 to 25 | Propensity-matched (5,419 pairs) | Buyer-count lift **+16.1%** [13.0, 19.4]; SOL lift +6.3% [−0.5, +15.1] (not significant); 7.0% of treated launches had zero non-cohort buyers in 30 min | 1,012 persistent rings, median first-buyer rank ≤3.55 | Single author; detector coverage disputed by the same author ([2609.18975](https://arxiv.org/abs/2609.18975)) |
| Szwajcok, Tsuchiya, Liu, Soska, Payer, Christin, "Meme Coin Factories", [arXiv 2609.10246](https://arxiv.org/html/2609.10246) (2026-09-09) | 15.2M pump.fun coins, 2024-01-14 to 2026-01-14; 1% sample = 152k coins, 50M transactions | Descriptive and heuristic detectors plus a logistic regression | Graduation 1.02% overall; wash-traded coins 2.0% vs 0.90%; copycats 0.86% vs originals 9.20%; doubling wash trades raises graduation odds about 19% | Wash trading **inflates** graduation, so it is a manipulation signal, not demand; 23.5% of coins were created after a social post | Excludes coins with >5M transactions; non-graduated EV set to 0 |
| Chen et al., "From Hype to Collapse", [arXiv 2603.24625](https://arxiv.org/abs/2603.24625) (2026-03-25, rev. 05-31) | 100,063 new tokens on three platforms, H1 2025; 117 verified rugs | Rule detector (SolRugDetector) | 76,469 flagged; audited FPR 0.26% (n = 382) | Freeze authority, liquidity withdrawal, pump-and-dump patterns; syndicates | Detector, not a forecaster |
| Mongardini & Mei, "MemeChain", [arXiv 2601.22185](https://arxiv.org/html/2601.22185v1) (2026-01-28); Mongardini, "A Midsummer Meme's Dream", [arXiv 2507.01963 v2](https://arxiv.org/abs/2507.01963) (2026-01-02) | 34,988 coins on 4 chains, Oct 2024 to Jan 2025 | Descriptive | **82.8% of tokens with >100% return show manipulation** (wash trading, LPI, concentration); top-10 holders hold a median of 87% of high-return tokens; 18.81% used bundle buys | Off-chain artefacts (websites, socials) | Survivorship toward listed tokens |
| Alhaidari, Kalal, Palanisamy, Sural, "SolRPDS", [arXiv 2504.07132](https://www.arxiv.org/pdf/2504.07132), **ACM CODASPY 2025 (peer reviewed)** | 3.69B transactions, 2021–2024; 62,895 suspicious pools; 22,195 rug tokens | Dataset | n/a | Liquidity add/remove and inactivity | Mostly pre-pump.fun era |
| Mancino, "The Memecoin Phenomenon", [arXiv 2512.11850 v3](https://arxiv.org/html/2512.11850v3) (2025-12-18) | Dune, Q4 2024 | Descriptive | Graduation peaked at <2%; up to 71.1% of Solana mints in a day were on pump.fun | — | No prediction |
| Cernera, La Morgia, Mei, Sassi, "Token Spammers, Rug Pulls, and Sniper Bots", **USENIX Security 2023 (peer reviewed)** ([arXiv 2206.08202](https://arxiv.org/html/2206.08202v3)) | ETH/BSC to Mar 2022 | Descriptive | ~60% of tokens live <1 day; 1-day rug pulls made ~$240M on BSC | Sniper-bot detection | Pre-Solana-meme era |
| [Wisdom-of-the-crowd signals, *Electronic Markets* 35:64 (2025), peer reviewed](https://link.springer.com/article/10.1007/s12525-025-00815-6) | 28k+ explicit buy/sell posts (X, Reddit, Stocktwits, Telegram) | Event study | Signals predict short-term moves, more strongly for small caps | Explicit crowd buy calls | Not memecoin-launch specific; authors not checked (**unverified**) |

**Market context (data, not peer reviewed):** CoinGecko (2026-05-07), from Dune realised P&L by wallet, reports profitable pump.fun wallets at **30.1% in June 2025 and 73.3% in April 2026**. Realised P&L only, so it "understates losses" ([CoinGecko](https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback)). Wallets are not people, and bot farms skew counts. This is still evidence that **the population of counterparties and the regime shift within months**.

**What the literature supports as features** (all as of decision time, all cohort- and bundle-adjusted):
1. SOL-per-trade intensity: SOL accumulated divided by the number of swaps to get there ([Marino](https://arxiv.org/html/2602.14860)).
2. Share of non-bot trades by instruction or route origin (same).
3. Holder concentration after clustering by bundle, co-purchase and fund flow ([MELT](https://arxiv.org/html/2602.13480)); naive top-10 share is misleading.
4. Wash-trade share (same-transaction buy+sell, round trips) as a **negative** or manipulation flag ([MELT](https://arxiv.org/html/2602.13480); [Szwajcok](https://arxiv.org/html/2609.10246)).
5. First-5-minute market activity: transactions, buy/sell ratio, volatility, liquidity ([Li et al.](https://arxiv.org/html/2608.20271v1)).
6. Copycat status, since the same name or image as an earlier coin graduates 10× less often ([Szwajcok](https://arxiv.org/html/2609.10246)).
7. Creator-cluster history: number of prior coins and their outcomes (same; Marino's top-creator signal has weak statistical support).
8. Social link presence (Telegram), with an explicit measurement-bias caveat ([Kamat v3](https://arxiv.org/html/2607.02823v3)).

**No paper reports net-of-cost trading profitability for a small, latency-disadvantaged bot.** MELT's "loss reduction" is a relative ranking result on migrated tokens, not a positive expected return.

---

## 5. Sample size, fat tails and sequential promotion

### 5.1 Per-trade distributions (simulation)

Two stylised net-return models, both including about 3% round-trip cost:

**Bracket model.** Take profit +30%, stop −15%, 8% gapped stops uniform on [−60%, −30%], 4% rug or blocked (−100%), 10% time exits.

| True mean | TP hit rate needed | SD | Win rate |
|---|---|---|---|
| 0 | **48.7%** | 0.320 | 52.2% |
| +2% | 53.2% | 0.323 | 56.6% |
| +5% | 59.9% | 0.323 | 63.4% |
| +10% | 71.0% | 0.320 | 74.5% |

**Runner model.** Trailing stop −20%, 4% rugs, 36% winners with a Pareto(α = 1.8) right tail. Standard deviation 0.78–1.50, the variance is effectively infinite, kurtosis exceeds 6,000, and the win rate is 36%.

**In-house check:** the rule-grid per-trade net SD was 0.20–0.69 (n = 162–167; [backfill_results.json](./empirical-data/results/backfill_results.json)), consistent with the bracket model.

### 5.2 Fixed-n requirements

Formula: `n = ((z₀.₉₅ + z₀.₈₀)·σ/μ)²` (one-sided α = 0.05, 80% power).

| Model | True edge μ | n (80% power) | n for a 95% CI of ±μ/2 |
|---|---|---|---|
| Bracket | +2% | 1,614 | 4,011 |
| Bracket | +5% | **258** | 642 |
| Bracket | +10% | 63 | 157 |
| Runner | +5% | 2,498 | 6,210 |
| Runner | +10% | 1,398 | 3,474 |

**Implication:** at the brief's three entry intents a day, 258 trades take 86 days. **The live account cannot be the evidence source.** Shadow evaluation of every eligible candidate is.
- In-house: entries at "migration + 1 min" produced about 600 candidates a day before filters.
- Correlation inflates the required n by the design effect `1 + (m−1)ρ` (m = trades per day, ρ = intra-day correlation). For example, m = 20 and ρ = 0.05 gives 1.95, which roughly doubles n. Estimate ρ from the data.

### 5.3 Do the usual intervals hold with fat tails? (simulation, 2,000 reps, true μ = +5%)

| Model | n | t-interval coverage (nominal 95%) | Percentile-bootstrap coverage |
|---|---|---|---|
| Bracket | 30 | 0.932 | 0.915 |
| Bracket | 100 | 0.942 | 0.935 |
| Bracket | 300 | 0.946 | 0.935 |
| Runner | 30 | 0.887 | 0.866 |
| Runner | 100 | **0.839** | 0.837 |
| Runner | 300 | **0.802** | 0.808 |

Bounded (bracketed) returns behave well; heavy right tails do not. Three consequences:
- (a) Prefer bracketed or partial take-profit exits during validation.
- (b) For runners, evaluate a capped return (for example at +300%) and report the share of P&L coming from the top 1% of trades.
- (c) Never promote on one outlier.

### 5.4 Sequential, anytime-valid promotion

**Wald's SPRT** ([Ann. Math. Stat. 16(2), 1945](https://projecteuclid.org/euclid.aoms/1177731118)) suits a simple-versus-simple test, but trade returns are not a two-point distribution.

**Better: a test-by-betting e-process.** The "wealth" K_t = Π(1 + λ_t·X_t) is a nonnegative supermartingale under H₀: E[X] ≤ 0, and by Ville's inequality P(sup K_t ≥ 1/α) ≤ α. **You can check after every trade without inflating the false-positive rate** ([Waudby-Smith & Ramdas, "Estimating means of bounded random variables by betting", JRSS-B 2024](https://par.nsf.gov/servlets/purl/10379214); [Ramdas, Grünwald, Vovk, Shafer, *Statistical Science* 38(4):576–597, 2023](https://arxiv.org/abs/2210.01948v2)). This requires X ≥ −1, which holds for net returns as a fraction of notional, plus a predictable bet size λ_t ∈ [0, 0.5].

Simulated with a plug-in λ_t = clip(μ̂/(σ̂²+μ̂²), 0, 0.5), α = 0.05, 1,000 reps, a cap at 3,000 trades:

| Model | True μ | Reject H₀ | Median trades to promote | p90 trades |
|---|---|---|---|---|
| Bracket | −5% | 0.000 | — | — |
| Bracket | 0 | **0.036** (≤ α) | — | — |
| Bracket | +2% | 0.672 | 1,383 | 2,658 |
| Bracket | +5% | 1.000 | **282** | 802 |
| Bracket | +10% | 1.000 | **87** | 187 |
| Runner (capped +300%) | +5% | 0.135 | 990 | 2,478 |
| Runner (capped +300%) | +10% | 0.989 | 772 | 1,768 |

The same machinery runs **in reverse as a decay detector**: bet on E[X] < 0, and demote when the wealth reaches 20.

**Bayesian alternative:** a Normal–Inverse-Gamma posterior on the mean of capped returns, or a Dirichlet-process or Bayesian bootstrap. Promote when P(μ > cost buffer) ≥ 0.95. This is easier to explain but not anytime-valid under optional stopping unless the prior is honest. **Use the e-process as the gate and the Bayesian posterior for display.**

### 5.5 Rare-event bounds (blocked exits, failed fills): exact one-sided 95% upper bounds

| Trades | Events | Upper bound |
|---|---|---|
| 30 | 0 | 9.5% |
| 100 | 0 | 2.95% |
| 100 | 1 | 4.66% |
| 300 | 0 | 0.99% |
| 300 | 3 | 2.56% |

(Clopper–Pearson; "rule of three" ≈ 3/n.) **Thirty canary trades with zero blocked exits only shows the blocked-exit rate is below 9.5%.**

---

## 6. Concept drift: how fast rules decay and how to retrain

### 6.1 Evidence of decay

- **Two weeks to collapse.** The pre-registered model went from AUROC 0.859 to 0.464 on the next 14 days ([Kamat v4](https://arxiv.org/abs/2607.02823)). Part of this is label measurement error, which is itself a lesson.
- **Venue transfer fails.** Pump.fun and Raydium models do not transfer (MCC ≈ 0); fused multi-source training generalises best ([Li et al.](https://arxiv.org/html/2608.20271v1)).
- **Base rates move a lot.** Graduation was 0.63% in Sept 2025 ([Marino](https://arxiv.org/html/2602.14860)) and 0.198% in May–June 2026 with a coverage-limited collector ([Kamat v3](https://arxiv.org/html/2607.02823v3)); a vendor reported 1.76% in August 2026 (unverified, via [data.md](./data.md) §6). **Definitions and collectors differ, so even the base rate must be measured by the bot itself.**
- **Counterparty mix changes.** Profitable wallets went from 30.1% (June 2025) to 73.3% (April 2026) ([CoinGecko](https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback)).
- **Mechanics change about monthly.** Platform changes in 2026 alone: USDC-quoted coins (05-21), BOOST buy-and-burn (07-21), holder-reward coins (09-12), signed negative `virtual_quote_reserves` on PumpSwap (from 09-30) ([venues.md](./venues.md) §2.6, citing [pump-public-docs](https://github.com/pump-fun/pump-public-docs)).
- **Published anomalies decay after publication** (equities, 58% post-publication; [McLean & Pontiff 2016](https://counterpointfunds.com/wp-content/uploads/2017/07/PredictabilityMcleanPontiff.pdf)). The memecoin features above are now public.

### 6.2 Retraining and monitoring policy (design choice, based on the above)

| Mechanism | Setting |
|---|---|
| Retrain | Daily rolling-origin refit on the trailing 14 days (try 7/14/28 in research; window length counts as a trial). GBDT on tens of thousands of rows retrains in seconds, so online learning is not needed for cost |
| Recalibrate | Daily on the most recent 2–3 days of out-of-fold predictions; Platt until ≥1,000 labelled rows, isotonic or Venn–Abers after |
| Champion/challenger | The new model runs in shadow and replaces the champion only if its trailing 7-day log loss and net expectancy are better with a paired day-block bootstrap p < 0.1, and it passes the calibration-slope gate |
| Drift detectors | ADWIN (δ = 0.002 default) on per-candidate log loss and on the per-trade net-return stream ([River 0.26.1 ADWIN](https://riverml.xyz/latest/api/drift/ADWIN/); [Bifet & Gavaldà, SDM 2007](https://riverml.xyz/latest/api/drift/ADWIN/)); reverse e-process on returns; ACI miscoverage tracking. See [Gama et al., ACM Computing Surveys 46(4):44, 2014](https://repositorio.inesctec.pt/handle/123456789/5370) |
| Hard regime breaks | Any program upgrade, IDL change, fee-config change, new quote asset or new coin flag automatically makes affected candidates **paper-only** until ≥200 new labelled post-change candidates exist and the model passes the gates on them |
| Online learning | Optional later: logistic regression with SGD/FTRL or River's Hoeffding/ARF trees as a challenger. Not the first build; daily batch refits are simpler to audit and replay |

---

## 7. Backtest realism (replay engine requirements)

1. **Universe and clock.** Replay the discovery log in `receipt_ts` order. The strategy sees only events with `receipt_ts ≤ now` (§1.4).
2. **Pool state at slot granularity.** Rebuild reserves from swap events: pump `TradeEvent` with post-trade virtual and real reserves; PumpSwap `BuyEvent`/`SellEvent` with `virtual_quote_reserves`, which can be negative ([venues.md](./venues.md) §2–3).
3. **Fill math.** Use exact integer math from the official SDK ([pump-sdk 2.0.0](https://registry.npmjs.org/@pump-fun/pump-sdk/-/pump-sdk-2.0.0.tgz)):
   - buy: `in = floor((amount−1)·10000/(10000+fee_bps))`, then `tokens = floor(in·T/(S+in))`, capped at real token reserves;
   - sell: `sol = floor(a·S/(T+a)) − ceil(sol·fee_bps/10000)`;
   - the fee is read from the fee-config tier for the current market cap, and the creator part applies only when a creator is set.

   For generic constant-product pools use `Δy = y·Δx·(1−f)/(x + Δx·(1−f))`, with `f` read from the pool config and any Token-2022 transfer fee deducted separately.
4. **Own impact and queue position.** The bot's trade is inserted **after** all trades in the landing slot. That is conservative: it assumes it was not first in the slot.
5. **Latency.** Draw Δ_entry from the measured end-to-end distribution (discovery, decision, quote, sign, land). Draw Δ_exit from the monitoring path. Run with p50 and p90 as scenarios.
6. **Failures.**
   - Each attempt lands with probability p_land(fee level); the default before own data is 0.66 on PumpSwap and 0.49 on the curve ([execution.md](./execution.md) §4).
   - A failed attempt costs base + priority fee.
   - The retry happens at the next state.
   - The blockhash expires after about 60–90 s ([Solana docs](https://solana.com/developers/guides/advanced/confirmation)).
7. **Blocked exits.** If the sell would return less than the emergency floor, or the token is non-transferable or frozen, record `blocked` and mark value at the last executable quote or 0.
8. **Costs.** Fees on both sides, priority fee and tip, ATA rent (recoverable only on a clean close), and Jupiter's young-token fee if the route uses it.
9. **Scenarios to report.** Base; conservative (slippage ×1.5, latency p90, close-based take-profit, no rent recovery); optimistic (wick take-profit). **Promote only on conservative.** In-house, the conservative scenario was 2.4–3.5 percentage points worse than base on every rule.
10. **Paper vs reality audit.** In shadow mode, also log a real Jupiter `/order` quote at the simulated fill moment, for a sample within the free 1 RPS. Track `paper_fill − quote` to keep the simulator honest.

---

## 8. Evaluation protocol and numeric promotion gates

The order is research → shadow → $2 canary → owner decision on a size increase. Thresholds are design choices derived from §2–5. Tighten them freely; per AGENTS.md, only the owner may loosen them or raise limits.

### Gate 0: data validity (always on)

- Discovery coverage ≥ 95% of migrations seen by an independent second feed, over 24 h.
- Zero features with `source_slot > as_of_slot`, enforced by an automated test that **shifts all events +1 slot and checks that features do not change**.
- Replay of a stored day reproduces the logged decisions bit-for-bit.
- Labels pass a coverage audit: the label window was fully observed. Otherwise the label is `censored`, never `0`.

### Gate 1: research → shadow (historical replay)

- Untouched final holdout of ≥ 7 consecutive days with **≥ 150 simulated trades** (superseded: the project requires n ≥ max(300, n_power) out-of-sample holdout trades and at least 10 trade days in a fixed window to 2026-10-20; `CLAUDE.md`, DECISIONS 2026-10-03 promotion row and the consensus rulings of 2026-10-04).
- Mean net per trade **> 0 at the one-sided 95% lower bound** (day-block bootstrap), **conservative scenario**.
- **DSR ≥ 0.95**, with N taken from the experiment registry (superseded for the project's G1: it gates on the SPA test, owner, 2026-10-04; the DSR is still reported).
- **PBO ≤ 0.25** (CSCV, S = 16 day-blocks).
- Share of P&L from the top 1% of trades ≤ 50%.
- `y_severe` rate ≤ 10%, with its 95% upper bound ≤ 15%.
- Blocked-exit 95% upper bound ≤ 5%.
- If a model is used: calibration slope ∈ [0.8, 1.25], |intercept| ≤ 0.2 (logit), Brier skill score > 0 against climatology, and the CORP reliability diagram archived.

### Gate 2: shadow → $2 live canary (frozen, pre-registered version)

- The betting e-process on capped net returns reaches **wealth ≥ 20 (α = 0.05)**.
- **n ≥ 150** shadow trades, across ≥ 14 calendar days, with no single day > 25% of P&L.
- The shadow mean sits inside the holdout's 90% predictive interval (no decay).
- Median |paper fill − live Jupiter quote| ≤ 0.5 percentage points on the audit sample.
- **Futility stop:** if after 400 trades the 95% upper bound is < +2%, or the reverse e-process reaches 20, reject the strategy version.
- Expected duration with 20 eligible trades a day and a true +5% edge: about 14 days median, 40 days p90 (from §5.4).

### Gate 3: canary mechanics (≥ 30 live trades at $2)

The canary tests mechanics, not profitability.
- 0 double-buys, 0 unreconciled balances, 0 signer policy bypasses.
- Landing failures within budget, for example ≤ 3 of 30 first-attempt failures with every exit eventually landing.
- Blocked exits 0 of 30, which bounds the rate at ≤ 9.5%.
- Paired live-minus-shadow return on the same candidates: median ≥ −1 percentage point; mean 95% CI excludes ≤ −3 percentage points.
- Live P&L is reported but **not** used as proof of edge.

### Gate 4: proposal to the owner for >$2 (owner decides)

- ≥ 100 live trades; live e-process wealth ≥ 10 **and** shadow gates still passing.
- At $5, price impact under 0.5% at decision-time depth.
- No hard regime break in the last 7 days.

### Demotion (automatic, any one)

- Reverse e-process wealth ≥ 20.
- ADWIN alarm on calibration or log loss.
- ACI miscoverage > 2× target over 100 decisions.
- A platform change (Gate 0 regime break).
- Two blocked exits in 30 days.
- The owner's loss limits.

Demotion means paper only. Exits always continue.

---

## 9. Data schema (Postgres, decision-time snapshots and labels)

Keep it minimal and append-only. Names are a proposal. Per AGENTS.md, saved-data shape changes under `packages/core/src/ledger/**` need the owner's approval.

```sql
-- what was known, when
create table observation (
  obs_id        bigserial primary key,
  provider      text not null,            -- 'helius_ws','pumpportal','jup_tokens',...
  mint          text not null,
  pool          text,
  kind          text not null,            -- 'trade','create','migrate','authority','quote','holders',...
  slot          bigint,                   -- chain slot of the underlying event (null if off-chain)
  event_ts      timestamptz,              -- chain block time or provider event time
  receipt_ts    timestamptz not null,     -- when WE received it
  commitment    text,                     -- processed|confirmed|finalized
  payload       jsonb not null,           -- raw, unmodified
  quality_flags text[] not null default '{}'
);

-- one immutable feature row per (candidate, decision moment, feature-set version)
create table feature_snapshot (
  snapshot_id    bigserial primary key,
  mint           text not null,
  pool           text,
  venue          text not null,           -- 'pump_curve','pumpswap',...
  quote_mint     text not null,
  decision_ts    timestamptz not null,
  as_of_slot     bigint not null,         -- max slot allowed in features
  max_receipt_ts timestamptz not null,    -- max receipt_ts actually used (must be <= decision_ts)
  featureset_ver text not null,           -- hash of feature code + detector versions
  creator_cluster text,                   -- cluster id as known at decision_ts
  features       jsonb not null,          -- e.g. sol_per_trade, non_bot_share, clustered_top10, wash_share, ...
  missing        text[] not null default '{}',
  regime_tags    text[] not null default '{}'  -- 'usdc_quote','token2022','mayhem','post_fee_change_2026_09_30'
);

-- decision taken (or not) by a specific strategy/model version
create table decision (
  decision_id   bigserial primary key,
  snapshot_id   bigint not null references feature_snapshot,
  strategy_ver  text not null,
  model_ver     text,
  calib_ver     text,
  p_meta        double precision,         -- calibrated P(net>0 | horizon)
  p_severe      double precision,
  conformal_thr double precision,
  action        text not null,            -- 'enter','reject','abstain'
  reasons       text[] not null,
  mode          text not null             -- 'replay','shadow','paper','live'
);

-- execution-aware triple-barrier labels, one per snapshot x barrier config x scenario
create table label_tb (
  snapshot_id   bigint not null references feature_snapshot,
  cfg_id        text not null,            -- e.g. 'tp30_sl15_h15m'
  scenario      text not null,            -- 'base','conservative','optimistic'
  exec_model_ver text not null,
  entry_filled  boolean not null,
  entry_slot    bigint, exit_slot bigint, touch_slot bigint,
  y_tb          smallint,                 -- +1 / -1 / 0
  r_net         double precision,         -- fraction of notional, all costs
  mfe double precision, mae double precision,
  n_exit_attempts int, blocked boolean not null,
  censored      boolean not null,         -- window not fully observed
  labelled_at   timestamptz not null,
  primary key (snapshot_id, cfg_id, scenario, exec_model_ver)
);

-- every configuration ever evaluated (feeds N for the deflated Sharpe ratio and the PBO matrix)
create table experiment_trial (
  trial_id     bigserial primary key,
  created_ts   timestamptz not null,
  strategy_ver text, model_ver text, cfg_id text, featureset_ver text,
  data_from    timestamptz, data_to timestamptz,
  split        text,                      -- 'cv_fold_k','holdout','shadow'
  n_trades int, mean_net double precision, sd_net double precision,
  sharpe double precision, skew double precision, kurt double precision,
  per_day_returns jsonb                   -- for CSCV/PBO
);

-- gate evaluations, immutable
create table promotion_gate_result (
  gate          text not null,            -- 'G1','G2','G3','G4','demote'
  strategy_ver  text not null,
  evaluated_ts  timestamptz not null,
  passed        boolean not null,
  metrics       jsonb not null,           -- e-process wealth, DSR, PBO, calibration slope, bounds...
  primary key (gate, strategy_ver, evaluated_ts)
);
```

---

## 10. Brief claims checked (quant area)

| Brief claim | Status | Note |
|---|---|---|
| "Nine gains of 1% and one loss of 30% lose money before fees" | **Confirmed** | 9×1% − 30% = −21% of one notional |
| "Use chronological walk-forward splits with overlapping outcome windows purged. Separate related deployer/funder groups. Include dead tokens and receipt-time data" | **Confirmed, incomplete** | Add embargo ≥ H, an untouched holdout used once, an experiment registry with DSR/PBO, and label coverage audits ([AFML](https://oreilly.com/library/view/advances-in-financial/9781119482086); [Kamat v4](https://arxiv.org/abs/2607.02823)) |
| "Tabular gradient-boosted models are a practical first candidate" | **Confirmed (with caveat)** | XGBoost/RF were best in Li et al.; in MELT, MLP edged out the tree models. Neither transferred across venues or time without retraining |
| "Candles alone cannot reliably reconstruct whether a stop or target happened first" | **Confirmed** | In-house wick vs close take-profit rule moved one rule's mean from −20.5% to +0.5% |
| "Do not display an uncalibrated score… show probability, horizon, calibration date, sample limitations" | **Confirmed** | Add calibration slope and n; Platt below ~1,000 samples ([sklearn](https://scikit-learn.org/stable/modules/calibration.html)) |
| "A $20 trial can test order handling and costs; it cannot establish a durable trading edge" / "$20 canary tests mechanics" | **Confirmed** | +5% edge needs ~258 trades (σ≈0.32); at 3 a day that is 86 days |
| "Neither a calendar duration nor a high win rate alone is a promotion gate" | **Confirmed** | Bracket strategy breaks even at a 52% win rate |
| "Use an untouched later holdout and report sample size and dependency between trades" | **Confirmed** | Specify a day-block bootstrap and design effect |
| "A starting hypothesis is at most three entry intents daily" | **Confirmed as a risk control; insufficient as an evidence source** | Statistical promotion must come from shadow trades on all eligible candidates |
| "Train separate models for return distribution… severe drawdown, exit availability, slippage, fill failure" | **Confirmed** | Implement as triple-barrier `r_net` plus `y_severe`, `blocked` and `entry_filled` labels with a meta-label filter |
| "Token-age windows and signal thresholds are hypotheses to test" | **Confirmed** | Each tested threshold is a trial in the DSR count |

---

## 11. Open questions

1. **Label collection budget.** Labelling every migration needs per-pool swap events for H after the decision. That may exceed free-tier streaming, since the sibling measured the pump stream at 184 transactions a second. Decide the subsample (for example all migrations, but only the first 60 minutes) and confirm the provider cost (data report).
2. The **true intra-day correlation ρ** between candidate outcomes, which sets the design effect. Measure it from the first 7 days of shadow data.
3. **Own latency and landing distributions.** The defaults above come from third-party samples; replace them with the bot's own measurements.
4. **Joubert meta-labelling (JFDS) exact citations:** unverified.
5. **Whether any 2026 paper reports net-of-cost P&L for a post-migration strategy:** none found.

---

## 12. Sources

Memecoin literature: [arXiv 2602.14860](https://arxiv.org/abs/2602.14860) · [arXiv 2602.13480](https://arxiv.org/abs/2602.13480) · [arXiv 2608.20271](https://arxiv.org/html/2608.20271v1) · [arXiv 2607.02823](https://arxiv.org/abs/2607.02823) · [arXiv 2607.02823v3](https://arxiv.org/html/2607.02823v3) · [arXiv 2607.02795](https://arxiv.org/abs/2607.02795) · [arXiv 2609.18975](https://arxiv.org/abs/2609.18975) · [arXiv 2609.10246](https://arxiv.org/html/2609.10246) · [arXiv 2603.24625](https://arxiv.org/abs/2603.24625) · [arXiv 2601.22185](https://arxiv.org/html/2601.22185v1) · [arXiv 2507.01963](https://arxiv.org/abs/2507.01963) · [arXiv 2504.07132](https://www.arxiv.org/pdf/2504.07132) · [arXiv 2512.11850](https://arxiv.org/html/2512.11850v3) · [USENIX Sec 2023 / arXiv 2206.08202](https://arxiv.org/html/2206.08202v3) · [Mazorra et al. 2022](https://arxiv.org/abs/2201.07220v1) · [Electronic Markets 2025](https://link.springer.com/article/10.1007/s12525-025-00815-6) · [CoinGecko 2026-05-07](https://www.coingecko.com/research/publications/pump-fun-traders-are-making-a-comeback)

Methodology: [AFML (Wiley 2018)](https://oreilly.com/library/view/advances-in-financial/9781119482086) · [Deflated Sharpe ratio](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf) · [PBO](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf) · [Harvey–Liu–Zhu](https://papers.ssrn.com/abstract=2513152) · [McLean–Pontiff](https://counterpointfunds.com/wp-content/uploads/2017/07/PredictabilityMcleanPontiff.pdf) · [Wiecki et al. via Quantpedia](https://quantpedia.com/?p=673) · [Ammann et al. 2022](https://alexandria.unisg.ch/handle/20.500.14171/108037) · [sklearn calibration](https://scikit-learn.org/stable/modules/calibration.html) · [CORP, PNAS 2021](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7923594/) · [Venn–Abers](https://arxiv.org/abs/1211.0025) · [Conformal intro](https://arxiv.org/abs/2107.07511v6) · [Conformal risk control](https://arxiv.org/abs/2208.02814v4) · [ACI](https://arxiv.org/abs/2106.00170) · [Selective classification](https://arxiv.org/abs/1705.08500) · [Wald 1945](https://projecteuclid.org/euclid.aoms/1177731118) · [Betting CIs, JRSS-B](https://par.nsf.gov/servlets/purl/10379214) · [SAVI, Stat. Sci. 2023](https://arxiv.org/abs/2210.01948v2) · [Gama et al. 2014](https://repositorio.inesctec.pt/handle/123456789/5370) · [River ADWIN](https://riverml.xyz/latest/api/drift/ADWIN/)

Mechanics: [pump-sdk 2.0.0](https://registry.npmjs.org/@pump-fun/pump-sdk/-/pump-sdk-2.0.0.tgz) · [pump-public-docs](https://github.com/pump-fun/pump-public-docs) · [pump.fun fees](https://pump.fun/docs/fees) · [Solana confirmation](https://solana.com/developers/guides/advanced/confirmation) · sibling reports [venues.md](./venues.md), [execution.md](./execution.md), [data.md](./data.md), [empirical-data](./empirical-data/results/backfill_results.json)

## Fact-check

Independent re-check of the load-bearing findings against their sources (2026-10-03). Verdicts: confirmed, contradicted (with the correction), or unverifiable.

| Finding | Claim | Verdict | Note |
|---|---|---|---|
| F1 | A pre-registered logistic pump.fun graduation model scored AUROC 0.8594 on a 15-day development cohort but 0.4642 on the next 14 days (95% CI [0.411, 0.520]); c | **confirmed** | Abstract (arXiv 2607.02823, latest v4 of 2026-09-10; v1 was 2026-07-02) matches: 749,816 mints, 12 May to 10 Jun 2026; AUROC 0.8594 on the 15-day development cohort and 0.4642 on the following 14-day cohort; 95% percentile bootstrap interval [0.4112, 0.5196]; calibration slope 0.013, intercept +2.816; of nine automated evaluations two pass, six fail, one is not evaluable. Author is Arati Uday Kamat (single author); four versions plus a reproducible correction history on Zenodo. Wording caveat: the paper says the collector's TIMEOUT label does not establish platform-side non-graduation. It does not say every label is an artefact. The AUROC 0.46 is therefore weak evidence about graduation predictability, because the outcome label itself is unreliable. Use it as a warning about label and collector quality, not as proof that graduation is unpredictable. |
| F2 | Rug-within-1h prediction from the first 5 minutes (6.3M pump.fun and 98k Raydium tokens, Nov 2024 to Jun 2025, temporal rolling cross-validation): fused XGBoost | **confirmed** | Checked in the paper text (arXiv 2608.20271v1, 2026-08-20). PumpFun has 6,304,235 tokens and Raydium 97,965, dated 2024-11-30 to 2025-06-30. The label is 'rug pull within a 1-hour horizon' from t=5 min features, validated with forward rolling-window time-series CV (last 3 months of training data, last window held out as test). Fused XGBoost on the Fusion-to-PumpFun column (Table VI): F1(1) 0.7885, MCC 0.3947, AUCPRC 0.8011. Cross-platform transfer for XGBoost: Raydium-to-PumpFun MCC -0.0026, PumpFun-to-Raydium -0.0664. Other models are about 0.1 down to -0.24. The authors write 'these results are not yet sufficient for real-world deployment'. Caveats you should keep. The rug label is loose: TVL falls below 99% OR idle time exceeds 80% of lifetime. Table V gives the PumpFun test set as 43,835 rug vs 9,711 non-rug, about 81.9% positive. So F1 0.79 and AUCPRC 0.80 sit near or below the base rate. I computed that an always-rug predictor would score F1 of about 0.90. MCC 0.39 is the more honest figure. |
| F3 | MELT/MemeTrans: 41k+ migrated pump.fun launches (Dec 2024 to Mar 2025), 122 features computed before migration, chronological 7:3 split. Best AUPRC 0.5729. Sele | **contradicted** | One number is wrong, the rest match. 'Best AUPRC 0.5729' is the best single model (MLP, Tables 8 and 9). The best overall is the ensemble MLP+LSTM at AUPRC 0.5827, with MLP+LGBM 0.5821 and MLP+RF 0.5804 close behind. I confirmed this in the arXiv PDF and HTML (v2, 2026-05-21). Everything else matches: 41,470 migrated pump.fun launches, 2024-12-01 to 2025-03-01; 122 features built from pre-migration data; chronological 7:3 split; Table 10 top-100 loss 60.71% with no model vs 26.64% with MLP (relative cut (60.71-26.64)/60.71 = 56.1%, computed); 36.5% of supply held by bundle-linked accounts, on average; 21.4% of 30.8M pre-migration transactions are wash trades; 84.13% (34,890 of 41,470) labelled high-risk. Interpretation caveats. The AUPRC columns sit beside the Label=0 (normal) class, where the Random baseline is 0.2589, so 0.57 is about 2.2x random. The high-risk label comes from post-migration 1-hour price dynamics (min_price_ratio < 0.3 or manual 'manipulated' flag), so the ranking is partly a label-definition effect. |
| F4 | pump.fun Sept 2025: 655,770 tokens, 0.63% graduated. Reaching a given amount of SOL in fewer trades is the strongest predictor of graduation, and a ≥70% share o | **confirmed** | Checked in the paper text (arXiv 2602.14860v1, 2026-02-16, Marino, Naviglio, Tarantelli, Lillo). Dataset covers 2025-09-01 to 2025-10-01: 655,770 tokens from 243,123 creators, 4,338 graduated, about 0.63%. 'Fast accumulation of liquidity through a small number of trades is the strongest predictor of graduation, dominating other variables across the entire range of vSol.' Of 184,282 tokens with at least 30 swaps, 169,938 (92.22%) show at least one dump event, and only 2.55% of those graduate. Precision on the 70% non-bot point: the paper tests two thresholds, non-bot share at least 0.3 and at least 0.7. Both curves lie above the baseline, and the two curves 'become statistically similar'. The signal is essentially exhausted at high non-bot presence, so 70% is not a distinct edge and 30% already captures it. The paper also says all conditional curves stay below the naive buy-and-hold breakeven over most of the vSol range, with the 0.3 curve approaching breakeven near graduation, and that this is only a qualitative comparison that ignores fees. 'Dump event' is the authors' own definition. |
| F6 | Across 15.2M pump.fun coins (2024-01 to 2026-01), 1.02% graduated. Wash trades make up 17% of all trades; wash-traded coins graduate at 2.0% vs 0.90%; copycats  | **confirmed** | Checked in the paper text (arXiv 2609.10246v1, 2026-09-09, 'Meme Coin Factories'). 15,245,966 coins, 2024-01-14 to 2026-01-14; baseline graduation 1.02%. Wash trading is 'at least 17%' of all trades, a lower bound. Graduation is 2.0% for wash-traded coins vs 0.90% for the rest, under the WT1 definition. Originals graduate at 9.20% vs copycats 0.86%, using the first, most conservative copycat heuristic. The top 1% of creator clusters account for 58.57% of coins only under 3-hop funding clustering. Without clustering it is 38.89%, with 1-hop 52.99%, with 2-hop 57.47%. State the clustering depth when you quote 58.57%. The wash-trading and copycat graduation lifts are observational correlations. |
| F9 | Deflated Sharpe ratio: the expected maximum Sharpe ratio under the null is √V·((1−γ)Φ⁻¹(1−1/N)+γΦ⁻¹(1−1/(Ne))). With 72 trials of 100 trades, the expected best  | **confirmed** | Bailey and Lopez de Prado, 'The Deflated Sharpe Ratio' (31 Jul 2014 version). The paper's reference code getExpMaxSR gives maxZ=(1-emc)*norm.ppf(1-1/N)+emc*norm.ppf(1-1/(N*e)), returned as mu + sigma*maxZ. The text rendering of Eq. 1 lost its glyphs, so I checked the formula from that code and the surrounding text. It matches the claim, with the mean of the trial Sharpe ratios at 0 under the null. My own computation: N=72, T=100, V=1/T=0.01 gives Phi^-1(1-1/72)=2.2004 and Phi^-1(1-1/(72e))=2.5683, so E[max SR]=0.1*(0.4228*2.2004+0.5772*2.5683)=0.2413, i.e. 0.24. Using V=1/(T-1) gives about 0.2425, still 0.24. The 0.24 depends on an unstated assumption that the null per-trade Sharpe variance is about 1/T. It also assumes independent trials, and correlated trials lower the effective N and so lower the expected maximum. |
| F11 | Official pump SDK fill math. Buy: in = floor((amount−1)·10000/(10000+fee_bps)), tokens = floor(in·T/(S+in)), capped at real reserves. Sell: sol = floor(a·S/(T+a | **confirmed** | Read @pump-fun/pump-sdk 2.0.0 (npm dist-tag latest; published 2026-09-13; author pump-fun, repo github.com/pump-fun/pump-sdk) src/bondingCurve.ts and src/fees.ts. Buy: inputAmount = (amount-1)*10000 / (10000 + protocolFeeBps + creatorFeeBps), BN integer division (floor). tokens = floor(in*virtualTokenReserves / (virtualQuoteReserves + in)), then BN.min with realTokenReserves. Sell: sol = floor(a*virtualQuoteReserves / (virtualTokenReserves + a)), minus getFee, where each fee is ceilDiv(amount*bps, 10000), protocol and creator fees rounded separately. Fee bps come from calculateFeeTier on market cap = virtualQuoteReserves*mintSupply/virtualTokenReserves, and the creator fee applies only when bondingCurve.creator is not the default key (a brand-new curve is assumed to have a creator). Details the claim omits. The tiers are selected by quote mint: SOL-like uses feeTiers, USDC uses stableFeeTiers, others use exotic or flat fees. If feeConfig is null the SDK falls back to the fixed global.feeBasisPoints and creatorFeeBasisPoints. A nonzero per-curve creatorFeeBps overrides the schedule's creator rate when global.creatorFeeConfigurable is on. The sell-side getFee uses a 1B supply constant for market cap unless the curve is in mayhem mode, while the buy path uses the passed mintSupply. Model the fee-tier lookup from live FeeConfig, not constants. |
| F12 | scikit-learn 1.9.1: isotonic calibration is as good as or better than sigmoid with more than ~1000 samples but more prone to overfitting on small sets; Platt is | **confirmed** | The page is scikit-learn 1.9.1 'Probability calibration'. Quotes: 'Overall, isotonic will perform as well as or better than sigmoid when there is enough data (greater than ~ 1000 samples) to avoid overfitting.' Isotonic 'is more prone to overfitting, especially on small datasets'. The sigmoid method (Platt) 'is most effective for small sample sizes or when the un-calibrated model is under-confident and has similar calibration errors for both high and low outputs'. 'A lower Brier loss, for instance, does not necessarily mean a better calibrated model, it could also mean a worse calibrated model with much more discriminatory power.' Note that ~1000 samples is a rule of thumb, not a hard threshold. |
| F13 | Conformal risk control bounds the expected monotone loss among accepted predictions, assuming exchangeable data. Adaptive conformal inference (α_{t+1}=α_t+η(α−e | **contradicted** | Two halves. (1) The conformal risk control wording is inaccurate. Angelopoulos, Bates, Fisch, Lei, Schuster (arXiv 2208.02814 v4, 2025-06-13) guarantee E[L_{n+1}(lambda_hat)] <= alpha for exchangeable losses that are monotone (non-increasing) in lambda. The expectation is over calibration and test draws, for the loss of the procedure on a fresh test point. It is not a bound on loss 'among accepted predictions', so there is no selective-prediction or conditional-on-acceptance guarantee. For a selection setting, use a different method such as conformal selection with FDR control. Also from the paper: it is tight up to O(1/n) and needs the loss bounded above by B. Under distribution shift it offers only a covariate-shift weighted version (with known likelihood ratio) and a total-variation degradation bound (Proposition 3). (2) The adaptive conformal inference half is true but not in the cited paper. It comes from Gibbs and Candes, arXiv 2106.00170, with update alpha_{t+1} = alpha_t + gamma*(alpha - err_t). Proposition 4.1 gives /(1/T) sum err_t - alpha/ <= (max{alpha_1, 1-alpha_1} + gamma)/(T*gamma) almost surely, with no assumption on the data process. That is a time-average miscoverage guarantee only. It does not give conditional or local coverage. alpha_t can leave [0,1] (it stays within [-gamma, 1+gamma]), which gives empty or full prediction sets. |
| F14 | Survivorship and delisting bias: 3,904 coins (2014–2021) gave a 62.19% a year bias in equal-weighted returns (0.93% value-weighted), and the size premium was ov | **confirmed** | Ammann, Burdorf, Liebi, Stockl, 'Survivorship and Delisting Bias in Cryptocurrency Markets' (2022-11-28; the search listing gives Financial Markets and Portfolio Management, vol. 34, issue 2). Abstract: '3'904 cryptocurrencies during the 2014-2021 period, we estimate an annualized bias of 0.93% (62.19%) for value-weighted (equal-weighted) portfolios', and the size 'premium is overestimated by 50% in a survival-conditioned sample'. All claimed numbers match. The claim's 'a year' means annualized. I did not open the journal page, so the venue comes from the search listing. |
