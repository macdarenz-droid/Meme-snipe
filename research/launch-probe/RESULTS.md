# Launch probe: buying on the pump.fun bonding curve right after creation (results, 2026-10-07)

Rules: `PREREG.md` (pushed before any return was computed; three amendments, all made before any return).
Code: `pumpdec.py` (decoding), `fetch.py` (Helius, read-only), `analyze.py` (replay and statistics),
`report.py` (tables), `check_pools.py` and `sensitivity.py` (review checks). Numbers: `derived/`.

## Verdict: **not supported**

Validation primary pair **L480_T1** (buy 480 slots ≈ 2.7 min after creation, sell 1 min later), chosen on
discovery by the pre-set rule. In validation it averaged **−7.1%** per trade, 95% interval [−8.7%, −5.8%], with a
stress mean of −9.5%. Neither filter helps: F1 (≥ 5 other early buyers) −11.7% and F2 (dev buy ≥ 1 SOL) −4.7%,
Holm p = 1.0 for both. **All 40 entry/exit pairs lose money in validation, and every 95% upper bound is below
zero.** In discovery only one pair had a mean above zero (L480_ST10, +0.4%, interval [−6.3%, +11.1%]); it did not
hold in validation (−7.6%).

## Plain words

We bought $10 of a random sample of new pump.fun coins on their bonding curve, from under 1 second to about 3
minutes after launch. We replayed the real trades one by one with the real fees, then sold after 1, 5, 15 or 60
minutes, with a stop/trailing stop, or at the first trade after graduation. Every version lost money on average.
Buying in the first second (slot +2) was the worst: −11% to −29% depending on the exit. Waiting longer lost less only because less
happens later, not because it makes money. Around 8% of the fastest buys are up after 1 minute, but the losers
lose more than the winners win. Only about 2–3% of new coins graduate within an hour. On top of that, landing
in slot +2 against professional snipers is optimistic, so a real bot would do worse than these numbers.

## Sample, data and cost

- Launches drawn uniformly by time from the create authority's transactions: 300 discovery and 250 validation
  instants. That gave 4,287 launches; the budget plan kept 1,294, and the analysed sample is the completed
  944-launch prefix of the random fetch order (amendment 3). 28 non-SOL-quoted launches were left out (12
  discovery, 16 validation), leaving **475 discovery (29 days) and 441 validation (17 days)**.
- Every successful bonding-curve transaction up to creation + 3,900 s was decoded. The real-reserve chain check
  found 0 breaks, so no trade is missing. 0 undecodable. Mayhem-mode coins: 91 discovery and 101 validation;
  their virtual reserves jump between trades (amendment 1) and are priced from logged post-trade states.
- Graduation (curve complete) within 60 min: **3.37%** discovery (16/475), **2.27%** validation (10/441).
- Slot length moved during the windows (0.315–0.423 s per slot by day). Mean entry delays: L2 ≈ 0.84/0.68 s,
  L10 ≈ 4.2/3.4 s, L40 ≈ 17/14 s, L120 ≈ 50/41 s, L480 ≈ 202/164 s (discovery/validation).
- **Credits: 1,407,410 counted** (140,741 calls × 10), under the 1,500,000 cap. Retries count as calls. Early
  in the run, two processes briefly shared the ledger file, so a few calls may be missing from the count (one
  failed write). No key in any file (`keycheck.py` ran before each commit). Raw responses stay outside the repo.

## Discovery (all pairs, description only)

Launches 475; graduated within 60 min: 16 (3.37%); pool traded within 60 min: 16; mayhem-mode: 91; real-reserve chain breaks: 0 coins; undecodable: 0; completed with no pool swap in the horizon (priced at the final curve state, optimistic): 0 coins. Dropped: {'outside_window': 0, 'non_sol_quote': 12, 'missing_events': 0}.
L in seconds (mean): 2 slots = 0.84 s, 10 slots = 4.20 s, 40 slots = 16.80 s, 120 slots = 50.41 s, 480 slots = 201.64 s. No entry (curve already complete): L2: 5, L10: 6, L40: 7, L120: 7, L480: 9.

