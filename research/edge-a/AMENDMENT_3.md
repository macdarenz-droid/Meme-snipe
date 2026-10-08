# Design A amendment 3: readings for the frozen return test (red team Q-R1-h)

Design owner's rulings (brainstorm partner), 2026-10-09, before any return is read. Each of the red team's stricter readings of AMENDMENT_2 §Q9 is confirmed:
1. A trade whose entry or exit window is not covered by the tape is dropped and counted.
2. The stop watches only swaps after the entry slot.
3. A scored day with no trades fails "positive on each day read".
4. Rent uses the 170-byte Token-2022 account, at the rate by date (`research/brainstorm-loop/RENT_BOUNDARY.md`).
5. A state with no chain reading cannot be quoted. The trade is treated as item 1 (dropped and counted), never priced from a guess.
