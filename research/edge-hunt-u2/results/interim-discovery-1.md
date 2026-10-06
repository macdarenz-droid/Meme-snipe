Sample: {'migrations': 3983, 'fetched': 677, 'err': 0, 'empty': 0, 'used': 677}; holdout=False

| Trial | n | Win | Mean net | Median net | 95% CI (coins) | 95% CI (days) | SOL total | H9 out | H9 unknown | Exits |
|---|---|---|---|---|---|---|---|---|---|---|
| T1-H4-current | 1 | 0% | -22.4% | -22.4% | — to — | — to — | -0.0038 | 0 | 0 | price_stop 1 |
| T2-H4-relaxed | 26 | 8% | -14.1% | -21.5% | -21.4% to -4.2% | -21.2% to -8.3% | -0.0617 | 2 | 0 | negative_flow 1, price_stop 22, time_flat 1, trailing_stop 2 |
| T3-H4-H8only | 8 | 0% | -21.2% | -21.5% | -25.1% to -17.1% | -24.3% to -16.9% | -0.0284 | 0 | 0 | price_stop 8 |
| T4-H4-H11only | 8 | 0% | -22.6% | -23.2% | -25.0% to -19.9% | -25.1% to -19.8% | -0.0305 | 0 | 0 | price_stop 8 |
| T5-H5p-current | 0 | — | — | — | — | — | — | 0 | 0 | |
| T6-H5p-relaxed | 80 | 20% | -13.9% | -24.5% | -18.9% to -8.6% | -20.0% to -6.2% | -0.1874 | 5 | 0 | negative_flow 11, price_stop 47, time_flat 12, trailing_stop 10 |

Funnel (furthest stage per graduate; gate = first failing modelled gate):

- T1-H4-current: H8:floor 586, H11:chase 55, H8:dust 21, H11:spike 8, stop-check 3, no-setup 2, entered 1, H16:not-covered 1
- T2-H4-relaxed: H8:floor 422, no-setup 184, entered 28, stop-check 22, H8:dust 21
- T3-H4-H8only: H8:floor 434, H11:chase 160, no-setup 25, H8:dust 21, H11:spike 21, entered 8, stop-check 7, H16:not-covered 1
- T4-H4-H11only: H8:floor 565, no-setup 72, H8:dust 21, stop-check 11, entered 8
- T5-H5p-current: H8:floor 586, H11:chase 55, H8:dust 21, H11:spike 8, no-setup 6, H16:not-covered 1
- T6-H5p-relaxed: H8:floor 422, no-setup 94, entered 85, stop-check 55, H8:dust 21

Deflated Sharpe of the best-mean trial: {'trial': 'T6-H5p-relaxed', 'dsr': 0.0}
PBO (CSCV, 10 day blocks): 0.19047619047619047