| pair | n | days | mean | 95% CI (day bootstrap) | median | win | >= 2x | mean capped 20x | stress mean | stress CI |
|---|---|---|---|---|---|---|---|---|---|---|
| L2_T1 | 470 | 29 | -12.8% | [-17.8%, -8.0%] | -4.3% | 8.7% | 3.0% | -12.8% | -15.2% | [-20.2%, -10.4%] |
| L2_T5 | 470 | 29 | -19.9% | [-24.7%, -15.2%] | -9.1% | 5.3% | 1.5% | -19.9% | -22.3% | [-27.1%, -17.6%] |
| L2_T15 | 470 | 29 | -17.3% | [-26.0%, -6.7%] | -9.7% | 3.2% | 1.1% | -18.4% | -19.7% | [-28.4%, -9.1%] |
| L2_T60 | 470 | 29 | -15.1% | [-26.2%, -1.3%] | -13.9% | 1.9% | 0.9% | -17.2% | -17.5% | [-28.6%, -3.7%] |
| L2_ST2 | 470 | 29 | -11.6% | [-15.4%, -7.5%] | -8.9% | 7.4% | 1.9% | -11.6% | -14.0% | [-17.8%, -9.9%] |
| L2_ST10 | 470 | 29 | -10.7% | [-15.1%, -5.7%] | -8.0% | 7.9% | 3.0% | -10.7% | -13.1% | [-17.5%, -8.1%] |
| L2_MG2 | 470 | 29 | -21.5% | [-26.2%, -17.0%] | -12.7% | 2.3% | 1.3% | -21.5% | -23.9% | [-28.6%, -19.4%] |
| L2_MG10 | 470 | 29 | -21.4% | [-26.1%, -16.6%] | -12.7% | 2.3% | 1.1% | -21.4% | -23.7% | [-28.5%, -19.0%] |
| L10_T1 | 469 | 29 | -11.0% | [-16.4%, -5.9%] | -3.6% | 7.9% | 2.3% | -11.0% | -13.4% | [-18.8%, -8.3%] |
| L10_T5 | 469 | 29 | -20.3% | [-24.5%, -16.4%] | -6.4% | 4.1% | 0.9% | -20.3% | -22.7% | [-26.8%, -18.7%] |
| L10_T15 | 469 | 29 | -19.3% | [-25.8%, -11.2%] | -6.7% | 3.2% | 0.6% | -19.3% | -21.7% | [-28.2%, -13.6%] |
| L10_T60 | 469 | 29 | -20.3% | [-26.1%, -14.0%] | -8.0% | 1.7% | 0.6% | -20.3% | -22.7% | [-28.5%, -16.4%] |
| L10_ST2 | 469 | 29 | -9.3% | [-13.9%, -3.9%] | -5.9% | 6.8% | 1.5% | -9.3% | -11.7% | [-16.3%, -6.3%] |
| L10_ST10 | 469 | 29 | -7.9% | [-13.8%, -1.3%] | -5.9% | 6.4% | 2.3% | -7.9% | -10.3% | [-16.2%, -3.7%] |
| L10_MG2 | 469 | 29 | -20.9% | [-25.1%, -16.8%] | -7.8% | 2.1% | 0.9% | -20.9% | -23.3% | [-27.5%, -19.2%] |
| L10_MG10 | 469 | 29 | -20.7% | [-25.0%, -16.4%] | -7.8% | 2.1% | 0.6% | -20.7% | -23.1% | [-27.4%, -18.8%] |
| L40_T1 | 468 | 29 | -7.1% | [-11.8%, -1.2%] | -3.5% | 5.3% | 1.5% | -7.1% | -9.5% | [-14.2%, -3.6%] |
| L40_T5 | 468 | 29 | -15.9% | [-19.3%, -13.1%] | -4.2% | 3.6% | 0.4% | -15.9% | -18.3% | [-21.7%, -15.4%] |
| L40_T15 | 468 | 29 | -14.2% | [-20.3%, -7.6%] | -4.4% | 3.0% | 0.4% | -14.2% | -16.6% | [-22.7%, -10.0%] |
| L40_T60 | 468 | 29 | -13.9% | [-21.0%, -5.0%] | -4.8% | 1.5% | 0.4% | -13.9% | -16.3% | [-23.3%, -7.4%] |
| L40_ST2 | 468 | 29 | -4.5% | [-10.7%, +4.6%] | -4.2% | 5.1% | 1.1% | -4.5% | -6.9% | [-13.1%, +2.2%] |
| L40_ST10 | 468 | 29 | -5.5% | [-11.5%, +3.7%] | -4.2% | 4.9% | 1.7% | -5.5% | -7.9% | [-13.9%, +1.3%] |
| L40_MG2 | 468 | 29 | -15.0% | [-20.3%, -8.0%] | -4.7% | 1.9% | 0.6% | -15.0% | -17.4% | [-22.7%, -10.4%] |
| L40_MG10 | 468 | 29 | -14.8% | [-20.3%, -7.9%] | -4.7% | 1.9% | 0.4% | -14.8% | -17.2% | [-22.7%, -10.3%] |
| L120_T1 | 468 | 29 | -7.9% | [-9.5%, -6.0%] | -3.5% | 3.2% | 0.4% | -7.9% | -10.2% | [-11.8%, -8.4%] |
| L120_T5 | 468 | 29 | -10.6% | [-12.4%, -8.8%] | -3.5% | 3.2% | 0.2% | -10.6% | -13.0% | [-14.8%, -11.2%] |
| L120_T15 | 468 | 29 | -6.0% | [-13.2%, +3.5%] | -3.5% | 2.4% | 0.4% | -6.3% | -8.4% | [-15.6%, +1.1%] |
| L120_T60 | 468 | 29 | -7.1% | [-13.9%, +2.7%] | -3.7% | 1.3% | 0.6% | -7.1% | -9.5% | [-16.3%, +0.3%] |
| L120_ST2 | 468 | 29 | -3.2% | [-8.7%, +6.8%] | -3.7% | 3.0% | 1.1% | -3.2% | -5.6% | [-11.1%, +4.5%] |
| L120_ST10 | 468 | 29 | -3.3% | [-8.8%, +6.9%] | -3.7% | 3.2% | 1.3% | -3.3% | -5.7% | [-11.2%, +4.5%] |
| L120_MG2 | 468 | 29 | -7.8% | [-12.5%, -0.7%] | -3.7% | 2.1% | 0.9% | -7.8% | -10.2% | [-14.9%, -3.1%] |
| L120_MG10 | 468 | 29 | -7.0% | [-12.6%, +1.0%] | -3.7% | 1.9% | 0.9% | -7.0% | -9.4% | [-15.0%, -1.4%] |
| L480_T1 | 466 | 29 | -4.6% | [-6.1%, -3.2%] | -3.5% | 2.8% | 0.2% | -4.6% | -7.0% | [-8.5%, -5.6%] |
| L480_T5 | 466 | 29 | -5.6% | [-7.9%, -2.9%] | -3.5% | 1.9% | 0.2% | -5.6% | -7.9% | [-10.3%, -5.3%] |
| L480_T15 | 466 | 29 | -2.4% | [-8.1%, +4.7%] | -3.5% | 0.9% | 0.4% | -2.4% | -4.8% | [-10.5%, +2.3%] |
| L480_T60 | 466 | 29 | -2.5% | [-8.8%, +8.0%] | -3.5% | 0.9% | 0.6% | -3.0% | -4.9% | [-11.2%, +5.7%] |
| L480_ST2 | 466 | 29 | -0.1% | [-6.7%, +10.7%] | -3.5% | 1.7% | 0.6% | -0.6% | -2.5% | [-9.1%, +8.3%] |
| L480_ST10 | 466 | 29 | +0.3% | [-6.3%, +11.1%] | -3.5% | 1.7% | 0.6% | -0.2% | -2.1% | [-8.7%, +8.7%] |
| L480_MG2 | 466 | 29 | -4.2% | [-8.0%, +2.2%] | -3.5% | 1.3% | 0.9% | -4.2% | -6.6% | [-10.4%, -0.2%] |
| L480_MG10 | 466 | 29 | -4.2% | [-8.0%, +2.2%] | -3.5% | 1.3% | 0.9% | -4.2% | -6.6% | [-10.4%, -0.2%] |

