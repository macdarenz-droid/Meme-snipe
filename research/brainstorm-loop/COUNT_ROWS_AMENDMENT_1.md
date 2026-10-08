# Step A count rows, amendment 1: answers to the tape code's open questions

Design owner's rulings (brainstorm partner), 2026-10-08, before any threshold is applied. They answer `research/brainstorm-loop/tape/OPEN_QUESTIONS.md` on origin/ccr-7fae2302-drz4co. Every item not named below is confirmed as the code reads it.

## Shared
- **Q1 Intervals:** a pool-clustered bootstrap stratified by day, the same as the designs' primaries. Event and control sets are resampled separately, by pool within day. 10,000 resamples, seed 20261008.
- **BOOST rows:** removing them by `BoostBuyAndBurnEvent` signature is correct. The `protocol` flag reading 0 on BOOST rows is a decoder or README defect for the tape builder.

## REBUY-ANCHOR
- **Q14, what may be read:** these rows may read as-of price levels and as-of past returns, because they describe other traders' behaviour and not our strategy's outcome. That covers the price compared with an ex-holder's sale price at the rebuy decision, ex-holders' realised gains, and past returns, drawdown, age and depth for the R² row. No count row may read any price or price change **after** its decision or event point. Flows after the point (SOL bought and sold) are allowed, as in DEV-ZERO.
- **Q15, decisions:** hourly points from migration + 60 min to + 12 h, on canonical non-mayhem SOL pools.
- **Q15, the rebuy-pressure measure (RB):** RB = the exit proceeds (SOL) of gain ex-holders who exited in the last 12 h, whose sale price is above the current price and whose proceeds are readable (signer = owner), divided by effective quote.
- **Q15, the materiality row:** net rebuy flow = ex-holders' buy SOL minus all other holders' sell SOL, in (t + 23 slots, t + 2 h], divided by effective quote. Compare top-quintile RB points with points within ±10 percentile points of the median RB, within the same day and drawdown tercile. The difference must be at least 3.4%, with a 95% lower bound above 0 (Q1 method). This replaces "predicted" net rebuy SOL with the measured flow.
- **Cost ledger:** reuse H1-CGO's per-(mint, owner) ledger code, with ex-holder exit price and realised gain added.

## SEAT-DRIFT
- **Q9:** "Lone" is the bottom tercile of N_m and "busy" the top tercile. Terciles are taken over each discovery day's eligible graduates. N_m = 0 alone would be too rare at about 1–2 graduations a minute.

## Two-sided clusters
- **Q13, narrowed:** only clusters of 2 to 50 owners are labelled. Larger components are hub artefacts (exchanges, routers), not wash rings. Report the share of swap rows labelled before and after the cap.

## Row 6 (round USD)
- **Q19:** use `base_supply` until A amendment (a)'s program read says otherwise.
- **SOL/USD input:** the Binance public archive SOLUSDT 1-minute closes for each tape day, committed with their sha256.
- **Market-cap levels:** these are as-of states, so they are allowed (Q14 rule).
