# Launch venues, token lifecycle and market regime

Research date: 2026-10-03 (UTC). Scope: what a $2–$5, one-position, paper-first Solana meme bot needs to know about where tokens launch, how they graduate, how long they live, where a selective trader might have an edge, and how to switch trading on and off by market regime.

Evidence labels used below:

- **On-chain (measured)**: read by me from Solana mainnet on 2026-10-03 through the public RPC `api.mainnet-beta.solana.com` (slot ~452.9M).
- **Primary doc**: official docs, program IDLs or source.
- **Data aggregator**: DefiLlama API (free, no key), CoinGecko free API.
- **Peer-reviewed / preprint**: arXiv papers (preprints are not peer reviewed; I say so where it matters).
- **Press**: news articles quoting dashboards; weaker, used only when nothing better exists.
- **Unverified**: I could not confirm it from a primary source.

---

## 1. Summary for the design

1. **pump.fun is still the market.** In the last 24 h it had ~49.7k successful token creations (measured on-chain), and its bonding curve did $177.5M of volume on 2026-10-01, versus ~$71M for all other curve launchpads combined (DefiLlama). Its graduation venue, PumpSwap, did $321M/day. Allowlist **PumpSwap canonical pools first**, the **pump.fun bonding curve second** (paper only at first), everything else later.
2. **Fees dominate cost at $2–$5.** pump.fun curve: 1.25% per side (0.95% protocol + 0.30% creator). PumpSwap canonical pool: 1.25% per side below a 420 SOL market cap, 1.20% just above it, falling to 0.30% only for very large caps. A round trip costs about **2.4–2.5% in venue fees** before Jupiter's 0.5%-per-side fee on young tokens (if that path is used), priority fees and rent. Price impact for $2–$5 is under 0.2% on these pools (my calculation, section 2.4). A strategy needs a conservative gross edge well above ~3% per trade to clear costs.
3. **Base rates are brutal.** Long-run graduation is about 0.6–1% of launches (two academic datasets: 0.63% in Sept 2025; 1.02% over ~15M coins over two years). It rose after pump.fun's BOOST change on 2026-07-21 (press: 2.5–6.7% in late July). My on-chain estimate for the last 24 h is about 2.6% (range ~2.3–2.9%; section 5.4). Most tokens die within an hour; academic labels mark a "vast majority" as rug-like within 1 h.
4. **Buying at graduation has been a losing trade on average.** In the MELT dataset (41k pump.fun graduates), buying at the migration price and selling at a random time within the next hour lost **60.7–64.8% on average**; about 73% of graduates fell below 40% of the migration price shortly after migration. A model filter cut the loss to ~27–34%, still a loss. This is the strongest available evidence that "buy every graduate" is exit liquidity.
5. **Market structure changed in July–September 2026** and makes older studies partly stale: BOOST (17.6 SOL of scheduled post-migration buy-and-burn per SOL pool, live since 2026-07-21), USDC-paired coins (2026-05-21), Token-2022 mints for new coins, `buy_v2`/`sell_v2`, "mayhem mode" coins with a 2B supply and an AI trader, holder-reward coins, and PumpSwap `virtual_quote_reserves` that can be negative from 2026-09-30. The decoder and the paper simulator must model these or reject the affected coins.
6. **Regime today is "hot".** pump.fun curve volume averaged $101M/day in September 2026 and $142–$211M/day in the last 7 days, versus a 365-day median of $59.7M. SOL is $119.26, above its 20/50/100-day averages ($114/$104/$90). Hot regimes bring both more opportunity and more manipulation; the bot should still trade only when its own measured post-graduation survival rate is acceptable.

---

## 2. pump.fun bonding curve

### 2.1 Program and live parameters

| Item | Value | Source |
| --- | --- | --- |
| Pump program | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | [Pump program README](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md) (repo last commit 2026-09-29) |
| Global account | `4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf` (PDA `["global"]`) | same |
| `initial_virtual_token_reserves` | 1,073,000,000.000000 tokens (6 decimals) | **On-chain (measured)** 2026-10-03, slot 452,916,922 |
| `initial_virtual_sol_reserves` | 30 SOL | **On-chain (measured)** |
| `initial_real_token_reserves` | 793,100,000 tokens sold on the curve | **On-chain (measured)** |
| `token_total_supply` | 1,000,000,000 tokens | **On-chain (measured)** |
| `fee_basis_points` (protocol) | 95 bps | **On-chain (measured)**; the README example still shows 100, so the README is stale on this field |
| `pool_migration_fee` | 15,000,001 lamports (~0.015 SOL) | README; pump.fun fee page lists 0.015 SOL |
| Mint authority PDA (used only by `create`/`create_v2`) | `TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM` | **On-chain (measured)**: sampled transactions mentioning it were all `CreateV2` (+ optional first buy) |
| Withdraw authority (passed to `migrate`/`migrate_v2`) | `39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg` | README Global dump; **on-chain**: transactions mentioning it are `Migrate`/`MigrateV2` |

New coins created with `create_v2` are **Token-2022 mints** (6 decimals, metadata-pointer extension) ([COIN_CREATION.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md)). That matters for rent and account size (the brief already warns about Token-2022).

### 2.2 Curve math (derived from the measured parameters)

Constant product on virtual reserves: `k = 1,073,000,000 × 30 = 32.19e9`. The curve completes when all 793.1M real tokens are sold:

| Point | Virtual SOL | Virtual tokens | Price (SOL/token) | Market cap (1B supply) |
| --- | --- | --- | --- | --- |
| Launch | 30.00 | 1,073.0M | 2.796e-8 | 27.96 SOL |
| Graduation | 115.005 | 279.9M | 4.109e-7 | **410.9 SOL** |

