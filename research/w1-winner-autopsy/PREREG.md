# W1: winner autopsy with a persistence test (pre-registration)

Idea by the research lead (round 10). Drafted 2026-10-08 (Melbourne) by the brainstorm partner with the five fixes the lead accepted in round 12. Written before any shared-tape day exists; nothing here was computed on market data. Tape only, 0 credits. Changes after a reviewer signs it are logged as dated amendments with a reason. Chances are judgement.

## 1. Question
- Copy-trading failed because it copied trades after they happened, at our latency (0 of 120 variants).
- W1 asks a different question: does any class of traders who are no faster than us make money that persists from one day to the next?
  - If yes, their observable entry and exit rules are a strategy candidate. The rules are tested on days W1 never touched; the wallets themselves are never followed.
  - If no slow class persists, that is the strongest evidence we can get that no edge exists at our speed.
- Chance of a usable rule: about 5% (judgement). The answer is useful either way.

## 2. Data and days
- Shared tape: S (curve and PumpSwap swaps, `owner` = `user_token_owner`, fee parts, `tx_fee`, `jito_tip`), T (token movements), W (SOL transfers of at least 0.05 SOL; kept only if Phase 0 allows), C (creates), G (migrations).
- Discovery: Step A (2026-09-10, then 09-11).
- Validation: Step B (2026-09-07, then 09-08 and 09-09), if released under the tape plan.
- Rule test: days W1 never touched. That means Step C (2026-09-02..09-06) if released, else the forward recorder.
- Windows: before the wall, outside U1-B's holdout (09-12..09-21) and the sealed window.

## 3. Traders (fix c: funding clusters)
- Owners that are program-derived (off-curve) addresses are excluded. So are pools, curves, the BOOST vault, the mayhem vault and buyback authorities.
- Owners are joined into one trader (union-find) when a W SOL transfer or a T transfer of any pump mint ran between them. Only transfers on or before the ranking day count, so a trader's identity never uses later days.
- Hubs: an address linked to more than 50 owners is never used for joining, so exchanges and routers do not merge everyone.
- Report the cluster size distribution. If W is absent, clusters use T only, and that is recorded as a limitation.

## 4. P&L per trader-day (fix a: mark-to-market, in SOL)
- Cash flow: SOL received from sells minus SOL paid for buys, fees included, minus `tx_fee` and `jito_tip`. These are split evenly over the swaps in a transaction.
- Positions are marked at day end at the executable sell of the whole position. On PumpSwap that uses effective reserves (vault + signed `virtual_quote_reserves`), fee and impact, capped by the real vault. On the curve it uses the curve's reserves and fee.
- Day P&L = cash flow + end mark − start mark.
- Positions opened before the first tape day read have no known start and are left out. Tokens moving in or out of a trader by transfer are valued at the executable mark at that slot, so a transfer adds no P&L.
- Per-trade return: for each position closed or marked that day, P&L ÷ SOL paid in.

## 5. Latency class (fix b: observable, decided before any P&L is read)
- **Fast** if either holds on that day:
  - at least 10% of its buys land within 2 slots of the mint's create (C) or migration (G);
  - at least 30% of its buys land within 2 slots after another trader's buy of at least 1 SOL on the same mint.
- **Slow** otherwise.
- Reported, never used to classify: the Jito-tip share (many retail apps add tips by default), and the median lag from the previous swap on the mint.
- Report how stable the class is from one day to the next.

## 6. Gate W1-0 (Step A; reads traders' P&L, not a strategy return)
- Report each class's share of total P&L, and P&L by size band.
- Kill (W1 closes, as "untestable"): fewer than 200 slow traders a day with at least 20 positions.

## 7. Persistence test
- Day pairs run forward: rank on the earlier day, test on the later one.
- Ranking (fix d: shrunk): slow traders with at least 20 positions on the ranking day, ranked by the t-statistic of their per-trade returns.
- On the test day, compare the top decile with deciles 5 and 6, among traders with at least 5 positions on the test day. Report how many traders in each decile still trade.
- Statistic: mean per-trade return, top decile minus deciles 5–6. Bootstrap by trader within group (10,000 resamples, fixed seed).
- Discovery (09-10 → 09-11): reported, plus a futility stop: if the one-sided 95% upper bound of the lift is below 0, W1 closes as "no persistence".
- **Validation (09-07 → 09-08 and 09-09, pooled) passes, all required:**
  - the 99.5% two-sided lower bound of the lift is above 0 (the loop family's 0.005);
  - the top decile's mean per-trade return on the test days is above 0 after their own costs;
  - the replay check is above 0. Every top-decile test-day trade is replayed at our latency and cost: entry and exit each delayed 23 slots, at $50 (0.4193 SOL at the repo's $119.26), with fees, impact and the fixed costs of `packages/backtest/src/research/edge-costs.ts`. The point mean must be above 0.
- Persistence without a positive replay closes W1 as "persistent, but not at our speed or cost". That answer goes to the owner as it is.

## 8. Rule extraction (fix e: method frozen now, before any winner's trade is read)
- Runs only after a validation pass.
- Winners: the top decile ranked on 09-07 whose test-day lift held.
- Their entries on all days read (09-07..09-11) are labelled 1. A matched sample is labelled 0: per winner entry, 5 random entries in eligible coins in the same 10-minute window.
- Features, each as of the entry slot:
  - coin age since create;
  - curve progress, or time since migration;
  - venue;
  - effective quote;
  - returns over the last 5 and 60 minutes;
  - buys and sells in the last 5 minutes;
  - unique buyers in the last 5 minutes;
  - the entry's size in SOL;
  - BOOST finished (yes or no);
  - creator's share of supply;
  - top-10 holders' share.
- Model: one decision tree, depth at most 3, at least 5% of entries per leaf, fixed seed. The rule is the leaf with the highest share of winners. The hold is the winners' median hold in that leaf. Nothing else is tuned.
- Rule test, on untouched days only:
  - entry D = 23 slots after the rule fires, $50, held for the extracted hold, costs as above;
  - control: random entries on eligible coins at the same times;
  - pass: the 99.5% lower bound is above 0, at least 300 trades, positive on each day, and the lift over the control is above 0.
  - This counts as a second test in the loop family.

## 9. Checks before scoring (worker, then a fresh reviewer)
1. As-of only. Clusters, latency classes and features use no slot after the decision, checked with a planted future-marker test.
2. P&L accounting on fixtures: router trades (owner differs from signer), transfers between cluster members, closing sells, curve positions carried through migration.
3. Excluded addresses listed by type, and the hub threshold's effect reported.
4. Code, seeds and input hashes committed before validation days are read.

## 10. Data note
Wallet addresses are public chain data. W1 joins no off-chain identity. Committed summaries show only truncated SHA-256 hashes of addresses.
