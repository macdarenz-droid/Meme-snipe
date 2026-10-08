# VERIFY items for M0 and M1: results

Researcher session, 2026-10-07 (read between about 11:00 PM and 11:30 PM Melbourne, 12:00–12:30 UTC). Repo base `0aecee3b`.

Rule kept: documentation pages, published IDLs, npm tarballs and GitHub source only. No RPC call, no provider API call, no pump.fun-operated host. Nothing downloaded was run; npm tarballs and the pump-public-docs clone were only read.

Scope: every VERIFY / UNVERIFIED item that an M0 or M1 ticket depends on (`docs/blueprint/INTEGRATION.md` "Global build plan" and "Unverified items register"; `docs/MIGRATION.md` "Ticket order" Z00–Z10; SPEC-A U-A rows; ARCH §17). Items owned only by M2–M4 tickets are left out, except three live-path facts that came up in the same pages (rows 32–33) because A-M14-03 (M1) registers their buckets.

## Pinned sources used

| Short name | What | Pin |
|---|---|---|
| PPD | `github.com/pump-fun/pump-public-docs` (GitHub, not a pump.fun host: `docs/MIGRATION.md:411`) | commit `cb188ce08b5069196eef1f3e4a0c43b70099793b`, 2026-09-29T15:50:38+04:00. sha256: `idl/pump.json` `ffe966c4…c8b56064b`, `idl/pump_amm.json` `20914338…6e0e7f2d1`, `idl/pump_fees.json` `d87b5230…164fa3859` (full hashes in the JSON block) |
| SWAP-SDK | npm `@pump-fun/pump-swap-sdk` 1.20.0 (published 2026-09-10), the official SDK (EX-10). Its code comments name the Rust function each piece mirrors ("rust reference: pump-amm …"). The program source is not public | tarball integrity `sha512-DuBZ5ge3OJPao6m0aZZj+GTZFzfZ/TU3ca1EgL9ejr+8QIYETlLQVMaiznS+U4uGzM9z58mpxoXn3HuVEYHCFw==` |
| NODE | `github.com/nodejs/node` docs at tags `v24.21.0` and `v22.23.3`; `github.com/nodejs/Release` `schedule.json`; `nodejs.org/dist/index.json` | read 2026-10-07 |
| SOL | `solana.com/docs/rpc/...` method pages (`.md` form) | read 2026-10-07 |
| SHYFT | `docs.shyft.to/solana/solana-rpc-limits.md`, `.../accelerated-getprogramaccounts.md`, `.../shyft-rpcs`, `shyft.to/solana-rpc-grpc-pricing` | read 2026-10-07 |
| CS | `docs.chainstack.com/docs/limits.md`, `.../rps-plan-limits.md`, `.../request-units.md`, `chainstack.com/pricing/` | read 2026-10-07 |
| HEL | `helius.dev/docs/billing/rate-limits.md`, `.../billing/credits.md`, `.../billing/plans.md`, `.../api-reference/rpc/http/getprogramaccountsv2.md`, `.../sending-transactions/sender.md` | read 2026-10-07 |

## Results

Status: **confirmed** (source says what the Blueprint assumed), **corrected** (source settles it but differs from, or adds to, what the Blueprint or FACTS say), **not verified** (no official source settles it; reason given).

