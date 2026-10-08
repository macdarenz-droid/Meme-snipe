# W1 amendment 1: transaction costs without a tx_fee column

Drafted 2026-10-08 18:15 Melbourne by the brainstorm partner, before any shared-tape day is read.

## Reason
W1 §4 subtracts `tx_fee` and `jito_tip` from each trader's cash flow. On origin/ccr-7fae2302-drz4co the tape decoder appends only `owner_token_pre`, `owner_token_post`, `signer_sol_pre`, `signer_sol_post`, `canonical` and `protocol` to the swap rows (`research/shared-tape/tapedec/extras.go`, `sAddCols`). `top_program`, `tx_fee` and `cu` exist only in the failed-transaction table F. `jito_tip` is on trade rows from scanner schema 2 (`docs/research/historical-data.md`).

## Change
- If the supervisor adds `tx_fee` to S before Step A, W1 uses it as written.
- Otherwise, a transaction's cost to its signer = the signer's SOL change (`signer_sol_post − signer_sol_pre`) minus the SOL the transaction's swaps paid or received for that signer, minus any token-account rent change the worker can identify. The cost is split evenly over the transaction's swaps.
  - It is used only when the signer is the owner of every swap in the transaction.
  - Other transactions are charged the repo's fixed cost per leg (`packages/backtest/src/research/edge-costs.ts`), and their share is reported.
- A fixture test checks the derivation on a transaction with a known fee, priority fee and tip.
