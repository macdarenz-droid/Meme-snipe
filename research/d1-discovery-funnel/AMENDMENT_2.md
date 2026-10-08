# Amendment 2: rent rate by date (correction to amendment 1)

Brainstorm partner, 2026-10-08, before any primary is scored. Amendment 1 set Token-2022 rent at 2,074,080 lamports. That is right only before 2026-09-03.

Rent is (128 + account size) × the `lamports_per_byte` in force at the trade's entry slot (`docs/research/execution.md` F1, SIMD-0437):
- 6,960 before 2026-09-03;
- 6,333 from 2026-09-03;
- 5,080 from epoch 1033 (2026-09-11 21:12 UTC).

For a 170-byte Token-2022 account that is 2,074,080 / 1,887,234 / 1,513,840 lamports, with RENT-1's refund model. The same ruling is G1 amendment 3, OQ-6.
