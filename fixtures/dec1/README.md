# DEC-1 mainnet goldens

Card Z03 (docs/MIGRATION.md): "DEC-1's mainnet goldens added as tests". Public on-chain data only: no keys, no signing, nothing fetched for Z03 (no network call was made to build this folder).

## Files

| File | Content | sha256 |
|---|---|---|
| `accounts.json` | 29 mainnet accounts read by DEC-1 on 2026-10-03 (public RPC; runs listed in its `meta`): pump `Global`, both `FeeConfig`s, PumpSwap `GlobalConfig`, SPL and Token-2022 mints, a 2024-layout bonding curve (150 bytes), current curves, a mayhem coin's curve, canonical and non-canonical PumpSwap pools, a pool with negative `virtual_quote_reserves`, pool vaults, an address lookup table | `9bd58ceb4fc5c5cd28cdef4b60f88b9f0320008b2c62a3ef24bef7504c7c1dab` |
| `transactions.json` | 22 mainnet transactions read by DEC-1 (legacy, v0 with a lookup table, v1; pump `TradeEvent`, `CreateEvent` with its first buy, a mayhem create, `CompleteEvent`; PumpSwap `BuyEvent`/`SellEvent`, two with negative virtual quote reserves; a migration with `CreatePoolEvent`, `InitBoostEvent`, `CompletePumpAmmMigrationEvent` and a buy; `BoostBuyAndBurnEvent`; a failed transaction). Each keeps the `getTransaction` base64 result DEC-1 stored and its JSON message | `bd6e07a18d97d38654963210d91f73be982995efb6c837c5d0b7cfed5ec7ef15` |
| `goldens.json` | DEC-1's decoded values for every account and transaction above, in the Z03 decoders' vocabulary (`DecodedAccount`, `DecodedEvent`), with the events DEC-1 decodes that A-M02-03 has no variant for listed under `skipped` | `8d76896af9c4d8295edd40ef136e4f1a83b4c87a2fcde3b8296a73027d3a4005` |

`accounts.json` and `transactions.json` are byte copies of `packages/core/test/chain/fixtures/` at `7fac908` (same sha256), so the Blueprint tests do not depend on Zeroed's folders.

## How `goldens.json` was derived

On 2026-10-08, a one-off script (not committed: it imports Zeroed's `packages/core`, which Blueprint code may not import) ran DEC-1's own decoders on these files: `recordFromRpc` and `transactionEvents` (`packages/core/src/chain/transaction.ts`), `decodeBondingCurve`, `decodeGlobal` (`pump.ts`), `decodePool`, `poolVirtualQuoteReserves`, `decodeGlobalConfig` (`pump-amm.ts`), `decodeFeeConfig` (`fees.ts`), `decodeMint`, `decodeTokenAccount` (`token.ts`). Each result was renamed field by field to the Z03 vocabulary (for example `feeBasisPoints` → `feeBps`, `baseAmountOut` → `baseAmount` on a buy, `mintAmount` → `baseAmount` on a migration, `marketCapLamportsThreshold` → `thresholdLamports`). Integers are decimal strings. On that day the Z03 decoders gave the same values on every field of every account and transaction (0 mismatches); `packages/decoders/test/dec1-goldens.test.ts` keeps that true.

Two adaptations, both in the test:
- DEC-1 stored a trimmed `meta` without `fee` or lamport balances. Event decoding reads neither, so the test passes `fee: 0`.
- The transaction is given to `readRpcTransaction` as a JSON-encoded `getTransaction` result built from DEC-1's JSON message and its base64 result's `meta`, which is what M14 fetches.

## Differences from DEC-1 kept on purpose

- DEC-1 accepts any pump or PumpSwap event-CPI instruction; Z03 accepts one only when its direct invoker is the same program (A-M02-03 logic 3, supervisor ruling of 2026-10-07). Every event in this sample passes both rules.
- `CreateEvent`, `CreatePoolEvent` and `BoostBuyAndBurnEvent` have no `DecodedEvent` variant in A-M02-03 logic 4, so Z03 does not return them (listed as `skipped`).
- Since pump's unannounced upgrade of 2026-10-02 (DECISIONS 2026-10-03), `TradeEvent`, `BuyEvent` and `SellEvent` carry 8 trailing bytes the pinned IDL does not describe. DEC-1 keeps them as `extra`; Z03 reads the documented fields and ignores trailing data, as Anchor does. Every documented field agrees.
