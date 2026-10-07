# Established-meme trend probe: result

Run 2026-10-07 on commit `a492e0c` (rules in `PREREG.md`). Exploration, not proof. 19 large memes, prices in SOL, weekly decisions 2024-01-01 to 2026-09-14.

## Verdict (as registered)
All four rules: **not supported**.

## Numbers (base costs, 0.6% a round trip; weekly returns in SOL)

| Rule | Discovery mean / compounded | Validation mean / compounded | Validation 95% CI of weekly mean | vs hold-all (validation) |
|---|---|---|---|---|
| TSM-28 (hold while 28-day SOL return > 0) | −0.21% / −62% | −1.36% / −69% | −3.98 to +1.27 | −0.45 |
| TSM-14 | +2.74% / +72% | −1.89% / −77% | −4.05 to +0.26 | −0.99 |
| XS-MOM (top 3 by 28-day return) | −1.23% / −75% | −1.10% / −63% | −3.54 to +1.34 | −0.19 |
| XS-REV (bottom 3 by 7-day return) | −1.82% / −86% | −1.72% / −71% | −3.37 to −0.07 | −0.81 |
| Hold all (benchmark) | +2.33% / +26% | −0.91% / −51% | −2.64 to +0.83 | — |
| Hold SOL (benchmark) | 0 | 0 | | |

Discovery: weeks before 2025-07-01 (79). Validation: 2025-07-01 to 2026-09-14 (63).

## What it means
- Measured in SOL, large memes rose in 2024 to mid-2025 (+26% as a basket) and fell after (−51%); over the whole period holding SOL beat holding memes and beat every timing rule.
- Trend-following whipsawed: it paid costs entering rallies that reversed. No rule beat simply holding SOL.

## Limits
Perp closes stand in for spot; the coin list was picked with hindsight (coins large enough for a perp listing; MYRO's delisting is kept); weekly rebalancing to equal weight is not charged.
