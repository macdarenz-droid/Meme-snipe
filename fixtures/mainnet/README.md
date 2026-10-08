# Mainnet fixtures

Real Solana mainnet data for the decoder, quote-math and pool-poller tests (A-M02-02, A-M02-03, A-M01-03, A-M04-01). Card C11. Public on-chain data only: no keys, no signing, nothing sent.

## Provenance

- Captured: 2026-10-06T17:25:10.599Z to 2026-10-06T17:26:34.178Z by `tools/fixtures/capture.ts`.
- RPC: `https://api.mainnet-beta.solana.com` (public, read-only), commitment `confirmed`. This set was captured before the request limiter of `tools/fixtures/http.ts` existed: RPC calls were 400 ms apart (about 2.5/s for one method, above half of the documented 40 per 10 s per method [LD-26]) and backed off 2 to 32 s on 429. The next refresh runs at most 2/s per method and 5/s in all. Accounts by `getMultipleAccounts` (base64); each account records its own context slot. Transactions by `getTransaction` with `maxSupportedTransactionVersion: 0`, once in `json` and once in `base64`; both full results (with `meta`) are stored.
- Program IDs and PDAs: [EX-01] in `docs/FACTS.json`. Before any request, `lib.ts selfCheck()` re-derives the four PDAs from the IDL seeds (bumps 255, 255, 253, 255, as in EX-01) and re-hashes every discriminator; the three programs were checked executable and owned by BPFLoaderUpgradeable.
- IDLs: `pump-fun/pump-public-docs` commit `cb188ce08b5069196eef1f3e4a0c43b70099793b` (discriminators, migrate seeds, field order for the few selection reads). SPL token base layout: `solana-program/token` `interface/src/state.rs` at `8185db13640f0df038266c7cf4306c212d81380a` (mint supply at byte 36, token amount at byte 64).

## How examples were found

- Config: the fixed EX-01 addresses.
- Pools: candidates from the two pools named in EX-09, the pools in the captured migration events, and the DexScreener public search API (`https://api.dexscreener.com/latest/dex/search?q=<q>`, no key) for the queries "pumpswap", "pump", "pump sol", "ansem", "cate", "wotf", "goif", "troll", keeping `dexId = pumpswap` pairs quoted in wSOL. Every candidate is then checked on chain: owner is PumpSwap, Pool discriminator, quote mint wSOL, `pool.creator == PDA["pool-authority", base_mint]` under the pump program (the documented canonical test [EX-08]) and the pool address equals `PDA["pool", 0u16, creator, base_mint, wSOL]` under PumpSwap (pump `migrate` seeds). Screened 71 candidates; rejected none.
- Market cap [EX-07]: `quote x baseMintSupply / base` from the vault balances (as the card asks) and again with effective quote (vault + `virtual_quote_reserves` [EX-09]). A pool counts in a fee-tier range only when both readings fall in the same range; both values are stored under `selection`. Ranges use the EX-07 boundaries 420, 1,470, 2,460, 3,440, 4,420, 9,820, 14,740 and 98,240 SOL.
- Token-2022: found; base mints owned by Token-2022 in pools 9jkXWMytAwBCFKkehHJ4dGkWq821NzEmraEg4viBP66N, CHtrRatGRJym6rcbSL1VNrJkVJE3PLFs3FTvCEidJqvc, 3Asuat6Nd11iGCtEw577V1gcdVhaXsGtZFModZC4HXgr, Hd9zdnVcpLXzz7t32Pneg996hY4uVLS2yJfH1JQE8DtH, FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC, ArB5efrEUcTAci8YC52ZPJoQWdFw3WnjZvwfrJ9RfXo9, 8JZiCe7yzUJphDdKsj2eSyErBja5xdhB23ziewyqVPpy, 9ebYNt7c7aZtaKQS8UPbCT6gdzyXWAje3x8Ca28ysyGT, Dh39kXkxvNEUtazqe4AZBHuCLud97WaPb6w8jqkVZyVs, DreMAMRc83uJtbvWuWrDqDaQUGHDbFGopmbTYbM3tJFW, 7Nj7mBE7iVmjvnBHNvjgaz6G3ZktTHFNbf7aQDfZ7iNR, DA4pM4xSDY4M9V4CgAKKBVH1pw1yscTQQa5nEkGHuKpt.
- PumpSwap trades: `getSignaturesForAddress` on selected pools (successful only), keeping transactions whose top-level instruction is PumpSwap and whose PumpSwap self-CPI inner instructions carry the event prefix [DA-16] with the BuyEvent or SellEvent discriminator.
- Migrations: `getSignaturesForAddress` on the withdraw authority [EX-03], keeping transactions with a CompletePumpAmmMigrationEvent from the pump program whose event quote mint is SOL (all zeros or wSOL [DA-V01]).
- Bonding curves: `PDA["bonding-curve", mint]` of a migrated mint (complete=true) and of pump.fun mints listed by the same DexScreener searches (`dexId = pumpfun`), read on chain (complete=false). Pump program transactions were not scanned for TradeEvents: a version-0 request cannot read version-1 transactions [EX-V04], and how many recent pump transactions are version 1 was not measured.
- Skipped while searching: 4 version-1 transactions (error -32015 at version 0 [EX-V04, LD-05]), 28 failed signatures, 0 migrations of non-SOL-quoted coins, 0 transactions with integers above 2^53. RPC calls: 92, retries after 429 or errors: 9.

