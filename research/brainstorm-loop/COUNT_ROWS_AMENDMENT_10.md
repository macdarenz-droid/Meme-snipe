# Count rows amendment 10: slicer rows strictly as of the event (lead ruling, 2026-10-09, before any row is computed)

Answers red-team Q-R2-f and the related minor item (CODE_REDTEAM.md).
- The slicer's two-sided-cluster exclusion is computed as of the event, from data before the event's slot only, as R2-17 does for the slicer label.
- After the event, buyers are labelled by their fast class as of the event, using only their trades before the event's slot. The whole-day class is not used, because it includes later trades.
- If a buyer has too few earlier trades to be classed, they are "unclassed" and reported as such, never put into a class by later data.
