# W1 amendment 5: Q33–Q35

Design owner's rulings (brainstorm partner), 2026-10-08, before any primary is scored.

- **Q33, a replay entry the venue refuses** (for example, a pool with no effective quote, or a curve past its cap).
  - It is **no trade**, not −100%. A refused buy spends no SOL except a failed transaction's fee, and the replay cannot lose money it never paid.
  - Count it, and report its share beside the replay mean. If the share is above 10%, the replay result is flagged as "mostly not executable at our latency".
  - An **exit** the vault cannot pay stays −100% for the unpaid part (amendment 3).
- **Q34, flipper flows:** confirmed as the code reads them.
- **Q35, identifying rent:** confirmed, except that the candidate rents follow the date, as `(128 + size) × lamports_per_byte` in force at the slot:
  - 6,960 before 2026-09-03;
  - 6,333 from 2026-09-03;
  - 5,080 from epoch 1033.

  For 170 bytes (Token-2022) that gives 2,074,080 / 1,887,234 / 1,513,840, and for 165 bytes (SPL) 2,039,280 / 1,855,569 / 1,488,440.
- **Q36, plans for Steps B and C:** for the lead. W1's validation, extraction and rule test may run only on plans registered with their hashes before any of those days is read.
