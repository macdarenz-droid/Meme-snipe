# Idea sweep 3 (2026-10-08)

Ground set by the research lead: the creator-fee lifecycle, protocol accounts other than BOOST, exit liquidity, and payouts. Two skeptics, then one synthesis. Run 19:28–20:20 Melbourne, 7 agents. No market data was read. Every chance is judgement. (The ids below were printed with the sweep-2 prefix by the script; they are sweep 3's.)

Honest summary: nothing beats G1-HC, D1 or W1. The one idea kept outright (LAUNCHER-ID) is a fix to the bot's filters, not an edge. The sweep's value is one constraint, checked by the partner at 20:20 in `packages/core/src/config/policy.ts:205` and `packages/core/src/gates/hard.ts:286-315`. H8, the liquidity gate, requires an effective quote worth at least max($15,000, 1,000 × trade size). At $119.26 a SOL that is about 126 SOL at $5, 168 SOL at $20 and 419 SOL at $50. A fresh graduate (about 85 SOL) fails H8 at every size. So any rule found in young pools can trade only if the owner changes H8.

## All ideas and the skeptics' votes
| Id | Idea | Skeptics keeping it | Skeptics' chances (econ+evidence / truth+rules) |
|---|---|---|---|
| s3-creator-fees-1 | CLAIM-LEAD: a creator's fee claim, made while the creator still holds supply, as a warning that a dump is coming (reject and exit filter only, not an edge) | 0 of 2 | 0.03% / 0.05% |
| s3-creator-fees-2 | LAUNCHER-ID: the bot's 'dev' is the coin's fee recipient, not the wallet that launched it (a fix to the hard-reject filters, not an edge) | 2 of 2 | 0.02% / 0.05% |
| s3-protocol-accounts-3 | PARENT-FILL: hold the parent coin while a child coin quoted in it fills its curve | 0 of 2 | 0.03% / 0.01% |
| s3-protocol-accounts-4 | CHILD-TOLL: G1 on children of deep parents, traded through multi_hop_swap at about a quarter of the toll | 0 of 2 | 0.04% / 0.02% |
| s3-exit-liquidity-5 | FLIP-BUYER EXIT: sell into buys by wallets that habitually resell within minutes (exit overlay, not a standalone trade) | 0 of 2 | 0.03% / 0.05% |
| s3-exit-liquidity-6 | SUPPLY-CLOCK: enter only when wallets with scheduled resale habits hold little of the float (the reverse: entries timed when predictable sellers are absent) | 0 of 2 | 0.05% / 0.1% |
| s3-payouts-7 | XFEE-BUYBACK: hold a coin ahead of a buyback that other coins' creator fees pay for (fee routers) | 0 of 2 | 0.01% / 0.01% |
| s3-payouts-8 | SOCIAL-CLAIM: buy after a named outside account first claims the creator fees routed to it | 0 of 2 | 0.01% / 0.01% |

## Synthesis (verbatim)


Eight ideas came in. The two skeptics kept only one outright, and that one is a filter fix, not an edge. The rest survive only as free count rows inside designs that already exist, or they are closed. Every chance below is judgement.

**What I checked myself today**
- **Limits in `policy.ts`:** line 191 sets `maxOpen` 1, `maxEntriesPerDay` 3, `maxEntriesPerMintPerDay` 1 and a 24 h re-entry block. Line 205 sets `floorUsd` 15000 and `floorNotionalMultiple` 1000.
- **H8 (`hard.ts` 285–320):** the floor is max($15k, 1,000 × size) on effective quote (vault plus virtual).
- **H12 and H14 key on `CreateEvent.creator`:** the dev check is at line 432 and H14 at about line 508. The same field is used at producer.ts:626 and deployer-index.ts:70.
- **H13 can fail closed:** `insiderLinks` returns null when the creator has no complete funder read (`funding.ts`), and the insiders fact then rejects as H16 not-covered.
- **Fee collects need no creator signature:** in both IDLs, `collect_creator_fee` (v1 and v2) and PumpSwap `collect_coin_creator_fee` mark `creator` / `coin_creator` signer=false. The CF table has a `signer` column (`decode.go` `creatorFeeCols`).
- **Pump Global account, read once on public RPC at slots 454,501,648 and 454,501,756 ($0, no Helius):** it is 1,087 bytes. That matches the 09-12 IDL exactly, which ends at `is_holder_reward_enabled`, and that last byte is 1.
- **New IDL (pump-public-docs 8cda1fa):** it adds `max_curve_depth` (u8) after that flag, and its own text says "0 disables the path". So the field is not stored on chain today.
- **D1 and H1-CGO universes:** both PREREGs set the universe at effective quote of 50 SOL or more.
- **PumpSwap fee tiers (`fee-configs.json`):** 1.20% a side from a 420 SOL cap, 1.00% just below 9,820 SOL, 0.95% from 9,820 SOL.

## 1. Survivors (ranked)

### 1. LAUNCHER-ID: our "dev" is the fee recipient, not the launcher (filter fix; kept 2/2)
- **Who pays:** nobody. It stops the bot buying from hidden launchers, and stops it rejecting coins because they share a platform creator.
- **Gate (counts only, frozen before Step A):**
  - (a) share of graduates where the launcher (`user`) is not the `creator`;
  - (b) share of eligible decisions where launcher-keyed H13 or H14 rejects but creator-keyed passes; material at 1% or more;
  - (c) creators with 5 or more distinct launchers in 24 h, and their share of H14 rejects; material at 5% or more;
  - (c') the mirror: launchers with 5 or more distinct creators (relays and gasless apps), and their share of launcher-keyed H14 rejects;
  - (d) share of pools whose `coin_creator` on S rows differs from `CreateEvent.creator` at m+60 min;
  - (e) on forward days from 10-21 only: holder-reward share of graduates, and a replay of how H13 and H14 handle those coins today (pass, reject, or H16 not-covered).
  - Plus a replay check that unaffected coins keep identical decisions.
- **Primary:** none. It ships with tests that fail on the old code and pass on the fix:
  - H14: a launcher makes 3 holder-reward creates in 24 h, each with its own PDA creator. Old code passes; fix rejects.
  - H13: wallets the launcher funded hold 6% in total, each under 10%. Old code passes; fix rejects.
  - The proposed H12 test is dropped: it cannot fail on the old code, because top-1 at 40% or more and any single holder above 10% already reject (verified).
- **Kill:** if (b), (c), (d) and (e) all fall below their thresholds, close it as immaterial and keep only the regression tests.
- **Frequency:** touches every decision. The affected share is UNVERIFIED.
  - Holder-reward coins start 09-12, after every tape day, so case 1 is forward-only.
  - Cases 2–4 can be measured on the tape.
  - What `CreateEvent.creator` holds on a holder-reward coin must be checked on one forward-day transaction or on devnet, never on 09-12..10-20 rows.
  - Holder-reward coins may currently be wrongly rejected by H13 (H16), not waved through. Which one happens is UNVERIFIED.
- **Owner flags:**
  - The tightening cases need a risk-reviewer pass and before/after tests.
  - Case 3 (platform-creator false factories) loosens H14, so it goes to the owner with the counts.
  - The launcher field holds public data only, so the supervisor approves the shape.
  - No alpha is spent.
- **Chance:** about 0 as an edge. About 30–60% that it proves material.

### 2. D60 inside H1-CGO (from SUPPLY-CLOCK; merged, not its own family member)
- **Who pays:** nobody directly. The bot avoids paying for the impact of holders whose own history says they sell on a timer. D60 is due supply over the next hour from each holder's hold-time habit.
- **Gate (flows and holdings, Step A):**
  - (a) classifier persistence 60% or more from 09-10 to 09-11;
  - (b) Spearman rho of 0.3 or more with realized sells, pool-clustered lower bound above 0;
  - (d) R² of D60 on recent returns, volatility, volume and CGO of 0.3 or less, and partial rho of 0.2 or more over CGO and 60-min volume;
  - (f) 90% or more of float traceable to owners with full history;
  - new: the bottom quintile's own mean net flow is above 0, not just its gap to the top quintile.
- **Primary:** one pre-registered incremental arm in H1-CGO's frozen primary, judged only if H1-CGO's own arm passes. The sign is fixed now: low D60 is better.
- **Kill:**
  - any gate item fails;
  - discovery futility (one-sided 95% upper bound of net below 0);
  - no added lift over CGO.
- **Frequency:** guessed at 10–60 bottom-quintile decisions a day at $5, fewer at $50 (UNVERIFIED). It needs named forward days to reach 300.
- **Owner flags:**
  - The entry limits (3 a day, 1 open) bind.
  - A live wallet-history stream was measured at about 14M credits a month, above the plan.
  - It only abstains, so there is no front-running issue.
- **Chance:** about 0.05–0.1% that it turns an H1-CGO fail into a pass.

### 3. Claim-outcome table (from CLAIM-LEAD; merged into CREATOR-BUY / FEE-RECYCLE Stage 0)
- **Who pays:** no one pays the bot. At best, a reject or early-exit filter keeps a host design from buying into a creator dump.
- **Gate (count rows, frozen before Step A, both signs set together):**
  - Run the lead test (c) first: the share of creator-group exits of 50% or more that had a claim signed by the creator group at least 23 slots + 10 s before the first sell. It needs 25% or more.
  - Count only claims where `CF.signer` is in the creator group (LAUNCHER-ID's dev set). Collects signed by anyone else are reported as a share and used as a placebo arm; they must not raise the dump hazard.
  - Then the hazard ratio (2 or more, pool-clustered lower bound above 1).
  - The four-way table (sells, buys, stays, abandons), shared with FEE-RECYCLE.
  - Coins with a sharing config are excluded. The skeptic read in the docs that collects fail on them; I did not re-check that.
- **Primary:** none of its own. It becomes a reject and exit arm in a host's PREREG only after that host passes on its own.
- **Kill:**
  - (c) or the hazard ratio fails;
  - the sign comes out negative (it is never flipped);
  - under 15 creator-signed linked claims a day means UNRESOLVED.
- **Frequency:** UNVERIFIED. The 80% accrual link applies to v2 tape units only.
- **Owner flags:**
  - No core decoder or trigger build until a host passes.
  - Decoding the post-10-02 sweep events is logged inside the existing forward-recorder task, not as a new card.
- **Chance:** about 0.03–0.05%. The prior runs against it: the fees are already SOL, so a dumper has no reason to claim first.

### 4. Flipper hold-time label (from FLIP-BUYER; count rows in W1 only)
- **Who pays:** as a trade, it would be wallets that resell within minutes. Here it is only a label.
- **Gate (rows only, no P&L):**
  - the classifier is frozen: 5 or more round trips, median hold between 30 s and 10 min, and a T transfer breaks a trip;
  - (a) persistence;
  - (b) reversal reliability;
  - (c) how much of the lift survives 23 slots;
  - (f) a census of buy SOL by class.
- **Primary:** none. Any trade use is blocked until the owner rules whether timing an exit ahead of inferred take-profit and time-stop presets counts as front-running (SWEEP_2.md:126 treated presets as pending orders). If it is ever reopened, it must also beat a simpler "sell after any qualifying buy" baseline.
- **Kill:** (a) or (b) fails, and the label is then dropped from W1.
- **Owner flags:** as above, plus the live-stream budget.
- **Chance:** about 0.03%, and capped at about 0.15–0.2 points even if the owner allows it.

## 2. Dropped, with reason
- **PARENT-FILL:** pump-coin-quoted children cannot be created today. The live Global account has no `max_curve_depth` field, and 0 disables the path. Even once enabled, the last 10% of a child is at most about 8.5 SOL of buying against a parent of 419 SOL or more at $50: about 4% gross before child sellers dump the parent, and frequency is very likely under 11 a day. Tripwire: a monthly $0 Global read for a size above 1,087 bytes and depth above 0.
- **CHILD-TOLL:** same dead universe. The documented per-hop fee rule (about 35 bps a side) was read in docs only. It needs four owner approvals and cannot rescue a G1 that loses before costs. It is kept as a contingent G1 cost note only.
- **XFEE-BUYBACK:** one known router coin (PAID). Its whole life sits in U1-B and the sealed window, the tape days come before the router existed, and 1 entry per mint per day makes 300 trades impossible. Standing ahead of a published buyback is the unresolved front-running question.
- **SOCIAL-CLAIM:** already broadcast in real time by a public bot. The event names no mint and is not on the tape, and the payer is the dead social-attention family.
- **FLIP-BUYER as a trade:** front-runs inferred standing sell presets, and the prize is about 0.15–0.2 points.
- **SUPPLY-CLOCK as its own member, and CLAIM-LEAD as a standalone build:** each was merged above, so no extra alpha is spent.
- **Proposers' own lens drops** (FEE-SHARE-JOIN, CTO-DIVIDEND, DISTRIBUTE-CRANK, BUYBACK-CLOCK, REWARD-RECYCLE, POOL-GIFT, DIVIDEND-INIT, G1-HR, charity coins, the FOOTPRINT and BOOST-STUCK variants): agreed, for the reasons they gave. Each is capped by fee-share arithmetic, trades in a dead family, falls in the holdouts, or is manipulation.

## 3. What changes before the tape is read (amendments worth freezing)

1. **H8 at the trade size, for D1, H1-CGO, Step A rows 1–3 and every post-migration design.** This matters most.
   - At $119.26 a SOL, the bot may enter only pools with effective quote of at least:

     | Size | Floor (USD) | Effective quote |
     |---|---|---|
     | $5 | $15k | ~126 SOL |
     | $20 | $20k | ~168 SOL |
     | $50 | $50k | ~419 SOL |
     | $1,000 | $1M | ~8,385 SOL |
     | $10,000 | $10M | ~83,850 SOL |

   - A fresh graduate (about 85 SOL, about $10.1k) fails H8 at every size. D1's and H1-CGO's 50 SOL universes are wider than anything the bot can trade.
   - H1-CGO's premise of "a young pool, about 3% at $50" describes pools the bot cannot enter at $50.
   - At $50, eligible pools sit near a 10,000 SOL cap (0.95–1.00% a side, about 2.2% round trip).
   - At $5, eligible pools pay 1.20% a side, and the 414,009-lamport fixed cost is about 1% of notional, so the round trip is roughly 3.4% (arithmetic).
   - **Freeze:** compute the floor from that hour's SOL/USD (Binance archive). Report every result on the H8-eligible stratum at each size. A pass counts as tradable only on that stratum at the primary size, unless the owner changes H8.
   - **Add a free count row:** H8-eligible pool-hours and graduates per day at $5, $20 and $50. It also measures the owner's 2-a-day target.
2. **Dev set:** freeze LAUNCHER-ID's dev set (launcher, plus `creator` unless it is a holder-rewards or sharing-config PDA, with role moves followed through E rows) before Step A, for:
   - Design A Gate 3;
   - the claim-outcome table;
   - DEV-ZERO, where the current `creator`/`coin_creator` definition stays primary because the premise is what screens show (UNVERIFIED). The launcher version is a pre-declared secondary row, and events where `coin_creator` is a PDA are dropped.
3. **H1-CGO:** add the D60 incremental arm and gates (a), (b), (d) and (f), plus the bottom quintile's own net flow above 0, in a dated amendment.
4. **W1:** add the flipper hold-time label and rows (a), (b), (c) and (f) beside the latency class.
5. **G1, forward only:**
   - The 8cda1fa IDL adds `PostCompleteBuyEvent` and `BondingCurve.post_complete_base_out` / `post_complete_quote_in`. The tape decoder's 09-12 IDLs lack `buy_v3`, `sell_v3`, `sweep_*` and that event (both checked).
   - If synthetic migration is live (UNVERIFIED), G1's "sell to snipers at migration" leg changes on every forward day. The forward recorder must use the new IDLs and report the synthetic part per completion.
   - Record the per-hop fee rule as a contingent cost note only.
6. **Design A, forward only (from 10-21):** holder-reward coins form a negative-control stratum, because the same 420 SOL step applies and no creator earns it.
7. **DECISIONS.md:** log PAID's 09-15..10-20 days as viewed, because sealed-window press about its price was read.

## 4. Honest line
No. Nothing in sweep 3 beats G1-HC (about 2%), D1 (about 2–4%) or W1 (about 5%); its best output is not an edge. Its value is two checked corrections, the H8-at-size universe and the launcher-versus-fee-recipient dev set, plus one checked closure: pump-coin-quoted children are not live on mainnet.