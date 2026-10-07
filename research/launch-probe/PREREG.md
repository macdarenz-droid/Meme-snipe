# Launch probe: buying on the pump.fun bonding curve seconds to minutes after creation (pre-registered 2026-10-07)

Owner's question: "Have you tested the concept as soon as it launched?" Earlier tests bought graduates 1–2 h after
migration and checked early windows after graduation; none bought on the bonding curve right after creation. This
probe does, transaction by transaction. This file is fixed and pushed before any return is computed.

## What was looked at before writing this
- One create transaction on 2026-08-01 (to fix event layouts) and its bonding curve's 11 signatures, six of whose
  decoded buys were used to check fee accounting (below). No price path or return was computed.
- Sizing only, on 8 random instants in 2026-07-10..07-20 (outside both windows): 28 launches; signatures on the
  bonding curve in the first 60 min, sorted: 1, 1, 2, 2, 3, 3, 5, 8, 13, 15, 18, 25, 35, 48, 66, 86, 93, 124, 130,
  181, 228, 236, 292, 348, 413, 2398, 2964, 4945. About 90% are failed transactions (sniper slippage); successful
  ones up to the horizon averaged 45 per launch (heavy tail). 3.5 launches per 20-second draw.
- Facts fixed from those transactions (they define the method, not a result):
  - The create authority `TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM` signs every create (docs/DECISIONS.md, SEED-1).
  - TradeEvent reserves (`virtual_sol_reserves`, `virtual_token_reserves`, real reserves) are **after** the trade
    (initial 30 SOL / 1,073,000,000 tokens; the dev buy of 990,098 lamports gave 30,000,990,098).
  - A buyer pays `sol_amount + fee + creator_fee` (`fee` = `fee_basis_points`, `creator_fee` =
    `creator_fee_basis_points` of `sol_amount`; 95 and 30 bps at launch). `buyback_fee` is a share of `fee`
    (5,000 bps of it), not an extra charge. A seller receives `sol_amount − fee − creator_fee`.
  - `getTransaction` returns `transactionIndex`; events are ordered by (slot, transactionIndex, inner order).
  - Many launches are bundled: several buys land in the creation slot right after the create.

## Data
- Helius RPC, read-only (`getBlockTime`, `getBlock` signatures only for paging anchors, `getSignaturesForAddress`,
  `getTransaction`). No transaction is sent or simulated. No pump.fun website or API request.
- Credit cap 1,500,000 counted as 10 per call (ledger in the scratch directory, hard stop), at most ~9.5 calls/s.
  Raw responses stay outside the repo; only code and derived numbers are committed.

## Sample (survivorship-free, uniform by time)
- Windows (UTC): **discovery** = creates 2026-07-22 00:00 .. 2026-08-21 00:00; **validation** = 2026-08-21 00:00 ..
  2026-09-07 00:00. Nothing at or after 2026-09-21T14:00Z is read (the horizon ends 65 min after the last create).
- Draws: 300 random instants in discovery (seed 20261071), 250 in validation (seed 20261072), uniform over each
  window. At each instant the anchor block is the block found by `heli.anchor_sig` (block time within 20 s before
  the instant); every **successful** create-authority transaction with block time in [anchor time − 20 s, anchor
  time) that holds a pump.fun CreateEvent is a sampled launch. Fixed-length windows give every launch the same
  inclusion probability, whatever happens to it later.
- Budget: after listing the signatures of every sampled launch (no transaction read beyond the create), the
  successful transactions to fetch are counted. If they do not fit the cap with 150,000 credits kept back, whole
  draws are dropped at random (seed 20261073) in both windows in proportion until they fit. Signature counts are
  not returns; the drop is recorded in RESULTS.

## Per launch
- Bonding-curve account signatures from the create transaction to creation + 3,900 s; every successful one is
  fetched; pump.fun TradeEvent / CompleteEvent are decoded and ordered by (slot, transactionIndex, inner order).
- Chain check: each trade's pre-state (post-state ∓ its amounts) must equal the previous post-state. Breaks are
  counted and reported; the primary analysis keeps those launches, a check reruns without them.
  *Amendment 2026-10-07, before any return was computed (smoke test on 20 out-of-window launches, no window
  data):* the check runs on the **real** reserves. In "mayhem mode" coins (a TradeEvent flag; 8 of the 20, traded
  through program `MAyhSmz…`) the virtual SOL reserves move between trades by more than the logged amounts while
  real reserves chain exactly, so a virtual jump is not missing data. The replay always uses each trade's logged
  post-trade state, so these jumps are priced. Mayhem share and virtual-jump counts are reported.
