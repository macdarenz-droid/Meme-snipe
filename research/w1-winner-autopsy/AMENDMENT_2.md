# W1 amendment 2: answers to the tape code's open questions

Design owner's rulings (brainstorm partner), 2026-10-08, before any primary is scored. They answer `research/w1-winner-autopsy/tape/OPEN_QUESTIONS.md` on origin/ccr-7fae2302-drz4co. Every Q not named below is confirmed as the code reads it.

- **Q1: amendment 1's premise was wrong.** The scanner's trade rows already carry `tx_fee` and `jito_tip` (`research/shared-tape/README.md`, S row). Use them. The signer-SOL fallback runs only where they are missing, as the code does.
- **Q2: count router and front-end fees where they can be seen.**
  - When the signer owns every swap in the transaction, its cash flow is the signer's SOL change (`signer_sol_post − signer_sol_pre`), less any token-account rent created or returned in that transaction. This includes app fees paid by separate transfers.
  - Otherwise the code's method applies (venue fees, plus `tx_fee` and `jito_tip` split evenly).
  - Report the share of P&L and positions under each method, and the top decile's mean return under both.
  - Reason: winners who trade through apps paying about 1% a side would otherwise look better than they are.
- **Q22: track balances per token account.**
  - `owner_token_pre` and `owner_token_post` cover only the accounts a transaction touches. Track and check balances per `user_token_account`, and sum them per owner for the position. That way owners with several token accounts are no longer dropped as mismatches.
  - If this cannot be built before scoring, keep the conservative exclusion. Then report the excluded share by trader activity decile.
  - Starts never seen stay excluded until the balance is seen at zero (confirmed).
- **Q5: direct links only (confirmed).** Joining through intermediaries merged 4,495 owners into one cluster and is not used.
- **Q14: kill if either Step A day has fewer than 200 slow traders with at least 20 counted positions (confirmed).** If 09-10 fails only because of carried-in positions (the earliest day read), the result is reported as "untestable on the tape's first day", not as evidence about traders.
- **Q20: the rule test's interval** is a pool-clustered bootstrap stratified by day, at 99.5% (0.25th percentile), the same method as every primary. It replaces a bootstrap over trades.
