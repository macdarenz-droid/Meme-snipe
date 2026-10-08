# D1 scoring code: open questions

Places where `PREREG.md` is silent or ambiguous. Each one has the reading the code uses now. CONSERVATIVE means I chose the safer reading because nothing in the repo decides it. A reviewer or the design owner should confirm or amend each one before the search runs on the full Step A.

## Universe and decision points
1. **Grid anchor.** "Every 5 minutes per eligible pool" does not say what the marks are aligned to. The code uses UTC-aligned 5-minute marks tau inside [migration + 60 min, migration + 24 h], both ends included. H1-CGO uses whole UTC hours. The decision slot is the last produced slot with block_time < tau.
2. **Migration not on the tape.** A pool whose migration happened before the first unit read has no known age, so it is excluded. CONSERVATIVE. As a result, early 2026-09-10 has few pools, because pools that migrated on 09-09 are never seen. Fold 0 on day 1 is therefore thin.
3. **Mayhem flag unknown.** The flag is read from CreatePoolEvent, then CreateEvent, then the curve rows. If none of these has it, the pool is excluded, as G1 §3 does. CONSERVATIVE.
4. **Coverage.** A decision needs gap-free tape from the migration to d. A hold arm needs it from d to its exit slot. Otherwise the arm is dropped by time.

## Trade and costs
5. **Fill price inside a slot.** The code takes the worse of the pool state at the start and at the end of the entry slot and of the exit slot. This copies H1-CGO §6 and G1 §4. CONSERVATIVE.
6. **Exit delay.** The trigger is the first slot at or after entry time + hold. The sell lands 23 slots later, as in H1-CGO ("+ D slots"). CONSERVATIVE.
7. **One entry per pool per hour.** The code uses a rolling 60 minutes from the last entry, chosen greedily in time order. A clock hour would allow entries 5 minutes apart. CONSERVATIVE.
8. **Fee rates.** The rates are the lp, protocol and creator bps on the pool row whose state is used.
9. **A sell larger than the real vault.** The program would refuse such a sell. The code caps the quote out at the real vault. CONSERVATIVE.
10. **Our own trade's effect on the pool.** Our buy's impact is not carried into the exit state, so the exit is priced on the market's own state. This is standard in the repo's designs, but it is a small optimism.
11. **Rent.** The code uses 1,513,840 lamports, as `edge-costs.ts` does. A Token-2022 associated token account (170 bytes) costs 2,074,080 lamports. G1 asks for this to be checked. D1 says "as edge-costs.ts", so the code is unchanged; flag for review.
12. **Pool state between trades.** It comes from trade rows only. InitBoost, deposits and withdrawals show up only at the pool's next trade. How large this effect is has not been measured.

## Features
13. **Window for "Who".** A 15-minute window is stated only for failed buys. The code uses [tau - 15 min, tau) for all four "Who" shares. CONSERVATIVE.
14. **"App-routed".** There is no registered list of app programs. The code counts a buy as app-routed when its `top_program` is neither PumpSwap nor pump, so trading-bot programs count too. On schema v1 units the share is NaN.
15. **W1's fast class.** W1 classifies "on that day", which would look ahead. The code reads it as of the decision: the cluster's buys from the start of tau's UTC day up to d. Clusters are rebuilt exactly at every tau. W1's exclusion of off-curve (PDA) owners is not applied, because there is no on-curve check without a new dependency. Hub degree counts every distinct linked address, not owners only.
16. **Creator cluster seeds.** The seeds are the create row's creator and user (G1 amendment 1). When the create predates the tape, the seed is the pool's `coin_creator`.
17. **"Creator share".** The code uses the creator address's own balance divided by supply, not the whole cluster's.
18. **Holders.** Only owners seen on the tape are counted. For coins created before the tape, `top10_share` is therefore a lower bound. Holdings from before the tape are found through `owner_token_pre/post` and given unknown cost. The denominator is `base_supply`. CGO is computed at any coverage; H1-CGO's 90% floor is not applied, because coverage is its own feature. Burn and protocol accounts other than the pool and the curve are not excluded, because the tape does not list them.
19. **CF.** The feature is the count of both collection events by the coin's creator in the last hour. Neither event names a mint, so collections from the creator's other coins count too. Windows that touch a v1 unit are NaN.
20. **BOOST finished.** It is 1 when the pool's last BoostBuyAndBurnEvent at or before d has `boost_vault_remaining` = 0, and 0 otherwise, including pools with no BOOST.
21. **Definitions not spelled out in the PREREG:**
    - net SOL is buy minus sell `quote_amount` (pre-fee);
    - BOOST and protocol buys count in buys and net SOL;
    - largest sell is divided by the effective quote at d;
    - a first-time buyer is one whose first buy of the mint on the tape (curve or PumpSwap) falls in the window;
    - realised volatility is the square root of the sum of squared log changes of the post-trade mid over the window;
    - "since migration" is measured from the first pool row's pre-trade mid.

## Search
22. **Folds.** Four folds: fold j holds out block j (00–06, 06–12, 12–18, 18–24 UTC) on every discovery day. A training point is dropped when its whole window [tau, exit] comes within 60 minutes of a held-out block. CONSERVATIVE: this also covers the hold. Points whose arm runs past the tape are used neither for edges nor for scoring.
23. **Quintiles.** Edges are numpy linear percentiles. Top is x ≥ q80, bottom is x ≤ q20, and NaN is in neither. A binary or degenerate feature (`boost_finished`, often `cf_collections_1h`) can put most points in a "quintile".
24. **Cost hurdle.** Read literally, the out-of-fold mean of net return must be at least the median round-trip cost, even though net already pays costs. CONSERVATIVE: this is stricter. The median is over all eligible discovery points with an entry fill.
25. **Sign rule.** "The same in all four folds" is read as all four fold means non-zero with one sign. The 5 advanced rules are counted across both holds together.

## Validation (not run)
26. **Lift baseline.** "Random eligible decision points" is the mean over all eligible points valid for the hold, with no throttle. That is the expected value of a random draw, so no sampling noise.
27. **Days without trades.** A validation day with no trade counts as not positive. CONSERVATIVE.
28. **Interval method.** The bootstrap gives a percentile interval. Clusters are pools within each day stratum, so a pool seen on two days counts as two clusters.

## Scale (not yet measured)
29. **Full Step A run.** Expected cost:
    - loading about 96 units takes about 10 s each;
    - one connected-components pass per 5-minute mark (about 576) takes several seconds each on 10M+ links;
    - memory is a few GB after the migrated-pool prefilter.

    None of this was run beyond 2 units, by rule.
