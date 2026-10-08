# Design A amendments (round 7), text for EDGE_DIALOGUE.md "## Agreed designs"

Paste under "### Design A" as "#### A amendments (round 7)". Agreed by the lead and the partner on 2026-10-08, before any tape read.

#### A amendments (round 7)
Reason: since BOOST (B2, 2026-07-21), a fresh graduate prices on effective reserves (about 67.4 real + 17.6 virtual SOL), so it opens near the curve-end price of about 411 SOL, about 2% under 420. Round 3's figure of 326 SOL used the real vault only (`docs/research/edge.md` §6.5.2). BOOST then spends about 17.6 SOL as a buy-and-burn TWAP in the first 5 minutes, which pushes almost every graduate through 420 by protocol rule.
- (a) Market cap uses effective quote = vault + signed `virtual_quote_reserves`, and the supply after BOOST burns. Before scoring, the worker reads from the program or IDL which supply the FeeConfig tier rule uses, and uses that.
- (b) Both gates exclude the window from migration to the end of the last `BoostBuyAndBurnEvent`, or the first 5 minutes when no BOOST event exists.
- (c) The count rule is unchanged and is confirmed from the schema only.