- Real SOL raised at completion: **85.005 SOL** (115.005 − 30). Price rises 14.7x from launch to graduation.
- At $119.26/SOL (CoinGecko, 2026-10-03) the graduation market cap is about **$49k**, not the "$69k" widely quoted; that figure assumed an older SOL price. Graduation is fixed in SOL, so its USD value moves with SOL.
- At migration the PumpSwap pool is seeded with the remaining 206.9M tokens and ~84.99 SOL (85.005 − 0.015 fee). Pool price equals the final curve price within 0.02%, but **depth falls about 26%** (115 virtual SOL on the curve versus ~85 real SOL in the pool). Marino et al. show this makes selling just before graduation worth more than selling just after, which gives creators and early holders a mechanical reason to sell into the end of the curve ([arXiv 2602.14860](https://arxiv.org/html/2602.14860v1), 2026-02-16).
- Progress formula commonly used by indexers: `progress = 100 − ((curve_token_balance − 206.9M) × 100 / 793.1M)` ([search snippet citing Bitquery/SolanaTracker docs](https://docs.bitquery.io/docs/blockchain/Solana/Pumpfun/)); equivalently derive it from `real_token_reserves` in the `BondingCurve` account.

`BondingCurve.complete` becomes true at the end of the buy that takes `real_token_reserves` to 0. `migrate` is permissionless and idempotent ([README](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md)).

### 2.3 Fees on the curve (pump.fun fee page, "Last updated 20 May 2026")

| Phase | Creator | Protocol | LP | Total |
| --- | --- | --- | --- | --- |
| Bonding curve (SOL and USDC coins) | 0.30% | 0.95% | 0% | **1.25%** |
| Coin creation | | | | 0 SOL |
| Graduation to PumpSwap | | | | 0.015 SOL |

Source: [pump.fun/docs/fees](https://pump.fun/docs/fees). The page also says some mobile users may pay up to **+0.1%** extra, that fees "may change at any time, without notice", and that the smart contract, not the UI, is authoritative. Read `fee_basis_points` and `creator_fee_basis_points` from each `TradeEvent` instead of hard-coding them.

Other one-time costs a buyer can hit on the first `buy`/`buy_v2` ([BUY.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/BUY.md)):

- `user_volume_accumulator` PDA: rent for a 137-byte account, **0.0018444 SOL**, paid once per wallet if missing (closable via `close_user_volume_accumulator`).
- The token ATA (Token-2022) and possibly quote-side ATAs for USDC coins.

### 2.4 Price impact for $2–$5 (my calculation)

At SOL = $119.26, including the 1.25% fee, a buy costs this much above the spot price:

| Venue state | $2 buy | $5 buy |
| --- | --- | --- |
| Fresh curve (30 virtual SOL) | 1.32% | 1.41% |
| Curve near graduation (~103 virtual SOL) | 1.28% | 1.31% |
| Fresh PumpSwap pool (~85 SOL) | 1.29% | 1.32% |

So at this size the fee is the cost; impact is under 0.2%. Bigger risks are adverse selection, failed or late landing, and the price moving while the transaction lands.

### 2.5 Instructions and events a bot can subscribe to

From the IDL refreshed 2026-09-12 ([idl/pump.json](https://github.com/pump-fun/pump-public-docs/tree/main/idl)):

- Creation: `create` (legacy), `create_v2` (Token-2022; optional `is_mayhem_mode`, `is_holder_reward`, quote mint). Event: **`CreateEvent`** (name, symbol, uri, mint, bonding_curve, user, creator, timestamp, initial reserves, token_program, is_mayhem_mode, is_cashback_enabled, quote_mint, virtual_quote_reserves, creator_fee_bps, is_holder_reward).
- Trading: `buy`, `sell`, `buy_exact_sol_in` (legacy), and **`buy_v2`, `sell_v2`, `buy_exact_quote_in_v2`** (all accounts mandatory; required for USDC-paired coins). Event: **`TradeEvent`** (mint, sol_amount, token_amount, is_buy, user, timestamp, virtual and real reserves after the trade, fee and creator fee with their bps, `ix_name`, `mayhem_mode`, buyback fee, quote_mint/quote_amount, holder rewards).
- Completion: **`CompleteEvent`** (user, mint, bonding_curve, timestamp, quote_mint) emitted when the curve completes.
- Migration: `migrate`, `migrate_v2`. Event: **`CompletePumpAmmMigrationEvent`** (user, mint, mint_amount, sol_amount, pool_migration_fee, bonding_curve, timestamp, **pool**, quote_mint).

Cheap subscription recipe (verified on-chain on 2026-10-03, standard RPC, no paid stream needed):

- `logsSubscribe` with `mentions: ["TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM"]` returns only coin creations (~1,700/hour today).
- `logsSubscribe` with `mentions: ["39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg"]` returns migration attempts (~85/hour today, including failed and no-op repeats; filter for `CreatePool` / `CompletePumpAmmMigrationEvent`).
- Subscribe to a single token's `BondingCurve` account (`accountSubscribe`) only after it passes the shortlist. Do not subscribe to every pump trade on a free plan: the full trade stream is far larger.

### 2.6 2026 changes the decoder must handle

| Change | Date | Effect on the bot | Source |
| --- | --- | --- | --- |
| Creator fees on curve and PumpSwap | 2025-05-13 | Fee split as above | [fees page](https://pump.fun/docs/fees) |
| USDC-paired coins | 2026-05-21 | Quote is not always SOL; legacy `buy`/`sell` cannot trade USDC coins; PumpSwap USDC fee tiers differ | fees page; [README](https://github.com/pump-fun/pump-public-docs) |
| BOOST default for new coins | 2026-07-21 | ~20% of migration liquidity (17.6 SOL per SOL pool, $2,516 per USDC pool) is held back and spent by TWAP buy-and-burn in the **first 5 minutes after migration** | [The Block, 2026-07-29](https://theblock.co/news/defi/2026-07-29-pump-fun-token-graduation-rate-jumps-boost-changes-launch-incentives-409815); [KuCoin/BlockBeats flash](https://www.kucoin.com/news/flash/pump-fun-launches-boost-mode-to-reinject-dead-liquidity-into-token-market); IDL `init_boost`, `boost_buy_and_burn`, `BoostBuyAndBurnEvent` |
| Mayhem mode | late 2025 (The Block covered week one) | Coin supply becomes 2B; an AI agent trades it for 24 h; separate fee recipients. Flag `is_mayhem_mode` and exclude initially | [The Block](https://www.theblock.co/post/379285/pump-funs-new-mayhem-mode-fails-boost-token-launches-revenue); [FEE_RECIPIENTS.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/FEE_RECIPIENTS.md) |
| Holder-reward coins; cashback coins deprecated | 2026-09-12/14 | Creator fee goes to holders; no trade interface change | [HOLDER_REWARDS_README.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/HOLDER_REWARDS_README.md) |
| PumpSwap `virtual_quote_reserves` (i128), may be **negative** from 2026-09-30 | 2026-09-29 doc | Price every PumpSwap quote with `effective_quote = vault_amount + virtual_quote_reserves` (signed). Using the raw vault balance gives wrong quotes | [NEGATIVE_VIRTUAL_QUOTE_RESERVES.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/NEGATIVE_VIRTUAL_QUOTE_RESERVES.md) |
| Unannounced upgrade of pump, PumpSwap and pump_fees: 8 new bytes on trade events, new pump `*_v3` instructions, 3 new event discriminators | 2026-10-02 15:47 UTC | None on SOL-quoted markets: documented fields, quotes, accounts, fees and rent unchanged. See 2.7 | chain data, 2.7 |

### 2.7 The 2026-10-02 program upgrade (UPG-1, read from mainnet 2026-10-03)

**What happened.** The pump.fun upgrade authority `7gZufwwAo17y5kg8FMyJy2phgpvv9RSdzWtdXiWHjFr8`, a Squads v4 vault, ran three `VaultTransactionExecute` → BPF loader `upgrade` transactions, all signed by `6W6qsDbocrEs3vjri5Di15bf9PLRYhfxekPk25MhVHWz`. The ELF hash is the SHA-256 of the program data after its 45-byte header, with trailing zeros removed (how `solana-verify get-program-hash` computes it), read on 2026-10-03.

| Program | Slot | Time (UTC) | Transaction | New ELF SHA-256 |
| --- | --- | --- | --- | --- |
| PumpSwap `pAMMBay6…` | 452,654,882 | 2026-10-02 15:47:07 | `nzzsTAuLRE69…Fn5YoK` | `01557035…9333cc3` |
| pump `6EF8rrec…` | 452,654,932 | 2026-10-02 15:47:21 | `2kixZiEAdXoC…FopE` | `b0b777c6…65cb0c75` |
| pump_fees `pfeeUxB6…` | 452,655,002 | 2026-10-02 15:47:39 | `32gPfuk3LZfu…Vmm5NR` | `f166c296…62fd` |

Full signatures, buffers and hashes are in `packages/core/test/chain/fixtures/upgrade-2026-10-02.json`. That is 01:47 AEST on 3 Oct in Melbourne. DATA-1's "about 20:00 UTC" is a slot-to-time estimate; the slots are right. **Nothing official was published:** pump-public-docs `main` is still at `cb188ce` (29 Sep), and its newest branch dates from 14 Sep. The newest npm releases are `@pump-fun/pump-sdk` 2.0.0 (13 Sep) and `@pump-fun/pump-swap-sdk` 1.20.0 (10 Sep). Their IDLs match our pinned layouts field for field and contain none of the new names.

**The 8 bytes.** These are bytes appended after the last IDL field of `TradeEvent` (pump) and `BuyEvent`/`SellEvent` (PumpSwap).

- Boundary, checked in consecutive blocks: PumpSwap events have 0 extra bytes up to slot 452,654,881 and 8 from 452,654,930. pump events have 0 up to 452,654,931 and 8 from 452,654,934.
- Coverage: 60 blocks spread over slots 452,654,935–452,984,568 plus 25 consecutive blocks from 452,709,000. That is 7,009 trade events, and every one carries exactly 8 bytes.
- Zero on SOL markets: in the 60 spread blocks, 46 of 4,254 events carry non-zero bytes, and all 46 are on markets quoted in another token. That is 21 curves whose `quote_mint` is not wrapped SOL, and 13 PumpSwap pools whose quote mints include CARDS, `pumpCm…` and `Xsc9…`. No SOL-quoted event had a non-zero value.
- Not yet decoded: read as a u64 on a token-quoted curve, the value grows by exactly each trade's `creator_fee` (5 of 5 consecutive same-curve pairs). That fits a running creator-fee balance in the quote token. On PumpSwap pools the value stays the same across trades that pay creator fees, so it means something else there. Neither meaning is published.
- How DEC-1 handles them: kept as `trailing`/`extra`; every documented field decodes the same with or without them (`test/chain/upgrade.test.ts`).

**New instructions.** pump now runs `sell_v3` (`1c92de7726c469d5`) and `buy_exact_quote_in_v3` (`e1f7501ed5b38488`). These are Anchor sighashes `sha256("global:<name>")[0..8]`, an exact match. They were seen only on token-quoted curves (11 of the 21). Their events report the old `ix_name` (`sell`, `buy_exact_quote_in`), so `ix_name` does not show the instruction version. Every existing buy and sell instruction kept its account count and data length (563 instructions in 4 blocks before, 648 in 6 blocks after). DEC-1's instruction parsers and TX-1's builders are untouched, and the signer policy refuses the v3 discriminators (`test/tx/policy.test.ts`).

**New events.** `pump:742b4dbd117a482b`, `amm:82a42461e48287a5` and `pump:a943276d6686b6e8` (DATA-1) match no IDL name in any SDK version or any pump-public-docs commit, nor 1,820 suffix and prefix variants of the known names. None appeared in the 89 blocks sampled here, as self-CPI events or as `Program data:` logs, so they are rare. DEC-1 keeps them as `other` with their discriminator, never decoded.

**Fees, accounts and rent.**
- pump: 95 bps protocol and 30 bps creator, the same before and after.
- PumpSwap: the same tier shape before and after (LP 20 or 25 bps, protocol 5 bps, creator by tier; the first tier is LP 2, protocol 93, creator 30).
- Accounts created by swaps are the same size at the same rate before and after: volume accumulators 137 bytes (1,346,200 lamports) on both programs, SPL token accounts 165 bytes, Token-2022 ATAs 170 bytes, at 5,080 lamports per byte.
- The CORE-2 quote goldens (313 curve and 353 PumpSwap swaps, slots 452,791,146–452,943,426) and the TX-1 compiled-message goldens (slots 452,954,462–452,954,827) were all recorded after the upgrade and reproduce exactly. A test now pins that.

---

## 3. PumpSwap (graduation venue)

- Program: `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`; GlobalConfig `ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw`; fee program `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` ([PUMP_SWAP_README.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md), [idl/pump_fees.json](https://github.com/pump-fun/pump-public-docs/tree/main/idl)).
- Canonical pool: created by `migrate` with pool index 0; pool PDA `["pool", index, creator, base_mint, quote_mint]`. **LP tokens from migration are burned** ([Pump program README](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md)). Burned LP is not proof of safety: the holders, not the LP, are the rug risk.
- Events: `CreatePoolEvent`, `BuyEvent`, `SellEvent` (pool reserves, lp/protocol/creator fees and bps, `virtual_quote_reserves`, `can_boost`, `base_supply`), `InitBoostEvent`, `BoostBuyAndBurnEvent` (quote used, base burned, vault remaining), `DepositEvent`, `WithdrawEvent`.

PumpSwap canonical-pool fees for SOL coins ([pump.fun/docs/fees](https://pump.fun/docs/fees), updated 2026-05-20; market cap = price × 1B):

| Market cap (SOL) | Creator | Protocol | LP | Total |
| --- | --- | --- | --- | --- |
| 0 – 420 | 0.300% | 0.930% | 0.020% | **1.250%** |
| 420 – 1,470 | 0.950% | 0.050% | 0.200% | **1.200%** |
| 1,470 – 2,460 | 0.900% | 0.050% | 0.200% | 1.150% |
| 4,420 – 9,820 | 0.750% | 0.050% | 0.200% | 1.000% |
| 49,120 – 54,030 | 0.300% | 0.050% | 0.200% | 0.550% |
| 98,240 and up | 0.050% | 0.050% | 0.200% | 0.300% |

(25 tiers in total; USDC coins use USD market-cap tiers from 0–59,000 USDC at 1.25% down to 20M+ USDC at 0.30%.) **Non-canonical PumpSwap pools**: 0% creator, 0.05% protocol, 0.25% LP = 0.30%.

Note: a fresh graduate sits at ~411 SOL market cap, right at the 420 SOL boundary, so the first trades pay 1.25% and a small rise moves them to 1.20%. Do not trust third-party summaries of this table: one AI-generated summary I fetched reported the first tier wrongly (0.05% protocol, 0.2% LP). I parsed the official HTML table directly.

Also note the creator fee in the arXiv paper is described as "0.950% down to 0.050%" on PumpSwap; that matches the table except for the first tier.

---

## 4. Other launchpads and AMMs

### 4.1 Program IDs and mechanics

| Venue | Program ID | Mechanics that matter to the bot | Source |
| --- | --- | --- | --- |
| Raydium LaunchLab | `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj` | Bonding curve (constant-product with virtual reserves is the only live type). Graduates by a Raydium crank (`MigrateToCpswap`) into **CPMM**; new launches can no longer migrate to AMM v4. Fees per trade = protocol `trade_fee_rate` + platform `fee_rate` (cap 5%, raised from 1% on 2026-08-26) + creator `creator_fee_rate` (cap 0.5%) + optional referral share (cap 1%). LP after migration: platform share locked, rest burned (post 2026-08-17). Token-2022 base mints may carry a **transfer fee up to 5%**; TransferHook and PermanentDelegate are rejected | [overview](https://docs.raydium.io/products/launchlab/overview.md), [platform-config](https://docs.raydium.io/products/launchlab/platform-config.md), [global-config](https://docs.raydium.io/products/launchlab/global-config.md), [fee reference](https://docs.raydium.io/products/launchlab/tips-and-gotchas/launchlab-cpmm-fee-reference.md), [program addresses](https://docs.raydium.io/reference/program-addresses.md) |
| LaunchLab protocol fee (live) | — | **On-chain (measured)**: all 584 GlobalConfig accounts have `trade_fee_rate = 2500` = **0.25%**; the SOL config has `min_quote_fund_raising` = 24 SOL. Platform and creator fees are per platform and must be read from `PlatformConfig` per pool | getProgramAccounts on LaunchLab, 2026-10-03 |
| Raydium CPMM | `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C` | Post-LaunchLab venue; fee tier from `AmmConfig` (typically 0.25%) plus an *additional* CPMM creator fee on LaunchLab-migrated pools | [program addresses](https://docs.raydium.io/reference/program-addresses.md), [fee reference](https://docs.raydium.io/products/launchlab/tips-and-gotchas/launchlab-cpmm-fee-reference.md) |
| Raydium AMM v4 | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | Legacy 0.25% AMM; OpenBook dependency removed; Raydium says use CPMM for new pools. Old pump.fun graduates (before PumpSwap) live here | [AMM v4 docs index](https://docs.raydium.io/llms.txt) |
| Meteora DBC | `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN` | Per-launchpad configurable curve (up to 16 segments), configurable migration threshold (minimum 10 SOL / 750 USDC for listed quote mints), graduates to **DAMM v2** (DAMM v1 deprecated). Fees: min 0.25%, **up to 99%** with time schedulers (anti-sniper fees decay over time) and optional dynamic fees; protocol takes 20% of fee. 0.2% protocol migration fee. At least 10% of LP locked at day 1. Supports Token-2022 **transfer-hook** pools | [What is DBC](https://docs.meteora.ag/core-products/dbc/what-is-dbc.md), [DBC fees](https://docs.meteora.ag/core-products/dbc/fees/overview.md), [migration](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity.md) |
| Meteora DAMM v2 | `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` | Constant product with position NFTs; base fee from time or market-cap schedulers, dynamic fee, fee cap up to 99% (v0 pools 50%); protocol 20% of fee | [What is DAMM v2](https://docs.meteora.ag/core-products/damm-v2/what-is-damm-v2.md), [fees](https://docs.meteora.ag/core-products/damm-v2/fees/overview.md) |

Platforms built on these programs (from DefiLlama methodology text, 2026-10-03):

- **BONK.fun / LetsBonk**: a LaunchLab platform ("Fees are collected from users and distributed to holders and protocol"; Graphite Protocol is its joint-venture fee partner).
- **StonkFun**: a LaunchLab platform since early Sept 2026; coins quoted in tokenized stocks, ETFs, wBTC, ZEC, STONK etc.; 1% platform fee on the curve plus CPMM creator fees ([DefiLlama methodology](https://defillama.com/protocol/stonkfun); [The Block, 2026-09-06](https://www.theblock.co/news/defi/2026-09-06-stonk-surges-250-to-140-million-market-cap-as-stonkfun-pulls-volume-to-raydium-and-jupiter-413621)). Non-SOL quote assets add a second price risk; exclude.
- **Bags**: Meteora DBC pre-migration and DAMM v2 post-migration on Solana (DefiLlama methodology).
- **Believe** ("Launch Coin on Believe"), **Heaven**, **boop.fun**, **Moonshot**: now near-zero activity (table below).

### 4.2 Market share snapshot (DefiLlama free API, pulled 2026-10-03)

Bonding-curve (launchpad) volume, USD:

| Venue | 24 h | 7 d | 30 d |
| --- | --- | --- | --- |
| pump.fun (curve) | 177.5M | 1,001M | 3,082M |
| StonkFun (LaunchLab) | 34.1M | 160.6M | 777.5M |
| Meteora DBC (all platforms) | 21.0M | 122.8M | 470.5M |
| Raydium LaunchLab | 16.3M | 97.3M | 408.2M |
| Rise.rich | 0.23M | 1.04M | 2.6M |
| moonshot.money (app) | 0.36M | 3.3M | 13.7M |
| Heaven / boop.fun | ~0 | ~0 | ~0 |

Post-graduation AMM volume: PumpSwap 321.1M (24 h) / 13.4B (30 d); Raydium AMM 221.9M; Meteora DLMM 180.7M; Meteora DAMM v2 11.2M (these AMM totals include non-meme pairs).

Fees (24 h): PumpSwap $4.74M, pump.fun $2.37M, StonkFun $0.91M, LaunchLab $0.32M, BONK.fun $0.29M, Meteora DBC $0.13M, Bags $13.8k, moonshot.money $7.3k, Believe $0.36, Heaven $0, boop $0.

Caveats: DefiLlama adapters differ in what they count; StonkFun runs on LaunchLab, and I could not confirm whether the LaunchLab figure includes it, so do not add them. Sources: `https://api.llama.fi/overview/dexs/Solana`, `https://api.llama.fi/overview/fees/Solana` (no key; Pro is $300/month per [DefiLlama API docs](https://api-docs.defillama.com/)).

Reading: on curve volume pump.fun has roughly 70–80% share today, depending on whether StonkFun is counted inside LaunchLab. That fits older press figures of 73–90% (e.g. [CoinMarketCap Academy](https://coinmarketcap.com/academy/article/pumpfun-reclaims-90percent-market-share-in-solana-launchpad-war), date not stated on the snippet), but I use the DefiLlama numbers as the dated source.

Trend (DefiLlama, monthly average volume per day):

| Month | pump.fun curve | PumpSwap | Meteora DBC | LaunchLab |
| --- | --- | --- | --- | --- |
| 2025-09 | 112.2M | 570.0M | 516.9M | 2.7M |
| 2026-03 | 56.9M | 873.3M | 3.7M | 4.0M |
| 2026-06 | 43.1M | 506.3M | 4.9M | 0.5M |
| 2026-08 | 85.7M | 644.9M | 6.6M | 0.5M |
| 2026-09 | 101.4M | 485.5M | 15.0M | 12.3M |

Competitor surges are short-lived (DBC Sep–Oct 2025, LaunchLab/LetsBonk Jul 2025, StonkFun Sep 2026). A venue allowlist must be re-checked monthly.

### 4.3 Allowlist recommendation

1. **PumpSwap canonical pools (pump.fun graduates), SOL quote only.** Deepest meme liquidity; one documented program; published IDL and events; fees fixed per market-cap tier and visible in every event; LP burned at migration; Jupiter routes it. Reject: USDC-quoted coins (until the second quote path is tested), mayhem-mode coins, non-canonical pools.
2. **pump.fun bonding curve** (paper first). Deterministic, exactly quotable from the `BondingCurve` account; tiny impact at $2–$5. But this is where snipers, bundlers and creator dumps concentrate (section 6), and the 1.25% fee applies to each side.
3. **Later, one at a time, only after per-pool fee decoding is built and tested:** Raydium LaunchLab → CPMM (variable platform fee up to 5%, creator fee up to 0.5%, possible 5% Token-2022 transfer fee) and Meteora DBC → DAMM v2 (fees up to 99% during anti-sniper schedules; transfer-hook pools exist).
4. **Do not allowlist now:** StonkFun (non-SOL quotes), Bags, Believe, Heaven, boop.fun, Moonshot (volume too small to exit safely), Raydium AMM v4 (legacy).

---

## 5. Survival statistics

### 5.1 Launch counts

| Measure | Value | Period | Source / grade |
| --- | --- | --- | --- |
| pump.fun creations | **49,706 successful** (53,601 transactions incl. failed) | 24 h to 2026-10-03 11:20 UTC | **On-chain (measured)**: `getSignaturesForAddress` on the mint-authority PDA |
| pump.fun creations | ~1,580 successful in 1 h | 2026-10-03 10:20–11:20 UTC | On-chain (measured) |
| pump.fun creations | 655,770 (≈21.9k/day) by 243,123 creators | Sept 2025 | [Marino et al., arXiv 2602.14860](https://arxiv.org/html/2602.14860v1) |
| pump.fun creations | 166,098 launches with buyers (≈12.4k/day) | 2026-06-11 to 06-25 | [Kamat, arXiv 2607.02795](https://arxiv.org/abs/2607.02795) (filtered sample) |
| pump.fun creations | ~42,000 in one day | press, 2026-06-10 | [Solana Compass](https://solanacompass.com/news/pumpfun-launched-42000-tokens-in-one-day-fewer-than-2-will-ever-reach-a-dex) (says no on-chain dashboard confirmed it) |
| pump.fun all-time | ~15.2M coins | to ~2026 | [Szwajcok et al., arXiv 2609.10246](https://arxiv.org/html/2609.10246) |

### 5.2 Graduation rate

| Rate | Period | Source / grade |
| --- | --- | --- |
| 0.63% (4,338 of 655,770); median time to graduate ~4.4 min | Sept 2025 | Marino et al. (preprint, on-chain data) |
| 1.02% of a random 1% sample of ~15M coins | ~2 years to 2026 | Szwajcok et al. (preprint, CMU/EPFL) |
| ~0.8–0.9% (June avg), 2.5% (week before BOOST), 4.7% (4-day avg), 6.7% (one day) | June–July 2026 | [The Block, 2026-07-29](https://theblock.co/news/defi/2026-07-29-pump-fun-token-graduation-rate-jumps-boost-changes-launch-incentives-409815) (press; data source not named) |
| 1.15% weekly | early 2026 | [Cryptopolitan](https://www.cryptopolitan.com/pump-fun-graduating-tokens-break-to-1-15-of-new-launches/) (press, Dune) |
| ~2.6% (estimate, range ~2.3–2.9%) | 24 h to 2026-10-03 | **On-chain (measured, sampled)**: 1,611 successful transactions mentioning the withdraw authority in 24 h; in two samples (77 decoded transactions) 80.5% contained `CreatePool` (the rest are repeat/no-op migrate calls). Implies ~1,300 graduations (range ~1,130–1,430) / ~49.7k creations. See 5.4 |

Graduation clusters early: in Marino's data the median is 4.4 min; press-cited samples say most graduates do so within the first hour (unverified, Medium article blocked).

Wash-trading and copycats distort the rate. Szwajcok et al.: wash-traded coins graduate at 2.0% vs 0.90%; at least 17% of all trading transactions are wash trades; 17.7% of graduated coins are copycats; the top 1% of creator clusters create ~53–59% of all coins.

### 5.3 Death, rugs and post-graduation outcomes

| Finding | Period | Source / grade |
| --- | --- | --- |
| "A vast majority" of memecoins show rug-pull characteristics within 1 h (label = TVL down 99% or idle >80% of life); dataset 6.4M tokens over 7 months | 2025–2026 | [Li et al., arXiv 2608.20271](https://arxiv.org/abs/2608.20271), 2026-08-20 (exact share not legible in HTML) |
| 76,469 of 100,063 new Orca/Raydium/Meteora tokens (76%) labelled rug pulls; median lifecycle < 1 h, 75th percentile ≤ 5 h; rug tokens' median life 0.01 days | H1 2025 | [Chen et al., arXiv 2603.24625](https://arxiv.org/abs/2603.24625v2) |
| 92.22% of tokens with ≥30 swaps show at least one dump event | Sept 2025 | Marino et al. |
| ~73% of pump.fun graduates fall below 40% of migration price shortly after migration; 60.3% in the lowest price-ratio bucket | MELT dataset, 41k graduates (published 2026-05-21 v2) | [Hu et al., arXiv 2602.13480](https://arxiv.org/html/2602.13480v2) |
| Buy at migration, sell at random time within 1 h: average loss 60.7% (top-100) / 64.8% (top-200) without a model; 26.6–36.5% with ML filters | same | same, Table 10 |
| On average 36.5% of supply is held by coordinated (bundled) accounts; first 10/20 buyers of high-risk tokens hold 17/19 points more supply than low-risk | same | same |
| 43.8% of 15,548 graduates still had $5k liquidity 30 min after graduation, 19.7% at 24 h; median liquidity falls 57% between minute 5 and 30 | from 2026-05-31 | **Unverified**: appeared only in a search-engine summary; the underlying article could not be fetched |

### 5.4 How I measured today's numbers (reproducible)

- Creations: page `getSignaturesForAddress("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM")` back 24 h; count `err == null`. Verified on a sample that these are `CreateV2` transactions.
- Graduations: same on `39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg` (1,611 successful in 24 h). Sample 1 (latest 40 transactions): 20 with `CreatePool`, 8 successful without it, 12 failed. Sample 2 (every 14th successful transaction over the last ~12.9 h): 42 with `CreatePool`, 7 without. Combined 62/77 = 80.5% (95% interval ~70–89%) → ~1,300 graduations (~1,130–1,430), i.e. ~2.6% (~2.3–2.9%) of creations. 36 of the 42 sampled migrations in sample 2 (86%) also ran `InitBoost`, confirming BOOST is active on most new graduations. A bot should count `CompletePumpAmmMigrationEvent` exactly instead.

---

## 6. Lifecycle phases and where an edge might exist

| Phase | What happens | Who wins (evidence) | Implication for a $2–$5 selective bot |
| --- | --- | --- | --- |
| 0. Creation + first block | Creator often buys in the create transaction; coordinated "sniper cohorts" fire in the first buyer window | Kamat: 1,012 persistent wallet rings (2,965 addresses) co-fire as early buyers across 166k launches; 7.0% of their launches had zero outside buyers in 30 min. Szwajcok: manipulators bypass the UI, bundle trades, run copycat factories; "market-manipulation-as-a-service" exists | No edge for a free-tier bot: it is slower and is the intended buyer. Brief's "avoid first-block sniping" is right |
| 1. Early curve (0–~30% progress) | Most tokens stall here; death within minutes is the norm | Marino: graduation probability climbs smoothly with SOL in the curve; fast accumulation in few trades is the strongest positive signal; bot-dominated flow lowers graduation odds; creator identity weak | If the curve is traded at all, condition on **progress + speed of real (non-bot, non-cluster) buying**, not on age |
| 2. Late curve (~70–100%) | Momentum toward a known threshold; creators and early holders have a reason to sell before the 26% depth drop | Marino: selling just before graduation beats selling just after; pre-graduation sell pressure observed | Late-curve entries buy from insiders. Any entry here needs an exit plan for the graduation minute |
| 3. Graduation + first 5 min | Migration to PumpSwap; since 2026-07-21 BOOST spends 17.6 SOL by TWAP buy-and-burn over ~5 min | MELT (pre-BOOST): average 60%+ loss for buying at migration price; ~73% fall below 40% of migration price. BOOST is public and predictable, so snipers and holders can sell into it | Do not buy the migration print. BOOST flow is a known bid that insiders sell into; treat 0–5 min as the most dangerous window |
| 4. Post-migration (5 min–6 h) | Most graduates bleed out; a minority keep liquidity and real buyers | Unverified press figure: ~44% keep $5k liquidity at 30 min, ~20% at 24 h | Best candidate window for a careful bot: wait until BOOST is spent and insider selling is visible, then require surviving liquidity, broad independent buyers, low cluster concentration and a working reverse quote |
| 5. "Second leg" (hours–days) | A few graduates re-accelerate on social attention | **No rigorous study found.** Only anecdotes | Treat as hypothesis; test in paper mode with dead tokens included |

What the literature says works for *avoiding* losers (all preprints, out-of-sample results limited):

- Concentration after linking bundled/co-funded wallets (MELT: model-guided selection cut the 1-h loss from ~61–65% to ~27–34%; still negative).
- First-5-minute trading features predict 1-h rug labels with moderate skill (MCC ~0.25–0.39); **models do not transfer across venues** (Raydium→pump.fun MCC near zero). Train and validate per venue.
- Temporal drift is real: a pre-registered pump.fun graduation model failed its temporal holdout, with a sign flip ([Kamat, arXiv 2607.02823](https://arxiv.org/abs/2607.02823)). Recalibrate after every platform change (BOOST, fee changes, quote assets).

Nothing found shows a durable positive edge for a retail-speed bot. The best documented use of intelligence here is **loss avoidance**.

---

## 7. Market regime indicators (cheap to compute)

| Indicator | How to compute cheaply | Today (2026-10-03) | Suggested use |
| --- | --- | --- | --- |
| Launch rate | Count `logsSubscribe` events mentioning the pump mint-authority PDA; rolling 1 h / 24 h | ~1,600–1,700/h; 49.7k/24 h | Context only: launches rise with spam as well as demand |
| Graduation count and rate | Count `CompletePumpAmmMigrationEvent` (or `CreatePool` in migrate transactions) / launches; rolling 24 h | ~1,300/24 h; ~2.6% (sampled estimate) | Falling graduations with stable launches = demand fading → pause |
| **Graduate survival** (most useful) | For each graduation in the last 6–24 h, record whether pool effective quote reserves are still above a threshold (e.g. 30 SOL) at +30 min and +6 h. Needs one `getAccountInfo` per pool per check | Not yet measured | Turn trading on only when survival of recent graduates is above its trailing median; this is directly tied to the post-migration strategy |
| Curve and PumpSwap volume | DefiLlama `/summary/dexs/pump.fun` and `/summary/dexs/pumpswap` once per hour (free, daily granularity) | pump.fun $142–211M/day last 7 d; 365-d median $59.7M, p25 $48.3M, p75 $73.8M | Above p75 = hot (more opportunity, more manipulation); below p25 = cold → reduce or pause |
| Solana DEX volume | DefiLlama `/overview/dexs/Solana` | $2.76B/24 h; Sept avg $2.61B/day; 2026 low ~$1.8B (July) | Broad liquidity backdrop |
| SOL trend | CoinGecko free `market_chart` daily, or an oracle; compare price to 20/50-day averages; track 24 h drawdown | $119.26; SMA20 $114.07, SMA50 $103.76, SMA100 $89.83; +62% vs 2026-08-05 ($73.71) | Pause new entries after a sharp SOL drop (e.g. −8% in 24 h; to be tested) because meme liquidity leaves fastest |
| Own execution health | Failed-transaction share, landing delay, quote-vs-fill error | — | Pause when execution degrades regardless of market signals |

Dune is not a free option for an automated regime feed: its docs say the free plan is view-only and API access needs a paid plan or trial ([Dune rate limits](https://docs.dune.com/api-reference/overview/rate-limits)). Computing launches and graduations from the bot's own subscription is free and more timely.

A first rule set to test in paper mode (hypothesis, not a validated policy):

- **ON** only if: graduate survival (30 min) ≥ its 14-day median, AND pump.fun curve volume (last full day) ≥ the 365-day 25th percentile, AND SOL 24 h change > −8%, AND own execution health is green.
- **OFF** (pause entries, keep exits running) if any condition fails for two consecutive checks.

---

## 8. Brief claims checked (venue-related)

| Brief claim | Status | Evidence |
| --- | --- | --- |
| "Avoid first-block launch sniping in the trial." | **Confirmed** (well supported) | Persistent sniper rings, bundling, MMaaS tools and creator dumps dominate the first window (arXiv 2607.02795, 2609.10246, 2602.14860) |
| "Target confirmed liquidity ... on a small allowlist of supported venues." | **Confirmed**, needs naming | Recommend PumpSwap canonical SOL pools first, pump.fun curve second (sections 4.2–4.3) |
| "Burned LP tokens alone do not prove safety." | **Confirmed** | PumpSwap burns migration LP, yet ~73% of graduates fall below 40% of migration price shortly after (MELT). LaunchLab now locks a platform share instead of burning all |
| Token-2022 deposit sizes must be queried | **Confirmed and more relevant than implied** | New pump.fun coins are Token-2022 mints (`create_v2`); LaunchLab and DBC also issue Token-2022 tokens, with transfer fees (LaunchLab ≤5%) and transfer hooks (DBC) possible |
| "Unsupported transfer hooks, permanent delegates ... should fail the allowlist." | **Confirmed** as necessary | DBC supports transfer-hook pools; LaunchLab rejects TransferHook/PermanentDelegate but allows transfer fees |
| Cost model "count both entry and exit: swap/platform fees ..." | **Confirmed**; numbers now known | Venue fees alone are ~1.25% per side on the curve and on young PumpSwap pools |
| Implicit: venue fees are stable | **Outdated assumption to avoid** | pump.fun says fees may change without notice; LaunchLab platform fee cap went 1% → 2.5% → 5% in 2026; read fees per pool/event |

---

## 9. Recommendations

1. **Must:** allowlist PumpSwap canonical SOL pools first; pump.fun curve in paper only; everything else blocked until a per-pool fee decoder exists.
2. **Must:** price PumpSwap with signed `virtual_quote_reserves` (effective reserves); read fee bps from each event/config; never hard-code 1%.
3. **Must:** reject mayhem-mode coins, USDC/stock-quoted coins, non-canonical pools and Token-2022 mints with transfer fee or hook extensions in the first release.
4. **Must:** do not enter in the first 5 minutes after migration (BOOST window) or at the migration price; record BOOST events so the simulator knows when the scheduled bid ends.
5. **Should:** build the regime gate on the bot's own counts (creations, graduations, graduate survival) plus DefiLlama volume and SOL trend; start with the hypothesis thresholds in section 7.
6. **Should:** add a cost floor: require conservative expected gross gain > ~2× round-trip venue fees (≈5%) before considering a trade on these venues.
7. **Should:** train and calibrate per venue and re-validate after any platform change; keep dead and rugged tokens in every dataset.
8. **Could:** subscribe with `logsSubscribe` on the two pump PDAs instead of a paid stream; upgrade data only if measured latency loses trades that would have been profitable.

---

## 10. Open questions

- Exact current pump.fun graduation rate and post-graduation survival under BOOST (needs a few days of the bot's own counts).
- How BOOST changes post-migration returns versus the pre-BOOST MELT result.
- BONK.fun's current platform fee and creator fee rates (read its `PlatformConfig` on-chain before enabling LaunchLab).
- Whether DefiLlama's LaunchLab volume includes StonkFun.
- Mayhem mode's current share of launches.
- Any rigorous evidence on "second leg" returns (none found).

---

## Sources

- pump.fun fees (updated 2026-05-20): https://pump.fun/docs/fees
- pump.fun bonding curve: https://pump.fun/docs/bonding-curve
- pump-public-docs repo (last commit 2026-09-29): https://github.com/pump-fun/pump-public-docs ; Pump program README, PumpSwap README, BUY.md, COIN_CREATION.md, FEE_RECIPIENTS.md, HOLDER_REWARDS_README.md, NEGATIVE_VIRTUAL_QUOTE_RESERVES.md, IDLs (2026-09-12)
- Raydium docs: https://docs.raydium.io/products/launchlab/overview.md ; /products/launchlab/platform-config.md ; /products/launchlab/global-config.md ; /products/launchlab/bonding-curve.md ; /products/launchlab/tips-and-gotchas/launchlab-cpmm-fee-reference.md ; /reference/program-addresses.md
- Meteora docs: https://docs.meteora.ag/core-products/dbc/what-is-dbc.md ; /core-products/dbc/fees/overview.md ; /core-products/dbc/migration-and-liquidity.md ; /core-products/damm-v2/what-is-damm-v2.md ; /core-products/damm-v2/fees/overview.md
- DefiLlama API (pulled 2026-10-03): https://api.llama.fi/overview/dexs/Solana , https://api.llama.fi/overview/fees/Solana , https://api.llama.fi/summary/dexs/pump.fun ; API docs https://api-docs.defillama.com/
- CoinGecko SOL price (pulled 2026-10-03): https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=200&interval=daily
- Marino, Naviglio, Tarantelli, Lillo, "Predicting the success of new crypto-tokens: the Pump.fun case", arXiv 2602.14860 (2026-02-16): https://arxiv.org/html/2602.14860v1
- Szwajcok, Tsuchiya, Liu, Soska, Payer, Christin, "Meme Coin Factories", arXiv 2609.10246 (2026-09-09): https://arxiv.org/html/2609.10246
- Hu, Tekin, Xu, Liu, "MELT", arXiv 2602.13480v2 (2026-05-21): https://arxiv.org/html/2602.13480v2
- Li et al., "Catching the Rug", arXiv 2608.20271 (2026-08-20): https://arxiv.org/abs/2608.20271
- Chen et al., "From Hype to Collapse: Investigating Rug Pull Scams on Solana", arXiv 2603.24625v2 (2026-05-31): https://arxiv.org/abs/2603.24625v2
- Kamat, "Coordinated Sniper Cohorts on Pump.fun", arXiv 2607.02795 (v3 2026-08-03): https://arxiv.org/abs/2607.02795
- Kamat, "Auditing Collector-Generated Graduation Labels on Pump.fun", arXiv 2607.02823 (v4 2026-09-10): https://arxiv.org/abs/2607.02823
- Mancino, "The Memecoin Phenomenon", arXiv 2512.11850 (Q4 2024 data): https://arxiv.org/html/2512.11850v3
- The Block, BOOST and graduation rate (2026-07-29): https://theblock.co/news/defi/2026-07-29-pump-fun-token-graduation-rate-jumps-boost-changes-launch-incentives-409815
- KuCoin/BlockBeats flash on BOOST (2026-07-21): https://www.kucoin.com/news/flash/pump-fun-launches-boost-mode-to-reinject-dead-liquidity-into-token-market
- The Block, Mayhem mode first week: https://www.theblock.co/post/379285/pump-funs-new-mayhem-mode-fails-boost-token-launches-revenue
- The Block, StonkFun (2026-09-06): https://www.theblock.co/news/defi/2026-09-06-stonk-surges-250-to-140-million-market-cap-as-stonkfun-pulls-volume-to-raydium-and-jupiter-413621
- Solana Compass (2026-06-10): https://solanacompass.com/news/pumpfun-launched-42000-tokens-in-one-day-fewer-than-2-will-ever-reach-a-dex
- Cryptopolitan (2026-02-19, updated 2026-05-05): https://www.cryptopolitan.com/pump-fun-graduating-tokens-break-to-1-15-of-new-launches/
- Dune API rate limits: https://docs.dune.com/api-reference/overview/rate-limits

## Fact-check

Independent re-check of the load-bearing findings against their sources (2026-10-03). Verdicts: confirmed, contradicted (with the correction), or unverifiable.

| Finding | Claim | Verdict | Note |
|---|---|---|---|
| F1 | Pump program 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P; live Global (slot 452,916,922): initial_virtual_token_reserves 1,073,000,000 tokens, initial_virtual_s | **confirmed** | Program ID matches the README and idl/pump.json. README Global example: initial_virtual_token_reserves 1073000000000000, initial_virtual_sol_reserves 30000000000, initial_real_token_reserves 793100000000000, token_total_supply 1000000000000000, fee_basis_points 100 (README still says 100). I read the live Global PDA 4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf over RPC at slot ~452,932,342 and it holds the same four reserve/supply values, with fee_basis_points = 95. Your slot 452,916,922 is a past read and cannot be re-checked, but nothing has changed since. The README gives completion only as real_token_reserves == 0 and has no price or mcap figures, so those are derived. I recomputed them: k=32.19e9, virtual SOL at completion 115.005359, real SOL 85.005359, price 4.1088e-7 SOL, mcap 410.88 SOL, 14.696x launch price (launch price 2.796e-8). 410.88 SOL x $119.26 = $49,002. Live SOL is $119.44 (Jupiter) / $119.52 (CoinGecko), so the $119.26 input is fine. Also on the live Global: pool_migration_fee = 15,000,001 lamports. Global.creator_fee_basis_points reads 5, but live TradeEvents show 30 bps creator, so do not read creator fee from Global. |
| F2 | pump.fun curve fees: creator 0.30% + protocol 0.95% = 1.25% per trade (SOL and USDC coins); graduation fee 0.015 SOL; creation free; mobile users may pay up to  | **confirmed** | Fees page literally says: curve creator 0.300% + protocol 0.95% + LP 0% = 1.25% (SOL and USDC); creation fee '0 SOL / 0 USDC'; graduation fee '0.015 SOL'; mobile users 'may experience fee increases of up to .1%'; 'may change these fees at any time, without notice'; displayed fees 'may not precisely match smart contract charges'. On-chain check: 36 recent pump TradeEvents (txs touching the mint-authority PDA) all show fee_basis_points 95 + creator_fee_basis_points 30 = 125 bps. Graduation fee on-chain is 15,000,001 lamports (0.015000001 SOL), in both Global.pool_migration_fee and the migration events. The page does not use the phrase 'contract is authoritative'. It says only that displayed fees may not precisely match contract charges, so the intent holds. |
| F3 | PumpSwap (pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA) canonical-pool fees, SOL coins by mcap: 0–420 SOL 0.300% creator/0.930% protocol/0.020% LP = 1.25%; 420–1 | **confirmed** | SOL canonical table matches: 0-420 SOL 0.300/0.930/0.020 = 1.250%; 420-1470 0.950/0.050/0.200 = 1.200%; steps down every ~1k-5k SOL to 98,240+ at 0.050/0.050/0.200 = 0.300%. Non-canonical pools: 0/0.05/0.25 = 0.3%. LP burn: docs/PUMP_PROGRAM_README.md line 5, 'The LP tokens received from the PumpSwap pool are then burnt.' On-chain check of fresh PumpSwap BuyEvents: LP 2 bps + protocol 93 + creator 30 = 125 in the first tier; LP 20 + protocol 5 + creator 95 = 120 once mcap passed 420 SOL. The USDC canonical table has its own bands (first break at 59,000 USDC), so do not reuse the SOL thresholds for USDC coins. |
| F4 | At migration the PumpSwap pool gets 206.9M tokens and ~84.99 SOL: price is continuous (within 0.02%) but depth drops ~26% vs the 115-virtual-SOL curve; selling  | **confirmed** | Core claims hold but three details need tightening. (1) The paper (Marino et al., 'Predicting the success of new crypto-tokens: the Pump.fun case') says the pool is initialised with (85 SOL, 2.069e8 tokens) and proves that selling before graduation yields strictly more than after (Δx > Δx′). It states no '26%' figure and no insider-incentive argument; both are your own inference. (2) On-chain, CompletePumpAmmMigrationEvent decodes to mint_amount 206,900,000 tokens and sol_amount 84.990359 SOL (85.005359 minus the 0.015 fee), repeated across 69 standard migrations, so '~84.99' is right. (3) Price continuity is 0.0244%, not 'within 0.02%': curve price 4.108802e-7 vs pool price 4.107799e-7. Quote depth ratio is 84.99/115.005 = 73.9%, so the ~26.1% drop is arithmetically correct. With BOOST, InitBoostEvent shows real quote in the pool vault is only 67.41 SOL, with virtual_quote_reserves +17.58 SOL, so effective quote stays at 84.99. Quote from effective reserves and treat only ~67.4 SOL as real. |
| F5 | BOOST (default since 2026-07-21): ~20% of migration liquidity (17.6 SOL per SOL pool, $2,516 per USDC pool) is spent by TWAP buy-and-burn within ~5 minutes afte | **confirmed** | Mechanism and figures hold; the '36 of 42' sample stat does not reproduce. The Block (2026-07-29) says roughly 20% of migration liquidity, previously locked in the pool, is now spent on automatic market buys in the first five minutes after migration, with every token acquired burned afterwards. It does not name TWAP, the date, or the 17.6 SOL / $2,516 amounts. KuCoin flash (https://www.kucoin.com/news/flash/pump-fun-launches-boost-mode-to-reinject-dead-liquidity-into-token-market) states July 21, 2026, 'default launch mechanism for all future tokens', 17.6 SOL (SOL pair), $2,516 (USDC pair), TWAP, within five minutes of migration completion. IDL (pump_amm.json) has init_boost, boost_buy_and_burn, InitBoostEvent, BoostBuyAndBurnEvent, and GlobalConfig boost_enabled is true on-chain. On-chain InitBoostEvent: virtual_quote_reserves +17.5845 SOL, which is 20.69% of 84.99 (not exactly 20%). BoostBuyAndBurn series seen for pools over 100-280 s, with the boost vault draining to 0. USDC figure: 20.69% of the USDC pool's ~12,161 USDC raise is ~2,516, so it is consistent, but my one USDC migration did not run InitBoost. Sample stat: my pull of 92 migrations (09:26-12:24 UTC, 2026-10-03) shows InitBoost on 71 (77%), and on 31 of the latest 42 (74%). All 69 standard 84.99-SOL migrations had it; the misses were 20 small-sol_amount SOL migrations plus 1 USDC. Re-measure the share yourself; do not hardcode 36/42. |
| F6 | PumpSwap Pool.virtual_quote_reserves is i128 and may be negative from 2026-09-30; all quotes must use effective_quote = vault amount + virtual_quote_reserves (s | **confirmed** | Doc: Pool::virtual_quote_reserves is an i128 (it has been since introduction) and 'can be negative' starting September 30 (no year in the text; today is 2026-10-03). effective_quote_reserves = pool_quote_token_account.amount + Pool::virtual_quote_reserves. The program guarantees the sum never overflows and is never negative. Base reserves stay as the raw vault balance. Integrators must use signed columns, and legacy pools missing the field count as 0. The IDL confirms the i128 field in BuyEvent/SellEvent/InitBoostEvent. Note the pump (bonding curve) TradeEvent field virtual_quote_reserves is u64, so only the PumpSwap side is signed. |
| F7 | New pump.fun coins (create_v2) are Token-2022 mints; trading has buy_v2/sell_v2/buy_exact_quote_in_v2 (mandatory for USDC coins); USDC pairs since 2026-05-21; m | **confirmed** | Most items are not in the repo root README; they are in docs/instructions/*.md and press. COIN_CREATION.md: new mint is Token-2022 (TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb), decimals 6. README: buy_v2, sell_v2 and buy_exact_quote_in_v2 exist, and 'Trading USDC-paired coins will not be possible with the legacy instructions' (the v2 trio is mandatory for USDC). BUY.md: user_volume_accumulator is a 137-byte account, 'Rent for 137-byte account if missing: 0.0018444 SOL'. The README says create_v2 has optional is_holder_reward, and 'Cashback mode is deprecated' (create_v2 rejects is_cashback_enabled=true; existing cashback coins keep working). USDC date: README says only 'next week'; Cryptopolitan (2026-05-19, https://www.cryptopolitan.com/pump-fun-usdc-liquidity-from-may-21/) says USDC pairs start May 21, and other press says activated May 21, 2026; I also saw a live USDC-quote migration on-chain. Mayhem: The Block (https://www.theblock.co/post/379285/pump-funs-new-mayhem-mode-fails-boost-token-launches-revenue) says opt-in, AI agent trades the coin for its first 24 hours, an extra 1B tokens minted and unused ones burned after 24 h (so 2B total); the repo has is_mayhem_mode and a separate reserved fee-recipient set. Global on-chain also shows create_v2_enabled, mayhem_mode_enabled and holder rewards enabled. |
| F8 | Bot-subscribable events: CreateEvent, TradeEvent, CompleteEvent, CompletePumpAmmMigrationEvent (pump); CreatePoolEvent, BuyEvent, SellEvent, InitBoostEvent, Boo | **contradicted** | The event names are right; the withdraw-authority filter is not. idl/pump.json has CreateEvent, TradeEvent, CompleteEvent, CompletePumpAmmMigrationEvent. idl/pump_amm.json has CreatePoolEvent, BuyEvent, SellEvent, InitBoostEvent, BoostBuyAndBurnEvent. All nine are present. TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM is the pump PDA for seed 'mint-authority', and I derived it. Its 45 latest txs: 42 readable, all carry CreateEvent (3 unreadable), so 'only creations' holds. 39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg is Global.withdraw_authority on-chain. But the claim that transactions mentioning it are migrations is false as a filter. Of 132 readable txs in the latest 200 signatures, only 92 (70%) contain CompletePumpAmmMigrationEvent. 33 have no events at all (many are no-op MigrateV2 calls from racing bots that log 'Bonding curve already migrated', and one is an unrelated program tx), and 7 are BuyEvent-only. Correct rule: detect a migration by CompletePumpAmmMigrationEvent (or a Migrate/MigrateV2 that does not log 'already migrated'), never by the account mention alone. Dedupe by mint. |
| F10 | Historical graduation rates: 0.63% (4,338/655,770, Sept 2025, median 4.4 min to graduate); 1.02% across ~15M coins over two years; June 2026 ~0.8–0.9%, rising t | **confirmed** | The cited source (https://arxiv.org/html/2609.10246, 'Meme Coin Factories: Uncovering Large-Scale Manipulations on pump.fun') supports only the 1.02% figure: 15.2M coins created 2024-01-14 to 2026-01-14, 'In our sample, 1.02% of coins graduate' (wash-traded coins 2.0%). The 0.63% data is from a different paper, arXiv 2602.14860 (Marino et al.): 'a total of 655,770 tokens... only 4,338 coins reached the graduation point, ... approximately 0.63%', dataset 2025-09-01 to 2025-10-01, 'median time to graduation is ≃4.4 minutes'. Fix the citation. The June 2026 and post-BOOST figures come from The Block (2026-07-29): '6.7% last Friday, roughly 8x higher than the average throughout June' (so June is about 0.84%, derived), '4.7% across the previous four days, against 2.5% the week before'. Caveat: a DEXTools search snippet (page not fetchable) reports graduation falling to ~0.26% in mid-June 2026, so the 0.8-0.9% June figure depends on the denominator definition. Treat these rates as definition-dependent. |
| F11 | MELT (41k pump.fun graduates): ~73% fall below 40% of migration price shortly after migration; buying at migration and selling at a random time within 1h lost 6 | **confirmed** | MELT paper matches. Dataset: 41,470 launches that migrated, Dec 1, 2024 to Mar 1, 2025. 'about 73% of memecoins drop below 40% of their migration price' within 20 minutes after migration. Buying at migration and selling at a random time in the next hour lost 60.71% (top-100) and 64.84% (top-200). ML-guided selection (Table 10) still lost 26.64% (MLP, top-100) up to 36.50% (LR, top-200), which is the quoted range. Other models: RF 30.34/33.72, XGB 31.45/33.15, LGBM 31.99/34.15. '36.5% of token supply is held by coordinated accounts' (bundled), a different number that happens to match the 36.5% loss. Caveat: the data predates BOOST and mostly predates PumpSwap, so it is a pessimistic base rate for migration-buying, not a current-regime estimate. |
