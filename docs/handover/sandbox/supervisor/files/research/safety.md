# Rug, scam and token safety detection

Research date: 2026-10-03. Scope: Solana meme tokens on pump.fun / PumpSwap, Raydium (LaunchLab, CPMM, CLMM, AMM v4) and Meteora (DBC, DAMM v2, DLMM), for a $20 bankroll, $2 default / $5 max entry, one open position, paper mode first.

Method: primary docs and program source where possible, plus four small live probes run from this research container on 2026-10-03, 11:48–12:05 UTC (RugCheck, GoPlus, Jupiter, public Solana RPC). Probe sample sizes are tiny (n = 4 to 24). They show how things work and roughly how fast. They are not population statistics. Anything I could not verify is marked **unverified**.

---

## 0. Executive summary (plain words)

1. **Most of the safety check needs no third-party API.** One read of the mint account gives us the token program, mint and freeze authority, and every Token-2022 extension. One read of the pool account gives us the venue and LP state. A PDA derivation proves a PumpSwap pool is the official one. These checks take one or two RPC calls (about 100–300 ms) and are deterministic. They should be the hard gates.
2. **The current pump.fun launch path removes the classic "authority" rugs.** `create_v2` makes a Token-2022 mint whose mint authority is a Pump PDA. RugCheck and Jupiter report mint and freeze authority as null on fresh pump mints. The live sample shows both null; launch docs say so too. LP tokens are burned at migration to PumpSwap. The dominant risk on these tokens is therefore **economic**: pump-and-dump by insiders, bundled supply, serial deployers and fake volume. It is not a contract trap. In the 2025 SolRugDetector dataset, pump-and-dump is 78.9% of detected rugs, liquidity withdrawal 20.4%, and freeze abuse only 0.6%.
3. **Base rates are brutal.** Solidus reported 98.6% of pump.fun tokens collapsing into pump-and-dump patterns (Jan 2024–Mar 2025). The median rug lifecycle is about 35 minutes (SolRugDetector, H1 2025). Pine Analytics found more than 50% of tokens sniped in the creation block, often by wallets the deployer funded. The default answer must be "no trade".
4. **Third-party scores are useful but flawed for minutes-old tokens.** RugCheck answers in about 0.4 s even for tokens 2–40 s old. But its "Single holder ownership" danger flag fired on 6 of 7 **Mayhem-mode** tokens in the sample, because it counts the Mayhem agent vault (`BwWK17cb…`, verified PDA) as a holder. That is a false positive. Its insider graph was 0 on all 18 fresh tokens sampled. GoPlus returns only static authority fields for bonding-curve tokens (dex and holders are null). Birdeye `token_security` is not on the free tier.
5. **Holder concentration must exclude**: the bonding-curve ATA, PumpSwap pool vaults, the Mayhem vault, LP lockers, burn accounts and program-owned accounts. Otherwise every new pump token looks 99% concentrated.
6. **"LP burned" means different things per venue.** PumpSwap canonical pool: burned (strong). Raydium LaunchLab → CPMM: burned or locked in Burn & Earn, both non-withdrawable. Meteora DBC → DAMM v2: **up to 90% can be unlocked**, because DBC only requires 10% locked at day 1. Concentrated liquidity (CLMM, DLMM) has no fungible LP. "Burned" there is either meaningless or a full-range Burn & Earn NFT. PumpSwap also allows anyone to create **non-canonical** pools whose LP is not burned.
7. **A simulated sell reduces uncertainty but cannot prove you can exit later.** The simulation runs on current state, and Solana RPC `simulateTransaction` has no state overrides. Authorities, hooks, a pause, and liquidity pulls can all change after entry. The real protection is the hard gates (no authority, no hook, no pause, no permanent delegate) plus small size plus the exit plan.

---

## 1. Token permissions: SPL Token, Token-2022 extensions, authorities, metadata

