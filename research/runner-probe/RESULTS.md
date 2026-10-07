# Runner probe: validation result (run 2026-10-07)

Run exactly as pre-registered (`PREREG.md` with both amendments; code at 98b7b50):
`python3 -I runner.py validate validation_sample.json <hourly> <out>`. Full output: `results/validation.json`.

**Verdict: primary R1 not supported. R2, R3 and R4 not supported.**

## Coins
900 sampled (created 2026-08-21..09-06):
- 443 usable;
- excluded: 287 dust pools, 159 start-missing, 10 with no tradeable entry, 1 with no data;
- 1 entry excluded by the entry-time cutoff.

That leaves 442 trades per rule.

## Primary: R1 on the hourly line, $10 (SOL terms)

| | Validation | Exploration (for reference) |
|---|---|---|
| Mean a trade | **−22.4%** | +3.6% |
| Median | −11.1% | |
| Win rate | 2.9% | 5.5% |
| Best trade | +1000% (11× proceeds) | +12,975% (one ~130× coin) |
| Mean without the best trade | −24.7% | −22.9% |
| Trades with ≥ 10× proceeds | 1 (exact 95%: 0.006%–1.25%) | 1 |
| Trades with ≥ 50× proceeds | 0 (exact 95%: 0%–0.83%) | 1 |
| Real-time line (optimistic bound) | −7.9% | +28.5% |

- **Realised bins (hourly line, $10):**

  | Bin | Trades | Summed net, in stakes |
  |---|---|---|
  | Stop or worse | 160 | −92.5 |
  | Small losses | 269 | −24.0 |
  | 0 to 2× proceeds | 10 | +3.6 |
  | 2× to 10× | 2 | +4.0 |
  | 10× to 50× | 1 | +10.0 |
  | 50×+ | 0 | 0 |

- **Loss bill:** the trades under 10× sum to −109 stakes. One winner of about +110× net in 442 trades would only have broken even.
- **Sensitivity:**
  - without the best trade: −24.7%;
  - best payout halved: −23.5%;
  - non-winners 5 points worse: −27.4%;
  - losing every second 10× winner: −22.4% (only one exists).
- **Calendar:** the 4 entry weeks were all negative. The mean of weekly means is −17.4%, approximate 95% −26.1% … −8.7%, from only 4 weeks.
- **Account:** $10 at each entry, positions overlapping. The total is **−$989** on the hourly line (−$349 on the optimistic line). Peak capital tied up was $3,900.

## Secondary rules ($10, validation)

| Rule | Hourly line | Optimistic line | Best trade |
|---|---|---|---|
| R2 (trail 60%) | −23.6% | −12.1% | 7.1× net |
| R3 (no stop, trail 40%) | −24.9% | −17.8% | 10.0× net |
| R4 (half at 5×, rest trails 60%) | −23.0% | −11.5% | 5.5× net |

Every rule loses at $3, $10 and $50 on both lines.

## What it means
- The rare giant winner that carried the exploration result did not appear among 442 fresh trades. The best was 11× proceeds.
- That is not proof that giants never come back: with one in 492 before, finding none in 442 has roughly a 16–40% chance. But the rule needs about one +110× winner per 450 trades merely to break even. Nothing in this sample supports that rate.
- The tail is not recurring at a usable rate, and the result is negative even on the optimistic execution line. By the outside reviewer's decision table, this strategy is **shelved**.
- The exploration jackpot is being replayed at transaction level (`../execution-audit/`). First result: a real-time trail would have sold that coin at about 27× (one swap crashed it from about 100× to 27×). The hourly-close rule sold at about 132× because it never saw that intra-hour crash. The exploration's "about 330× real-time" figure was therefore an artefact of hourly bars.