## Files

| File | Kind | Content |
|---|---|---|
| `config/pump_global.json` | account | 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf |
| `config/pumpswap_global_config.json` | account | ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw |
| `config/fee_config_curve.json` | account | 8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt |
| `config/fee_config_pumpswap.json` | account | 5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx |
| `tx/migration/tx_3xcn7YbY.json` | transaction | CompletePumpAmmMigrationEvent; slot 453967882; version 0 |
| `tx/migration/tx_32tjvqFP.json` | transaction | CompletePumpAmmMigrationEvent; slot 453967868; version legacy |
| `tx/migration/tx_3ho5U23D.json` | transaction | CompletePumpAmmMigrationEvent; slot 453967481; version 0 |
| `pumpswap/pools/pool_9jkXWMyt.json` | pumpswap_pool_set | pool 9jkXWMytAwBCFKkehHJ4dGkWq821NzEmraEg4viBP66N; 0-420 SOL; base token_2022 |
| `pumpswap/pools/pool_CHtrRatG.json` | pumpswap_pool_set | pool CHtrRatGRJym6rcbSL1VNrJkVJE3PLFs3FTvCEidJqvc; 0-420 SOL; base token_2022 |
| `pumpswap/pools/pool_3Asuat6N.json` | pumpswap_pool_set | pool 3Asuat6Nd11iGCtEw577V1gcdVhaXsGtZFModZC4HXgr; 0-420 SOL; base token_2022 |
| `pumpswap/pools/pool_Hd9zdnVc.json` | pumpswap_pool_set | pool Hd9zdnVcpLXzz7t32Pneg996hY4uVLS2yJfH1JQE8DtH; 98240+ SOL; base token_2022 |
| `pumpswap/pools/pool_FnzKY6x7.json` | pumpswap_pool_set | pool FnzKY6x7entQ1eR3D225dQyT7ybfka4PskBMQhb8L3CC; 98240+ SOL; base token_2022 |
| `pumpswap/pools/pool_ArB5efrE.json` | pumpswap_pool_set | pool ArB5efrEUcTAci8YC52ZPJoQWdFw3WnjZvwfrJ9RfXo9; 98240+ SOL; base token_2022 |
| `pumpswap/pools/pool_8JZiCe7y.json` | pumpswap_pool_set | pool 8JZiCe7yzUJphDdKsj2eSyErBja5xdhB23ziewyqVPpy; 420-1470 SOL; base token_2022 |
| `pumpswap/pools/pool_9ebYNt7c.json` | pumpswap_pool_set | pool 9ebYNt7c7aZtaKQS8UPbCT6gdzyXWAje3x8Ca28ysyGT; 1470-2460 SOL; base token_2022 |
| `pumpswap/pools/pool_Dh39kXkx.json` | pumpswap_pool_set | pool Dh39kXkxvNEUtazqe4AZBHuCLud97WaPb6w8jqkVZyVs; 2460-3440 SOL; base token_2022 |
| `pumpswap/pools/pool_DreMAMRc.json` | pumpswap_pool_set | pool DreMAMRc83uJtbvWuWrDqDaQUGHDbFGopmbTYbM3tJFW; 3440-4420 SOL; base token_2022 |
| `pumpswap/pools/pool_7Nj7mBE7.json` | pumpswap_pool_set | pool 7Nj7mBE7iVmjvnBHNvjgaz6G3ZktTHFNbf7aQDfZ7iNR; 4420-9820 SOL; base token_2022 |
| `pumpswap/pools/pool_9GBXHym9.json` | pumpswap_pool_set | pool 9GBXHym9gxDZH3u6UnW71yXaixaBkG8K7EegywH2WQGg; 9820-14740 SOL; base spl_token |
| `pumpswap/pools/pool_DA4pM4xS.json` | pumpswap_pool_set | pool DA4pM4xSDY4M9V4CgAKKBVH1pw1yscTQQa5nEkGHuKpt; 14740-98240 SOL; base token_2022 |
| `tx/pumpswap/tx_49MbpHBy.json` | transaction | BuyEvent; slot 453967966; version legacy |
| `tx/pumpswap/tx_5KGXqZKp.json` | transaction | SellEvent; slot 453967079; version 0 |
| `tx/pumpswap/tx_54aFRgFw.json` | transaction | SellEvent; slot 453967982; version 0 |
| `tx/pumpswap/tx_2TipyhLt.json` | transaction | BuyEvent; slot 453967962; version 0 |
| `tx/pumpswap/tx_TvpwJWSt.json` | transaction | BuyEvent; slot 453912403; version 0 |
| `tx/pumpswap/tx_2JncvkXg.json` | transaction | SellEvent; slot 453912103; version 0 |
| `tx/pumpswap/tx_5Z6GNb2b.json` | transaction | BuyEvent; slot 453914907; version 0 |
| `tx/pumpswap/tx_2Ta573eN.json` | transaction | SellEvent; slot 453913540; version legacy |
| `pump/curves/curve_9ergzzPt.json` | pump_bonding_curve | 9ergzzPtPwvSiThTkiuqJRP4rLFcXmYKQv4ZyDXBXPjd; complete=true |
| `pump/curves/curve_586AJyoo.json` | pump_bonding_curve | 586AJyoon3AZ1ztnpJebWnzMr6zr9dtCokZFfznJPQGJ; complete=false |
| `pump/curves/curve_BRe3zx83.json` | pump_bonding_curve | BRe3zx835MLoS4hbTfiVkQPCaEeK4HTcSjR5hgDwhrNd; complete=false |

