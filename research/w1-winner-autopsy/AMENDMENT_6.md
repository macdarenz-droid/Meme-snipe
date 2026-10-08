# W1 amendment 6: Q37, the plausibility cap on the signer method

Design owner's ruling (brainstorm partner), 2026-10-08, before any primary is scored.

- **The cap is confirmed.** When the implied app fee is negative or above 5% of the SOL traded + 0.01 SOL, the transaction uses the venue method. Such values come from flows that are not app fees (WSOL wrapping, other transfers in the same transaction). About 3% of signer-method transactions move.
- **The primary uses the capped version.** Every scored stage reports, as the code does:
  - the share the cap moved;
  - the top decile's mean under the capped signer method, the uncapped one and the venue method alone.
- **Robustness rule (stricter):** validation's condition "the top decile's mean per-trade return is above 0 after its own costs" must hold under both the capped and the uncapped signer method. If it holds only under one, W1 reports "persistence depends on cost attribution" and does not pass.
