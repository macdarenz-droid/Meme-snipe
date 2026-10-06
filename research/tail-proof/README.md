# TAIL-PROOF: non-zero B5 trade tails vs swap math

Question: since B5 (2026-10-02 15:47 UTC), PumpSwap `BuyEvent`/`SellEvent` carry 8 unpublished bytes. GATE-1c (H5) refuses a pool if any trade since migration has a non-zero tail. Does a non-zero tail change what a trader pays or receives?

Read from public mainnet (keyless RPC) on 2026-10-06, 20:42–21:20 Melbourne (09:42–10:20 UTC), slots 453,864,355–453,873,166.

## Result

**A non-zero tail does not change the trade's money.** Every sampled trade reproduces to the raw unit, tail or not.

Each trade is on a canonical, SOL-quoted, non-mayhem pool. It is decoded with DEC-1 and quoted with CORE-2 from the event's pre-trade reserves (effective quote = vault + `virtual_quote_reserves`) and the PumpSwap FeeConfig (read at slot 453,867,075). The FeeConfig admin's only action since B5 is a `SetQuoteControlAdmin` on 2026-10-04, which is not a fee change.

| Check | Non-zero tail | Zero tail (control) |
| --- | --- | --- |
| Trades (buys / sells) | 1,188 (386 / 802), 36 pools, 31 on v2 instructions | 180 (85 / 95), 23 pools |
| Event fields: fee rates, LP, protocol, creator and buyback fees, amounts | 1,188 / 1,188 exact | 180 / 180 exact |
| Pool vaults' real balances before and after (meta) | 1,186 / 1,186 exact | 160 / 160 exact |
| Token transfers made by the swap itself: trader paid and received, vault in and out | 1,188 / 1,188 exact | 180 / 180 exact |
| Trader's base token balance change (meta), where nothing else touched the account | 675 / 675 exact | 64 / 64 exact |
| Trader's wrapped-SOL balance change (meta), same condition | 43 / 43 exact | 1 / 1 exact |

There were no mismatches. Each row counts only the trades where that check could be applied (for example, vault checks need the pool's only trade in the transaction).

Limits:
- The trader's native SOL change is not compared. Most trades wrap and close a WSOL account and pay fees and tips in the same transaction, so the swap's share cannot be isolated from the total. The swap's own transfers (row 4) are the direct measure of what the trader paid or received.
- This covers one 38-minute window on one day. 1,188 trades from 36 pools are evidence, not proof for every pool.

## What the tail is

It is the pool's **unswept creator fee**: creator fees that v2-instruction trades leave parked in the vault. The tail is read as a u64, little-endian. Evidence:

- Three consecutive pool tapes: 894 trades, 300 transactions per pool, in RPC order. After each trade, the tail equals the previous tail plus that trade's `coin_creator_fee` when it used `buy_exact_quote_in_v2`, `sell_v2` or `buy_v2`, and is unchanged on a v1 instruction. That holds for 891 of 891 checked trades, and 24 of them are v2 trades.
- Each tape holds one sweep transaction. Each sweep runs two new PumpSwap instructions, logged as `SweepCreatorFee` and `SweepProtocolFee`. The creator sweep transfers exactly the tail out of the quote vault (3 of 3), and the next trade's tail is 0. Across the sweep, the vault falls and `virtual_quote_reserves` rises by the same amount, so the effective reserve, and therefore the price, is unchanged.
- The names come from the Anchor hashes, which match exactly:
  - instructions: `sha256("global:sweep_creator_fee")[0..8]` = `20f6bf3408c949ba` and `global:sweep_protocol_fee` = `0830be07b644b7e5`;
  - events: UPG-1's unknown events are `event:SweepPoolFeeEvent` = `82a42461e48287a5` (PumpSwap) and `event:SweepBondingCurveFeeEvent` = `742b4dbd117a482b` (pump, which has the same two sweep instructions);
  - the third unknown discriminator, `a943276d6686b6e8`, is still unnamed.
- This matches UPG-1's curve observation, where the tail grows by each trade's `creator_fee`. It also explains why a pool is zero after migration (nothing parked yet) and grows over time, and why it is identical on v1 buys and sells of any size (v1 trades pay the creator directly).
- The protocol fee that v2 trades leave in the vault is swept too, but it does not appear in the tail.

Nothing official is published. pump-public-docs `main` is still `cb188ce` (2026-09-29), and the newest npm SDKs are `pump-swap-sdk` 1.20.0 (09-10) and `pump-sdk` 2.0.0 (09-13). So this meaning is measured, not documented.

Money impact of the mechanism:
- Parking and sweeping move SOL between the vault and `virtual_quote_reserves`, so the effective reserve does not change.
- CORE-2 already models v2 parking (`instruction: 'v2'`) and quotes from the pre-trade vault and virtual reserves read on chain.
- The only new effect is that a sweep, an instruction other than a trade, moves the vault and virtual reserves between trades. The price is unchanged by it, and every quote reads fresh state anyway.

## Files

- `collect.ts`: collects and caches raw transactions in `data/` (git-ignored). Run `discover`, `pools`, `history` and `accounts` in that order.
- `analyze.ts`: runs every check above and writes `data/report.json`. With `fixture`, it also writes `packages/core/test/chain/fixtures/tail-proof.json` (359 non-zero, at most 20 per pool, from 36 pools; 108 zero; 3 tapes). It refuses to write a fixture while any trade mismatches.
- `changes.ts`: finds where a pool's tail changes, by binary search over its signatures (how the sweep was found).
- Test: `packages/core/test/chain/tail-proof.test.ts`. Two mutations fail it: quoting sells from the real vault instead of the effective reserve fails 184 tests, and dropping the creator fee from the tail rule fails 2 tapes.

Re-run:

```
node research/tail-proof/collect.ts discover 3 12
node research/tail-proof/collect.ts pools 40 20 10
node research/tail-proof/collect.ts history <pool> 1 1 300
node research/tail-proof/collect.ts accounts
node research/tail-proof/analyze.ts fixture
```