### 1.1 Program IDs
- SPL Token: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`; Token-2022: `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` ([Raydium Token-2022 doc](https://docs.raydium.io/algorithms/token-2022-transfer-fees.md); [pump COIN_CREATION.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md)).
- pump.fun `create_v2` creates a **Token-2022** mint (decimals 6, metadata pointer = mint itself, mint authority = Pump PDA `[b"mint-authority"]`) ([pump COIN_CREATION.md](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md), repo HEAD 2026-09-29). Live check, 2026-10-03: all 10 RugCheck "new tokens" and all 30 Jupiter "recent" tokens sampled were pump `…pump` mints on Token-2022 with mint authority and freeze authority null.

### 1.2 Base authorities (both programs)
| Authority | Buyer risk | Gate |
|---|---|---|
| Mint authority non-null | Unlimited dilution, then dump into the pool | **Hard block** |
| Freeze authority non-null | Your token account can be frozen after you buy (the classic Solana honeypot). SolRugDetector counts 461 "Freeze Authority Abuse" rugs in H1 2025 ([arXiv 2603.24625](https://arxiv.org/html/2603.24625v1)) | **Hard block** |

Pump.fun sets mint and update authority to null for new tokens ([Helius docs: explore authorities](https://www.helius.dev/docs/orb/explore-authorities)). Live RugCheck data agrees: `mintAuthority: null`, `freezeAuthority: null`, `tokenMeta.mutable: false`, `updateAuthority: 1111…1111`.

### 1.3 Token-2022 extensions: complete list from source and danger rating
The source is `solana-program/token-2022` `ExtensionType` at commit `bb4c841` (2026-10-02) ([repo](https://github.com/solana-program/token-2022), [docs list](https://solana.com/docs/tokens/extensions)). Source has one extension the docs page does not list: **PermissionedBurn**.

| Extension (mint-level unless noted) | Mechanics (verified) | Danger to a buyer | Gate |
|---|---|---|---|
| **PermanentDelegate** | A mint-level authority that "can authorize transfers and burns for any token account for that mint". It can only be set at mint creation. The mint authority can rotate it, and token holders cannot revoke it ([Solana docs](https://solana.com/docs/tokens/extensions/permanent-delegate)). | Delegate can take or burn your tokens at any time. | **Hard block** (any non-null delegate) |
| **TransferHook** | Every transfer CPIs into the hook program, and if the hook errors "the initial token transfer fails". It is set only at mint creation ([Solana docs](https://solana.com/docs/tokens/extensions/transfer-hook)). Authority type `TransferHookProgramId` can change the hook program ([source `AuthorityType`](https://github.com/solana-program/token-2022/blob/main/interface/src/instruction.rs)). The hook program itself may be upgradeable. | Arbitrary sell blocking (allowlist or time-bomb honeypot). Simulation passing today proves nothing about tomorrow. | **Hard block** if the program id is non-null or the authority is non-null. Note: Meteora DBC transfer-hook pools have the hook **active during the bonding phase** and revoke it at curve completion ([Meteora DBC migration](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity.md)) |
| **Pausable** | When paused, "Transfers, Mints, Burns" are rejected. The pause authority signs pause and resume ([Solana docs](https://solana.com/docs/tokens/extensions/pausable)). Authority type `Pause` exists in source. | Issuer can halt all selling. | **Hard block** |
| **TransferFeeConfig** | Fee = min(bps × amount, maximum_fee). `MAX_FEE_BASIS_POINTS = 10_000` (100%) ([source](https://github.com/solana-program/token-2022/blob/main/interface/src/extension/transfer_fee/mod.rs)). `SetTransferFee` takes effect **two epochs later** (`epoch.saturating_add(2)` in the processor) ([Solana docs](https://solana.com/docs/tokens/extensions/transfer-fees)). | Fee honeypot: the fee can be raised to 100% with roughly 2 epochs (about 4 days) notice. A fee also skews every quote. Raydium LaunchLab Token-2022 launches can attach a transfer fee, and the fee-config authority moves to the platform key at graduation ([LaunchLab platform config](https://docs.raydium.io/products/launchlab/platform-config.md)). | **Hard block** in the trial if any fee > 0 **or** the config authority is non-null. A permanently zero fee with null authorities is harmless but rare; still block it in the trial for simplicity. |
| **DefaultAccountState** | New token accounts start in a set state, possibly Frozen. Changing it is gated by the mint's freeze authority (processor reads `freeze_authority`) ([source](https://github.com/solana-program/token-2022/tree/main/program/src/extension/default_account_state)). | Default Frozen means you cannot sell unless the issuer thaws you. | **Hard block** if state is Frozen. If Initialized with freeze authority null: allow (cannot be changed) |
| **NonTransferable** | Tokens cannot move. Raydium `CreatePool` rejects such mints ([Raydium doc](https://docs.raydium.io/algorithms/token-2022-transfer-fees.md)). | Cannot sell. | **Hard block** |
| **MintCloseAuthority** | The mint can be closed only when supply is 0 (`MintHasSupply` error in processor) ([source](https://github.com/solana-program/token-2022/blob/main/program/src/processor.rs)). | Low on its own. Dangerous **with** PermanentDelegate (burn everyone, then close and re-create the address). | Block in the trial ("unexplained privilege"). Opportunity cost is about zero because pump mints do not have it |
| **ConfidentialTransferMint / ConfidentialTransferFeeConfig / ConfidentialMintBurn** | Encrypted balances and amounts; an auditor key exists. | Holder concentration and flows become unobservable, so the other checks cannot run. | **Hard block** |
| **ScaledUiAmount** | The authority changes a UI multiplier immediately or at a future timestamp. Raw amounts are unchanged, and round-trips are "not guaranteed" exact ([Solana docs](https://solana.com/docs/tokens/extensions/scaled-ui-amount)). | Price and amount display can be manipulated, and sizing done in UI units goes wrong. | **Hard block** in the trial. Always compute in raw units |
| **InterestBearingConfig** | Balances appear to grow. Raydium pools read raw vault balances ([Raydium doc](https://docs.raydium.io/algorithms/token-2022-transfer-fees.md)). | Display distortion. | Block in the trial |
| **PermissionedBurn** (new in source, `AuthorityType::PermissionedBurn`) | Burning needs authority approval ([source](https://github.com/solana-program/token-2022/tree/main/interface/src/extension/permissioned_burn)). Whether it is deployed on mainnet is **unverified**. | Low for a seller, but an unexplained privilege. | Block in the trial |
| MetadataPointer / TokenMetadata | Metadata lives on the mint. The update authority can change name, symbol and URI. | Impersonation and rebranding, not direct theft. | Allowed. **Soft** penalty if the update authority is non-null. For pump mints, non-null means "not a genuine pump mint" → block |
| GroupPointer / TokenGroup / GroupMemberPointer / TokenGroupMember | Collections | None known | Allowed |
| Account-level: ImmutableOwner, MemoTransfer, CpiGuard, TransferFeeAmount, TransferHookAccount, NonTransferableAccount, PausableAccount, ConfidentialTransferAccount | These are set on *your* account or mirror the mint's state. MemoTransfer and CpiGuard are opt-in by the account owner. | Not an issuer lever. The mirror extensions show the mint has the matching mint extension. | Ignore (judge the mint extension) |

**Policy shape:** use an **allowlist**, not a blocklist. Allowed mint extensions = {MetadataPointer, TokenMetadata, GroupPointer, TokenGroup, GroupMemberPointer, TokenGroupMember}, plus DefaultAccountState=Initialized when freeze authority is null. Any unknown extension type (a future addition) → block.

### 1.4 Metadata mutability
- Token-2022 TokenMetadata: the update authority lives in the mint's extension. RugCheck exposes `token_extensions.tokenMetadata.authority` and `tokenMeta.mutable`.
- Classic SPL tokens use Metaplex metadata (`isMutable` and update authority). Birdeye exposes `mutableMetadata` and `metaplexUpdateAuthority` ([Birdeye token_security](https://data.birdeye.so/docs/data-api/security/get-defi-token-security.md)). GoPlus exposes `metadata_mutable` ([GoPlus](https://docs.gopluslabs.io/reference/solanatokensecurityusingget)).
- Copycat signal seen live: two different mints (`3WKdfri…pump`, `D8BsPnq…pump`) had the same name "WIN2Day" and the same IPFS URI within a minute, from a serial deployer. **Soft feature:** a duplicate metadata URI or name hash across mints in the last N hours.

---

## 2. Venue and LP safety

### 2.1 pump.fun bonding curve → PumpSwap
- Pump program `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`; PumpSwap AMM `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`; Mayhem program `MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e` ([pump-public-docs](https://github.com/pump-fun/pump-public-docs), HEAD 2026-09-29).
- Curve parameters (Global): initial virtual token reserves 1,073,000,000; virtual SOL 30; real token reserves 793,100,000; total supply 1,000,000,000 (6 decimals) ([PUMP_PROGRAM_README](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md)). Constant-product math gives about **85 SOL real reserves at completion**. This is my calculation (30×1073/279.9 − 30), not a documented figure.
- `complete = true` when `real_token_reserves == 0`. `migrate` is permissionless and idempotent. "The LP tokens received from the PumpSwap pool are then burnt." The old admin `withdraw` path is disabled ([PUMP_PROGRAM_README](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_PROGRAM_README.md)).
- **Canonical pool check (hard gate):** a canonical pool has `index == 0` and `pool.creator == PDA(["pool-authority", base_mint], pump program)` ([PUMP_SWAP_CREATOR_FEE_README](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_CREATOR_FEE_README.md), [PUMP_SWAP_README](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md)). Anyone can `create_pool` with any index, and that creator receives withdrawable LP. Only route through the canonical pool, or a pool whose LP state you have verified.
- `Pool::lp_supply` excludes user burns, so "burned %" = 1 − (LP mint supply / lp_supply) for user-burned LP. Use effective quote reserves = vault amount + `virtual_quote_reserves` (signed i128, can be negative since 2026-09-30) ([pump README](https://github.com/pump-fun/pump-public-docs/blob/main/README.md)).
- **Platform risk (soft, document it):** the PumpSwap admin can `disable(…disable_buy, disable_sell)` globally, and the pump `Global::authority` can `set_params` ([PUMP_SWAP_README](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md)). This is a centralized venue risk, not a token risk.
- **Mayhem mode** (launched about Nov 2025): an opt-in AI agent trades the coin for its first 24 h. **An extra 1 billion tokens is minted for the agent** (supply becomes 2B), unused agent tokens are burned after 24 h, and the agent pays no protocol fees ([The Block, 2025-11-18](https://www.theblock.co/post/379285/pump-funs-new-mayhem-mode-fails-boost-token-launches-revenue)). `BondingCurve.is_mayhem_mode` flags it. Agent tokens sit in the `mayhem_token_vault` ATA owned by `sol_vault` PDA. I derived that PDA as **`BwWK17cbHxwWBKZkUYvzxLcNQ1YVyaFezduWbtm2de6s`**, and it matches the live RugCheck holder data. Implications: (a) exclude this vault from concentration; (b) agent trades are **not organic** demand, so exclude them from volume and buyer features (how to identify the agent's trading signer is **unverified**; start with the vault and sol_vault as owner); (c) supply-based market caps are doubled during the window.
- Graduation rate: secondary sources report about 0.4–1.8% of pump tokens graduating (April 2025) ([soltokencreator, secondary](https://www.soltokencreator.io/blog/pump-fun-graduation-explained)). **Unverified** against primary data.

### 2.2 Raydium
- Program IDs ([Raydium program addresses](https://docs.raydium.io/reference/program-addresses.md)): AMM v4 `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`, CPMM `CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C`, CLMM `CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK`, LaunchLab `LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj`, Burn & Earn locker `LockrWmn6K5twhz3y9w1dQERbmgSaRkfnTeTKbpofwE`.
- **LaunchLab → CPMM:** the platform's `migrateCpLockNftScale` splits LP into `burnScale` (burned), `creatorScale` and `platformScale` (locked in Burn & Earn with Fee Key NFTs). The parts sum to 1,000,000 ([Raydium LP fee distribution](https://docs.raydium.io/products/launchlab/tips-and-gotchas/lp-fee-distribution.md)). Burn & Earn is an escrow with **no withdraw instruction**: "the liquidity can never be withdrawn" ([Burn & Earn](https://docs.raydium.io/user-flows/burn-and-earn.md)). So migrated LaunchLab liquidity is non-withdrawable either way. Verify on chain that the LP sits in the burn or the locker.
- LaunchLab Token-2022 launches may carry a **transfer fee**. The `transfer_fee_config_authority` passes to the platform key at graduation, and the withdraw-withheld authority has been at the platform key since mint creation (changed 2026-08-27) ([LaunchLab platform config](https://docs.raydium.io/products/launchlab/platform-config.md)). The hard gate in §1.3 catches this.
- **AMM v4 / CPMM pools created by hand:** the LP is fungible. Check LP mint supply against the burned or locked share. Solidus found **93% of 388,000 Raydium v4 pools** showed soft-rug patterns (removal of 90% or more of liquidity) ([Solidus Labs, May 2025](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance)).
- **CLMM (concentrated):** liquidity sits in tick ranges as position NFTs, not fungible LP. Burn & Earn on CLMM is supported "full-range only", and a locked tight range can stop providing liquidity once price exits it ([Burn & Earn](https://docs.raydium.io/user-flows/burn-and-earn.md)). Also, one-sided ranges can show large "liquidity" that is all token side, with little SOL to sell into. Gate on **executable sell depth for your size**, not on TVL or "LP burned".

### 2.3 Meteora
- DBC `dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN`; DAMM v2 `cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG` ([Meteora DBC accounts](https://docs.meteora.ag/core-products/dbc/accounts-and-permissions.md), [DAMM v2 Rust library](https://docs.meteora.ag/developer-guides/damm-v2/rust-integration/library.md)).
- **DBC → DAMM v2:** migrated liquidity is split into partner and creator buckets × {unlocked, permanently locked, vesting}. "DBC requires **at least 10%** of liquidity to remain locked at day 1 after migration", and vesting is capped at 2 years ([DBC migration and liquidity](https://docs.meteora.ag/core-products/dbc/migration-and-liquidity.md)). **Up to 90% of a graduated DBC pool can therefore be withdrawable by the creator or partner.** Read the position NFTs' lock state; do not trust a launchpad label.
- A 0.2% protocol migration fee applies. Keeper thresholds are 10 SOL, 750 USDC, and others (same source). A 10 SOL graduation threshold is far smaller than pump's ~85 SOL, so a "graduated" DBC token can have very thin liquidity.
- DLMM is concentrated (bins). The same caveats as CLMM apply.

### 2.4 Liquidity-withdrawal research numbers
- SolRugDetector, H1 2025, Orca/Raydium/Meteora new tokens: liquidity withdrawal = 15,606 tokens (20.4% of detected rugs). Rule: a creator-related address takes positive liquidity profit, followed by under 5 tx/hour ([arXiv 2603.24625](https://arxiv.org/html/2603.24625v1)).
- SolRPDS (2021–2024): 3.69 B transactions, 62,895 suspicious pools, 22,195 tokens with rug patterns ([arXiv 2504.07132](https://www.arxiv.org/pdf/2504.07132); [HF dataset](https://huggingface.co/datasets/DeFiLab/SolRPDS/blob/main/README.md); ACM CODASPY 2025).

---

## 3. Bundled launches, insiders, snipers and serial deployers

### 3.1 Evidence
- **Pine Analytics, "Exit Liquidity Machines" (2025-06-09), about one month from 2025-03-15** ([Bitget translation](https://www.bitget.com/news/detail/12560604803448)). More than 15,000 tokens were sniped in the launch block by wallets the **deployer had directly funded with SOL before launch**: 4,600+ sniper wallets, 10,400+ deployers, more than 15,000 SOL net profit, an 87% sniper success rate, and ">50% of tokens are sniped in the genesis block". Exits: 55% sold within 1 minute, 85% within 5 minutes, and over 90% used 1–2 sells. This is industry analysis, not peer reviewed.
- **MemeTrans (Georgia Tech, arXiv 2602.13480, 2026-02-13):** 41,470 pump.fun tokens that migrated to Raydium (Dec 2024–Mar 2025). Bundled accounts are identified three ways: multi-account buys in one transaction, fund-flow links, and **Jito bundle IDs**. Bundled accounts held 36.5% of supply. The "market activity" feature group ranked most important, then "bundle statistics". Best AUPRC was 0.573, and selecting low-risk tokens cut losses by 56.1%. 84.13% of migrated tokens were labeled high-risk ([arXiv](https://arxiv.org/html/2602.13480v1)).
- **SolRugDetector:** 78 fraud syndicates, median 36 members and median 48.5 tokens each, with star and cluster topologies ([arXiv 2603.24625](https://arxiv.org/html/2603.24625v1)).
- **Coordinated sniper cohorts** (single-author preprint, arXiv 2607.02795 v3, 2026-08-03): June 11–25, 2026, 166,098 pump launches, 1,012 persistent wallet rings (2–12 wallets). The contamination-adjusted first-30-minute buyer-count lift was +16.1% [13.0, 19.4], while the SOL-inflow lift was not significant. In 7.0% of treated launches there were zero non-cohort buyers in the first 30 minutes ([arXiv](https://arxiv.org/abs/2607.02795)). Takeaway: cohorts inflate **buyer counts** more than real money, so buyer-count features must be cohort-adjusted.
- **Caveat on detectors** (same author, arXiv 2609.18975, 2026-09-23): two observation pipelines on pump.fun produced "nearly disjoint outputs" (overlap 0.29–0.80%) ([arXiv](https://arxiv.org/abs/2609.18975)). The collector's configuration drives what gets detected. Validate our own detector's coverage.
- **Live probe (this research, n = 24 pump launches, 2026-10-03, public RPC):** 7/24 (29%) had more than one distinct signer in the creation slot. 11/24 had more trades in slots +1..+2. 1/24 had a Jito tip account in a creation-slot transaction. A tip placed in a separate bundle transaction that does not touch the curve would be missed, so this is a lower bound. Jupiter `devMints` (deployer's mint count) was ≥3 for 11/24 and ≥100 for 7/24, with a maximum of **13,525**. This is a tiny sample: it shows the method works, not a rate.

### 3.2 Detection recipe (computable within budget from our own stream)
- **Stream:** pump program logs carry Anchor events as `Program data:` lines (verified live: the TradeEvent discriminator prefix `vdt/007m…`). `logsSubscribe` on the pump program (free WebSocket) gives create and trade events with slot. That is enough for slot-0 and early-slot analysis without extra RPC calls.
- **Same-slot / bundle:** count distinct buyers with slot == creation slot; flag a create and buy in the same transaction (dev buy); flag any tx in slots [s0, s0+2] containing a transfer to one of the 8 Jito tip accounts (from `getTipAccounts`: `DttWaMuV…`, `3AVi9Tg9…`, `Cw8CFyM9…`, `ADaUMid9…`, `96gYZGLn…`, `HFqU5x63…`, `DfXygSm4…`, `ADuUkR4v…`). Tips can sit in a separate bundle tx.
- **Common funder:** for each early buyer (first N buyers, or slot ≤ s0+2), find the first inbound SOL transfer. Free path: `getSignaturesForAddress` (oldest page) plus `getTransaction` on fresh wallets, about 2–3 RPC calls per wallet. That is too slow for more than about 10 wallets at entry time, so precompute it in the background. Paid shortcut: Helius `GET /v1/wallet/{addr}/funded-by` (Wallet API beta, **paid plans only**; Free returns 403) ([Helius funded-by](https://www.helius.dev/docs/wallet-api/funded-by.md)). Flag: ≥2 early buyers funded by the deployer or a shared funder within T minutes.
- **Serial deployer:** count the deployer's prior mints and their outcomes. Sources: own index, Jupiter Tokens V2 `audit.devMints` / `devMigrations` (free, keyless 0.5 RPS) ([Jupiter Tokens](https://developers.jup.ag/docs/tokens/token-information.md)), RugCheck `creatorTokens` and the risk "Creator history of rugged tokens". That flag fired on **10/18** fresh tokens sampled.
- **Insider supply share:** the sum of balances held by flagged insiders (dev, slot-0 buyers, deployer-funded wallets) divided by circulating supply, excluding vaults.

---

## 4. Holder concentration done correctly

**Exclude** before computing top-1 and top-10 share:
1. The bonding-curve ATA, which is the ATA of PDA `["bonding-curve", mint]`. Before trading it holds about 100% of supply. Verified live: the top holder at 49.96% had owner `4fdRyq…`, which is exactly the derived bonding-curve PDA.
2. The Mayhem vault (owner `BwWK17cb…`), up to 50% of a 2B supply.
3. AMM pool vaults: PumpSwap `pool_base_token_account`, Raydium and Meteora vault accounts. Identify them by owner = pool PDA or authority of an allowlisted program.
4. LP lockers and escrows (Raydium Locker `LockrWmn…`, Meteora lock escrows) and known vesting programs.
5. Burned tokens. A real `Burn` reduces mint supply, so use current `supply`. Tokens sent to a burn address such as the incinerator (`1nc1nerator11111111111111111111111111111111`, widely used; **unverified** in primary docs) still count in supply, so subtract them.
6. Any token account whose owner is a PDA, meaning off-curve. Classify it as a program account and look it up in the allowlist. If it is unknown, keep it in the holder set but flag it.

**Then compute:** top-1 non-excluded wallet %, top-10 %, dev %, insider-cluster %, and the count of holders with more than a dust value. Use circulating supply = supply − excluded balances. Be careful: for a token still on the curve, the circulating supply is small, so percentages swing a lot. Report both % of total supply and % of circulating.

**Third-party pitfalls (measured):**
- RugCheck "Single holder ownership" (danger) and "High holder concentration" fired on **5 of 6** Mayhem tokens in the sampled set, plus the 1 in the first probe. It is driven by the Mayhem vault. False positive.
- Jupiter `audit.topHoldersPercentage` excludes the curve. On a fresh token it equalled `devBalancePercentage` (0.70%). How it treats the vault is **unverified**.
- GoPlus `holders` was **null** on all 4 fresh pump tokens tested.

---

## 5. Fake volume, wash trading and volume bots

Evidence:
- MemeTrans: **21.4% of transactions are wash trades**, defined as a buy and a sell within one transaction, detected from balance changes ([arXiv 2602.13480](https://arxiv.org/html/2602.13480v1)).
- Bitquery case (2026-04-27/28, 12 h window, anecdote): one funder sent exactly 0.5 SOL to about 200 bot wallets in 52 s. The token "OpenLie" showed $532,461 of volume from 233 wallets and 40,523 trades. 96% of wallets traded both sides, round-trip ratio was 0.95–1.00, and average trade size was $13.14 ([Bitquery](https://bitquery.io/blog/solana-volume-numbers-are-a-lie)).
- Bot taxonomy (volume bots, bundlers, snipers) from 586 GitHub bot repos. "bundle-submission" is among the top 10 building blocks ([ASE '26, arXiv 2607.28424](https://arxiv.org/pdf/2607.28424)).
- Mayhem agent trades are protocol-made, not organic (see §2.1).

Features, all computable from the event stream in a rolling window of 1–5 min:
| Feature | Definition | Direction |
|---|---|---|
| unique_buyers / trades | Distinct buy signers ÷ buy count | Low = bot churn |
| two_sided_wallet_share | Wallets with both buys and sells ÷ wallets | High (>0.8) = wash |
| round_trip_ratio per wallet | min(buy SOL, sell SOL) ÷ max | Close to 1 = wash |
| same-tx buy+sell count | MemeTrans definition | > 0 = wash |
| size_entropy / repeated sizes | Share of trades whose SOL size repeats exactly, or Shannon entropy of rounded sizes | Low entropy = bot |
| micro-trade share | Trades < 0.01 SOL ÷ trades | High = volume bot |
| funder concentration | Herfindahl of first-funders of active traders | High = sybil |
| fresh-wallet share | Traders whose first-ever tx is less than X min old | High = sybil |
| cohort-adjusted buyers | Unique buyers minus known persistent-cohort wallets (arXiv 2607.02795) | Use this, not raw |
| organic volume | Jupiter `organicScore`, `numOrganicBuyers` (free) | Fresh tokens usually 0 or "low" |

Use **net buyer SOL from non-flagged wallets** as the demand signal, not raw volume.

---

## 6. Honeypot detection by simulated sell, and its limits

**How:** build an unsigned transaction with buy (amount X) then sell (all received) in **one transaction** for the target route. Call `simulateTransaction` with `replaceRecentBlockhash: true`, `sigVerify: false`, `innerInstructions: true`. Pass `accounts` to read back balances. Check `err`, logs, SOL delta and token delta ([Solana RPC simulateTransaction](https://solana.com/docs/rpc/http/simulatetransaction)). Separately, simulate the exact sell for the real position size before each exit. Jupiter's Swap API also returns a route; a missing reverse route at your size counts as a "practical honeypot".

**What it catches:** active transfer hooks that reject, frozen default state, NonTransferable, paused mints, punitive transfer fees (shown as a token delta shortfall), broken or custom pools, and the round-trip cost (fees + price impact). Pass the gate only if round-trip loss ≤ the modelled venue fee + price impact + a small tolerance.

**Limits (why it is not proof):**
1. It runs on current state only. The standard RPC has no state overrides ([same doc](https://solana.com/docs/rpc/http/simulatetransaction)). A later freeze, hook-program change (`TransferHookProgramId` authority), pause, fee change (after 2 epochs), or liquidity pull is invisible.
2. Hooks can be stateful: allow small or first sells, allowlist the simulator's wallet, or switch on by time. Sell blocking that only starts after N buyers is a known pattern ([Sharpe honeypot guide, secondary](https://www.sharpe.ai/rug-check/risk/honeypot)).
3. Commitment and slot drift: the default commitment is finalized. Use `processed` or `confirmed` and set `minContextSlot` near the head.
4. Simulation needs a funded fee payer. It reveals nothing about MEV and sandwiching at landing time.

**Conclusion:** use the simulation as a hard gate for "sellable now at expected cost". Rely on the static authority and extension gates for "cannot be made unsellable later".

---

## 7. Third-party APIs: tested 2026-10-03

| API | Access / limits | Latency on tokens seconds old (measured) | Coverage on fresh tokens | Notes |
|---|---|---|---|---|
| **RugCheck** `GET /v1/tokens/{mint}/report` and `/report/summary` | No key needed for report, summary, insiders graph/networks and stats. API key needed for bulk, lockers, vote and verify. `refresh=true` is paid-key only. Header `x-rate-limit-limit: 15` (the window is **not documented**; 4.5 s spacing never hit 429) ([swagger](https://api.rugcheck.xyz/swagger/doc.json)) | p50 **0.39 s**, max 0.72 s, n = 18. Every token aged 2–40 s returned HTTP 200 | Authorities, all Token-2022 extensions, `tokenMeta.mutable`, topHolders with owner, markets with LP mint, `lpLockedPct`, `creatorTokens`, `launchpad`, `rugged`, `risks[]`, `graphInsidersDetected` (0 on 18/18 fresh) | `score` = sum of risk scores + 1 (verified: 110400+4993+1000+1 = 116394). `score_normalised` runs 0–100, higher = riskier (1 when no risks). The formula is **undocumented**. Mayhem vault false positive (§4). In the SolRugDetector benchmark: precision 76.9%, recall 94.0% |
| **GoPlus Solana** `GET api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=` | Keyless worked; Bearer token optional. Rate limit **unverified** ([docs](https://docs.gopluslabs.io/reference/solanatokensecurityusingget)) | 0.35–0.59 s, n = 4 | Static fields only on fresh pump tokens: mintable, freezable, closable, balance_mutable_authority (permanent delegate), transfer_fee(+upgradable), transfer_hook(+upgradable), default_account_state(+upgradable), non_transferable, metadata_mutable. **`dex`, `holders`, `lp_holders`, `creators` were null or empty** | Good for an independent second read of authorities; no economic risk data |
| **Birdeye** `GET /defi/token_security` | **Not on the free Standard tier** (30k CU/month, 1 rps). Needs Lite $39/mo (2.5M CU, 15 rps) or higher. **25 CU** per call ([endpoint doc](https://data.birdeye.so/docs/data-api/security/get-defi-token-security.md), [pricing](https://data.birdeye.so/docs/guides/payment/pricing.md)) | Not tested (needs a key) | creator/owner balances, `creationSlot`, `mintTx`, `mutableMetadata`, top10 holder and user %, `freezeable`, `transferFeeEnable`, `isToken2022`, `nonTransferable`, `preMarketHolder`, `lockInfo`, `jupStrictList` | The Solana schema has no explicit permanent-delegate, hook or pause fields, so it cannot replace the local extension parse |
| **SolSniffer** | Site and API page returned 403 to the fetcher. Pricing and limits **unverified** | n/a | "Snifscore" 0–100, 20+ indicators (secondary) | SolRugDetector benchmark: precision 67.45%, recall 97.44% ([arXiv 2603.24625](https://arxiv.org/html/2603.24625v1)) |
| **Helius** | Free: 1M credits/mo, 10 RPC rps, **DAS 2 rps**. Developer $49: 10M, 50 rps, DAS 10 rps ([plans](https://www.helius.dev/docs/billing/plans.md)). DAS = 10 credits per call. Standard RPC ≈ 1 credit. Wallet API `funded-by` is **paid only**. Parsed Streams (decoded WS) work on all plans at 1 credit per event ([credits](https://www.helius.dev/docs/billing/credits.md), [llms.txt](https://www.helius.dev/docs/llms.txt)) | Not tested | DAS `getAsset` returns authorities, mutability and token info; raw `getAccountInfo` + local parse is cheaper and complete | Prefer raw mint parse (1 credit) over DAS (10 credits) for gates |
| **Jupiter Tokens V2 / Shield** | Keyless 0.5 rps; Free key 1 rps; Developer $25/mo 10 rps ([llms.txt](https://developers.jup.ag/docs/llms.txt)). `/tokens/v2/recent` = by **first pool** time. `/ultra/v1/shield?mints=` still answers, but Ultra is "no longer actively maintained" ([shield doc](https://developers.jup.ag/docs/ultra-api/get-shield.md)) | 0.22 s, n = 1 | `audit.mintAuthorityDisabled`, `freezeAuthorityDisabled`, `topHoldersPercentage`, `devBalancePercentage`, `devMints`, `devMigrations`, organic score. Shield: NOT_VERIFIED, LOW_ORGANIC_ACTIVITY, NEW_LISTING, HAS_FREEZE_AUTHORITY, HAS_MINT_AUTHORITY, … | Free deployer-history signal (`devMints`, `devMigrations`) |

**Takeaway:** third-party checks are a cross-check and an extra signal, never the gate of record. If one is missing, the policy treats it as "unknown → no new entries" only for **critical** fields we cannot compute ourselves. Mint and extension state is never one of those, because we compute it locally.

---

## 8. Research numbers at a glance (2024–2026)

| Source | Data | Key numbers | Type |
|---|---|---|---|
| Solidus Labs, May 2025 ([link](https://www.soliduslabs.com/reports/solana-rug-pulls-pump-dumps-crypto-compliance)) | pump.fun Jan 2024–Mar 2025; 388k Raydium v4 pools | 98.6% of pump tokens collapse (P&D). Only 97k of 7M+ tokens kept > $1k liquidity. 93% of v4 pools soft-rugged (≥90% liquidity pulled). Median rug about $2,832 | Industry |
| SolRugDetector, arXiv 2603.24625 (2026-03-25) ([link](https://arxiv.org/html/2603.24625v1)) | 100,063 new tokens on Orca/Raydium/Meteora, H1 2025 | 76,469 flagged. P&D 78.9%, liquidity withdrawal 20.4%, freeze abuse 0.6%. **Median lifecycle about 35 min**, p75 about 1.5 h. Median holders 9 vs 41,026 for legit tokens. $151M losses. 78 syndicates. Precision 100%, recall 93.2% | Academic preprint |
| Catching the Rug, arXiv 2608.20271 (2026-08-20) ([link](https://arxiv.org/html/2608.20271)) | 6.3M pump + 98k Raydium tokens, Nov 2024–Jun 2025 | **First 5 min of trading predicts a rug within 1 h**: XGBoost F1 0.78, MCC 0.36, AUPRC 0.76 (pump). Fusion AUPRC 0.80. Cross-platform transfer fails (MCC ≈ 0) | Academic preprint |
| MemeTrans, arXiv 2602.13480 (2026-02-13) ([link](https://arxiv.org/html/2602.13480v1)) | 41,470 migrated pump tokens | 84.1% high-risk. Wash = 21.4% of tx. Bundled accounts hold 36.5% of supply. AUPRC 0.573. Loss reduction 56.1% | Academic preprint |
| SolRPDS, arXiv 2504.07132 / CODASPY 2025 ([link](https://www.arxiv.org/pdf/2504.07132)) | 2021–2024, 3.69B tx | 62,895 suspicious pools, 22,195 rug tokens | Academic (peer-reviewed) |
| Pine Analytics, 2025-06-09 ([link](https://www.bitget.com/news/detail/12560604803448)) | about 1 month from 2025-03-15 | >50% sniped in the creation block. 15k+ tokens sniped by deployer-funded wallets. 85% exit within 5 min | Industry |
| Cohorts, arXiv 2607.02795 (2026-08) ([link](https://arxiv.org/abs/2607.02795)) | 166k launches, June 2026 | 1,012 rings. +16.1% buyer-count lift; SOL lift not significant | Single-author preprint |

The definitions differ a lot: the 1-hour rug rate on pump is about 4.75% in Catching the Rug, while 98.6% eventually "collapse" per Solidus. Do not mix horizons. The bot's question is "will this collapse **during my holding horizon**", which matches the Catching the Rug framing (5-min features → 1-h outcome).

---

## 9. Ranked gates and features (latency-budgeted)

Assumed budget: about **300–800 ms** from candidate to decision. This is not first-block sniping, which the brief already rules out. Calls run in parallel. Costs are on the Helius free plan unless noted.

### 9.1 Hard gates (any fail → no entry). Ordered by cost, cheapest first
| # | Gate | Data source | Cost / latency | Rationale |
|---|---|---|---|---|
| H1 | Mint owner ∈ {SPL Token, Token-2022} | `getAccountInfo(mint)` (or stream cache) | 1 call, ~50–150 ms | Unknown program = unknown semantics |
| H2 | `mint_authority == null` | same account | 0 extra | Dilution rug |
| H3 | `freeze_authority == null` | same | 0 | Freeze honeypot (461 cases H1-2025) |
| H4 | Token-2022 extension **allowlist** (§1.3): block PermanentDelegate, TransferHook (non-null program or authority), Pausable, NonTransferable, DefaultAccountState=Frozen, TransferFeeConfig (fee > 0 or authority non-null), MintCloseAuthority, Confidential*, ScaledUiAmount, InterestBearing, PermissionedBurn, any unknown type | same | 0 (local parse < 1 ms) | Each one can make the token unsellable or misleading |
| H5 | Venue allowlist: the pool account's owner program ∈ {pump `6EF8…`, PumpSwap `pAMM…`, Raydium CPMM `CPMMoo8…`, LaunchLab `LanMV9…`, (later) Meteora DBC/DAMM v2}. PumpSwap pool must be **canonical** (index 0, creator = PDA `["pool-authority", mint]`) | `getAccountInfo(pool)` + PDA derive | 1 call | Non-canonical pools have withdrawable LP |
| H6 | LP not withdrawable: PumpSwap canonical (burned by protocol); CPMM: LP in burn or `LockrWmn…` ≥ 95%; DBC → DAMM v2: unlocked share ≤ 10%; CLMM/DLMM: **excluded in the trial** | pool + LP mint + positions | 1–2 calls | Liquidity withdrawal = 20.4% of rugs |
| H7 | Bonding curve not `complete && !migrated` (no trading in the migration gap) | curve account | 0–1 call | Avoid a stuck state |
| H8 | Round-trip **simulate** (buy X then sell all, one tx) succeeds, with loss ≤ modelled fees + impact + tolerance; reverse route exists at size | `simulateTransaction` (processed, minContextSlot) | 1 call, ~100–300 ms | "Sellable now at expected cost" |
| H9 | Deployer is not a serial launcher: deployer mints in the last 24 h ≤ 2, and no prior "rugged" outcomes | own index; Jupiter `devMints`; RugCheck risks | 0 (cached) / 0.2–0.4 s | Syndicates median 48.5 tokens. Fired on 10/18 fresh tokens |
| H10 | Insider supply ≤ threshold: dev + creation-slot buyers + deployer-funded wallets ≤ **15%** of circulating (hypothesis, calibrate) | own stream + background funder graph | 0 at decision (precomputed) | Bundled holders 36.5% avg in MemeTrans |
| H11 | Largest non-excluded single wallet ≤ **10%**, top-10 ≤ **35%** after exclusions (hypotheses, calibrate) | `getTokenLargestAccounts` + owner classification | 1–2 calls | Concentration = dump capacity |
| H12 | Evidence freshness: mint and pool state read at slot ≥ head − 2, quote under 2 s old | slot bookkeeping | 0 | Brief's "unknown critical evidence blocks" |

### 9.2 Soft features (score; ranked by expected value per ms)
1. Early-window market activity from the stream: buys/sells, unique non-flagged buyers, net non-flagged SOL inflow, price path in the first 5 min. Catching the Rug and MemeTrans both rank market activity as the most predictive group. Cost 0 ms (stream).
2. Bundle stats: creation-slot buyer count, Jito-tip-in-launch flag, same-tx dev buy size. Cost 0.
3. Wash and volume-bot metrics (§5): two-sided share, round-trip ratio, size entropy, micro-trade share, funder Herfindahl, fresh-wallet share, with Mayhem agent trades excluded. Cost 0 to small.
4. Deployer history quality: `devMigrations / devMints` (Jupiter, free), share of prior tokens that kept liquidity. Cost 0.2 s, cacheable.
5. Holder growth rate and holder count above dust, excluding cohort wallets.
6. Metadata: mutable (penalty), duplicate URI or name across recent mints (penalty), social links present (weak).
7. Third-party cross-checks: RugCheck `score_normalised` and risk names. **Ignore** "Single holder ownership" when the holder is a known vault. GoPlus authority bits (must agree with local; disagreement → investigate and block). Jupiter organic score.
8. Mayhem-mode flag: inflated activity, doubled supply. Penalty, or exclude in the trial.
9. Platform-risk flags: PumpSwap admin can disable trading; LaunchLab platform holds the fee authority. Informational.

### 9.3 Labelling for calibration (paper mode)
Store, for every candidate including rejected ones: all gate inputs, all features, and outcomes at +5 min, +15 min, +1 h and +24 h. Outcomes: max drawdown from entry, whether liquidity fell by ≥90% (Solidus rule), holder drop ≥73% (SolRugDetector τ), and inactivity (< 5 tx/h). This allows a later model comparable to Catching the Rug (5 min → 1 h) without lookahead.

---

## 10. Checks on the brief's statements in this area

| Brief statement | Status | Notes |
|---|---|---|
| "Unsupported transfer hooks, permanent delegates, freeze controls, nontransferability, or unexplained privileges should fail the initial allowlist policy." | **Confirmed**, incomplete | Add Pausable, DefaultAccountState=Frozen, TransferFee with authority, Confidential*, ScaledUiAmount, MintCloseAuthority, PermissionedBurn (new in source) |
| "A current reverse quote and simulation reduce uncertainty; neither proves future sellability." | **Confirmed** | `simulateTransaction` has no state overrides. Authorities can act later. Hook program id can be changed by its authority |
| "Exclude identified pool vaults and burn addresses from naive holder concentration." | **Confirmed**, incomplete | Must also exclude the **pump bonding-curve ATA** and the **Mayhem vault** `BwWK17…`. RugCheck itself fails on the Mayhem vault |
| "Burned LP tokens alone do not prove safety, particularly for concentrated-liquidity structures." | **Confirmed** | Raydium Burn & Earn on CLMM is full-range only. Meteora DBC allows up to 90% unlocked. PumpSwap non-canonical pools are not burned |
| "GoPlus Solana and Rugcheck … Missing or stale results are unknown, not safe; coverage must be tested on target mints." | **Confirmed** (tested) | RugCheck covers 2–40 s old tokens at ~0.4 s. GoPlus covers only authority and extension fields; dex and holders are null |
| "Birdeye … do not assume the free tier supplies all required feeds." | **Confirmed** | `token_security` requires Lite ($39/mo) or above, 25 CU |
| "Helius free plan … 1 million credits monthly and 10 RPC requests per second." | **Confirmed** | DAS is limited to 2 rps on Free. Funded-by (wallet funder) needs a paid plan |
| "Wallet clustering is uncertain evidence." | **Confirmed** | Cohort detectors disagree (0.3–0.8% overlap between pipelines, arXiv 2609.18975) |
| "Avoid first-block launch sniping in the trial." | **Confirmed by data** | More than 50% of launches are sniped in the genesis block by insiders (Pine). Insiders exit within 1–5 min |
| Relevant token-risk links (Solana extensions, Permanent delegate) | **Confirmed** | Pages exist. The docs page omits PermissionedBurn, which is present in source as of 2026-10-02 |

---

## 11. Cheapest upgrades, ranked by value per dollar
1. **$0:** raw `getAccountInfo` parse + PDA checks + `logsSubscribe` on the pump and PumpSwap programs + `simulateTransaction` + RugCheck and Jupiter keyless calls. This covers H1–H9 and H11–H12.
2. **$25/mo Jupiter Developer** (10 rps) if keyless 0.5 rps throttles enrichment and quotes.
3. **$49/mo Helius Developer:** the Wallet API `funded-by` makes H10 (deployer-funded insiders) cheap. It also raises DAS to 10 rps and RPC to 50 rps. This is the best value if funder-graph features prove predictive in paper mode.
4. Birdeye Lite $39/mo: low marginal value for safety. Its fields mostly overlap local checks plus RugCheck.

## 12. Open questions / unverified
- RugCheck rate-limit window and the `score_normalised` formula.
- GoPlus Solana rate limits. SolSniffer API access and pricing.
- The Mayhem agent's actual trading signer(s), needed to exclude its volume.
- Whether PermissionedBurn is live on mainnet Token-2022.
- The incinerator address in primary docs.
- Graduation rate (only secondary sources).
- Our probes ran from one container region; production latency depends on host location relative to RPC and API servers.
