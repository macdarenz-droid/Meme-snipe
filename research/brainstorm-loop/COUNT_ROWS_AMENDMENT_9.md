# Step A count rows, amendment 9: Q-tercile cut points for DEV-ZERO's payer bar (red team Q-R1-i)

Design owner's ruling (brainstorm partner), 2026-10-09, before any threshold is applied.

- Confirmed as coded (16707f33): the "same Q tercile" cut points are computed per arm and per UTC day, over that arm's events and controls together.
- Matching is within the comparison set, so events and controls share one scale. Cut points from events alone, or from all launches, would put most of one side into a single tercile.
