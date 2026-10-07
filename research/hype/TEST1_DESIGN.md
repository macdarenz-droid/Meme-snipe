# Test 1 design (paid attention at entry), from the hype workflow, with the three critics' required fixes

Source: hype-signal-research workflow, 2026-10-07. The sample in `test1_sample.json` was drawn by the supervisor: seed 20261008; 3,000 of 27,467 graduates created 2026-07-22..08-20 with quote mint native SOL, WSOL or null and a pump_swap_pool, excluding `../lottery-probe/sample.json`; sorted by mint before sampling. Callouts for the fresh draw are **not** collected: the owner approved keeping existing pump.fun data only, not new pump.fun requests.

```text

== rank 
 1

== name 
 Paid attention and callouts at entry, re-tested on a fresh draw from the exploration window

== hypothesis 
 Two-sided, both directions stated in advance. H1 (owner's idea): graduates that already show bought or called attention at the entry moment earn a higher mean net in SOL under the existing entry and exit. Bought attention means a paid DexScreener profile, boost or community takeover; called means 5 or more distinct pump.fun callers. H1-alt (exploration data and literature): they earn a lower mean net, because attention marks volatility and exit liquidity, so the flag is a reject rule.

== signal_definition 
 t_e = entry time = ts[1] + 3600 (the close of the bar one hour after the pool's first bar, exactly as research/runner-probe/runner.py trade() enters). Primary: PAID(t_e) = 1 if GET https://api.dexscreener.com/orders/v1/solana/{mint} returns an order with type=='tokenProfile', status=='approved' and paymentTimestamp <= t_e - 15 min. Secondary flags, declared in advance and Holm-corrected: BOOST(t_e) = sum of boosts[].amount with paymentTimestamp <= t_e - 15 min >= 10. CALLED5(t_e) = number of distinct userId among /callout/coin/{mint}?limit=100 items with createdAt <= t_e - 2 min >= 5. A coin that returns 100 items with fewer than 5 qualifying calls is 'unknown' (the list is sorted by maxMultiplier and capped) and is reported both ways. CTO (diagnostic only). These are never used: 'has a profile now', tokens/v1 info, ath_market_cap, reply_count, and the callout outcome fields multiple, maxMultiplier, maxMultiplierAt, maxPrice*, likes, reply, repost and comment counts (dropped on save, items re-sorted by createdAt).

== entry_rule 
 The R1 entry, unchanged: buy at the close of hour 1 after migration (1-2 h after migration, so every flag is known at least minutes earlier; latency is realistic). Usable coins only (lottery.py classify == ok and runner.coins filters; dust pools out, matching the bot's H8). Size $10. Costs from research/lottery-probe/lottery.py net(): PumpSwap tier fee each side, constant-product impact, 414,009 lamports fixed. Results in SOL.

== exit_rule 
 R1 on the hourly-pessimistic line, as pre-registered in research/runner-probe/PREREG.md: cut loss at -30%, filled at min(level, close), until armed; arm when the close reaches 2x; trail 40% below the peak close; max hold 14 days. Hourly bars cannot show an on-chain big-holder exit; Test 4 covers that.

== benchmark 
 (a) The complement group (UNPAID) on the same draw. (b) 10,000 random subsets of the same size as the PAID group, matched to the PAID group's count per creation day: PAID's mean must fall outside the central 95% of that distribution. (c) The unfiltered R1 basket.

== data_recipe 
 1) Fresh draw: seed 20261008, 3,000 mints drawn uniformly from the SOL-quoted graduates created 2026-07-22..08-20 in scratchpad/socials/grads_socials.jsonl, excluding research/lottery-probe/sample.json. That file was checked today: 28,253 SOL-quoted exploration-window rows, and its pump_swap_pool equals sample.json's pool for all 899 overlapping mints. In code, assert created_timestamp < 1787270400000 (2026-08-21T00:00Z). 2) Hourly OHLCV in SOL with research/lottery-probe/fetch_hourly.py (GeckoTerminal keyless, currency=token), bars ending by the wall 2026-09-21T14:00Z. 3) DexScreener orders with the pattern in scratchpad/hype/crypto-native/scripts/orders.py at <=55 requests a minute. DexScreener API terms, checked 2026-10-07: commercial and non-commercial use allowed, free and paid tiers differ only in rate limits, no competing product. The historical-feasibility report's 'commercial use is on paid tiers' is a misreading. 4) Callouts for the fresh draw only if the owner accepts the pump.fun Terms risk. §21(h)(i) bars bots and scripts 'except as expressly permitted under Section 6.1'; §6.1 allows only automated means 'we expressly permit'; terms last updated 25 Sep 2026; both read 2026-10-07. Without that decision, CALLED5 stays descriptive on the 900 already collected (scratchpad/hype/crypto-native/data/callouts_explore.jsonl). 5) Simulate with runner.coins/trade and lottery.net. Commit a PREREG with these thresholds and the primary endpoint before any fetch.

== kind 
 historical-now

== time_to_result 
 About 1 day. The fetch takes about 6-7 h: about 3,000 GeckoTerminal calls at about 10 a minute (the keyless limit in the CoinGecko doc cited by the crypto-native report; the shared IP may double this), plus about 1 h for DexScreener. Analysis takes about 1 h. Started around 20:00 Melbourne on 2026-10-07, the result is due around midday Melbourne on 2026-10-08.

== cost 
 $0

== sample_size_and_power 
 About 1,640 usable coins expected. Assumption: the same usable rate as 492/900. Expected PAID share about 41% (exploration: 201 of 492 paid at least 2 min before entry), so about 690 vs 950. Measured today on the 492 exploration coins, R1 hourly at $10: SD per trade 0.48 without the best coin and 0.99 with returns capped at 20x. Power at two-sided alpha 0.05: a 15 pp mean difference has 85% power at SD 1.0 and over 99% at SD 0.5; a >=5x-peak rate of 6.0% vs 2.4% has 95% power (486 coins per group needed). CIs come from a day-block bootstrap over 30 creation days. Holm correction across the primary endpoints of Tests 1 and 2 on this draw.

== kill_criteria 
 Drop attention at entry as an entry signal if either holds: (a) the PAID-minus-UNPAID capped-mean difference has a day-block 95% CI that includes 0 and PAID sits inside the random-subset 95% band; or (b) PAID is better but the upper bound of its own mean's 95% CI is below +8% a trade, the minimum true mean for 80% power at the 300-trade pre-funding gate with SD 0.5, so it cannot rescue the strategy. If PAID is significantly worse, keep it only as a candidate reject or exit-width feature for a written validation PREREG (validation_sample.json, created 2026-08-21..09-06), never as proof. Data kill: fewer than 95% HTTP 200 order responses, or fewer than 1,200 usable coins, means 'insufficient'. If the sign flips between the 15-min and 60-min approval buffers, the verdict waits for the lag Test 3 measures.

== biases_and_mitigations 
 Look-ahead: paymentTimestamp comes before the profile is visible. The lag is unknown: live samples showed 70 s and 5.3 min, and DexScreener allows up to 12 h. Mitigation: a 15-min buffer, a 60-min sensitivity run, and the real lag measured live in Test 3. Survivorship: only approved orders were seen, and cancelled or rejected ones may be missing. Callouts: sorted by an outcome and capped at 100, so the CALLED5 rule is a lower bound with an 'unknown' class. Deleted callouts are invisible, and Callout Rewards (about Aug-Sep 2026) changed callers' incentives. Selection: the 492 coins already shaped this hypothesis, so the verdict comes only from the fresh draw; the 492 are reported separately. Tails: one coin (~330x real-time, ~130x hourly) decides every positive mean, so capped-20x and without-best-coin results are reported beside every figure. Universe completeness is unverified: the file has 28,253 SOL-quoted rows against the PREREG's 28,563, a 1.1% gap.

== ethics_note 
 Read-only public data. The bot never buys profiles, boosts or ads and never posts callouts. Callout userIds are wallets tied to pump.fun profiles, so store only hashed IDs or counts. Further automated pump.fun access is an owner decision (Terms §21(h)).

## CRIT bias-leakage | 1. Paid attention and callouts at entry, re-tested on a fresh draw from the exploration window | fixable
 - Name one primary endpoint (capped-20x mean difference, or mean log(1+r)). Make uncapped results and tail counts descriptive, and state plainly that the 50x question is not testable at this n.
 - Recompute power at the Holm-adjusted alpha. Fix the family now (PAID, BOOST and CALLED5 are in or out whatever the owner decides). Name the 15 min buffer and the 'unknown = not called' rule as primary. Use Holm-adjusted CIs in the kill criterion.
 - Pre-declare a covariate-adjusted secondary (strata of h1 and log hour 0-1 volume, both known at t_e) and a close-triggered stop sensitivity. If PAID adds nothing beyond price and volume, prefer a price-only rule.
 - Pre-declare PAID vs UNPAID under R3 (no stop) as a diagnostic, so a reject rule is not an artefact of the stop.
 - Include the 113 null-quote rows with a pool (check their quote on-chain), or state the exclusion. List the outcome-viewed mints and report with and without them.
 - Before the fresh fetch, re-fetch 5 known 07-22..07-24 paid coins to confirm order retention. Compare per-day PAID share between the 900 and the fresh draw.
 - Commit the PREREG, and log its commit hash and time before the first API call, so that order can be checked.

## CRIT feasibility-cost-latency | 1. Paid attention and callouts at entry, fresh exploration draw | fixable
 - Re-estimate the fetch at 10-12 h with the 429 rate measured on this IP. Wrap each pool fetch in try/except so one failure is logged and the run continues. Run the 'first' then the 'refetch' modes, and report pools dropped as time-only.
 - State the universe as quote_mint in {System Program, None} (28,366 rows), or justify excluding the None rows. Record that one sample mint is absent.
 - Correct the survivorship note: cancelled orders appear. Report PAID both with and without coins whose orders are not approved, plus the 60-min buffer.
 - In the PREREG, declare BOOST as descriptive unless it has 200 or more coins.
 - State plainly that the fresh draw shares calendar days with the exploration sample. A time-independent verdict needs the validation PREREG.
 - Disclose that the universe came from scripted pump.fun access, as part of the owner's Terms decision.

## CRIT sources-legal-ethics | Test 1: paid attention and callouts at entry, on a fresh draw | fixable
 - Before the fetch, write in the PREREG and DECISIONS that the universe and callouts came from scripted pump.fun access with fake Origin and Referer headers. Put that to the owner as part of the §21(h) decision, naming (i), (iv) and (vii). Any further pump.fun request, if approved, uses an honest User-Agent and no forged Origin or Referer.
 - Hash the userIds in callouts_explore.jsonl and drop the engagement-count fields now, or get owner approval to keep them. Make the stated 'dropped on save' true.
 - Define cancelled orders in the PREREG: PAID counts approved orders only, with a sensitivity run that also counts cancelled ones. Remove the 'only approved seen' sentence.
 - Resolve the 113 null-quote rows (check each pool's quote vault, or report them as excluded with their count).
 - Record the GeckoTerminal/CoinGecko terms question (storage clause, keyless 'not for production or scheduled polling') as unverified and an owner risk item next to the pump.fun one. Do not present the data path as fully cleared.
 - Replace -34% vs -8% with R1 numbers and state that the fresh draw shares days with the exploration sample.
 - Mark BOOST as descriptive only, or give its expected event count before running.
```