- Migration: the migrate transaction on the bonding curve gives the PumpSwap pool; its swaps from migration to
  creation + 3,900 s are fetched and replayed as in research/execution-audit (pre-swap reserves from each event,
  effective quote = real + virtual, LP + protocol + creator fees).
- Slot to seconds: per UTC day, block times of the first and last slot of the day give the mean slot length; L
  slots are reported in seconds with it. Entry time t_e = creation block time + L × slot length.

## Entry
- A $10 buy: B = 10 / 119.26 SOL (`lottery.SOL_USD`), at entry slot s_e = creation slot + L, L ∈ {2, 10, 40, 120,
  480}, against the curve state after every trade in slots ≤ s_e (the create transaction's dev buy included).
- Curve math: with fee rates f, c (bps) of the latest trade at or before the entry state (95/30 if none),
  `sol_amount` = floor(B·1e9 · 1e4 / (1e4 + f + c)); tokens = floor(sol_amount · vtok / (vsol + sol_amount)),
  capped at the real token reserves.
- No entry (counted and reported, not a return) if the curve has completed at or before s_e.

## Exits (each reported for every L)
Sell price for T tokens at a curve state: gross = floor(T · vsol / (vtok + T)), capped at real SOL reserves + our
`sol_amount`; proceeds = gross − ceil(gross·f/1e4) − ceil(gross·c/1e4) with f, c of the latest trade at or before
that state. Selling into the observed state (which does not hold our buy) is conservative: our buy would have
raised the price we sell into. After migration the sell goes into the PumpSwap pool state as of that moment
(`audit.sell`); if the pool has no swap yet, its first swap's pre-swap reserves (the state at pool creation).
1. **T1, T5, T15, T60**: sell at the state as of the last event with block time ≤ t_e + 1 / 5 / 15 / 60 min
   (curve before migration, pool after).
2. **ST2, ST10** (stop −30% / trail 40% after 2×): after each event in a slot > s_e, mark = proceeds of selling
   our tokens at that state / B. Trigger at the first event with mark ≤ 0.70, or with peak mark ≥ 2.0 and mark ≤
   0.60 × peak (peak over events so far). The sell lands at the state after every event in slots ≤ trigger slot +
   2 (ST2) or + 10 (ST10). Not triggered by t_e + 60 min: sell as T60. Marks continue on the pool after migration.
3. **MG2, MG10** (sell at the first trade after migration): if the pool's first swap happens by t_e + 60 min, sell
   at the pool state after every swap in slots ≤ that swap's slot + 2 / + 10; otherwise sell as T60.

## Costs
- Base: event fees (above) plus `lottery.FIXED` (414,009 lamports per round trip: network base + priority fee).
  The token account rent is refundable and left out.
- Stress: base plus a 0.001 SOL tip on each of the two transactions (a stand-in for a Jito tip to land early).
- Plain caveat to repeat in RESULTS: landing in slot +2 against professional snipers is optimistic; the state at
  s_e assumes our buy goes after every trade in that slot.
- Return r = (proceeds − FIXED [− 0.002 stress]) / B − 1.

## Statistics (per window, per L × exit, base and stress)
n, mean, median, win rate (r > 0), share ≥ 2× (r ≥ 1), mean with the multiple capped at 20× (r ≤ 19), and a
day-clustered bootstrap 95% interval of the mean (10,000 resamples of UTC days with replacement, mean = total
return / trades, percentile interval, seed 20261074). Also: graduation (curve complete) rate of the sampled
launches within 60 min, and the no-entry counts.

## Primary pair, filters and verdict
- **Primary pair** (one L, one exit), chosen on discovery only, before any validation return is computed: the
  highest base-line bootstrap lower bound; ties by higher mean. Validation is computed only after the choice is
  committed to RESULTS (a commit before the validation run).
- **Filters** (known at entry, applied to the primary pair only): F1 = at least 5 distinct non-creator wallets
  bought in slots ≤ s_e; F2 = the creator's own buys in the create transaction total ≥ 1 SOL. In validation each
  has a one-sided bootstrap p (share of resampled means ≤ 0); Holm over the two at α = 0.05. No other sweeps.
- **Verdict "promising"** only if, in validation, the primary pair has base mean > 0 with the 95% lower bound > 0
  AND stress mean > 0, or a filter version passes Holm with base lower bound > 0 and stress mean > 0. Otherwise
  "not supported". All 40 pairs are reported in both windows as description only.
