# POOL-NOOP-EVENTS: two PumpSwap events that leave a pool's reserves unchanged

Question: DEC-1 does not decode two PumpSwap events. Does either one move a pool's base vault, quote vault or `virtual_quote_reserves`? Until now, the producer staled the pool's chain on every unnamed PumpSwap event (WATCH-1c).

- `929fbdac925838f4` = `sha256("event:CloseUserVolumeAccumulatorEvent")[0..8]`. It appears inside ordinary buys.
- `6161d7905d92167c` = `sha256("event:ExtendAccountEvent")[0..8]`. It comes from the `ExtendAccount` instruction, which grows an account written before the program upgrade, typically a pool account from 287 to 301 bytes. That happens once per pool, just before a trade.

The names are the Anchor hashes, which match exactly (`packages/core/test/chain/no-change-events.test.ts`).

Read from keyless public mainnet RPC (`solana-rpc.publicnode.com`; `api.mainnet-beta.solana.com` was too throttled for this volume). No bot key and no Helius credits were used. Window: 6–7 Oct 2026, slots 453,759,518 to 454,007,578.

## Result

**No case showed a change.** For every conclusive case, the pool's swap just before the event and the one just after it chain exactly. The previous swap's post-trade state (from the exact replay, `swapEventState`) equals the next swap's pre-trade reserves, with base, vault and virtual each compared on their own.

| Event | Cases checked | Unchanged | Changed | Inconclusive | Pools (unchanged) |
| --- | --- | --- | --- | --- | --- |
| CloseUserVolumeAccumulatorEvent | 138 | 80 | 0 | 58 | 17 |
| ExtendAccountEvent | 78 | 62 | 0 | 16 | 62 |

Why cases were inconclusive (never counted for or against):
- No tape: the pool was too busy to page back from the newest signature to the event within 50 pages, or the RPC no longer found a transaction. This was 57 Close cases and 11 Extend cases.
- No swap of the pool on one side, within 20 transactions. This was 1 Close case and 4 Extend cases.
- Another PumpSwap event (`BoostBuyAndBurnEvent`) between the two swaps. This was 1 Extend case.

Limits:
- This covers about two days and the pools that traded in them. 80 and 62 cases are evidence, not proof for every pool. A future program upgrade could change either instruction, so any other or new unnamed event still stales the pool.
- The Close cases cluster in 17 pools: the event comes with particular users' buys.
- ExtendAccount was found by searching pool histories. The cases are pools whose own account was extended; that is the case that matters, since an extended non-pool account cannot touch a pool's reserves.
- For 5 pools, a lamport top-up had no ExtendAccount in its transaction. These were not counted and are not needed for the proof. They were most likely plain SOL transfers to the pool address, but this was not checked.

## Method

1. **Discover** (`collect.ts discover`): program-wide `getSignaturesForAddress` pages on PumpSwap, each transaction decoded with DEC-1, keeping those that hold either event. This found 386 Close events in about 7,000 transactions, and 0 Extend events (Extend is once per pool).
2. **Find ExtendAccount** (`collect.ts extends`): for each pool traded in the sampled transactions, a binary search over the pool's own signatures for the first transaction after which it holds more lamports (an extension's rent top-up). The search checks that transaction holds the event. 306 pools tried: 78 had an extension, 164 none, 59 had too many signatures to search, and 5 had a top-up without the event.
3. **Tapes** (`collect.ts tapes`): for each case and each pool swapped in its transaction, the pool's 20 transactions just before and 20 just after. They come from the pool's own signature list, paged back from the newest to the event, so the window is contiguous. Cases are taken round-robin across pools.
4. **Check** (`collect.ts report`):
   - The tape's order (the RPC's) is trusted only when every other consecutive pair of the pool's swaps on it chains exactly.
   - No other PumpSwap event may sit between the swaps before and after the event.
   - The swap before must replay; its post-trade state must equal the swap after's pre-trade reserves.
   - A sell's vault/virtual split that differs while the effective reserve matches is counted inconclusive, never unchanged.

An earlier run was discarded. Its "after" side took the oldest of the newest 1,000 signatures, which on a busy pool is not adjacent to the event, so the tape had a gap. That gap produced one false "moved". That run is kept locally in `data/tapes-v1.json` (git-ignored).

## Re-run

```
SOLANA_RPC=https://solana-rpc.publicnode.com node research/pool-noop-events/collect.ts discover 4
SOLANA_RPC=https://solana-rpc.publicnode.com node research/pool-noop-events/collect.ts extends 80 30
SOLANA_RPC=https://solana-rpc.publicnode.com node research/pool-noop-events/collect.ts tapes 120
node research/pool-noop-events/collect.ts report
```

Raw transactions are cached in `data/` (git-ignored). `data/report.json` holds every case with its verdict and the swap signatures it was judged on.

## Use

`PUMP_AMM_NO_CHANGE_EVENTS` (`packages/core/src/chain/events.ts`) holds exactly these two discriminators. A matching event on the PumpSwap program:
- does not stale a pool's chain;
- does not block a heal;
- is not echoed as an unnamed event to other watches (DEDUP-PER-WATCH).

Any other unnamed event, or the same bytes from another program, still counts as a change (DECISIONS "POOL-FIRST-READ", part 2).