| # | ID | Ticket(s) | Question | Answer | Source | Status |
|---|---|---|---|---|---|---|
| 1 | U-A01 (EX-08) | A-M01-01, A-M03-03 (Z03, Z08) | Seeds of the pump pool-authority PDA used by the canonical-pool rule | Seeds `["pool-authority", base_mint]` under the **pump** program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`. A pool is canonical when `Pool.creator` (not `Pool.coin_creator`) equals this PDA. The IDL's `migrate` instruction derives `pool_authority` with const bytes `[112,111,111,108,45,97,117,116,104,111,114,105,116,121]` = `pool-authority` and account `mint` | PPD `docs/PUMP_SWAP_CREATOR_FEE_README.md:4-13`; `docs/FEE_PROGRAM_README.md:7-11`; `idl/pump.json:6082-6105` (`migrate`) @ cb188ce; SWAP-SDK `src/sdk/util.ts:26-31` | confirmed |
| 2 | U-A02 | A-M01-01 (Z03) | `@solana/kit` 8.x PDA helper name and signature | `getProgramDerivedAddress({ programAddress, seeds }): Promise<ProgramDerivedAddress>`, where `ProgramDerivedAddress = readonly [Address, ProgramDerivedAddressBump]` and a seed is `ReadonlyUint8Array \| string`. It is async. Kit latest is 8.4.0 (2026-09-28), MIT; the helper lives in `@solana/addresses` 8.4.0, which kit re-exports | npm `@solana/addresses` 8.4.0 `dist/types/program-derived-address.d.ts:13-16,45,68`; `registry.npmjs.org/@solana/kit` | confirmed |
| 3 | U-A09 (DA-11) | A-M02-01 (Z03) | Full commit SHA of the pinned IDLs | `cb188ce08b5069196eef1f3e4a0c43b70099793b` ("docs: negative virtual quote reserves on PumpSwap pools", 2026-09-29). It is the head of `main` on 2026-10-07. File hashes in "Pinned sources" | `git clone` of PPD, `git log -1` | corrected (DA-11 said the SHA could not be checked) |
| 4 | U-A10 | A-M02-01, A-M02-03 (Z03) | IDL field and argument names beyond EX-10 / EX-37 | Use the pinned PPD IDL spelling. Note: the PPD IDL is **newer** than the SDK 1.20.0 copy: PPD `Pool` has a 16th field `is_holder_reward` (bool) that SDK 1.20.0 lacks, and the two IDLs differ in instructions (SDK has `set_coin_creator_fee_bps`, `admin_set_coin_creator_fee_editable`, `admin_set_coin_creator`; counts 34 vs 32). Golden tests against the SDK must allow for this | PPD `idl/pump_amm.json` @ cb188ce vs SWAP-SDK `src/idl/pump_amm.json` | confirmed (with the version note) |
| 5 | A08 (GlobalConfig) | A-M01-02, A-M02-02 (Z03, Z07) | PumpSwap `GlobalConfig` layout | Borsh, discriminator `[149,8,156,202,160,252,176,217]`. Offsets (after the 8-byte discriminator): `admin`@8, `lp_fee_basis_points` u64 @40, `protocol_fee_basis_points` u64 @48, `disable_flags` u8 @56, `protocol_fee_recipients` [pubkey;8] @57, `coin_creator_fee_basis_points` u64 @313, `admin_set_coin_creator_authority` @321, `whitelist_pda` @353, `reserved_fee_recipient` @385, `mayhem_mode_enabled` bool @417, `reserved_fee_recipients` [pubkey;7] @418, `is_cashback_enabled` @642, `buyback_fee_recipients` [pubkey;8] @643, `buyback_basis_points` u64 @899, `boost_authority` @907, `boost_enabled` @939, `creator_fee_configurable` bool @940, `max_configurable_creator_fee_bps` u64 @941; fields end at byte 949. Offsets computed from the IDL type list; check against a recorded account in the decoder fixture | PPD `idl/pump_amm.json:6819-6930` @ cb188ce | confirmed |
| 6 | A08 (FeeConfig) | A-M01-02, A-M02-02 (Z03, Z07) | `FeeConfig` layout and how a schedule is chosen | Account of the fee program `pfeeUxB6…`, discriminator `[143,52,146,187,219,123,76,155]`: `bump` u8 @8, `admin` @9, `flat_fees` (3×u64: lp, protocol, creator bps) @41, then `fee_tiers` Vec<FeeTier> @65 (u32 length + n × 40 bytes: `market_cap_lamports_threshold` u128 + Fees), then `stable_fee_tiers` Vec<FeeTier>, then `exotic_flat_fees` (Fees). Choice: non-canonical pool → `flat_fees`; canonical + SOL-like quote (default key, wSOL, Token-2022 native mint) → `fee_tiers`; canonical + USDC → `stable_fee_tiers` (falls back to `fee_tiers` if empty); canonical + any other quote → `exotic_flat_fees`, or `flat_fees` while exotic is all zero | PPD `idl/pump_fees.json` (FeeConfig type) and `idl/pump_amm.json:6727`; SWAP-SDK `src/sdk/fees.ts:18-47,125-156` | confirmed |
| 7 | A08 (Pool, creator fee) | A-M01-02/03, A-M02-02 (Z07) | Pool layout and per-pool creator-fee fields | Borsh, discriminator `[241,154,109,4,17,177,109,188]`: `pool_bump`@8, `index` u16 @9, `creator` @11, `base_mint` @43, `quote_mint` @75, `lp_mint` @107, `pool_base_token_account` @139, `pool_quote_token_account` @171, `lp_supply` u64 @203, `coin_creator` @211, `is_mayhem_mode` @243, `is_cashback_coin` @244, `virtual_quote_reserves` i128 @245, `creator_fee_bps` u64 @261, `can_edit_creator_fee` bool @269, `is_holder_reward` bool @270; fields end at 271. Accounts are allocated at 300 bytes once extended; the docs say callers must prepend `extendAccount(pool)` when `pool.dataLen < 300`, so shorter legacy pools exist and missing tail fields must read as zero (as DA-V01 says for curves). Shyft lists accelerated offsets 43 and 75 for the PumpSwap program, which matches `base_mint` and `quote_mint` | PPD `idl/pump_amm.json:7075-7177`; `docs/PUMP_SWAP_CREATOR_FEE_README.md:18-19`; SHYFT `accelerated-getprogramaccounts.md:55` | confirmed |
| 8 | U-A03 | A-M01-02, A-M01-03, A-M10-03 (Z07, Z09) | PumpSwap fee placement, rounding, market-cap input, tier threshold inclusivity | **Placement:** buy fees are added on top of the pre-fee quote input; sell fees are taken from the gross output. **Rounding:** each fee is `ceil(amount × bps / 10000)`, computed separately for lp, protocol and creator (the SDK comment says "floor" but the code calls `ceilDiv`). Buy (exact base out): `quote_in = ceil(Qeff × base / (B − base))`, then fees on `quote_in`. Buy exact quote in: `q' = floor(quote × 10000 / (10000 + totalBps))`, reduce `q'` if `q' + fees > quote`, then the swap uses `q' − 1`, `base_out = floor(B × (q'−1) / (Qeff + q'−1))`. Sell: `out = floor(Qeff × base / (B + base))`, user gets `out − lp − protocol − creator`. **Market-cap input:** the **effective** quote reserve (vault + `virtual_quote_reserves`), `mcap = Qeff × supply / B` (floor); for mayhem pools the supply is fixed at 1,000,000,000,000,000 base units, not the mint supply. **Threshold:** a tier applies when `mcap ≥ threshold` (inclusive); below the first threshold the first tier applies. **Creator fee:** 0 when `Pool.coin_creator` is the default key; when `GlobalConfig.creator_fee_configurable` is true and `Pool.creator_fee_bps > 0`, it replaces the schedule's creator rate (lp and protocol unchanged). The SDK ignores `tradeSize` ("pump-fees tiers by market cap only") | SWAP-SDK `src/sdk/util.ts:8-17,37-60`; `src/sdk/buy.ts:71-113,184-240`; `src/sdk/sell.ts:69-112`; `src/sdk/fees.ts:68-108,159-183`; PPD `docs/FEE_PROGRAM_README.md:100-112` | corrected (see Flag 2: SPEC-A A-M01-02 step 3 uses the lower of vault-only and effective market cap, and has no per-pool creator fee, mayhem supply or exotic schedule) |
| 9 | U-A04 / A-09 (EX-V01) | A-M01-03 (Z07); also A-M06-04, B-M20 (M2) | What happens to a sell whose output is larger than the real quote vault | The official SDK **refuses** it: `sellBaseInput` throws "Insufficient real quote reserves to cover the sell output" when `real_quote_vault < out − lp_fee` (the lp fee stays in the pool). It is not clamped. The SDK has a test for exactly this ("rejects sells whose output exceeds the real quote reserves"). `sellQuoteInput` also throws when the wanted quote exceeds the real vault. The program source is not public, so the on-chain result (a failed transaction) is inferred from the SDK; a simulation near the boundary in the builder's test is the final check | SWAP-SDK `src/sdk/sell.ts:102-106`, `src/__tests__/boost.spec.ts:84-99` | corrected (see Flag 3: the Blueprint plans to clamp proceeds to the real vault) |
| 10 | U-A05 (fields) | A-M01-04, A-M02-03 (Z03, Z07) | Do PumpSwap `BuyEvent`/`SellEvent` carry pool reserves, and the exact names | Yes: `pool_base_token_reserves` and `pool_quote_token_reserves` (u64), plus `virtual_quote_reserves` (i128), `base_supply`, `lp_fee_basis_points`/`lp_fee`, `protocol_fee_basis_points`/`protocol_fee`, `coin_creator_fee_basis_points`/`coin_creator_fee`, `buyback_*`, `cashback_*`, `holder_rewards_*`, `can_boost`, `ix_name`. Buy has `quote_amount_in`, `quote_amount_in_with_lp_fee`, `user_quote_amount_in`, `base_amount_out`; Sell has `quote_amount_out`, `quote_amount_out_without_lp_fee`, `user_quote_amount_out`, `base_amount_in`. Event discriminators: BuyEvent `[103,244,82,31,44,245,119,119]`, SellEvent `[62,47,55,10,165,3,220,42]` | PPD `idl/pump_amm.json:6145` (BuyEvent), `:7178` (SellEvent) @ cb188ce | confirmed |
| 11 | U-A05 (timing) | A-M01-04, A-M02-03 (Z07) | Are the event reserves taken before or after the swap | No official page says. The repo's own CORE-2 work read them as pre-trade (`docs/DECISIONS.md:352,771`; `docs/MIGRATION.md:417`), which is from chain data, not docs. Settle with the 353 PumpSwap goldens: replay each event on its own reserves and match the amounts | none official | not verified (needs the golden replay; no live call needed) |
| 12 | U-A06 | A-M01-05, A-M06-04 | `GlobalConfig.disable_flags` bit layout | Not published. The README still says the bitmask "is not used" while documenting `disable(...)`; the SDK has only `disableFlags: number`. Keep SPEC-A's rule: only `disable_flags == 0` counts as enabled | PPD `docs/PUMP_SWAP_README.md:58,218-219`; SWAP-SDK `src/types/sdk.ts:135` | not verified (no source exists) |
| 13 | U-A07 (DA-16) | A-M02-03, A-M02-04 (Z03, Z07) | Are pump events emitted by self-CPI | Supporting evidence only: PumpSwap `sell` and other instructions take `event_authority` (PDA `["__event_authority"]`) and `program` accounts, the Anchor event-CPI pattern; the docs do not say "self-CPI" outright. (In the PPD IDL `buy` lists 23 accounts and its last six do not include `event_authority`; `sell` has it at position 16.) Settle on recorded transactions | PPD `docs/instructions/SELL.md:34`, `BUY.md:35`, `idl/pump_amm.json` | not verified (inference stays; recorded-tx test) |
| 14 | U-A08 | A-M02-02 (Z03) | SPL Token / Token-2022 base layouts and `COption` | Mint (82 bytes): `mint_authority` COption<Pubkey> @0 (36), `supply` u64 @36, `decimals` @44, `is_initialized` @45, `freeze_authority` COption @46 (36). Account (165): `mint` @0, `owner` @32, `amount` u64 @64, `delegate` COption @72 (36), `state` u8 @108, `is_native` COption<u64> @109 (12), `delegated_amount` u64 @121, `close_authority` COption @129 (36). `COption` = 4-byte tag `[0,0,0,0]` None / `[1,0,0,0]` Some, then the body (32 or 8 bytes, little-endian). Token-2022 keeps the same 165-byte base; the account-type byte sits at index 165 and TLV extensions follow (`BASE_ACCOUNT_LENGTH = Account::LEN`) | `github.com/solana-program/token` `interface/src/state.rs:38-42,132-136,253-289` @ `8185db13640f0df038266c7cf4306c212d81380a`; `github.com/solana-program/token-2022` `interface/src/extension/mod.rs:311-322` @ `2a3f277c9c5886cd5cbb60120454f8746576aeea` | confirmed |
| 15 | A-19 | A-M02-02 (Z03) | Does Codama 1.11.0 consume the pump Anchor IDL | `codama` 1.11.0 and `@codama/nodes-from-anchor` 1.5.6 (both MIT, 2026-09-15). The converter "converts Anchor IDLs from various versions" and ships a `v01` path; the pump IDLs use `"spec": "0.1.0"`. Whether it generates a working decoder for these IDLs was not run (no downloaded code is executed here). INTEGRATION decision 10 keeps decoders dependency-free, so hand-written decoders from the IDL are the path anyway | npm `@codama/nodes-from-anchor` 1.5.6 `README.md:10`, `dist/types/v01/` | not verified (prototype in ticket; fallback is the plan of record) |
| 16 | A-18 (LTS) | B-M30-01 (Z01), Z00, B-M24-01 (Z02) | Which Node LTS, and its dates | On 2026-10-07: Node 24 "Krypton" is Active LTS (since 2025-10-28), goes to maintenance 2026-10-20, end of life 2028-04-30; latest 24.21.0 (2026-09-07). Node 26 becomes LTS on 2026-10-28 (EOL 2029-04-30). Node 22 is in maintenance (EOL 2027-04-30). The repo's `package.json` says `"node": ">=22.18"` and this container runs 22.22.0 | NODE `schedule.json`; `nodejs.org/dist/index.json` | corrected (see Flag 5: pick Node 24 ≥ 24.15.0, not 22) |
| 17 | A-45 / U-A22 (sqlite) | B-M24-01 (Z02) | Does `node:sqlite` support transactions, WAL and online backup | On Node 24.21.0: module is **Stability 1.2, Release candidate** (since v24.15.0). Transactions: `database.exec(sql)` runs `BEGIN`/`COMMIT`/`ROLLBACK`, and `database.isTransaction` (added v24.0.0) reports state. Online backup: `sqlite.backup(sourceDb, path, {rate, progress})` wraps `sqlite3_backup_init/step/finish` (added v23.8.0); "mutations from other connections will cause the backup process to restart". WAL: the Node docs do not mention it; it is SQLite's `PRAGMA journal_mode=WAL`, which returns `"wal"` on success. On Node 22.23.3 the module is only Stability 1.1 (active development), but it does have `isTransaction` (correction, 8 Oct: checked on 22.22.0; Z02's `sqlite-verify.test.ts` asserts it on CI's 22.23.3) | NODE `doc/api/sqlite.md` @ v24.21.0 lines 3-18, 382-392, 511-517, 1436-1468; @ v22.23.3 line 13; `sqlite.org/wal.html` §3 | confirmed on Node 24 (record in `DEPENDENCIES.md`; the builder's test checks `PRAGMA journal_mode=WAL` returns `wal` on the pinned build) |
| 18 | U-A22 (zstd) | A-M07-02 (Z08) | Built-in zstd in `node:zlib` | Present (`zlib.zstdCompress`, `ZstdCompress`, added v23.8.0 / v22.15.0) but marked **Stability 1, Experimental** on Node 24.21.0 | NODE `doc/api/zlib.md` @ v24.21.0 lines 1094, 1141, 1712-1720 | confirmed (experimental; keep the C-17 gzip fallback) |
| 19 | A-07 / U-A27 | A-M14-02, A-M14-05 (Z03, Z08) | Shyft Free "unlimited credits" fair-use limits | No fair-use number is published. The pricing page, its FAQ, the RPC docs and the limits page say "unlimited credits" with no fair-use clause; `shyft.to/terms` serves a privacy policy that points to `shyft.com/terms.html` (not read: a different domain, not confirmed to be Shyft's). The docs say "your plan limit is a ceiling, not a guarantee against 429s" | SHYFT pricing page, `solana-rpc-limits.md`, `shyft-rpcs` FAQ | not verified (watch 429s; the ≤ 50% rule applies) |
| 20 | Shyft Free limits | A-M14-01, A-M14-02, A-M04-01 (Z03, Z07) | Shyft Free per-second limits per call type | Free: **10 RPC req/s**, **0 index req/s**, **1 sendTransaction/s**, unlimited credits, no gRPC, no staked connections. "Index calls" are `getProgramAccounts`, `getTokenAccountsByOwner`, `getTokenLargestAccounts`, `getTokenAccountsByDelegate`, each limited separately. gPA has a 1 s timeout and unfiltered gPA is blocked; Accelerated gPA "is not available in the free plan". HTTP and WebSocket standard methods are supported. At ≤ 50%: standard reads ≤ 5 req/s | SHYFT `solana-rpc-limits.md` ("Unlimited RPC Plan Limits" table and FAQ); `accelerated-getprogramaccounts.md:14,357` | corrected (LD-33 has no index limit; see Flag 1) |
| 21 | Chainstack Free limits | A-M14-02 (Z03) | Chainstack Developer (free) limits for Solana | Developer plan: **5 RPS on Solana Mainnet** (the 25 RPS figure is the global plan limit; Devnet gets 25). 3M request units a month; a Solana call is 1 RU, except archive-scope calls (2 RU: `getSignaturesForAddress` always, and some history calls for old slots). `getProgramAccounts`, `getSupply`, `getTokenAccountsByOwner` are **paid plans only**; `getTokenLargestAccounts` is 0 RPS (dedicated nodes only). Per-method cap `getMultipleAccounts` 300 RPS. Over-limit → HTTP 429, JSON-RPC −32005. Pricing lists "Extra usage, per 1M RUs $20" on Developer. The owner's one read every 2 s (0.5 req/s, ~1.3M RU per 30 days) fits under both the ≤ 50% rate (2.5 req/s) and the monthly 3M | CS `limits.md:11-18,143-206,215-222`; `rps-plan-limits.md:11`; `request-units.md:19-20,93-108`; `chainstack.com/pricing/` plan table | corrected (LD-32 says 25 req/s; see Flag 4) |
| 22 | A-06 / U-A13 (Solana) | A-M04-01, A-M03-03 (Z07, Z08) | Maximum accounts per `getMultipleAccounts` | "up to a maximum of 100" pubkeys. The Blueprint's batches of ≤ 90 fit | SOL `rpc/http/getmultipleaccounts.md:141-142` | confirmed |
| 23 | A-06 / U-A13 (providers) | A-M04-01 (Z07) | Lower per-call caps at Shyft, Chainstack, Helius | None of the three publishes a per-call account cap lower than 100 in the pages read (Shyft's method page, Chainstack's limits page, Helius's rate-limit page) | SHYFT `rpc-calls/http/getmultipleaccounts.md`; CS `limits.md`; HEL `rate-limits.md` | not verified (absence of a statement is not proof; the builder's first batch of 90 on each provider is the test, within the ≤ 50% rule) |
| 24 | D30 / U-A12 / A-42 (provider support) | A-M03-03 (Z08) | Which provider can run the daily `getProgramAccounts` on PumpSwap, with `dataSlice` | **Shyft Free: no** (0 index req/s). **Chainstack Developer: no** (gPA paid only). **Helius Free: yes**, 5 gPA/s on Free; `getProgramAccounts` costs 10 credits; `getProgramAccountsV2` costs 1 credit per page with a limit of 1–10,000 accounts per page and `changedSinceSlot` for updates; end of pagination is when `paginationKey` is null. Standard gPA accepts `dataSlice` and up to 4 filters (DA-06); the V2 page does not mention `dataSlice`. Public Solana RPC: its page does not say whether gPA on this program is served | HEL `rate-limits.md` "Complex RPC Calls"; `credits.md:93-102`; `getprogramaccountsv2.md:16-17,46,107`; SOL `rpc/http/getprogramaccounts.md:299` | corrected (see Flag 1: the Phase 0 plan reads from Shyft, which cannot do this) |
| 25 | A-42 (layout for the filter) | A-M03-03 (Z08) | Pool account size and quote-mint offset for the filter | `quote_mint` at byte 75, `base_mint` at 43, `creator` at 11 (row 7). Size is 300 bytes after extension but older pools can be shorter (row 7), so a `dataSize: 300` filter can miss pools. Use `memcmp` on the Pool discriminator at offset 0 plus `memcmp` wSOL at offset 75 (2 of the 4 allowed filters). A `dataSlice` of offset 11, length 192 covers `creator` through `pool_quote_token_account` (canonicality check plus both vaults) | rows 1 and 7 sources; SOL gPA page | confirmed (offsets); filter advice is a recommendation |
| 26 | D30 cost / A-43 | A-M03-03 (Z08) | Cost of the enumeration and the real pool count | Cost on Helius at the documented rates: gPA 10 credits per call, or V2 1 credit per page of up to 10,000. At the Blueprint's assumed 50,000 pools (A-43): about 5–10 V2 pages a day, about 150–300 credits a month, or 300 a month with one gPA call a day. Vault refresh at ≤ 90 accounts per batch every 6 h: about 1,100 standard calls a day for 50,000 pools (2 vaults each), which only fits an unmetered provider (Shyft at ≤ 5 req/s takes about 4 minutes). The real count is unknown until the first enumeration | HEL `credits.md`; arithmetic from ARCH §M03 (`docs/blueprint/ARCH.md:889-891`) | not verified (pool count needs the first call; the cost figures are arithmetic on confirmed rates) |
| 27 | A-31 / U-A28 | A-M04-03 (Z07) | `accountSubscribe` method and parameters | `accountSubscribe(pubkey, {encoding, commitment})`, notifications `accountNotification`; `accountUnsubscribe` to stop. Shyft lists it among its WebSocket methods. Metering: Shyft has no credits; Helius per LD-V01 | SOL `rpc/websocket/accountsubscribe.md:4-46`; SHYFT `llms.txt` (accountsubscribe page) | confirmed (method); WS connection caps on Shyft Free not published |
| 28 | A-36 | B-M15-01 (Z06) | `getEpochInfo` returns slot and block height together | Yes: `absoluteSlot` and `blockHeight` in one result | SOL `rpc/http/getepochinfo.md:116-119,137-143` | confirmed |
| 29 | A-37 | B-M15-01 (Z06) | `getBlockTime` returns whole seconds | Yes: i64 "Estimated production time, as Unix timestamp (seconds since the Unix epoch)", or null | SOL `rpc/http/getblocktime.md:105-107,115-120` | confirmed |
| 30 | SPEC-B (register #84) | B-M15-01 (Z06) | `getRecentPerformanceSamples` field names | `slot`, `numTransactions`, `numSlots`, `samplePeriodSecs`, `numNonVoteTransactions`; the last "is null for older performance samples" | SOL `rpc/http/getrecentperformancesamples.md:100-108,132-159` | confirmed |
| 31 | A-44 / U-A25 (MinBTL) | A-M13-03 (Z04) | Exact MinBTL expression | Theorem 3.1: `MinBTL ≈ ( [(1−γ)·Z⁻¹(1 − 1/N) + γ·Z⁻¹(1 − 1/(N·e))] / E[max_N] )² < 2·ln[N] / E[max_N]²` years, γ ≈ 0.5772156649, Z⁻¹ the inverse standard normal CDF, N ≫ 1. Same as SPEC-A A-M13-03 step 5. Check: N = 45 gives 4.998 years and N = 7 gives 1.923 years at E[max] = 1, matching the paper's "45 … 5 years" and the register's 2-year / 7 example. Read from the authors' hosted copy (version dated April 1, 2014); the published Notices PDF on ams.org returned 403 through the proxy | `davidhbailey.com/dhbpapers/backtest-pseudo.pdf`, eq. (3.2), §3 (pdftotext lines 405-425) | confirmed |
| 32 | A-40 / U-A26 | A-M14-03 (Z08; use is M4) | Helius Sender key placement and per-region counting | The key goes in the URL query: `https://sender.helius-rpc.com/fast?api-key=…`. "append it to your Sender endpoint for the standard 50 requests per second, per-region limit". Sender needs no credits and is on all plans. Because the key sits in the URL, every log of a Sender URL must be redacted | HEL `sending-transactions/sender.md:37,77-81,144,342` | confirmed |
| 33 | Integration #121 | B-M18-02 (M4) | How a Sender request selects SWQOS-only | "Add `?swqos_only=true` to any endpoint URL"; minimum tip 0.000005 SOL (Sender Max: 0.001 SOL) | HEL `sending-transactions/sender.md:14,49,64-65,307` | confirmed |
| 34 | U-A14 | A-M03-04 (Z08) | DexScreener `chainId` for Solana; fields; rate | `chainId` path value `solana`. `GET https://api.dexscreener.com/tokens/v1/{chainId}/{tokenAddresses}`, up to 30 comma-separated addresses, 300 requests per minute; pair fields include `chainId`, `dexId`, `pairAddress`, `baseToken`, `quoteToken`, `priceNative`, `priceUsd`, `txns`, `volume`, `priceChange`, `liquidity` {usd, base, quote}, `fdv`, `marketCap`, `pairCreatedAt`. Pair lookup `/latest/dex/pairs/{chainId}/{pairId}` is also 300/min; profile and boost endpoints are 60/min | `docs.dexscreener.com/api/reference` | confirmed |
| 35 | A-32 | A-M03-04 (Z08) | May DexScreener data be stored in a private database | The API terms (last updated 2023-08-18) neither allow nor forbid private storage. They give a revocable licence, allow commercial use, keep all rights to "the data obtained through it" with DEX Screener, and forbid making the API "or any portion thereof, available for third parties". Keep the Blueprint rule: store privately, never redistribute; the private reports repo upload of recordings must not carry DexScreener fields to anyone else | `docs.dexscreener.com/api/api-terms-and-conditions` §1-§4 | not verified (terms are silent; safest reading kept) |
| 36 | U-A27 (billing month) | A-M14-05 (Z08) | Provider billing month boundaries | Not found on the pages read. Shyft Free has no credits, so it does not matter there; Chainstack (3M RU) and Helius (1M credits Free) boundaries not stated | — | not verified (keep SPEC-A's UTC calendar month, the stricter reading for alerts) |
| 37 | Register #95 | B-M30-01 (Z01) | pnpm flag to disable lifecycle scripts | The repo pins `pnpm@10.28.0`. pnpm 10: `--ignore-scripts` / `ignoreScripts` ("Do not execute any scripts defined in the project package.json and its dependencies"); `ignoreDepScripts` for dependencies only; "Since v10, pnpm doesn't run the lifecycle scripts of dependencies unless they are listed in `onlyBuiltDependencies`"; `strictDepBuilds` (v10.3.0+) fails the install when a dependency has unreviewed build scripts | `pnpm.io/10.x/cli/install`; `pnpm.io/10.x/settings` (Build Settings) | confirmed |
| 38 | Register #94 | B-M28-01 (Z02) | zod version and licence | `zod` 4.6.5 (2026-09-13), MIT | `registry.npmjs.org/zod` | confirmed |
| 39 | Register #123 | B-M30-01 (Z01) | Property-test library version and licence | `fast-check` 4.10.2 (2026-09-19), MIT | `registry.npmjs.org/fast-check` | confirmed |
| 40 | UI U-04 | UI-T04 (Z05) | Do the named Lucide icons exist in `lucide-react` 1.52.0 | All 11 exist as files in the 1.52.0 tarball: `trending-up`, `trending-down`, `triangle-alert`, `octagon-alert`, `octagon-x`, `flask-conical`, `radio`, `history`, `clock-alert`, `unplug`, `lock-keyhole` (and `check`). `lucide-react` 1.52.0, ISC, 2026-10-04 | npm `lucide-react` 1.52.0 `dist/esm/icons/*.mjs` | confirmed |
| 41 | UI U-11, UI facts #116 (UI-F32) | UI-T01 (Z05) | Versions and licences in UI-F32 | Every listed version is still `latest` on 2026-10-07 except `next` (now 16.4.0, not chosen). Licences that UI-F32 left as "—": Vitest MIT, `@playwright/test` Apache-2.0, Storybook MIT, ESLint MIT, typescript-eslint MIT, Next.js MIT, **`axe-core` and `@axe-core/playwright` MPL-2.0**. typescript-eslint 8.71.1 still declares peer `typescript >=4.8.4 <6.1.0` (newest 6.0.x is 6.0.3; `latest` 7.0.2); Vite 8.3.3 engines `^20.19.0 \|\| >=22.12.0` | `registry.npmjs.org/<package>` for each | corrected (two MPL-2.0 licences; see Flag 7) |
| 42 | UI facts #117, U-12 | UI-T01 (Z05) | React and Vite release dates; cmdk last publish | React and React DOM 19.3.0 published 2026-09-09; Vite 8.3.3 published 2026-10-06. `cmdk` 1.1.1 was published **2025-03-14**; 2025-08-27 is only the registry's `modified` time. Support windows were not checked | `registry.npmjs.org/react`, `/vite`, `/cmdk` (`time` field) | corrected (cmdk date) |
| 43 | U-A11 | A-M03-01 (Z08) | PumpPortal key, message shapes, ban signal | Not read. The owner ruled PumpPortal is not used for now and A-M03-01 is built but not run against it (`CLAUDE.md` 7 Oct; `docs/MIGRATION.md:705`) | — | not verified (deferred by the owner's ruling) |
| 44 | U-A23 | A-M14-03 (Z08); A-M11-04 (M2) | CoinGecko on-chain OHLCV path and Demo limits | Not read. Addendum A18: no early CoinGecko screen for now (owner, 7 Oct); in M1 A-M14-03 only needs a disabled bucket | — | not verified (deferred) |
| 45 | A-24, A-24b, A-43, A-48, U-A30 | A-M05-03, A-M13-01, A-M07-02 (Z08, Z09) | Pool universe size, move sizes, zstd ratio, priors | Not documentation facts. They are measured from the M1 recording (the M1 exit study) | — | not verified (by design: measured in M1) |

Counts over the 45 rows: **confirmed 24**, **corrected 9**, **not verified 12**. Rows 10 and 11 are the two halves of U-A05, rows 22 and 23 the two halves of U-A13, and rows 24–26 the three parts of D30 / U-A12.

- confirmed (24): 1, 2, 4, 5, 6, 7, 10, 14, 17, 18, 22, 25, 27, 28, 29, 30, 31, 32, 33, 34, 37, 38, 39, 40
- corrected (9): 3, 8, 9, 16, 20, 21, 24, 41, 42
- not verified (12): 11, 12, 13, 15, 19, 23, 26, 35, 36, 43, 44, 45

## Flags: findings that change a ticket or the ticket order

1. **D30 enumeration has no free path on the approved Phase 0 providers (A-M03-03, Z08).** Shyft Free allows 0 index calls a second and Chainstack Developer does not serve `getProgramAccounts` at all. Helius Free serves it (5/s; about 150–300 credits a month for this job), but the owner's 7 Oct rule says "Helius headroom stays unused" in Phase 0. The supervisor or owner must choose before Z08: (a) allow this one small capped Helius job (it is a "fix with its own small, capped budget", not a rate rise; owner wording needed if it counts as Helius use), (b) the Blueprint fallback: track only migrations seen since recording started (reduced coverage, recorded in the manifest), or (c) a paid Shyft plan (new spend: owner only). Same root cause for M2: `getTokenLargestAccounts` and `getTokenAccountsByOwner` (holder checks, A-M06-03) also cannot run on Shyft Free or on Chainstack's shared nodes. Not an order change by itself, but Z08 cannot finish A-M03-03 as written.
2. **Quote and fee maths (A-M01-02, A-M01-03, A-M10-03; Z07, Z09).** SPEC-A A-M01-02 step 3 must change: market cap uses the effective quote reserve (the SDK does), mayhem pools use the fixed 10^15 supply, a configured `Pool.creator_fee_bps` replaces the creator rate when `GlobalConfig.creator_fee_configurable` is on, the creator fee is 0 when `coin_creator` is the default key, and exotic quote mints use `exotic_flat_fees`. Rounding is ceil per fee component, and buy-exact-quote-in subtracts 1 from the swap input. The "lower of vault-only and effective market cap" rule is no longer needed and would fail A08's acceptance ("a fixture fails a quote that uses … the vault alone"). The ≤ 30 bps filter must read the per-pool creator fee too (A08 already says so). The decoder (A-M02-02, Z03) must read `creator_fee_bps`, `is_mayhem_mode`, `creator_fee_configurable` and `max_configurable_creator_fee_bps`.
3. **Sells above the real vault fail, they are not clamped (A-M01-03 in Z07; A-M06-04, B-M20 in M2; A09).** The SDK refuses a sell when `real_quote_vault < gross_out − lp_fee`. The quoter should return an error (or the largest sellable size), and the exit ladder must size sells to the real vault. A09's acceptance text "proceeds clamped" should be re-read as "sell size limited so it can land"; the "entry rejected" and "collapse exit fires" parts stay. Confirm with one simulation near the boundary in the builder's test.
4. **Chainstack is 5 req/s on Solana mainnet, not 25 (A-M14-02, Z03).** Bucket ≤ 2.5 req/s. The owner's one read every 2 s fits, as does the 3M RU month at that rate (about 1.3M); 1 Hz polling there would use about 2.6M a month, so Chainstack stays a backup only. FACTS LD-32 needs a correction.
5. **Node version (Z00, Z01, Z02).** The repo says `>=22.18`; the Blueprint wants an active LTS. On Node 22 `node:sqlite` is still "active development" (correction, 8 Oct: it does have `isTransaction`; checked on 22.22.0, and Z02's `sqlite-verify.test.ts` asserts it on CI's 22.23.3); on Node 24 (≥ 24.15.0) it is a release candidate with transactions and online backup. Recommend pinning Node 24 (current 24.21.0) in `engines`, CI and the installer before Z02 builds persistence. Node 26 turns LTS on 28 Oct 2026; moving to it later is a separate card. This affects Z01's CI image and Z00's installer, so it should be settled in the first batch.
6. **Pool filter (A-M03-03).** Do not filter on `dataSize: 300`; use the discriminator `memcmp` at 0 and wSOL `memcmp` at 75 (row 25). Decoders must accept pools shorter than 300 bytes and read missing tail fields as zero.
7. **Licences (Z05, `DEPENDENCIES.md`).** `axe-core` and `@axe-core/playwright` are MPL-2.0 (dev and test only). The allowlist needs an explicit entry or a ruling.
8. **Sender key in the URL (A-M14-03/04).** The Helius Sender key is a query parameter, so URL logging must redact it (the register already says "key never logged").
9. **FACTS corrections (Z0D).** LD-32 (Chainstack Solana RPS), LD-33 (Shyft index and sendTransaction limits), DA-11 (commit now known), UI-F32 (cmdk date, licences). Proposed entries below.

No finding changes the batch order Z00, Z01, Z0D → Z02, Z04, Z05 → Z03 → Z06 → Z07, Z08 → Z09, provided Flag 1 is decided before Z08 starts and Flag 5 before Z02.

## Proposed FACTS register entries

Schema as in `docs/blueprint/FACTS.json` `facts[]`. New IDs use the prefix `VF-` (verification of M0/M1 items); the supervisor may renumber them into the existing prefixes when folding in. Entries marked as corrections name the fact they correct in `note`.

```json
[
  {
    "id": "VF-01",
    "topic": "PumpSwap canonical pool: pool-authority PDA seeds",
    "claim": "The pump pool-authority PDA is derived with seeds [\"pool-authority\", base_mint] under the pump program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P. A PumpSwap pool is canonical when Pool.creator (not Pool.coin_creator) equals this PDA. The pump IDL's migrate instruction derives pool_authority from the const bytes of \"pool-authority\" and the mint account.",
    "sources": [
      "https://github.com/pump-fun/pump-public-docs/blob/cb188ce08b5069196eef1f3e4a0c43b70099793b/docs/PUMP_SWAP_CREATOR_FEE_README.md",
      "https://github.com/pump-fun/pump-public-docs/blob/cb188ce08b5069196eef1f3e4a0c43b70099793b/docs/FEE_PROGRAM_README.md",
      "https://github.com/pump-fun/pump-public-docs/blob/cb188ce08b5069196eef1f3e4a0c43b70099793b/idl/pump.json"
    ],
    "source_type": "official_repo_or_idl",
    "as_of": "commit cb188ce08b5069196eef1f3e4a0c43b70099793b (2026-09-29), read 2026-10-07",
    "confidence": "high",
    "design_relevance": "Resolves U-A01: A-M01-01 can compute isCanonical, so pools are no longer rejected for unknown seeds.",
    "verification": "confirmed",
    "note": "Rust snippet at PUMP_SWAP_CREATOR_FEE_README.md:4-13; isPumpPool at FEE_PROGRAM_README.md:7-11; pump.json:6082-6105 (migrate.pool_authority). The SDK uses the same rule (pump-swap-sdk 1.20.0 src/sdk/util.ts:26-31).",
    "verifier_evidence": [
      "git clone https://github.com/pump-fun/pump-public-docs (HEAD cb188ce)",
      "npm @pump-fun/pump-swap-sdk 1.20.0 src/sdk/util.ts"
    ]
  },
  {
    "id": "VF-02",
    "topic": "pump-public-docs pin and IDL hashes",
    "claim": "pump-public-docs main is at commit cb188ce08b5069196eef1f3e4a0c43b70099793b (2026-09-29T15:50:38+04:00). sha256: idl/pump.json ffe966c42f1af41652ee753fe2f1e3f7cd4077d7e6f49faf3138959c8b56064b; idl/pump_amm.json 2091433899b07d003d98118ae6cd3c628960fd393b40710b6e15bce6d0e7f2d1; idl/pump_fees.json d87b52305fd6b2ec487d4ba1e08a49990c23fa9b8b76092b2097df0164fa3859. The PPD pump_amm IDL is newer than the copy in @pump-fun/pump-swap-sdk 1.20.0: its Pool type has an extra field is_holder_reward, and the instruction lists differ (32 vs 34).",
    "sources": [
      "https://github.com/pump-fun/pump-public-docs/commit/cb188ce08b5069196eef1f3e4a0c43b70099793b",
      "https://registry.npmjs.org/@pump-fun/pump-swap-sdk/-/pump-swap-sdk-1.20.0.tgz"
    ],
    "source_type": "official_repo_or_idl",
    "as_of": "2026-10-07",
    "confidence": "high",
    "design_relevance": "Resolves U-A09. A-M02-01 vendors these exact files; SDK golden tests must allow for the newer PPD IDL.",
    "verification": "corrected",
    "note": "Corrects DA-11, which says the commit could not be checked.",
    "verifier_evidence": ["git log -1 and sha256sum on a fresh clone; IDL type comparison against the SDK tarball"]
  },
  {
    "id": "VF-03",
    "topic": "PumpSwap account layouts: Pool, GlobalConfig, FeeConfig",
    "claim": "Borsh layouts from pump_amm.json at cb188ce, offsets after the 8-byte discriminator. Pool [241,154,109,4,17,177,109,188]: pool_bump 8, index u16 9, creator 11, base_mint 43, quote_mint 75, lp_mint 107, pool_base_token_account 139, pool_quote_token_account 171, lp_supply u64 203, coin_creator 211, is_mayhem_mode 243, is_cashback_coin 244, virtual_quote_reserves i128 245, creator_fee_bps u64 261, can_edit_creator_fee 269, is_holder_reward 270 (271 bytes of fields; accounts are extended to 300 bytes, and pools with dataLen < 300 exist). GlobalConfig [149,8,156,202,160,252,176,217]: admin 8, lp_fee_basis_points 40, protocol_fee_basis_points 48, disable_flags u8 56, protocol_fee_recipients [pubkey;8] 57, coin_creator_fee_basis_points 313, admin_set_coin_creator_authority 321, whitelist_pda 353, reserved_fee_recipient 385, mayhem_mode_enabled 417, reserved_fee_recipients [pubkey;7] 418, is_cashback_enabled 642, buyback_fee_recipients [pubkey;8] 643, buyback_basis_points 899, boost_authority 907, boost_enabled 939, creator_fee_configurable 940, max_configurable_creator_fee_bps 941. FeeConfig [143,52,146,187,219,123,76,155] (fee program): bump 8, admin 9, flat_fees (lp, protocol, creator u64 bps) 41, fee_tiers Vec<FeeTier{market_cap_lamports_threshold u128, fees}> 65, then stable_fee_tiers Vec<FeeTier>, then exotic_flat_fees.",
    "sources": [
      "https://github.com/pump-fun/pump-public-docs/blob/cb188ce08b5069196eef1f3e4a0c43b70099793b/idl/pump_amm.json",
      "https://github.com/pump-fun/pump-public-docs/blob/cb188ce08b5069196eef1f3e4a0c43b70099793b/idl/pump_fees.json",
      "https://github.com/pump-fun/pump-public-docs/blob/cb188ce08b5069196eef1f3e4a0c43b70099793b/docs/PUMP_SWAP_CREATOR_FEE_README.md",
      "https://docs.shyft.to/solana/accelerated-getprogramaccounts.md"
    ],
    "source_type": "official_repo_or_idl",
    "as_of": "2026-10-07",
    "confidence": "high",
    "design_relevance": "Addendum A08 and A-42: decoders (A-M02-02) and the enumeration filter (A-M03-03). Use memcmp on the discriminator at 0 and on wSOL at 75, not dataSize 300.",
    "verification": "added_by_verifier",
    "note": "Offsets are computed from the IDL type list (all three types are borsh). Shyft's accelerated gPA offsets for pAMMBay… are 43 and 75, which matches base_mint and quote_mint. Check offsets against one recorded account per type in the decoder fixtures.",
    "verifier_evidence": ["IDL type walk over pump_amm.json and pump_fees.json at cb188ce"]
  },
  {
    "id": "VF-04",
    "topic": "PumpSwap fee placement, rounding, market-cap input and schedule choice",
    "claim": "Per the official @pump-fun/pump-swap-sdk 1.20.0, whose functions name the Rust code they mirror: each fee component is ceil(amount x bps / 10000), computed separately for lp, protocol and coin creator. Buy fees are added on top of the pre-fee quote input; sell fees are taken from the gross output. Buy exact quote in: q' = floor(quote x 10000 / (10000 + totalBps)), reduced if q' plus fees exceeds quote, and the swap input is q' - 1. Market cap for tier choice = floor(effective_quote x supply / base_reserve), with effective_quote = vault + virtual_quote_reserves, and supply fixed at 1e15 base units for mayhem pools. A tier applies when market cap >= threshold. Non-canonical pools pay flat_fees; canonical SOL-like quote (default key, wSOL, Token-2022 native) pays fee_tiers; canonical USDC pays stable_fee_tiers; other quotes pay exotic_flat_fees (flat_fees while exotic is all zero). The creator fee is 0 when Pool.coin_creator is the default key, and Pool.creator_fee_bps replaces the schedule's creator rate when GlobalConfig.creator_fee_configurable is true and creator_fee_bps > 0. Trade size does not affect the tier.",
    "sources": [
      "https://registry.npmjs.org/@pump-fun/pump-swap-sdk/-/pump-swap-sdk-1.20.0.tgz",
      "https://github.com/pump-fun/pump-public-docs/blob/cb188ce08b5069196eef1f3e4a0c43b70099793b/docs/FEE_PROGRAM_README.md"
    ],
    "source_type": "official_repo_or_idl",
    "as_of": "SDK 1.20.0 (2026-09-10), read 2026-10-07",
    "confidence": "high",
    "design_relevance": "Resolves U-A03 for A-M01-02/03 and A-M10-03; replaces SPEC-A's lower-of-two market-cap rule and adds the per-pool creator fee, mayhem supply and exotic schedule.",
    "verification": "added_by_verifier",
    "note": "SDK src/sdk/util.ts:8-17,37-60; buy.ts:71-113,184-240; sell.ts:69-112; fees.ts:68-108,125-183. The buy.ts comment says floor but the code uses ceilDiv. The program source is not public; the 353 PumpSwap goldens (A08) are the on-chain check.",
    "verifier_evidence": ["Read of the SDK tarball source; not executed"]
  },
  {
    "id": "VF-05",
    "topic": "PumpSwap sells above the real quote vault are refused",
    "claim": "The official SDK refuses a sell when the real quote vault balance is below gross_output - lp_fee, throwing 'Insufficient real quote reserves to cover the sell output', and tests this case. Sell-for-exact-quote also refuses a quote above the real vault. Proceeds are not clamped.",
    "sources": ["https://registry.npmjs.org/@pump-fun/pump-swap-sdk/-/pump-swap-sdk-1.20.0.tgz"],
    "source_type": "official_repo_or_idl",
    "as_of": "2026-10-07",
    "confidence": "medium",
    "design_relevance": "Settles the UNVERIFIED part of EX-V01 and A-09 / U-A04 as far as docs can: exits must size sells to the real vault; A09's 'proceeds clamped' model needs re-reading.",
    "verification": "added_by_verifier",
    "note": "SDK src/sdk/sell.ts:102-106 and src/__tests__/boost.spec.ts:84-99. Medium confidence because the on-chain program source is not public; confirm with one simulateTransaction near the boundary in the builder test (within the 50% rule).",
    "verifier_evidence": ["Read of the SDK tarball source; not executed"]
  },
  {
    "id": "VF-06",
    "topic": "PumpSwap BuyEvent and SellEvent fields",
    "claim": "BuyEvent [103,244,82,31,44,245,119,119] and SellEvent [62,47,55,10,165,3,220,42] carry pool_base_token_reserves and pool_quote_token_reserves (u64), virtual_quote_reserves (i128), base_supply, lp/protocol/coin_creator fee bps and amounts, buyback, cashback and holder_rewards fields, can_boost and ix_name. Buy adds quote_amount_in, quote_amount_in_with_lp_fee, user_quote_amount_in, base_amount_out; Sell adds quote_amount_out, quote_amount_out_without_lp_fee, user_quote_amount_out, base_amount_in. No official page says whether the pool reserves are pre- or post-trade.",
    "sources": ["https://github.com/pump-fun/pump-public-docs/blob/cb188ce08b5069196eef1f3e4a0c43b70099793b/idl/pump_amm.json"],
    "source_type": "official_repo_or_idl",
    "as_of": "2026-10-07",
    "confidence": "high",
    "design_relevance": "U-A05 field names for A-M02-03 and A-M01-04. Reserve timing (pre-trade per the repo's CORE-2 chain work) stays to be proven by the golden replay.",
    "verification": "added_by_verifier",
    "note": "pump_amm.json:6145 (BuyEvent), :7178 (SellEvent).",
    "verifier_evidence": ["IDL read at cb188ce"]
  },
  {
    "id": "VF-07",
    "topic": "SPL Token and Token-2022 base layouts",
    "claim": "Mint is 82 bytes: mint_authority COption<Pubkey> 0..36, supply u64 36, decimals 44, is_initialized 45, freeze_authority COption 46..82. Account is 165 bytes: mint 0, owner 32, amount u64 64, delegate COption 72..108, state 108, is_native COption<u64> 109..121, delegated_amount u64 121, close_authority COption 129..165. COption is a 4-byte tag [0,0,0,0] None or [1,0,0,0] Some, then the body, little-endian. Token-2022 keeps the same base; the account-type byte is at index 165 and TLV extensions follow.",
    "sources": [
      "https://github.com/solana-program/token/blob/8185db13640f0df038266c7cf4306c212d81380a/interface/src/state.rs",
      "https://github.com/solana-program/token-2022/blob/2a3f277c9c5886cd5cbb60120454f8746576aeea/interface/src/extension/mod.rs"
    ],
    "source_type": "official_repo_or_idl",
    "as_of": "2026-10-07",
    "confidence": "high",
    "design_relevance": "Resolves U-A08 for A-M02-02.",
    "verification": "added_by_verifier",
    "note": "state.rs:38-42,132-136,253-289; extension/mod.rs:311-322.",
    "verifier_evidence": ["Source read at the named commits"]
  },
  {
    "id": "VF-08",
    "topic": "Node.js LTS and built-ins for the bot",
    "claim": "On 2026-10-07 Node 24 is Active LTS until 2026-10-20 (maintenance to EOL 2028-04-30; latest 24.21.0); Node 26 becomes LTS on 2026-10-28; Node 22 is in maintenance (EOL 2027-04-30). On Node 24.21.0 node:sqlite is Stability 1.2 release candidate (since v24.15.0), with database.exec for BEGIN/COMMIT, database.isTransaction (v24.0.0) and sqlite.backup(sourceDb, path, {rate, progress}) wrapping the SQLite online backup API; on Node 22.23.3 it is Stability 1.1 but also has isTransaction (correction 8 Oct: checked on 22.22.0, asserted by CI on 22.23.3). node:zlib zstd (zstdCompress, ZstdCompress) exists but is Stability 1 Experimental. WAL is SQLite's PRAGMA journal_mode=WAL, which returns 'wal' on success; the Node docs do not mention it.",
    "sources": [
      "https://raw.githubusercontent.com/nodejs/Release/main/schedule.json",
      "https://nodejs.org/dist/index.json",
      "https://github.com/nodejs/node/blob/v24.21.0/doc/api/sqlite.md",
      "https://github.com/nodejs/node/blob/v22.23.3/doc/api/sqlite.md",
      "https://github.com/nodejs/node/blob/v24.21.0/doc/api/zlib.md",
      "https://sqlite.org/wal.html"
    ],
    "source_type": "official_docs",
    "as_of": "2026-10-07",
    "confidence": "high",
    "design_relevance": "A-18, A-45 and U-A22: pin Node 24 (>= 24.15.0) for B-M24-01; keep the gzip fallback for A-M07-02.",
    "verification": "added_by_verifier",
    "note": "sqlite.md v24.21.0 lines 3-18, 382-392, 511-517, 1436-1468; zlib.md lines 1712-1720. The repo's package.json engines (>=22.18) predates this.",
    "verifier_evidence": ["Docs read at the named tags"]
  },
  {
    "id": "VF-09",
    "topic": "Shyft plan limits by call type",
    "claim": "Shyft Free: unlimited credits, 10 RPC req/s, 0 index req/s, 1 sendTransaction/s, no gRPC, no staked connections. Index calls (getProgramAccounts, getTokenAccountsByOwner, getTokenLargestAccounts, getTokenAccountsByDelegate) have their own limit; gPA has a 1-second timeout and unfiltered gPA is blocked; Accelerated gPA is not on the free plan. Build is 100/10/20, Grow 150/20/40, Accelerate 400/40/80 (RPC/index/sendTransaction per second). No fair-use limit is published for 'unlimited credits'.",
    "sources": [
      "https://docs.shyft.to/solana/solana-rpc-limits.md",
      "https://docs.shyft.to/solana/accelerated-getprogramaccounts.md",
      "https://shyft.to/solana-rpc-grpc-pricing"
    ],
    "source_type": "official_docs",
    "as_of": "2026-10-07",
    "confidence": "high",
    "design_relevance": "A-M14-02 buckets for the Phase 0 provider (standard reads <= 5 req/s at 50%). Shyft Free cannot run D30 enumeration or holder index calls.",
    "verification": "corrected",
    "note": "Corrects LD-33, which lists only RPC and API rates. A-07 (fair use) stays unverified: no text found.",
    "verifier_evidence": ["Docs pages read 2026-10-07"]
  },
  {
    "id": "VF-10",
    "topic": "Chainstack Developer plan on Solana mainnet",
    "claim": "Chainstack Developer (free): Solana Mainnet 5 RPS (the 25 RPS figure is the global plan limit and Solana Devnet), 3M request units a month, Solana calls 1 RU except archive-scope calls at 2 RU. getProgramAccounts, getSupply and getTokenAccountsByOwner are paid plans only; getTokenLargestAccounts is dedicated-node only. Per-method cap getMultipleAccounts 300 RPS. Over-limit returns HTTP 429 with JSON-RPC -32005. Pricing lists extra usage at $20 per 1M RUs on Developer.",
    "sources": [
      "https://docs.chainstack.com/docs/limits.md",
      "https://docs.chainstack.com/docs/rps-plan-limits.md",
      "https://docs.chainstack.com/docs/request-units.md",
      "https://chainstack.com/pricing/"
    ],
    "source_type": "official_docs",
    "as_of": "2026-10-07",
    "confidence": "high",
    "design_relevance": "Backup reader bucket <= 2.5 req/s. One read every 2 s uses about 1.3M RU per 30 days.",
    "verification": "corrected",
    "note": "Corrects LD-32 (25 req/s is not the Solana mainnet figure on Developer).",
    "verifier_evidence": ["Docs pages read 2026-10-07"]
  },
  {
    "id": "VF-11",
    "topic": "getProgramAccounts on Helius and the getMultipleAccounts cap",
    "claim": "Helius Free allows getProgramAccounts at 5/s (Developer 25, Business 50, Professional 75). getProgramAccounts costs 10 credits; getProgramAccountsV2 costs 1 credit and pages 1-10,000 accounts per request with paginationKey and changedSinceSlot; pagination ends only when no accounts are returned / paginationKey is null. Solana's getMultipleAccounts takes up to 100 pubkeys. No provider page read (Shyft, Chainstack, Helius) states a lower per-call cap.",
    "sources": [
      "https://www.helius.dev/docs/billing/rate-limits.md",
      "https://www.helius.dev/docs/billing/credits.md",
      "https://www.helius.dev/docs/api-reference/rpc/http/getprogramaccountsv2.md",
      "https://solana.com/docs/rpc/http/getmultipleaccounts.md"
    ],
    "source_type": "official_docs",
    "as_of": "2026-10-07",
    "confidence": "high",
    "design_relevance": "D30 / A-M03-03 provider choice and cost; A-06 batch size (<= 90 fits).",
    "verification": "added_by_verifier",
    "note": "V2 docs do not mention dataSlice.",
    "verifier_evidence": ["Docs pages read 2026-10-07"]
  },
  {
    "id": "VF-12",
    "topic": "Solana RPC field facts for the slot clock",
    "claim": "getBlockTime returns an i64 Unix timestamp in seconds (or null). getEpochInfo returns absoluteSlot and blockHeight in the same result. getRecentPerformanceSamples returns slot, numTransactions, numSlots, samplePeriodSecs and numNonVoteTransactions, the last null for older samples. accountSubscribe takes a pubkey and {encoding, commitment} and sends accountNotification messages.",
    "sources": [
      "https://solana.com/docs/rpc/http/getblocktime.md",
      "https://solana.com/docs/rpc/http/getepochinfo.md",
      "https://solana.com/docs/rpc/http/getrecentperformancesamples.md",
      "https://solana.com/docs/rpc/websocket/accountsubscribe.md"
    ],
    "source_type": "official_docs",
    "as_of": "2026-10-07",
    "confidence": "high",
    "design_relevance": "A-36, A-37, register #84 for B-M15-01; A-31 / U-A28 for A-M04-03.",
    "verification": "added_by_verifier",
    "verifier_evidence": ["Docs pages read 2026-10-07"]
  },
  {
    "id": "VF-13",
    "topic": "MinBTL expression",
    "claim": "Bailey, Borwein, Lopez de Prado and Zhu, Theorem 3.1: MinBTL ~ ( ((1-g) Zinv(1 - 1/N) + g Zinv(1 - 1/(N e))) / E[max_N] )^2 < 2 ln(N) / E[max_N]^2 years, g = 0.5772156649 (Euler-Mascheroni), Zinv the inverse standard normal CDF. N = 45 gives 4.998 years and N = 7 gives 1.923 years at E[max_N] = 1.",
    "sources": ["https://www.davidhbailey.com/dhbpapers/backtest-pseudo.pdf"],
    "source_type": "paper",
    "as_of": "authors' version dated 2014-04-01, read 2026-10-07",
    "confidence": "high",
    "design_relevance": "Resolves A-44 for A-M13-03; SPEC-A's expression is right.",
    "verification": "added_by_verifier",
    "note": "Equation (3.2). The ams.org copy returned 403 through this session's proxy; the authors' hosted copy was used.",
    "verifier_evidence": ["pdftotext of the PDF; numeric check with Python statistics.NormalDist"]
  },
  {
    "id": "VF-14",
    "topic": "Helius Sender key placement, regional limit and SWQOS-only",
    "claim": "A keyed Sender request carries the key as the api-key URL query parameter (https://sender.helius-rpc.com/fast?api-key=...); with a key the limit is 50 requests per second per region. SWQOS-only is selected with ?swqos_only=true on any endpoint URL; minimum tip 0.000005 SOL (Sender Max 0.001 SOL). Sender uses no credits and is on all plans.",
    "sources": ["https://www.helius.dev/docs/sending-transactions/sender.md"],
    "source_type": "official_docs",
    "as_of": "2026-10-07",
    "confidence": "high",
    "design_relevance": "A-40 / U-A26 for A-M14-03/04 (redact URLs in logs); integration item 121 for B-M18-02.",
    "verification": "added_by_verifier",
    "verifier_evidence": ["Docs page read 2026-10-07"]
  },
  {
    "id": "VF-15",
    "topic": "DexScreener token-pairs endpoint and API terms",
    "claim": "GET https://api.dexscreener.com/tokens/v1/{chainId}/{tokenAddresses}, chainId 'solana', up to 30 comma-separated addresses, 300 requests per minute; pair fields include chainId, dexId, pairAddress, baseToken, quoteToken, priceNative, priceUsd, txns, volume, priceChange, liquidity {usd, base, quote}, fdv, marketCap, pairCreatedAt. The API terms (updated 2023-08-18) allow commercial use, keep data rights with DEX Screener, and forbid making the API or any portion available to third parties; they do not address private storage.",
    "sources": [
      "https://docs.dexscreener.com/api/reference",
      "https://docs.dexscreener.com/api/api-terms-and-conditions"
    ],
    "source_type": "official_docs",
    "as_of": "2026-10-07",
    "confidence": "high",
    "design_relevance": "U-A14 for A-M03-04; A-32 stays open (store privately, never redistribute).",
    "verification": "added_by_verifier",
    "verifier_evidence": ["Docs pages read 2026-10-07"]
  },
  {
    "id": "VF-16",
    "topic": "Build tooling and UI package facts for M0",
    "claim": "pnpm 10: --ignore-scripts / ignoreScripts disables project and dependency scripts; since v10 dependency lifecycle scripts run only when listed in onlyBuiltDependencies; strictDepBuilds (v10.3.0+) fails installs with unreviewed build scripts. npm latest on 2026-10-07: zod 4.6.5 MIT; fast-check 4.10.2 MIT; @solana/kit 8.4.0 MIT; lucide-react 1.52.0 ISC, which contains trending-up, trending-down, triangle-alert, octagon-alert, octagon-x, flask-conical, radio, history, clock-alert, unplug and lock-keyhole. UI-F32 versions all still latest except next 16.4.0. Licences: vitest MIT, @playwright/test Apache-2.0, storybook MIT, eslint MIT, typescript-eslint MIT, next MIT, axe-core MPL-2.0, @axe-core/playwright MPL-2.0. cmdk 1.1.1 was published 2025-03-14 (2025-08-27 is the registry modified time). react 19.3.0 published 2026-09-09; vite 8.3.3 published 2026-10-06.",
    "sources": [
      "https://pnpm.io/10.x/cli/install",
      "https://pnpm.io/10.x/settings",
      "https://registry.npmjs.org/zod",
      "https://registry.npmjs.org/fast-check",
      "https://registry.npmjs.org/lucide-react",
      "https://registry.npmjs.org/axe-core",
      "https://registry.npmjs.org/@axe-core/playwright",
      "https://registry.npmjs.org/cmdk"
    ],
    "source_type": "official_docs",
    "as_of": "2026-10-07",
    "confidence": "high",
    "design_relevance": "Register items 94, 95, 116, 117, 123 and UI U-04, U-11 for B-M30-01, B-M28-01 and UI-T01/T04. MPL-2.0 needs a DEPENDENCIES.md ruling.",
    "verification": "corrected",
    "note": "Corrects UI-F32's cmdk date and fills its unchecked licences.",
    "verifier_evidence": ["npm registry metadata and the lucide-react 1.52.0 tarball file list"]
  }
]
```

## What is left for builders (needs a live call or running code, within the ≤ 50% rule)

- Row 9 / VF-05: one `simulateTransaction` of a sell just above the real vault on a recorded pool state (or a recorded failed transaction), to confirm the program refuses it as the SDK does.
- Row 11: replay the 353 PumpSwap goldens to prove event reserves are pre-trade.
- Row 13: decode events from recorded transactions to confirm the self-CPI path.
- Row 15: run Codama on the pinned IDLs only if the ticket chooses generated encoders.
- Row 17: `PRAGMA journal_mode=WAL` returns `wal` on the pinned Node build.
- Row 23: first `getMultipleAccounts` of 90 accounts on each provider.
- Row 26: the first enumeration gives the real pool count (after Flag 1 is decided).
