# CROWD-BREAK-SHORT: results

Run 2026-10-09 (Melbourne) on branch `ccr-7fae2302-drz4co`. The PREREG was frozen at c898f8df. Paper research only.

## Verdict: KILLED (PREREG §7)
- **Mean net n is −0.92% per trade**, below 0 (kill rule).
- **Mean lift d over matched ordinary breakdowns is −0.19 points**, below 0 and below the 0.60% round trip (kill rule).
- The primary was scored once, at 99.5%, on 376 events, 228 UTC days and 20 coins. All 376 events were executable and all had a full C1 set.

| Measure | Value | 99.5% day-block bootstrap | 99.5% day-clustered t |
|---|---|---|---|
| Mean n (median) | **−0.92%** (−0.81%) | −1.96% to +0.27% | −2.07% to +0.22% |
| Mean d (median) | **−0.19 pts** (−0.13) | −1.27 to +0.99 | −1.34 to +0.96 |
| Halves (split 2025-07-13): n / d | −1.04% / −0.13 (187); −0.81% / −0.24 (189) | | |
| Entry-delay lines: T + 60 s / T + 120 s | −0.92% / −0.91% | | |
| Cost lines: 2× / low (0.40%) | −1.52% / −0.72% | | |
| Liquidation line (1.714×, assumed) | −0.92% (0 liquidations) | | |
| Gross before costs | −0.32% | | |
| Funding received, net of the SOL leg | +0.02% | | |
| C1 mean / C2 mean / win rate | −0.74% / −0.68% / 42.6% | | |

- Per coin (events, mean n): kBONK 44, −2.26%; WIF 39, −0.01%; POPCAT 28, −1.18%; TRUMP 28, −1.46%; CHILLGUY 25, +0.28%; GOAT 25, −0.70%; FARTCOIN 23, −1.13%; GRIFFAIN 22, −1.85%; MYRO 20, +0.21%; VINE 18, −2.88%; BOME 17, −0.96%; SPX 17, −0.04%; MEW 14, +0.34%; PENGU 12, +0.44%; MELANIA 10, +0.01%; ZEREBRO 10, −0.56%; AI16Z 9, −3.42%; MOODENG 8, +0.81%; PNUT 5, −3.83%; DOOD 2, +3.43%.
- The owner's 300-trade proof standard: 376 trades here, but the result is negative, so the standard does not apply.

## In plain words
- The idea was to bet against a meme coin when many traders were betting on it going up with borrowed money (high funding and high open interest), right as its price broke down.
- The setup was real: after these breakdowns, open interest fell 5% or more within 6 hours about 9.6% of the time. After ordinary breakdowns of the same coin it fell only 3.2% of the time. So the crowd really did get flushed out.
- Shorting it still lost money: about −0.9% per trade after costs. That was no better than shorting an ordinary breakdown of the same coin (−0.2 points).
- Even before costs it lost (−0.3%). This is not something to trade.

## Gate (§3, reads no return): PASS
- 20 coins with at least 600 hours of overlap (10 needed).
- Median Hyperliquid funding at event hours: +0.0067% per hour, above 0.
- OI mechanism check: share of events with OI down 5% or more by T + 6 h was 9.6%, against 3.2% for the first 10 ranked C1 controls. The difference was +6.4 points; one-sided 95% lower bounds were +3.6 (bootstrap) and +3.5 (t). 375 of 376 events had both OI values.
- Excluded coins: USELESS and JELLY (0 evaluable overlap hours); YZY and LAUNCHCOIN (no Binance OI, klines or 1-minute data).

## Freeze and data
- **Stage 1** (`stage1.json`, SHA-256 `4874cabd99e50c8c157cdd2661df5f3ae246cf3d0b392ef690cd4574e872664d`) was committed in c03a638 with `gate.json`. The 1-minute prices after any T were downloaded after that.
- **Results:** `results.json`, SHA-256 `1d51fca5693395014aed542371acc54eadebc9fb24964e9169cdb210c755031f`. It holds every trade with its controls.
- **Data** was free and keyless only. Nothing at or after 2026-09-21T14:00Z was used.
  - Binance archive: OI metrics and 5-minute klines (`research/squeeze-probe/fetch_bn.py`, zip SHA-256 in `bn_manifest.json`), and 1-minute USD-M klines for the months in `needs.json` (`fetch_1m.py`, 302 zips, manifest SHA-256 `6b8c89cb…`).
  - Hyperliquid: hourly funding (`research/short-probe/fetch_hl.py`, file-set hash `208dd07f…`).
  - Downloads are kept outside the repo.

## Choices the PREREG left open (fixed before scoring, documented in the scripts)
- **Gate:**
  - "falls 5% by T + 6 h" is read as the end-point change;
  - the C1 set is the first 10 ranked candidates, since an executability test would read a post-T price;
  - each event needs at least 3 controls with OI;
  - the one-sided 95% bound must hold for both bootstrap and t.
- **Stage 2:**
  - 1 − r_meme is floored at 0 (a 1x short cannot lose more than its collateral);
  - funding is taken by settlement-hour slot within [entry, exit), weighted by price over entry, minus the SOL-perp long's Hyperliquid funding (H1-PERP "both legs");
  - the low cost line is 0.40% (coin leg 0.30% plus SOL-leg fees 0.10%);
  - an event enters the lift set with at least 3 executable controls (squeeze rule);
  - a trade whose exit would fall after the wall is non-executable.
- **Statistics:** the day-block bootstrap and day-clustered t are those of the squeeze stage 2, at 99.5% two-sided. Its lower bound is stricter than a one-sided 0.005.

## Review
- One fresh review (opus) checked the scoring scripts before scoring. It found:
  - 1 blocking item: missing month files were read as empty;
  - 3 should-fix items: the exit-before-wall rule, funding by settlement slot, and SOL-leg funding.
- All were fixed in ce7bd0d before the single scoring run. Its notes on stage 1 and the gate found them faithful to §3–4 and §6.

## Notes and omissions
- **T + 7 s equals T + 60 s.** T is a multiple of 300 s, so both enter at the T + 60 s minute. The PREREG's T + 60 s pass line therefore tests nothing new. The T + 120 s line is reported.
- **Not computed:**
  - the size lines ($5–$10,000), because the cost model does not vary with size. $5 is also below Hyperliquid's $10 minimum, which is UNVERIFIED;
  - the Hyperliquid basis stress. Its ~17 days of 5-minute data now fall after the wall.

  Neither feeds the verdict.
- **Sign check:** 2026-09-22..10-20 may be read only after 2026-10-21. It was not read, and it cannot rescue a KILLED verdict.
- **Honesty note (§1):** these coins' prices, OI and funding were already read by earlier probes. A pass would have earned only forward paper trading. The kill is what the data says.
