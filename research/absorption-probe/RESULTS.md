# Absorption probe: results (2026-10-08)

**Verdict: unresolved.** The data within reach holds far fewer qualifying events than the test needs, and the
credit cap could not cover the full design even if it held more. **No return was computed** for any group.
Steps 2–3 (pre-registration review, exits, returns) were not run. Running them on 5 trades would only invite
over-reading.

Code: `screen.py` (bar screens), `events.py` (swap-level large sales, funding groups, triggers, entries),
`swaps.py`, `funding.py`, `hel.py` (read-only Helius, credit ledger, key hygiene), `gt.py` (GeckoTerminal),
`count.py` (this report's numbers), `test_rules.py` (synthetic checks of the rules). Exit and statistics code
(`outcome.py`, `stats.py`, `assemble.py`) is written but was never run. Derived data:
`step1_counts.json`, `step1_events.csv` (every confirmed large sale), `step1_rejected.csv` (every rejected candidate).
The rules used for the count are in `PREREG.md`.

## What was counted (Step 1, outcomes untouched)
Universe: the 163-pool survivor list (`../deep-pool-probe/eligible.json`). Pre-screen: pool-days with a daily close
of at least 36,000 SOL market cap, which left 63 pools and 1,636 pool-days. 1-minute bars were fetched for 899 of
those pool-days (55%), in pool-address order, which is effectively random. The download was stopped once the
count was decisive (see "Why stop here").

| Step | Count |
|---|---|
| Large-drop bar candidates (≥ 10% within 6 min), in the 55% | 951 |
| … tier 1 (bar drop ≥ 15%) | 199; 167 processed |
| … tier 2 (10–15%) | 752; random sample of 40 processed |
| Tier 1 rejected: pool < 24 h old / too busy (≥ 1,000 tx in 10 min) / no wallet took ≥ 10% | 20 / 42 / 64 |
| Tier 2 rejected: < 24 h / too busy / no wallet took ≥ 10% | 7 / 24 / 9 (**0 sales in 9 swap checks**) |
| **Confirmed large sales** (one wallet took ≥ 10% of the quote reserve within 5 min) | **44** in 18 pools (43 + 1 dropped) |
| … met the absorption trigger (group A) | **8** (4 pools) |
| … A after the overlap rule, eligible, would trade | **5**, all in period A |
| … no trigger (group C), would trade | 27 (19 period A, 8 period B), plus 4 overlap/ineligible and 4 marked incomplete (a 60 s fetch past the last swap found none in a quiet pool; their entry state exists, so C is really up to 31) |
| … dropped (a later window passed 400 pages) | 1 |
| Ordinary-recovery bar candidates / with no large drop in the prior 2 h | 442 / 89 |

Swap data quality: 42,138 swaps read across the event windows, 0 mismatches between carried and logged reserves.

### What the A events look like
- All 8 recovered to the pre-sale price within 29 s to 25 min of the sale's end (median about 5.5 min). All
  passed the funding test easily: 15–216 apparently independent funding groups, top group 9–33% of buy SOL. In no C
  event did price and reserve ever pass together, so funding was never tested there (`funding_checks` = 0 for all
  35 in `step1_events.csv`). **The trigger is decided by the price.**
- None of the 35 C events came back to the pre-sale price within the hour. An independent check on 1-minute bar
  highs (`bar_high_1h_over_pre` in `step1_events.csv`, from `count.py`) agrees on all 43 events: C highs stayed at
  0.773–0.998 of the pre-sale price, while A highs reached 1.013–1.311.
- A events cluster: 5 of 8 come from one pool (6unnG2…), and 3 of those 5 overlap an earlier event.
- Cost at the decision: median 0.70% (A) and 0.96% (C) for the $50 round trip. Every event but one was eligible.

## Why it is unresolved
1. **Too few events.** 5 tradable A events in 55% of the pool-days. A straight projection to the whole pre-screened
   universe (×199/167 for unprocessed tier-1 candidates, ÷0.55 for the pool-days not downloaded) gives about 11.
   This is an estimate from 5 events: an exact Poisson 95% range on 5 projects to about 3.5–25, and clustering
   (5 of 8 A in one pool; whole pools are in or out of the sample) widens it. Two sources could add more: tier 2
   (0 sales in 9 checks, but a one-sided 95% upper bound on its yield of 28% could mean up to ~12 more projected A)
   and the busy moments left out by the activity cap (about ×1.4). So 30 is unlikely but not excluded.
2. **The cap cannot buy them either.** Measured cost: 11,970 credits per confirmed sale on average (median 4,240,
   up to 74,400), about 1,200 per rejected candidate. About 728,000 credits on the count gave 5 tradable A:
   about 146,000 per tradable A before any B match, so 30 A need about 4.4M. Group B is dearer still: the cost
   test confirmed 1 B in 8 attempts for 24,800 credits, so 90 matched B would need about 2.2M more. That is about
   6.6M for the design, against the original 2M cap and also against the 4M cap the parent session set during the run.
3. **Group B is thin too.** Only 89 of 442 ordinary-recovery candidates had no large drop in the 2 h before. In a
   cost test, 6 of 8 were in pools too busy to read. Matching 3 per A on age, liquidity, returns and week would
   often fail.

### Why it costs so much
In one measured window (not committed: raw data stays outside the repo), about 25 non-swap bot transactions touched
the pool for each real swap; they clustered right after the large sale.
They cannot be filtered out before download (the pool's token vaults show the same noise). In a one-minute survey of the 63
pools (not committed), 8 ran at 400+ transactions a minute; a quarter of tier-1 candidates (42 of 167) fell in
moments with ≥ 1,000 transactions in 10 minutes (`step1_rejected.csv`). One such window cost 95,000 credits in a
test, so those were skipped by a frozen activity cap.

## Credits
994,140 counted (final ledger in `step1_counts.json`): 11,880 calls, 9,726 `getTransactionsForAddress` counted at
100 each (my conservative count, because that method returns up to 100 full transactions; I could not confirm its
real price) and 2,154 standard calls at 10. At the task's flat 10 per call it is 118,800. About 241,000 went on early
tests and diagnostics, including one 95,000-credit window in a launch-phase pool before the activity cap existed.
About 728,000 went on the count and 25,000 on the B cost test. The cap was raised to 4,000,000 during the run by
the parent session, with the instruction to stop as unresolved if events stay too few. The rest is unspent. No transaction was sent or simulated. No pump.fun request was made.

## Caveats
- **Survivors only.** The universe favours coins that later recovered. The lottery random sample was not added,
  because at most a handful of its 900 coins ever reach the ~39,000 SOL market cap a < 1.5% round trip needs
  (`PREREG.md`).
- **Calm pools only.** The activity cap leaves out the busiest moments, mostly coins in their first days.
- **Screen recall is partly unknown.** Tier 2 found no sales in 9 checks, but its 95% upper bound on the yield is
  about 34%. 64 of 167 tier-1 candidates had no single wallet taking 10%.
- Funding groups are a heuristic. They mattered for none of the 8 A events. Fixed after the count, before any reuse:
  the hub cache was keyed by funder and day, so in shuffled order it could reuse a verdict anchored up to a day
  later (no effect here, since funding decided nothing). Unverified: whether Helius honours a `before` signature
  that is not in the funder's own history (`funding.is_hub`).
- The 36,000 SOL pre-screen leaves out a small eligible band: events at the 0.70% fee tier (from 34,380 SOL) passed
  the 1.5% cost test at 1.49%.
- Overlaps are judged only among sales found; a sale in an unprocessed or busy candidate could make a kept A an overlap.
- **Period B has no A.** It holds 12 confirmed sales (11 C, 1 dropped); every A event fell before 2026-08-21.

## What it would take
- A decoded PumpSwap trade dataset (for example a self-run indexer or a bulk historical export) instead of
  per-window RPC reads. That would cut the cost per event by orders of magnitude and allow the busy pools.
- A survivorship-free universe of large pools, and probably a longer period: about 11 A events per two months means
  30 needs about 5–6 months.
- If built, the frozen rules in `PREREG.md` and the code here can be run unchanged, with the pre-registration
  review and the analysis review the task asks for.

## Plain words
The idea needs a coin that takes a big hit from one seller and then gets bought back up within the hour by many
unrelated buyers. In two months of the bigger PumpSwap coins, this happened in a usable way only 5 times in
the half of the data I could check: about 11 times overall, against the 30 needed for any judgement. When it did
happen, the bounce was fast (minutes) and came from many wallets. Most large sales (35 of 43) were never bought
back within the hour. With this data source, each event costs so many credits that even the full 2M budget
could not reach 30. So there is no answer yet, good or bad, and the cost of one
with this data source (about 6.6M credits) is above even the raised 4M cap. On these survivor, calm-pool coins the bot would trade roughly 5 times
a month (a projection from 5 events), mostly in a few pools.
