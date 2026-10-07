# Hype Test 1: paid attention at entry (results)

Run 2026-10-08 about 07:30 Melbourne. Rules: `PREREG.md` (committed `2349dfe` before the first API call; amendment A1 after the code review, before any outcome was seen). Code: `analyze.py` (run), `fetch_prices.py` (prices), `artefacts.py` (one report-only check added after the run). Raw output: `results.json` and `retention.json`. Downloads stayed in the session scratch directory. No pump.fun request was made.

## Verdict

**Kill (a): drop paid attention at entry as an entry signal.**
- The primary difference (PAID minus UNPAID, capped mean net, R1 hourly line, $10) is **-4.8 points a trade**. Its 98.33% day-block interval (the Holm level) is -11.5 to +2.8, so it includes 0. The bootstrap p is 0.114.
- PAID's capped mean (-27.1%) lies inside the band of random same-day-matched groups (-28.0% to -20.2%).
- Both kill-(a) conditions hold. No sensitivity run changes that.

## Data

| Item | Count |
|---|---|
| Mints drawn (all created before 2026-08-21, asserted in code) | 3,000 |
| DexScreener orders: HTTP 200 | 3,000 (100%; data kill needs at least 95%) |
| GeckoTerminal files fetched (failures 0; 19 pools refetched; 1 empty) | 3,000 |
| Usable for R1 (`runner.coins`) | 1,605 |
| Dust pools / start-missing (including any non-SOL quote) / no-entry / no data | 949 / 394 / 51 / 1 |
| Entry + 14 d past the last bar before the wall | 2 |
| **Usable with known PAID status** (data kill needs at least 1,200) | **1,603** |
| PAID (approved profile paid at least 15 min before t_e) | 617 (38.5%) |
| UNPAID | 986 |

**Retention check (before the fresh fetch).**
- All 900 exploration mints answered with HTTP 200.
- 20 approved profiles paid on 07-22..07-24 are still returned, so old orders are kept.
- Coins with any approved profile: 23.8% in the exploration 900 vs 22.0% in the fresh 3,000. That is a 1.8-point gap, under the 10-point caveat line.
- The per-day gap ranges from -24 to +29 points (about 30 coins a day in the exploration sample). The mean gap is -1.7 points.

## Primary

Net returns are in SOL terms. The R1 hourly-pessimistic line is used at $10 (0.0838 SOL). No trade reached the 20x cap, so the capped and uncapped means are equal.

| | PAID | UNPAID | Difference |
|---|---|---|---|
| n | 617 | 986 | |
| **Mean net, capped at 20x** | **-27.1%** | **-22.3%** | **-4.8 pts** |
| 95% day-block CI of the difference | | | -10.3 to +1.3 |
| 98.33% day-block CI (Holm level, m = 3; Test 2 absent, so its p = 1) | | | **-11.5 to +2.8** |
| 95% coin-level CI | | | -10.5 to +1.7 |
| Bootstrap p (day-block, two-sided) | | | 0.114 (Holm: not rejected at 0.0167) |
| PAID's own mean, 98.33% day-block CI | -32.3% to -20.5% | | |
| Random same-day groups, 98.33% band (95% band) | -28.0% to -20.2% (-27.5% to -20.8%) | | PAID inside both |
| Mean log(1 + net), floor 0.001 | -0.668 | -0.975 | +0.31 (95% CI +0.13 to +0.48) |
| Median net | -32.6% | -7.5% | |
| Win rate | 7.3% | 3.7% | |
| SD (capped) | 0.69 | 0.44 | |
| Best trade / mean without it | +1,297% / -29.3% | +592% / -22.9% | |
| Trades returning 10x or more (50x or more) | 1 (0) | 0 (0) | |
| Exits: stop / trail / time | 372 / 45 / 200 | 259 / 46 / 681 | |
| Median at entry: c[1]/c[0]; hour 0-1 volume (GeckoTerminal units) | 0.76; 1,923 | 0.99; 973 | |

**Unfiltered R1 basket (benchmark c).**
- 1,603 trades, mean -24.1% a trade (95% day-block CI -26.3% to -21.9%).
- 1 trade returned 10x or more; none returned 50x.
- Fixed $10 bets: -$3,869 in total. Without the PAID coins: -$2,196.

## Sensitivity and diagnostics (report only)

| Run | n PAID / UNPAID | D capped (95% day CI) | Holm-level CI |
|---|---|---|---|
| Primary | 617 / 986 | -4.8 (-10.3, +1.3) | (-11.5, +2.8) |
| 60-min buffer (PAID60) | 540 / 1,063 | -3.3 (-8.9, +3.0) | (-10.0, +4.6) |
| Cancelled orders counted | 620 / 983 | -4.7 (-10.1, +1.5) | (-11.3, +2.9) |
| Without coins with a non-approved profile order (7) | 614 / 982 | -4.8 (-10.2, +1.4) | (-11.4, +2.9) |
| Without the 5 outcome-viewed coins | 615 / 983 | -5.2 (-10.9, +1.1) | (-12.1, +2.6) |
| Covariate-adjusted (9 strata of c[1]/c[0] x hour 0-1 volume) | 617 / 986 | -2.2 (-7.6, +3.4) | (-8.7, +4.7) |
| Close-triggered stop | 617 / 986 | -5.4 (-10.9, +0.7) | (-11.9, +2.2) |
| Real-time line (optimistic bound) | 617 / 986 | -6.9 (-15.0, +1.7); means -12.5% vs -5.6% | (-16.7, +3.7) |
| **R3, no stop** | 617 / 986 | **-14.7 (-21.8, -7.5)**; means -38.5% vs -23.9% | (-23.3, -5.9) |
| BOOST (descriptive) | 94 / 1,509 | -8.9 (-24.0, +10.8) | |
| CTO (diagnostic; 5 coins) | 5 / 1,598 | -35.1 | |

