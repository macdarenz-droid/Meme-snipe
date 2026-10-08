# Maker probe (design C): result

Scored once on 2026-10-08 with `maker.py` at commit `9da69fe` (rules in `PREREG.md`, pushed at `69dfdb8` before any bar was downloaded; review amendments at `9da69fe`, before scoring). Paper research only.

## Verdict
**Not supported**, at both 99.58% (judged) and 95% (shown). It fails two of the three pass conditions. The fill floor is met (152 ≥ 30), so the result is not "unresolved".

| Validation (09-01 to the 09-21 wall), $50 a fill, in SOL | Value |
|---|---|
| Fills | 152 (21 days, 11 of 12 pools) |
| Mean net per fill | −1.41% = −0.0059 SOL (q = 0.419 SOL) |
| 99.58% day-bootstrap interval | −2.68% to −0.42% (fails: the lower bound must be above 0) |
| 95% day-bootstrap interval | −2.24% to −0.69% |
| Day-cluster t-interval, 99.58% (shown) | −2.75% to −0.08% |
| S0 (random-bar taker, same exits, same exit-only costs) | −0.99% (1,658 entries) |
| Lift over S0 | **−0.43 points** (fails: at least +0.45 needed) |
| Mean gross | −0.78% (S0 −0.36%) |
| Win rate | 37% |

Shown, not judged:
- S0 with full deep-pool taker costs: −1.24%. The maker is still 0.17 points worse than that.
- MR-A as a taker (realistic line, round-trip costs): −0.85% net, +0.05% gross, 135 trades.
- Discovery (07-22 to 08-31): maker −1.48% net over 292 fills (99.58% −2.15% to −0.78%), S0 −0.78%, lift −0.70 points. It points the same way.
- How fills ended: 88 of 152 timed out at 30 minutes, and 24 hit the stop inside the fill bar.

## In plain words
- The idea was to rest a cheap buy order well below the price and catch sharp dips without paying the entry toll.
- The orders did fill: 152 times in three weeks. But a dip deep enough to fill the order usually kept falling. Bought this way, the coin did worse than one bought at a random moment (−0.78% against −0.36% before costs).
- Skipping the entry fee does not make up for that. The maker seat lost 1.4% a trade, which is worse than just buying at random and paying the full fee both ways.
- This is adverse selection, the doubt the design named at the start: a resting bid fills exactly when the price is running through it.

## Limits
- Proxy fills: a PumpSwap 5-minute low under the bid stands in for a DLMM fill. Real DLMM depth, bin steps and fees were not read. No DLMM fee is credited, which is conservative for C: a resting bid would earn the swap fee on each fill. (Parent-session correction, 2026-10-08: the original text said "optimistic". The verdict holds anyway, because the 99.58% lower bound of −2.68% stays below 0 unless the fee earned on a fill were above about 2.7%.)
- Survivorship: the 12 coins are today's list, which favours buying dips. A null under that bias is stronger, not weaker.
- About 21 validation days. Pool coverage is uneven: PAID has 6 eligible days, OTC 13, fone 19 and TOAD 20.

## Data
GeckoTerminal only (`fetch.py daily` and `bars`), downloaded 2026-10-08 after the pre-registration push and kept outside the repo. No Helius calls and no pump.fun requests. The first 16 hex digits of each SHA-256 are below (bars / daily); the full hashes are in `results.json` `manifest`. Eligibility file SHA-256: `d281e0858102f177b53f6cc187751fd876488c8a827bfe158578d1647c9563af`.

Cupsey 9a4929546a8c4c00 / 8c6763ccd4415bbd · PAID b537acdaf75e83e2 / 120a559ca78f4b5a · KET 1cc81af08be254e4 / 2eb2c8813aab32ed · ANSEM f37db6b15e9cdbb0 / f82aa0412855b0aa · TOAD 04a5cf4318b162d8 / 79a05aa2cc714670 · CATE eef6c2a61ad60141 / a516146bf2049e9f · MANIFEST 28b77fe2aeb6cb55 / 39da71a7bd2a4d89 · fone 57737463e85fc051 / c6be023ec30ec949 · Buttcoin bd0c811084ac8111 / bf6a7e3c4343bf49 · Jimothy 49f88b813b6b1294 / 85f6b980287f9ad1 · TripleT ed101edda4bcffc9 / fc6bcc623680f86d · OTC 2b5f2ce3268e44f8 / aee3e3890d33abeb
