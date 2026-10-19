Sample: {'migrations': 16546, 'fetched': 1272, 'err': 0, 'empty': 0, 'used': 1272}; holdout=True

| Trial | n | Win | Mean net | Median net | 95% CI (coins) | 95% CI (days) | SOL total | H9 out | H9 unknown | Exits |
|---|---|---|---|---|---|---|---|---|---|---|
| T3-H4-H8only | 11 | 27% | -9.3% | -15.9% | -17.9% to +0.8% | -18.8% to -2.4% | -0.0170 | 0 | 0 | price_stop 7, time_flat 2, trailing_stop 2 |

Funnel (furthest stage per graduate; gate = first failing modelled gate):

- T3-H4-H8only: H8:floor 868, H11:chase 295, no-setup 54, H11:spike 23, stop-check 11, entered 11, H8:dust 10

## Size sweep and gross

Same signals; exits re-simulated at each size. "Allowed" = trades the bot would still take: pool quote side >= max(trial floor, 1,000 x size) (R12) and entry impact <= 1%.

| Trial | n | Gross (no costs) mean, 95% CI | Size | Net mean | 95% CI | Win | Median entry impact | Allowed n | Allowed net mean (95% CI) |
|---|---|---|---|---|---|---|---|---|---|
| T3-H4-H8only | 11 | -4.3% (-13.2% to +6.3%) | $2 | -9.3% | -17.9% to +0.8% | 27% | 0.02% | 11 | -9.3% (-17.9% to +0.8%) |
|  |  |  | $5 | -8.2% | -16.7% to +1.8% | 27% | 0.05% | 11 | -8.2% (-16.7% to +1.8%) |
|  |  |  | $20 | -7.7% | -16.2% to +2.4% | 27% | 0.19% | 0 | — |
|  |  |  | $100 | -8.7% | -17.2% to +1.3% | 27% | 0.96% | 0 | — |
|  |  |  | $1,000 | -17.0% | -28.0% to -3.5% | 18% | 8.81% | 0 | — |
|  |  |  | $10,000 | -65.8% | -70.3% to -60.6% | 0% | 49.15% | 0 | — |

Deflated Sharpe of the best-mean trial: None
PBO (CSCV, 10 day blocks): None
