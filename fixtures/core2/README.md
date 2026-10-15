# CORE-2 goldens (imported by card Z07)

Mainnet trades that the venue quote model (`packages/venue`, A-M01-02/03) must reproduce to the raw unit. Imported
under `docs/MIGRATION.md` Rules 1 and research addendum A08; the Zeroed copies stay where they were.

| File | Copied from (at `2b880bca`) | Content |
|---|---|---|
| `golden.json` | `packages/core/test/amm/fixtures/golden.json` (last changed in `b8cd3c5`) | 313 pump curve TradeEvents and 353 PumpSwap Buy/SellEvents with the instruction arguments that emitted them, and 61 vault balance deltas. Captured 2026-10-03T12:41:30Z from `https://api.mainnet-beta.solana.com` by `packages/core/test/amm/fixtures/fetch-golden.ts`; selection: every successful non-mayhem trade in the captured pages (SOL-quoted curves; PumpSwap pools quoted in SOL or an exotic mint, USDC excluded) |
| `fee-configs.json` | `research/edge/snapshot/fee-configs.json` | The pump-fees `FeeConfig` accounts of the curve (`8Wf5…`) and PumpSwap (`5PHirr…`), PumpSwap read at slot 452,931,656 |
| `pump-global.json` | `research/edge/snapshot/pump-global.json` | pump `Global` launch parameters, read at slot 452,916,922 |

Public on-chain data only. Reserve timing, as the vectors show: PumpSwap Buy/SellEvent pool reserves are the
pre-swap state (the quote reproduces the event from them, and `vaultDeltas` match the vault balances before and after);
the pump `TradeEvent` reserves are post-trade (the test undoes the trade to get the priced state). No official page
states either (fact VF-06); these vectors are the evidence.
