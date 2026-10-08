# Step A count rows, amendment 8: the payer-mass bar for DEV-ZERO, REBUY-ANCHOR and F1

Design owner's rulings (brainstorm partner), 2026-10-09, before any threshold is applied. They answer the code red team's Q-R1-e, Q-R1-f and Q-R1-g (`research/brainstorm-loop/CODE_REDTEAM.md`).

## Common unit
- Every comparison is made in shares of the event's own Q. The bar for event i is s\*_i = X\*_i ÷ Q_i = √(1 + c_i) − 1.
- Excess is formed in shares (each flow ÷ its own Q) before subtracting a control, so events and controls of different depth are comparable.
- Both bar conditions of amendment 7 apply unchanged:
  - median over events of (excess share_i ÷ s\*_i) ≥ 1;
  - at least 11 events a day with excess share_i ≥ 2 s\*_i.

## Q-R1-e: DEV-ZERO
- **Matched controls** are each arm's primary control on the same UTC day and in the same effective-quote tercile (as of the event):
  - near-full dev exits for the zero arm;
  - placebo-cutoff crossings (4.2% or 2.4%) for the ≤5% and ≤3% arms.
- Excess share_i = net_i ÷ Q_i − the median of (net_j ÷ Q_j) over those controls.
- If an event has no matched control, it is left out of the bar and counted.

## Q-R1-f: REBUY-ANCHOR
- **Events** are the top-quintile RB decision points.
- Each event's control is the median net-rebuy share of the median-band points (±10 percentile points of RB) on the same day and in the same drawdown tercile.
- Excess share_i = the event's net rebuy share − that median.

## Q-R1-g: F1
- On the bonding curve, Q is the curve's virtual SOL reserve at the leader's buy, because the curve prices on its virtual reserves. On a pool, Q is the effective quote.
- c_i uses that venue's fee from the trade's own fee fields (curve or pool tier), plus the impact of a $5 buy and its sell on that Q, plus 414,009 lamports ÷ 41,925,205.
- **Events** are the day-2 buys of persistent leaders that have a valid placebo, the same population as the gate's timing statistic.
- Excess share_i = (follower SOL landing after 23 slots within the window ÷ Q_i) − (the same quantity after its placebo buy ÷ the placebo's Q).
- F1 stays counts-only: no return test is written without a further ruling.