- **Sign.** The 15-min and 60-min buffers agree in sign (both negative). The sign-flip rule does not apply.
- **What the stop does.** Without the stop (R3), PAID coins are clearly worse: -14.7 points, an interval below 0 even at the Holm level. With R1's stop, most of that gap disappears. PAID coins are stopped far more often (372 of 617, 60%, vs 259 of 986, 26%). So the stop, not the flag, is doing the work. This matches the exploration finding: paid coins are already falling at entry (median c[1]/c[0] 0.76 vs 0.99).
- **Log mean favours PAID; the capped mean does not.**
  - UNPAID has twice the share of near-total losses: 129 of 986 trades lost 90% or more (13%), vs 40 of 617 (6.5%). All of these are stops filled at an hourly close far below the level.
  - So PAID coins lose more often but less catastrophically. The PREREG puts the verdict on the capped mean. The log result is reported beside it and changes nothing.
- **Covariate-adjusted.** With price and volume at entry held constant, the gap shrinks to -2.2 points. Most of what PAID "says" is already in the hour-1 price.
- **Big coins.**
  - 18 usable coins had a peak close of 10x or more within the hold; 9 were PAID.
  - Coins reaching 5x: 22 of 617 PAID (3.6%) vs 14 of 986 UNPAID (1.4%).
  - R1 captured almost none of it. One trade returned 10x or more (a PAID coin, +1,297%).
  - The 50x question is not testable at this n.
- **Price-data artefacts.**
  - Spike prints were found in 6 holds, 5 of them PAID: a close at least 5x the previous close on under 5 units of volume, carried through hours with no trades. Examples: 9MfTt3kp at "517x" and DuCZ8Wgd at "154x".
  - Without those 6 coins, D = -4.8 points (98.33% CI -11.3 to +2.8). No change.
  - This check was not pre-registered (`artefacts.py`). It means the peak-10x list overstates real runners.

**Against the exploration result (492 coins, same 30 days).**
- PAID share: 41% in exploration vs 38.5% here.
- Capped means: exploration -31.7% vs -10.2% (a 21.5-point gap); fresh -27.1% vs -22.3% (a 4.8-point gap).
- Uncapped: exploration -31.7% vs +27.9%, which rested on one ~130x UNPAID coin; fresh -27.1% vs -22.3%.
- The direction repeats (paid is not better), but the size of the exploration gap does not.

**Power at the result.** At the observed SDs (0.69 and 0.44) and group sizes, the standard error of D is about 3.1 points iid; the day-block CI implies about the same. At alpha 0.0167:
- a 15-point difference had over 99% power;
- an 8-point difference had about 57%.

The test could have found a lift big enough to matter for the gate. It found none.

## Caveats
- **Calendar days.** The fresh coins share their 30 calendar days with the exploration sample. This repeats the exploration on new coins; it does not test a new time period.
- **Payment time vs visibility.** The delay between paymentTimestamp and the profile becoming visible is unknown (Test 3 measures it). The 60-min buffer gives the same answer.
- **Hourly bars.** The hourly line fills a gapped stop at the hour's close. Near-total losses (8% of trades) come from that. A transaction-ordered replay would be more exact.
- **Inactive-pool spot-check.** The check of about 20 inactive pools for missing GeckoTerminal data was not done: no allowed second historical source exists. Spike prints were found and reported above.
- **Quotes and outcome-viewed coins.**
  - Null-quote rows were not checked on-chain. A non-SOL quote would fall into the 394 start-missing coins.
  - The outcome-viewed set is the deep-pool universe overlap (5 coins), not the unrecorded "top 10 by market cap" list.
- **Terms.** GeckoTerminal's keyless terms (storage, "not for production or scheduled polling") are unverified and remain an owner risk item. The universe came from earlier scripted pump.fun access, which the owner decided to keep on 2026-10-07.
- **Holm level.** It assumes Test 2's two primaries are untested (p = 1). If Test 2 later rejects both, PAID's level would relax to 0.05. Even then, its 95% interval (-10.3 to +1.3) still includes 0 and the verdict stands.

## In plain words
1. We checked 3,000 new coins and whether each had paid for a DexScreener ad before we would buy.
2. 1,603 coins could be traded under our rules; 617 had paid.
3. With the R1 stop, paid coins lost 27% a trade and unpaid ones lost 22%. That 5-point gap could be luck.
4. Random groups of coins did just as badly as the paid ones. So "paid for an ad" does not pick winners. Rule: drop it.
5. Without the stop, paid coins lose clearly more. They are often already falling when we buy, and the stop saves us.
6. The plain R1 basket loses about 24% a trade. A filter here cannot fix that.
