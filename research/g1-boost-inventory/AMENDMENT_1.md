# G1 amendment 1: holder-makeup arm (G1-HC) and BOOST descriptive rows

Drafted 2026-10-08 18:15 Melbourne by the brainstorm partner, from idea sweep 1 (`research/brainstorm-loop/SWEEP_1.md`, survivor 1). It must be frozen before any shared-tape day is read. If it is frozen later, G1-HC becomes forward-only. G1's own primary is unchanged.

## Reason
BOOST is a fixed buyer of about 17.6 SOL per graduate. How much of it G1 captures depends on how much pre-migration supply is ready to sell into it. G1 buys every catchable curve; G1-HC buys only where little supply is ready to sell. Chance about 2% (judgement); it moves with G1's own prior.

## Feature R: sell-ready share, as of slot t0 + D − 1
- Base: tokens held by all owners except the curve, on curves created on a tape day read so far. Curves created earlier have no full holder history and are left out of G1-HC (they stay in G1).
- R = the share of those tokens held by owners in any of these groups, all as of the slot:
  1. the creator's funding cluster: union-find on T and W links on or before the slot, seeded with the create row's creator and user, never joining through an address linked to more than 50 owners;
  2. owners whose first buy of the mint landed within 10 slots of its create;
  3. owners whose average cost (H1-CGO §4 method) is at most half the curve price at t0;
  4. owners with at least 5 buys on the tape before the slot, of which at least 10% landed within 2 slots of a create or migration.

## Arm
- G1-HC trades G1's entries whose R is below the median R of the discovery days' G1 triggers. That median is frozen in a commit before any validation day is read.

## Gate additions (Step A; no returns read)
- (a) Mechanism: Spearman ρ between R and the share of pre-migration holders' tokens sold in [m, m + D] is at least 0.2, with a one-sided 95% lower bound above 0.
- (b) Coverage: at least 90% of curve-held tokens can be traced to owners with full history. Report the triggers dropped because the curve predates the tape.
- (c) Count: at least 100 filtered catchable triggers a day. Otherwise G1-HC is judged on forward recorder days named before any is read.
- (d) Report R's correlation with time from create to the trigger, and counts by R tercile.
- Any failure closes G1-HC; G1 continues.

## Judgement
- Same as G1 §9 on the filtered subset, plus a point lift over unfiltered G1 above 0.
- G1-HC counts as its own test in the loop family (0.005).
- Futility: if G1 fails futility, G1-HC also closes unless its own one-sided 95% upper bound on discovery is above 0.

## Descriptive rows added to G1-0(c), never judged
- BOOST quote still unspent at m + D, m + 150 and m + 300 slots.
- The share of BOOST slices with a non-BOOST trade between them, and non-BOOST buy SOL in [m, m + D].
- The share of `boost_buy_and_burn` instructions with a non-zero `min_base_amount_burned`. If BOOST sets a price floor, it is not fully price-blind, and G1's premise is restated before any return is read. If the tape does not keep this argument, report "unknown" and the slices' quote ÷ base instead.