## Validation

Launches 441; graduated within 60 min: 10 (2.27%); pool traded within 60 min: 10; mayhem-mode: 101; real-reserve chain breaks: 0 coins; undecodable: 0; completed with no pool swap in the horizon (priced at the final curve state, optimistic): 0 coins. Dropped: {'outside_window': 0, 'non_sol_quote': 16, 'missing_events': 0}.
L in seconds (mean): 2 slots = 0.68 s, 10 slots = 3.42 s, 40 slots = 13.67 s, 120 slots = 41.01 s, 480 slots = 164.06 s. No entry (curve already complete): L2: 5, L10: 5, L40: 5, L120: 5, L480: 8.

| pair | n | days | mean | 95% CI (day bootstrap) | median | win | >= 2x | mean capped 20x | stress mean | stress CI |
|---|---|---|---|---|---|---|---|---|---|---|
| L2_T1 | 436 | 17 | -17.0% | [-21.2%, -12.3%] | -6.5% | 8.0% | 1.6% | -17.0% | -19.4% | [-23.6%, -14.7%] |
| L2_T5 | 436 | 17 | -22.2% | [-29.0%, -10.1%] | -11.0% | 3.4% | 0.7% | -22.2% | -24.6% | [-31.4%, -12.5%] |
| L2_T15 | 436 | 17 | -28.8% | [-30.8%, -26.9%] | -13.4% | 1.8% | 0.0% | -28.8% | -31.2% | [-33.2%, -29.3%] |
| L2_T60 | 436 | 17 | -28.8% | [-30.9%, -27.0%] | -15.1% | 1.8% | 0.0% | -28.8% | -31.2% | [-33.3%, -29.4%] |
| L2_ST2 | 436 | 17 | -14.3% | [-17.8%, -9.8%] | -10.9% | 6.2% | 1.6% | -14.3% | -16.6% | [-20.1%, -12.2%] |
| L2_ST10 | 436 | 17 | -15.5% | [-19.0%, -11.1%] | -9.6% | 6.7% | 1.1% | -15.5% | -17.9% | [-21.4%, -13.5%] |
| L2_MG2 | 436 | 17 | -23.9% | [-29.9%, -14.1%] | -12.9% | 2.8% | 0.9% | -23.9% | -26.3% | [-32.2%, -16.5%] |
| L2_MG10 | 436 | 17 | -24.7% | [-30.0%, -15.8%] | -13.4% | 2.5% | 0.7% | -24.7% | -27.1% | [-32.4%, -18.2%] |
| L10_T1 | 436 | 17 | -16.5% | [-19.9%, -12.3%] | -4.9% | 8.0% | 1.4% | -16.5% | -18.9% | [-22.3%, -14.6%] |
| L10_T5 | 436 | 17 | -21.3% | [-27.4%, -10.7%] | -9.6% | 3.7% | 0.7% | -21.3% | -23.7% | [-29.8%, -13.1%] |
| L10_T15 | 436 | 17 | -27.1% | [-29.1%, -25.3%] | -10.2% | 1.8% | 0.0% | -27.1% | -29.4% | [-31.5%, -27.7%] |
| L10_T60 | 436 | 17 | -27.1% | [-29.2%, -25.4%] | -10.6% | 1.8% | 0.0% | -27.1% | -29.5% | [-31.6%, -27.8%] |
| L10_ST2 | 436 | 17 | -12.9% | [-15.5%, -9.6%] | -9.1% | 6.4% | 1.4% | -12.9% | -15.3% | [-17.9%, -11.9%] |
| L10_ST10 | 436 | 17 | -12.4% | [-15.8%, -8.5%] | -9.1% | 6.7% | 1.4% | -12.4% | -14.8% | [-18.2%, -10.9%] |
| L10_MG2 | 436 | 17 | -22.5% | [-27.9%, -13.9%] | -9.7% | 2.8% | 0.9% | -22.5% | -24.9% | [-30.3%, -16.3%] |
| L10_MG10 | 436 | 17 | -23.4% | [-28.1%, -15.7%] | -9.8% | 2.5% | 0.7% | -23.4% | -25.8% | [-30.5%, -18.1%] |
| L40_T1 | 436 | 17 | -13.9% | [-16.9%, -10.3%] | -3.5% | 7.3% | 0.7% | -13.9% | -16.3% | [-19.3%, -12.7%] |
| L40_T5 | 436 | 17 | -19.2% | [-23.3%, -13.4%] | -4.7% | 3.2% | 0.7% | -19.2% | -21.6% | [-25.7%, -15.8%] |
| L40_T15 | 436 | 17 | -23.1% | [-25.4%, -21.3%] | -5.4% | 1.4% | 0.0% | -23.1% | -25.5% | [-27.8%, -23.7%] |
| L40_T60 | 436 | 17 | -23.1% | [-25.6%, -21.2%] | -5.7% | 1.4% | 0.0% | -23.1% | -25.5% | [-28.0%, -23.6%] |
| L40_ST2 | 436 | 17 | -11.5% | [-14.0%, -8.6%] | -5.4% | 5.3% | 0.7% | -11.5% | -13.9% | [-16.3%, -11.0%] |
| L40_ST10 | 436 | 17 | -12.2% | [-15.1%, -8.9%] | -5.4% | 5.5% | 1.1% | -12.2% | -14.6% | [-17.5%, -11.3%] |
| L40_MG2 | 436 | 17 | -20.0% | [-23.9%, -15.0%] | -5.4% | 2.3% | 0.9% | -20.0% | -22.3% | [-26.2%, -17.4%] |
| L40_MG10 | 436 | 17 | -20.6% | [-24.2%, -15.8%] | -5.4% | 2.1% | 0.5% | -20.6% | -23.0% | [-26.5%, -18.2%] |
| L120_T1 | 436 | 17 | -9.7% | [-12.5%, -5.4%] | -3.5% | 4.8% | 0.5% | -9.7% | -12.0% | [-14.9%, -7.8%] |
| L120_T5 | 436 | 17 | -12.5% | [-16.1%, -7.7%] | -3.7% | 2.8% | 0.7% | -12.5% | -14.9% | [-18.5%, -10.0%] |
| L120_T15 | 436 | 17 | -16.3% | [-18.6%, -14.4%] | -4.1% | 0.7% | 0.0% | -16.3% | -18.7% | [-21.0%, -16.8%] |
| L120_T60 | 436 | 17 | -16.4% | [-18.7%, -14.6%] | -4.2% | 0.7% | 0.0% | -16.4% | -18.8% | [-21.1%, -16.9%] |
| L120_ST2 | 436 | 17 | -7.4% | [-10.0%, -3.9%] | -4.0% | 4.4% | 0.9% | -7.4% | -9.8% | [-12.4%, -6.3%] |
| L120_ST10 | 436 | 17 | -9.0% | [-11.2%, -6.2%] | -4.0% | 4.1% | 0.7% | -9.0% | -11.3% | [-13.6%, -8.6%] |
| L120_MG2 | 436 | 17 | -13.7% | [-17.1%, -8.9%] | -4.2% | 1.4% | 0.7% | -13.7% | -16.0% | [-19.5%, -11.3%] |
| L120_MG10 | 436 | 17 | -13.8% | [-17.1%, -9.2%] | -4.2% | 1.4% | 0.5% | -13.8% | -16.1% | [-19.5%, -11.6%] |
| L480_T1 | 433 | 17 | -7.1% | [-8.7%, -5.8%] | -3.5% | 1.6% | 0.0% | -7.1% | -9.5% | [-11.1%, -8.2%] |
| L480_T5 | 433 | 17 | -8.9% | [-10.7%, -7.5%] | -3.5% | 0.9% | 0.0% | -8.9% | -11.3% | [-13.1%, -9.8%] |
| L480_T15 | 433 | 17 | -9.9% | [-11.6%, -8.3%] | -3.5% | 0.2% | 0.0% | -9.9% | -12.2% | [-14.0%, -10.7%] |
| L480_T60 | 433 | 17 | -10.2% | [-12.2%, -8.5%] | -3.5% | 0.9% | 0.0% | -10.2% | -12.6% | [-14.6%, -10.9%] |
| L480_ST2 | 433 | 17 | -7.6% | [-8.7%, -6.5%] | -3.5% | 1.8% | 0.0% | -7.6% | -10.0% | [-11.1%, -8.9%] |
| L480_ST10 | 433 | 17 | -7.6% | [-8.7%, -6.4%] | -3.5% | 1.8% | 0.0% | -7.6% | -9.9% | [-11.1%, -8.8%] |
| L480_MG2 | 433 | 17 | -9.4% | [-11.5%, -7.6%] | -3.5% | 1.4% | 0.2% | -9.4% | -11.8% | [-13.9%, -10.0%] |
| L480_MG10 | 433 | 17 | -9.4% | [-11.5%, -7.6%] | -3.5% | 1.4% | 0.2% | -9.4% | -11.8% | [-13.9%, -10.0%] |

