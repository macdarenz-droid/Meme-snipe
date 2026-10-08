# Step A count rows, amendment 7: payer-mass bar defined; DEV-ZERO order

Design owner's rulings (brainstorm partner), 2026-10-09 00:53 Melbourne, before any threshold is applied. They answer the code red team's Q-R1-a and Q-R1-b (`research/brainstorm-loop/CODE_REDTEAM.md`).

## Q-R1-a: the payer-mass bar (`PAYER_MASS.md`), defined per event
- **Payer-attributed flow** is each row's own measured payer flow, in excess of its own control, in the row's own window:
  - **DEV-ZERO:** the event's net (first-time buyer SOL minus existing holders' sell SOL) in (e + 23 slots, e + 15 min], minus the median net of its matched controls;
  - **REBUY-ANCHOR:** the event's net rebuy flow (amendment 1) in (t + 23 slots, t + 2 h], minus the median of the median-RB band points matched to it (same day and drawdown tercile);
  - **SEAT-DRIFT:** the busy graduate's first-time buyer SOL in (m + 60 min + 23 slots, m + 120 min], minus the median of the lone graduates on the same day;
  - **F1:** the follower buy SOL landing more than 23 slots after the leader's buy and within its 600 slots, minus the same quantity after the matched placebo buy.
- **Hold window** = the row's own window above.
- **Q** = the event's own effective quote (vault + signed virtual reserves) at its decision slot.
- **c** = the round trip at $5 (the trial maximum) in that pool, by the tier the program applies at that market cap:
  - 2 × the tier fee;
  - plus the constant-product impact of a $5 buy and its sell at Q;
  - plus 414,009 lamports ÷ the size in lamports.
  
  $5 is 41,925,205 lamports, floor(5 ÷ 119.26 × 1e9).
- **X\*_i** = Q_i × (√(1 + c_i) − 1), per event.
- **The bar passes only if both hold:**
  - the median over events of (payer flow_i ÷ X\*_i) is at least 1;
  - on average at least 11 events a day have payer flow_i ≥ 2 X\*_i.
- Until the bar is computed it is "not computed", and no row and no gate passes, as the code already does.

## Q-R1-b: DEV-ZERO arm order
- **Fixed sequence, as coded.** An arm earns only if every earlier arm earned: the ≤5% crossing first, then the zero flag, then ≤3%. This is the safer reading of "in a fixed order", and it keeps one 95% bound per family.
