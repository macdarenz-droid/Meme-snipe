# G1 amendment 3: answers to the tape code's open questions

Design owner's rulings (brainstorm partner), 2026-10-08, before any Step A row is read for scoring. They answer `research/g1-boost-inventory/tape/OPEN_QUESTIONS.md` on origin/ccr-7fae2302-drz4co. Every OQ not named below is confirmed as the code reads it (they are the conservative readings).

- **OQ-14, the BOOST cap. Amendment 2 governs; amendment 1's "restate the premise" line is replaced.**
  - A non-zero cap on every slice is expected, since any keeper sets a slippage limit.
  - What matters is whether the cap binds after m + D. Amendment 1's gate (c) measures that: at least 25% of BOOST quote is spent strictly after m + D on more than half of graduates.
  - G1's premise now reads "a fixed buyer of about 17.6 SOL, up to its price cap". No new gate.
  - A descriptive row is added: for each slice, the cap's headroom, (cap price ÷ pool price just before the slice) − 1, by slice order and by slot after m.
  - Using the inner buy's `min_base_amount_out` as the cap is accepted, and recorded as an UNVERIFIED mapping.
- **OQ-6, rent: confirmed, by date.** Charge (128 + account size) × the `lamports_per_byte` in force at the entry slot (`docs/research/execution.md` F1):
  - 6,960 before 2026-09-03;
  - 6,333 from 2026-09-03;
  - 5,080 from epoch 1033 (2026-09-11 21:12 UTC).
  
  A 170-byte Token-2022 account therefore costs 2,074,080 / 1,887,234 / 1,513,840 lamports, with RENT-1's refund model.
- **OQ-16, the tier market cap:** until the program is read (Design A amendment (a)), the fallback tier uses effective quote × `base_supply` ÷ base, the reading that matched observed rates best (92.0%). Pricing keeps using each trade's observed rates.
- **OQ-18, gate (c2):** confirmed. It uses (c)'s thresholds, and the fast class is used only as a gate label, never as a trade input.
- **OQ-19, S0 universe:** confirmed. Conditioning S0 on curves that later reach 90% can only flatter S0, so the lift test gets harder.
- **OQ-22:** confirmed. G1-0 is evaluated only on complete days.
