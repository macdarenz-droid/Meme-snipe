# Maker probe (design C): rules fixed before any bar is downloaded

Paper research only. Written and pushed on 2026-10-08 before any 5-minute or daily bar for this probe was downloaded and before any return was computed. Nothing here enters the bot. A change after this commit is an amendment with a reason, never an edit in place.

## Frozen source rules (restated)
- Design: `research/EDGE_DIALOGUE.md:158-185` ("Design C: maker seat"), inside the freeze at `:136-138` (family k = 12, so 99.58% intervals judge; 95% shown beside them).
- Coins: the 12 coins with `passes_50_sol: true` in `research/deep-pool-probe/dlmm_gate0.json`. Their PumpSwap pools come from `research/deep-pool-probe/universe.json` (mint → `pool`): ANSEM, CATE, OTC, Buttcoin, PAID, fone, Jimothy, TripleT, MANIFEST, TOAD, KET, Cupsey.
- Dates, wall and split: `research/deep-pool-probe/PREREG.md:10-11` (only bars ending at or before 2026-09-21T14:00Z; decisions from 2026-07-22T00:00Z; discovery 07-22 to 08-31; validation 09-01 to the wall); code `research/deep-pool-probe/probe.py:8-12`.
- Bid (`EDGE_DIALOGUE.md:168`): for bar i, bid = close(i−1) × exp(−3σ), renewed every bar. σ is MR-A's (`deep-pool-probe/PREREG.md:24`, `:45`; `probe.py:108-140`): the standard deviation of 5-minute log returns over the previous 864 bars (rets of bars i−864 … i−1), at least 500 of them with volume.
- Fill (`EDGE_DIALOGUE.md:169`): low(i) ≤ bid × 0.995, filled at the bid.
- Limits (`:170`): one open position per pool; at most one fill per pool per UTC day.
- Exits (`:171`): +6% target, −4% stop, 30 minutes, all from the bid, as a PumpSwap taker. A stop fills at min(stop, that bar's close), the fill bar included (as the realistic line, `deep-pool-probe/PREREG.md:43`, `probe.py:176-178`).
- Costs (`EDGE_DIALOGUE.md:172-175`), in SOL at $50 (q = 50 / 119.26 SOL, `probe.py:13-14`): entry none (no fee, no impact, no DLMM fee credited); exit = PumpSwap tier fee (`probe.py:23-33`) + impact q/R with R = sqrt(85 × 206,900,000 × mcap / 1e9) (`probe.py:16`, `:186`) + 0.001 SOL priority fee. Net per fill = gross − fee − q/R − 0.001/q.
- Primary statistic (`:176`): validation mean net per fill, day-bootstrap 99.58% interval.
- Pass, all three (`:177-180`): lower bound > 0; point lift over S0 ≥ +0.45 points; ≥ 30 validation fills. Fewer than 30 fills = unresolved; anything else = not supported (`:181-183`). The 30-fill floor and the kill rules are not loosened.
- Secondary, not judged (`:184`): MR-A as a taker on the same bars.

## Choices the design leaves open (decided here, before data)
1. **Eligible days.** A fill (and an S0 entry) counts only on a UTC day whose previous-day daily close × 1e9 is ≥ 49,120 SOL (groups A + B, the deep-pool primary group, `deep-pool-probe/PREREG.md:14`, `probe.py:45-63`). The daily bars are re-downloaded with `fetch.py daily`, because the committed `eligible.json` was trimmed of its per-day list. Reason: same population as the deep-pool primary result.
2. **Timing inside the fill bar.** The target is never credited on the fill bar (the high may have come before the low). The stop is checked on the fill bar as the design says. After the fill bar, each bar checks the stop before the target (`probe.py:173-180`). Time exit at the close of bar fill+6 (at least 30 minutes after any fill inside the fill bar). Reason: the safest reading.
3. **σ guard.** No bid on a bar whose window has σ ≤ 0, fewer than 500 bars with volume, or close(i−1) ≤ 0. A bar with no volume cannot fill (its carried low equals the previous close, above the bid).
4. **After an exit** at bar x, the next bid is on bar x+1. A fill whose 30-minute window would end after the wall is dropped (`probe.py:168`).
5. **Fee tier and depth** at mcap = bid × 1e9 (the fill price; the realistic line uses the decision price, `deep-pool-probe/PREREG.md:44`).
6. **S0** = deep-pool realistic S0 (`deep-pool-probe/PREREG.md:29`, `:46`; `probe.py:213-228`): one taker entry per eligible pool-day at a pseudo-random bar, 10 fixed seeds, entry at the close of the first bar with volume at or after it, then the same +6/−4/30-min exits with the stop at min(stop, close). **Costs: the same as C** (exit fee + exit impact + 0.001 SOL, no entry cost), as "the same exits and costs" reads literally. This is the stricter reading: S0 keeps the entry toll it would really pay, so the lift measures only where the bid buys versus a random bar. A second S0 line with full deep-pool taker costs (`probe.py:183-187`) is shown, not judged. Lift = C validation mean net − S0 validation mean net (S0 pooled over the 10 seeds).
7. **Bootstrap.** Resample the UTC days that hold validation fills, 20,000 resamples, seed 7, mean of all fills in the resample (`probe.py:230-247` method); quantiles 0.0021 / 0.9979 for 99.58% and 0.025 / 0.975 for 95%. The day-cluster t-interval (`probe.py:270-285`) is shown beside it, not judged.
8. **Verdict is computed only on validation.** Discovery numbers are shown for context and do not enter the verdict (the frozen rule names validation only).
9. **Secondary MR-A taker line** = deep-pool MR-A realistic (`probe.py:192-211`, `real=True`) on the same 12 pools and eligible days, deep-pool round-trip costs at $50.
10. **Data.** `fetch.py daily` and `fetch.py bars` (`deep-pool-probe/fetch.py:64-100`), GeckoTerminal only, at most about 8 calls a minute (the script sleeps 6.5 s per call), saved outside the repo; SHA-256 of every file recorded in `RESULTS.md`/`results.json`. No Helius, no pump.fun requests.
11. **Fresh review.** One fresh-context code review of `maker.py` before the single scoring run. A bug fix from that review is recorded as an amendment here before scoring.

## Known limits (stated before data)
- Proxy: a PumpSwap low that trades through the bid stands in for a DLMM fill; real DLMM depth near the price and bin steps are unread.
- Survivorship: the 12 coins are today's list.
- No DLMM fee is credited and no maker-side cost (order placement, rent) is charged on entry, as frozen.

## Amendments before scoring (2026-10-08, from the fresh-context code review; no return computed)
- Choice 7 wording: the 99.58% quantiles are taken at exactly α/2 = 0.05/12/2 = 0.0020833 (code `maker.py` `LEVELS`), not the rounded 0.0021. Slightly more conservative; the code was already this way.
- `maker.py` now asserts that the eligibility file holds exactly the 12 frozen pools (from `dlmm_gate0.json` via `universe.json`) and records that file's SHA-256. No rule changes.
