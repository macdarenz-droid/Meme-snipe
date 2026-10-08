# F1 tape code: open questions

`GATE.md` is frozen and does not settle these points. The design owner answered them in `../AMENDMENT_1.md` (frozen, 2026-10-08): items 1–6 and 8–10 are confirmed as the code reads them, and item 7 is replaced by the amendment's rule, which the code implements. Each entry gives the reading the code uses, chosen as the most conservative one. A reviewer or the lead should confirm or replace each one before the gate is evaluated.

1. **Which swaps count.** GATE.md says "buy" and "follower SOL volume" without naming the quote.
   *Conservative reading used:* SOL-quoted swaps only (curve `quote_mint` = native SOL; PumpSwap `quote_mint` = WSOL). Rows with no `user_token_owner` are dropped.
   BOOST buy-and-burn rows are dropped by signature (E `BoostBuyAndBurnEvent`), and so are rows with a non-zero `protocol`.
   Decoder v3 sets `protocol=1` on BOOST swaps. Any non-zero `protocol` is dropped, and the signature match stays for older units.
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
7. **Minimum valid pairs [AMENDMENT_1].** A leader is testable on a day only with at least 8 valid (buy, placebo) pairs that day (window on the tape and a placebo found; `MIN_VALID_PAIRS = 8`, fixed in code). With fewer pairs it is "untestable": not followed on day 1, not persisting on day 2. The bound is the one-sided 0.5% percentile bound from 10,000 resamples, seed 20261009.
   - The earlier `--min-buys` flag and the zero-variance rule are gone. The amendment keeps the percentile bound as the rule. `zero_variance` is still reported per leader.
   - The summary counts untestable leaders per day.
8. **Repeat buys.** A leader's repeat buys of the same mint are separate events. "Distinct mints" applies only to the candidate rule.
9. **Complete days for `--decide`.** `--decide` refuses unless the loaded units equal the committed plan's rows (`research/shared-tape/stepa-plan.txt`) for 09-11 and 09-10 exactly, with contiguous slots. The summary records the plan's sha256.
10. **"Fewer than 15 persistent-leader buys a day".** `decide` compares the day-2 count of persistent-leader buys with 15. A partial day can therefore only fail this rule, never pass it falsely. The summary reports `slots_loaded` per day.
11. **Day roles.** Day 1 = 2026-09-11 (ranking) and day 2 = 2026-09-10 (persistence), as written. Units of any other day are loaded but ignored.