Primary pair L480_T1. Verdict: **not supported**.

| filter | n | mean | 95% CI | one-sided p | Holm p | stress mean | passes |
|---|---|---|---|---|---|---|---|
| F1 | 183 | -11.7% | [-15.1%, -8.9%] | 1.0000 | 1.0000 | -14.0% | no |
| F2 | 145 | -4.7% | [-6.1%, -3.4%] | 1.0000 | 1.0000 | -7.1% | no |

## Review and checks

- Before the first result, a fresh-context reviewer checked the code. Fixed: slot-day keys, signature listing
  that started from today, the quote-mint check, the creator set and a completeness check (amendment 2).
  It found no look-ahead and no error in the curve or pool maths.
- A second reviewer checked the pool-thinning and prefix code after the first results. Fixed: an ST sell on a
  thinned pool is now priced after every swap of its slot, not after the first one; 0 fallbacks occurred. The
  rerun moved ten ST pairs by at most 0.02 points, the primary pair did not change, and the verdict is the same.
  Checks from cached data (`check_pools.py`, no new calls): all 28 pools were thinned by the same rule. 2 pools
  had a few unfetched slots between pool creation and first swap + 10 (MG exits there may use an earlier
  state). In 6 pools, 49 of about 430 time checkpoints fell on a slot with no swap, so those T exits use the last
  fetched swap before it. That is an earlier state, not a later one.
