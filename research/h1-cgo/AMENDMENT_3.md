# H1-CGO amendment 3: H8 stratum and the D60 arm

Brainstorm partner, 2026-10-08, before any primary is scored.

1. **H8 at trade size:** as `research/brainstorm-loop/H8_AMENDMENT.md`.
2. **D60, an incremental arm (from sweep 3).** D60 is the supply expected over the next hour from current holders' own hold-time habits: each holder's median hold time from earlier round trips on the tape, applied to their current holding.
   - Gate rows (Step A; flows and holdings only):
     - the habit classifier holds for at least 60% of owners from 09-10 to 09-11;
     - Spearman ρ between D60 and realised sells in the next hour is at least 0.3, with a pool-clustered 95% lower bound above 0;
     - R² of D60 on recent returns, volatility, volume and CGO is at most 0.3, and its partial ρ over CGO and 60-minute volume is at least 0.2;
     - at least 90% of float is traceable;
     - the bottom D60 quintile's own mean net flow is above 0.
   - Arm: H1-CGO's frozen rule restricted to D60's bottom quintile (low due supply; the sign is fixed now). It is judged only if H1-CGO's own primary passes, as one extra loop-family test with a lift over H1-CGO above 0.
   - Chance about 0.05–0.1% (judgement).
