# G1, amendment 5: G1-0's catchable kill over the Step A days (lead ruling, 2026-10-08)

The principle of amendment 4 also governs G1-0's catchable kill (tape/g1lib/gate.py, the G1-0 rule that averaged day values):

- G1-0's statistic is computed on the pooled Step A events, not as an average of day values.
- G1-0 passes only if the pooled statistic passes and neither day alone triggers the kill:
  - a count threshold needs at least 40% of the threshold on each day (amendment 4's rule);
  - a time or share threshold must pass on each day's own events at the full threshold.