Every JSON file has `schema`, `kind`, `found_via` and `method`. Account entries carry `pubkey`, `owner`, `lamports`, `data_base64`, `context_slot`, `fetched_at`, `rpc_url` and `reason`. Transaction files carry `signature`, `slot`, `blockTime`, `version` and the raw `base64` and `json` results. `MANIFEST.json` holds the sha256 of every file here.

## Commands

- Check: `node tools/fixtures/verify.ts` (offline: hashes, required fields, card coverage) and `npm test` (runs `tools/fixtures/test/*.test.ts`).
- Refresh: `node tools/fixtures/capture.ts && node tools/fixtures/verify.ts`. A refresh replaces the whole set; a failed run leaves the old set in place. Tests that assert exact on-chain values must be updated with a refresh.
- Recovery: one capture runs at a time (`fixtures/.capture.lock`; delete a lock left by a killed capture by hand). A capture killed during the swap leaves the previous set at `fixtures/mainnet.old-<pid>`; the next capture moves it back, and stops instead when there is more than one backup or a backup next to `fixtures/mainnet`. If the set is lost or damaged, `git checkout -- fixtures/mainnet` restores the committed one; then run `node tools/fixtures/verify.ts`.

## Limits

- Version-1 transactions are not in this set (the card fixes `maxSupportedTransactionVersion` at 0). A-M02-03 needs its own v1 fixture.
- Values are a snapshot. Reserves, virtual quote reserves [EX-09] and fee tiers can change after capture.