- Upper bound on any pool-replay error (`sensitivity.py`): every launch that reached the pool is given its best
  return over all 40 pairs (hindsight). The validation primary is then still **−4.3%**, interval [−8.2%,
  +2.5%]. Pool replay errors cannot turn the result positive.

## Caveats

- Landing at slot +2 assumes our buy goes after every trade in that slot, against snipers who pay for
  priority. That is optimistic. The stress line (0.001 SOL tip per transaction) costs about 2.4 points more
  per trade at a $10 size.
- Sells are priced into the observed state without our own buy. That is conservative by about the impact of a
  $10 buy (≈ 0.3% on a 30 SOL curve).
- Our trades are assumed not to change anyone else's behaviour.
- Pool liquidity changes between fetched swaps are not tracked.
- Stop/trail marks on thinned pools are taken at fetched swaps only (amendment 3), so the effect on ST is in an
  unknown direction. Only 26 launches reached the pool, so this is small.
- The prefix stop depended on credit spend, so "uniform subset" is approximate, at about the weight of one coin.
- The sample is 916 launches. The validation interval is tight (±1.5 points for the primary), but a rare
  jackpot that a larger sample would catch cannot be ruled out. The largest multiple seen was 29.8× in
  discovery and 12.1× in validation.
- Covers 2026-07-22 to 2026-09-06 only. Launch mechanics (fees, mayhem mode, slot length) changed during it
  and may have changed since.
