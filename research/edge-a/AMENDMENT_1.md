# Design A, amendment 1: supply rule from the tape (2026-10-08)

Ruling: the parent session (lead), 2026-10-08, on research/edge-a/tape/OPEN_QUESTIONS.md Q2.

The fee tier uses the live `base_supply` of each trade, as the tape records it, in place of a fixed 1B supply. This is accepted on a tape check instead of a reading of the program's code. On the discovery units (2026-09-11, 2 units, schema v2), the two rules picked different tiers on 5,565 rows; the live supply matched the creator fee actually charged on all 5,565, and the fixed supply on none.

At scoring, research/edge-a/tape keeps checking this on every row where the two rules disagree, and refuses to score if live supply matches on fewer than 99.9% of them.
