# VERIFY-NEXT (#308): reviews and rulings

## Round 1 (head `8b6d0dc9`, base `1e4df569`): reviewer + red team `session_01E4bsB1F8B2siMGkYyx9VRh`

Review FAIL. Red team 0 BLOCKER, 2 MAJOR, 3 MINOR. The reviewer re-checked V1, V5, V9–V11, V17, V19, V25 and the pump-public-docs hashes; all hold.

Answer on the Z03 read path at the stale pin `cb188ce`: nothing is mis-decoded (new fields are appended or carved from reserved; longer layouts are flagged), but PumpSwap `buy_v2` / `sell_v2` / `buy_exact_quote_in_v2` trade events on SOL pools are dropped and counted under the wrong reason `non_sol_quote`; `multi_hop_swap` hops are dropped even after a re-pin (no quote_mint account); `PostCompleteBuyEvent` and `Sweep*` become `unknown_event`. Counted, not silent, but SOL trades are missing.

### Supervisor rulings for round 2 (9 Oct 2026, about 12:20 AM)

1. **MAJOR, V22 diff.** Complete it: the trailing `partial_fill: OptionBool` on pump `buy`, `buy_v2`, `buy_exact_sol_in`, `buy_exact_quote_in_v2`; the new events (PostCompleteBuyEvent, SweepBondingCurveFeeEvent, SetQuoteControl*); `QuoteControl.reserves_admin` carved from `_reserved` (64→32), so "added fields are appended" is not a general rule. Same in §6(d).
2. **MAJOR, §7 effect on Z03.** Say plainly: a re-pin is required before M1 or any card relies on PumpSwap volume or flow, plus a decoder card for `multi_hop_swap` and `PostCompleteBuyEvent`, and a separate gap reason so these drops are not labelled non-SOL. The supervisor opens that card (IDL-REPIN, in `docs/reviews/Z03.md`).
3. **MINORs.** The v2/v3 mainnet go-live slot or date is UNVERIFIED (it decides which B-10 days are pre- or post-IDL); V20/§6(a) add the pool part of a completing v3 buy for PM-01 reads on post-upgrade days; V9 cites the gh manual line for "drafts stay editable and deletable".

## Round 2 (head `dc5d4fe9`): delta review + red team, same session

Review PASS, final. Red team 0 BLOCKER, 0 MAJOR, 2 MINOR. `multi_hop_swap` settled from the `8cda1fa3` IDL: 16 fixed accounts, none named `quote_mint`; each hop's quote mint is slot 2 of its 5-account group in `remaining_accounts`. AMM Buy/SellEvent carry no quote mint, so pool-hop events stay dropped after a plain re-pin. Curve hops are unaffected.

### Supervisor rulings for round 3 (9 Oct 2026, about 12:28 AM)

4. **MINOR 1.** RESULTS.md §7: replace "was not checked here" with the settled answer, citing this review and the IDL-REPIN card.
5. **MINOR 2.** RESULTS.md V22: the "missing trailing fields read as zero" rule is stated for accounts only, not for instruction args (`partial_fill` is a trailing arg).

## Round 3 (head `14ada845`)

The supervisor checked the delta from `dc5d4fe9` itself: one file, two lines. Rulings 4 and 5 are applied as worded. **#308 is approved:** review PASS (final), red team findings closed. It merges once it is out of draft and green on a head that contains the latest base.
