# F1 tape code: open questions

`GATE.md` is frozen and does not settle these points. Each entry gives the reading the code uses, chosen as the most conservative one. A reviewer or the lead should confirm or replace each one before the gate is evaluated.

1. **Which swaps count.** GATE.md says "buy" and "follower SOL volume" without naming the quote.
   *Conservative reading used:* SOL-quoted swaps only (curve `quote_mint` = native SOL; PumpSwap `quote_mint` = WSOL). Rows with no `user_token_owner` are dropped.
   BOOST buy-and-burn rows are dropped by signature (E `BoostBuyAndBurnEvent`), and so are rows with a non-zero `protocol`.
   Finding: on the v2 unit 09-11 446265000-446269499, all 651 BOOST rows in S_amm have `protocol` = 0 and an empty owner. The README says `protocol` marks them, but it does not. The signature match is what removes them.
2. **SOL amount.** The code uses curve `sol_amount` and PumpSwap `quote_amount`, which are pool-side amounts without the user's fees. `user_quote_amount` (with fees) is the alternative.
3. **Link timing.** "Ran between them on the tape" has no time limit.
   *Conservative reading used:* any T or W transfer anywhere on the loaded tape, before or after the buy, links the pair. This removes more followers.
   SOL links are W rows plus T rows of the WSOL mint. Mint links are T `transfer` rows of that mint only. T `mint`/`burn` rows are not links.
4. **"After the leader's buy".** Same-slot buys later in the block (higher `tx_idx`/`ev_idx`) count as followers, and earlier ones do not. The window is slots (leader, leader + 600], inclusive.
5. **Window coverage.** GATE.md says nothing about buys near the edge of the loaded tape.
   *Conservative reading used:* a leader buy is dropped (`window_not_on_tape`) unless slots [s − 1,800, s + 1,800 + 600] all lie in contiguous loaded units of that day.
6. **Placebo draw.** The draw is uniform over all buys (not owners) of the mint within ±1,800 slots, inclusive, by owners outside the day-1 candidate set. On day 2 the placebo still excludes every day-1 candidate. The draw uses `numpy.random.default_rng(20261008)`, in tape order. The seed is committed here.
   A placebo buy may itself be a follower of the leader buy. Its own followers may include the leader.
   Placebo followers exclude the placebo owner and the owners linked to it (the leader is not excluded).
7. **Bootstrap.** 10,000 resamples of a leader's (buy, placebo) pairs, seed 20261009, percentile 0.5% bound. A leader is followed only if its mean difference is above 0 and the bound is above 0.
   No minimum number of buys per leader is set. One lucky buy gives a bound of 0, so that leader is not followed.
8. **Repeat buys.** A leader's repeat buys of the same mint are separate events. "Distinct mints" applies only to the candidate rule.
9. **"Fewer than 15 persistent-leader buys a day".** `decide` compares the day-2 count of persistent-leader buys with 15. A partial day can therefore only fail this rule, never pass it falsely. The summary reports `slots_loaded` per day.
10. **Day roles.** Day 1 = 2026-09-11 (ranking) and day 2 = 2026-09-10 (persistence), as written. Units of any other day are loaded but ignored.
