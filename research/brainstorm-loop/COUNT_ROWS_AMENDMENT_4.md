# Step A count rows, amendment 4: the slicer-ride rows (counts only)

Brainstorm partner, 2026-10-08, before any Step A row is read. From sweep 4 (`SWEEP_4.md`, survivor 1; about 0.2%, judgement). No return is read. **No pre-registration may be written before the owner rules** whether riding a wallet's unfinished slices counts as "front-running other users" (ARCH.md:86).

- **Event:** owner X, with signer = owner, not a PDA, and not in the creator group, protocol rows, two-sided clusters or W1's fast class. X makes its 3rd buy of a mint within 30 minutes, over at least 3 slots and 60 seconds.
  - X's buys total at least 1% of effective quote Q.
  - X's SOL after its last slice (`signer_sol_post`) is at least 2.2% of Q.
  - X has not sold the mint in the prior 24 hours read.
  - Excluded: routed or app slices; regular cadence (interval or size CV ≤ 0.2 / 0.1); wallets whose next slice starts from exactly the last slice's balance.
- **Rows, each with its threshold:**
  - X's own net buy in (t + 23 slots, t + 60 min] is at least 50% of its remaining SOL in at least half of events (one-sided 95% lower bound above 40%);
  - X's median continuation is at least the payer-mass bar (`PAYER_MASS.md`);
  - the continuation is at least twice that of a dispersed-flow control;
  - wallets with little SOL left show at most half of it;
  - R² on past returns, volatility, volume and buy count is at most 0.3;
  - fast-class buying in [t, t + 23 slots] is at most 25% of X's remaining SOL;
  - at most 50% of slicers sell half their buys within 4 hours;
  - the 09-10 and 09-11 shares are within 15 points of each other;
  - count at $5 in U1: at least 11 a day.
- If every row passes, the counts go to the owner for the ethics ruling.
