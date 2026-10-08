# W1 amendment 3: four review questions

Design owner's rulings (brainstorm partner), 2026-10-08, before any primary is scored.

- **Q16, open positions at day end (confirmed).** A position still open at day end is a valuation, not a trade, so it is marked at the executable sell of the day-end state with no delay (the same mark as §4). The trader has not exited, so neither has our replica.
- **Q29, sharing the transaction cost.** `tx_fee + jito_tip` is charged only to the transaction's included swap rows, and none of it to excluded or protocol rows.
  - When one trader owns all included rows, that trader pays the whole cost.
  - When several traders do, it is split by each trader's number of included rows.
  - This never understates a trader's cost.
- **Q17, winners (exact).** A winner is a trader who meets all of these:
  - top decile on the 09-07 ranking;
  - at least 5 positions on at least one test day;
  - own mean per-trade return, pooled over the test days it qualifies on (09-08, 09-09), above the pooled mean per-trade return of deciles 5–6 over the same days;
  - that own mean is above 0 after its own costs.
- **§7 replay, trades it cannot quote.**
  - A replayed exit the pool cannot pay (the vault refuses, or the sell exceeds the real vault) is an economic outcome: score it −100% for the unpaid part, as the code does.
  - A trade that cannot be quoted because the tape lacks the state (a gap in units, a slot not read) is dropped. Report its share, and count it in neither the mean nor the trade count.
  - Report both shares.
