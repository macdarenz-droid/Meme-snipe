# H8 amendment 2: the floor depends on the universe tag

Brainstorm partner, 2026-10-08 21:47 Melbourne, before any primary is scored. It corrects `H8_AMENDMENT.md`, from sweep 4. Checked in `packages/core/src/gates/hard.ts:284-292` and `config/policy.ts:186-205`.

## Fact
- `liquidityFloor` = max($15k, 1,000 × size). For the U1 universe it is raised to at least `u1FloorUsd` = $50k.
- U1 (Zeroed's study config) covers pools 1–14 days after migration. U2 covers 60–240 minutes and adds H11's chase check. Pools 4–24 hours old are in neither universe.
- The trial policy allows trades of $2–$5, 1 open position, 3 entries a day and 1 per mint a day.

## Change to the H8 stratum (D1, H1-CGO, count rows 1–3)
1. Each decision point is checked under the universe the bot would tag it with:
   - U2 window: max($15k, 1,000 × size), plus H11;
   - U1 window: the $50k floor (about 419 SOL at $119.26 a SOL) up to $50, and $100k at $100;
   - 4–24 hours: "not tradable without a new universe tag". That is a supervisor change, and any floor below $50k for pools a day or older needs the owner.
2. H6 (outstanding LP) and the dust-at-migration check also apply.
3. "Tradable as the bot stands" needs at least 300 validation trades with a positive mean at **$5**, the trial maximum. Results at $20 and $50 are reported as research lines that need the owner to raise `maxNotional`.
4. The count row adds the sizes $100, $200, $500, $1,000 and $10,000, each on its universe floor, and a count of canonical pools whose creator fee is 0.
