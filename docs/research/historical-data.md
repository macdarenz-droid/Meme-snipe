# Historical data for the backtest

Research and build date: 2026-10-03 (task DATA-1). This document covers which sources were tested, the dataset that was built, what it does and does not cover, how it was checked, and how to extend it. It serves CLAUDE.md's pre-funding gate, check 2 (historical backtest on at least 30 days of survivorship-free on-chain data, replayed transaction by transaction) and check 6 (the strategy proof with an untouched holdout). Every number here comes from a run whose evidence is in the repo or in the dataset's manifest and QA report.

## Bottom line

1. **Source: the Old Faithful archive** (`files.old-faithful.net`, run by Triton). It holds the full Solana ledger as one content-addressed CAR file per epoch. It is free, needs no account, and was current to the end of epoch 1047 (2026-10-02 21:49 UTC) when tested. It is the only free source that is both complete and bulk.
   - Public RPC also has full history, but allows about 1 `getTransaction` per second.
   - Every published dataset we found stops before September 2026 or lacks PumpSwap (see Sources).
2. **What was built:** a scanner that streams the archive and keeps every transaction touching the pump.fun bonding-curve program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) or PumpSwap (`pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`). It decodes every event of both programs from their published IDLs and writes per-day files.
   - Each trade row carries its slot, block time, position in the block, signature, user, amounts, reserves, every fee, and the pool or curve balances recorded on-chain after the transaction.
   - That is enough to rebuild pool state before every trade and insert our own simulated order at any slot.
3. **Universe:** a fixed hash sample of mints, decided by the mint address alone, so it cannot depend on outcomes.
   - Launch (72-hour tape), graduation and direct-pool (15-day tapes, covering the "aged 24 h to 14 days" universe U1).
   - An hourly census of every mint that traded, sampled or not.
4. **Checks** (see Quality), on the first finished slice (2026-10-02 09:07 to 21:49 UTC):
   - PumpSwap reserves rebuilt from events equal the vault balances recorded on-chain after the transaction in 230,784 of 230,784 checks.
   - Bonding-curve real reserves rebuild exactly in 145,213 of 145,213 trade pairs.
   - 51 of 51 idle curves and pools equal their live on-chain accounts.
5. **Throughput limit:** the archive throttles heavy users (429 after ~0.6 TB in an hour from one machine). The scan runs on one polite lane only (supervisor ruling): one GitHub Actions job at a time, at most 80 MB/s, stopping on any 429 and waiting at least an hour. 45 chain days take about 4 to 5 days of wall time at that pace.
6. **Things the backtester must handle:**
   - Mayhem-mode curves re-price their virtual reserves inside the program, so use the event's reserves, not a local recomputation.
   - On 2026-10-02 pump.fun upgraded both programs without publishing a new IDL: trade events gained one 8-byte trailing field, and new event types appeared. Both are kept raw (see Limits).
   - Some curves are quoted in a token other than SOL (see Limits).

## Sources

Tested on 2026-10-03 from the build container. No accounts, keys or sign-ups were used.

| Source | Covers | History depth (tested) | Completeness | Limits, cost, terms | Account |
|---|---|---|---|---|---|
| **Old Faithful** (`files.old-faithful.net`) | Whole ledger: every block, transaction and meta (logs, inner instructions, balances) | Epochs 1030 to 1047 present (0.72 to 0.98 TB each, about 1.4 days per epoch). Epoch 1048 (in progress) not yet published. | Complete | Free. [docs.old-faithful.net](https://docs.old-faithful.net): "Triton provides a full copy of this ledger at https://files.old-faithful.net that you can download". No usage terms published. Measured: 100 range requests/s sustained without errors, 429 only after bursts of ~200/s; ~310 MB/s with 16 parallel streams. | No |
| Public RPC `api.mainnet-beta.solana.com` | Every transaction | `getFirstAvailableBlock` = 0. `getBlock` worked back to 2026-01-09; `getTransaction` to 2026-08-18 | Complete, but `getSignaturesForAddress` on the pump program pages 1,000 signatures per ~3 s of activity | Headers: `x-ratelimit-method-limit: 10` per 10 s for `getTransaction` and `getSignaturesForAddress`, 6 for `getBlock`. Also rejects version-1 transactions unless `maxSupportedTransactionVersion: 1`. Free; rate limited. | No |
| publicnode RPC | Every transaction | About 1 day (`getFirstAvailableBlock` 452,650,914) | Recent only | Free | No |
| GeckoTerminal API v2 | 1-minute and 1-hour OHLCV per pool; last 300 trades | 180 days of candles (older: HTTP 401, paid plan) | Candles, not trades | [Terms](https://www.coingecko.com/en/api_terms) forbid redistribution and storing or deriving data. Used only for on-the-fly price comparison; nothing stored. | No (180 days) |
| DexScreener API | Current pair and token snapshot | None | No history (candle and trade endpoints 404) | Terms page returned 403 (not verified) | No |
| Jupiter lite-api | Current price and quote | None | No history | Keyless 0.5 req/s ([docs](https://developers.jup.ag/docs/api-setup)) | No (keyless) |
| Google BigQuery Solana public dataset | Listed by Google as community-maintained | Not verifiable here | Unverified (tables, freshness, logs) | Needs a Google Cloud project | **Yes** |
| HF `cryptodata/pumpfun-dataset-light` | pump.fun curve trades | 2026-07-20 to 08-02 | Every TradeEvent per its card; "complete capture not independently established" | CC-BY-4.0, 9.97 GB | No |
| Zenodo 22306254 | pump.fun curve trades | 2026-04-28 to 05-29 | 20.7M trades | CC-BY-4.0, 24 GB | No |
| HF `Slinky21/Pumpfun_v2_dataset` | pump.fun events from a live collector | 2026-08-10 to 09-18 | Unknown | No licence: not usable | No |
| HF `loopholetape/pumpfun-launches` | Launch-level outcomes | 2026-08-31 to 09-26 | Not trades; older rows miss ~48% of buys per its card | CC-BY-4.0 | No |
| HF `biznus1/pumpswap-historical-trades`, datastore.sh | PumpSwap trades | Periods in 2025 and Jan 2026 | Per swap | Paid | Paid |
| MELT (`git-disl/MELT`) | 41k launches, curve plus Raydium (not PumpSwap) | Range not stated | Transaction level | CC BY-NC 4.0 (non-commercial) | No |
| SolRPDS (`DeFiLab/SolRPDS`) | Rug-pull labels | 2021 to Nov 2024 | Labels | CC-BY-4.0 | No |

**Would need an account the owner creates** (none used): a Google Cloud project (BigQuery), the GeckoTerminal Analyst plan (beyond 180 days), a Jupiter API key, any paid RPC or Yellowstone gRPC provider, and datastore.sh or Gumroad for the paid PumpSwap sets.

**Could not verify:** BigQuery tables, freshness and log coverage; DexScreener terms; GeckoTerminal's exact rate limits; the public RPC terms page; Old Faithful's host terms (none published); MELT's date range; the completeness of any third-party dump.

## How the scanner works

Code: `research/historical/scanner` (Go 1.24). Tests: `go test ./...` in that folder. QA: `research/historical/qa/check.mjs` (Node 22, no dependencies).

1. **Locate:** the CAR file is probed directly; no index files are needed. A window is read at an offset, and the reader resynchronises on a section whose data hashes to its CID (three in a row). It then walks to the next block node. A binary search on offsets finds where any slot range starts and ends. Nodes of a block come before its block node, so a range runs from just after the previous block's node to just after the last wanted block's node.
   - Boundaries are cached per epoch (CAR files are immutable, named by their root CID).
   - On the units compared, the byte ranges are identical to those given by the archive's own slot-to-CID and CID-to-offset indexes.
2. **Stream:** the range is fetched in 16 MB chunks, in parallel and in order, over HTTP/1.1 (one HTTP/2 connection capped throughput at ~25 MB/s). Limits:
   - 40 requests/s and a byte cap (`-max-mbps`) per process;
   - the cap must be above 0 and at most 80 MB/s (1 MB = 10^6 bytes); anything else is refused (exit 2);
   - a 429, or a 503 with `Retry-After`, stops the run by default (exit 75). The back-off end, max(1 h, the largest `Retry-After`), is persisted in `<out>/archive-429.state` and every 429 is logged in `<out>/429.log`, so any later run or rescan on that directory sleeps it out before its first request. `-on-429 pause` instead waits the same back-off inside the process, at most 6 h in total;
   - `-parallel 2 × -dl 6` (the CI setting) means up to 12 connections, all under the one process-wide byte and request limit.

   Every streamed node is checked against its CID (sha256).
3. **Filter:** vote transactions are skipped: every top-level instruction calls the vote program (or compute budget) and nothing is loaded from lookup tables; a byte search is only the fast pre-filter. A transaction is kept if its message names either program, or (for versioned messages with lookup tables) its meta names either program. **53% of pump and PumpSwap transactions reach the programs only through lookup tables**, so a static filter would miss them. A transaction without meta is counted as a decode failure (`missing_meta`), never skipped silently, and so is a meta in an unexpected format (`legacy_meta`).
4. **Decode:**
   - Events are Anchor self-CPI instructions (`e445a52e51cb9a1d` tag plus 8-byte discriminator) issued by the program itself, decoded with the IDLs in `scanner/idl/` (copied from [pump-fun/pump-public-docs](https://github.com/pump-fun/pump-public-docs) at `cb188ce`, 2026-09-29).
   - Older events are prefixes of the current layout and decode cleanly. Bytes beyond the IDL are kept in `extra_hex`. Unknown discriminators are written raw as `Unknown` events.
   - Failed transactions emit no events; each failed trade transaction of a sampled mint is kept as one `failed` row plus its raw record, and counted per mint and hour in `failed_hourly`. The archive keeps inner instructions for failed transactions (checked on a failed Jupiter→pump swap, slot 452,700,001, error 0x1771: 22 inner instructions in 3 groups), so failed aggregator→pump swaps are found too.
5. **Cross-check columns:** for the last trade of a curve or pool in a transaction, the row also carries the balances the validator recorded after that transaction:
   - curve: lamports, base token account, quote token account;
   - pool: both vault token accounts.
6. **Units and resume:**
   - Work is split into fixed units of 4,500 slots aligned to the epoch start.
   - A unit is written to `<unit>.tmp` and renamed only when:
     - every byte of its range was read;
     - its first block is the first block at or after its start slot;
     - every block names the previous block as its parent.

     So a killed run never leaves a half-written unit that looks finished.
   - A restart skips finished units and redoes unfinished ones from scratch. Proof: `research/historical/evidence/resume-proof.md`, with 18 of 18 files identical after a kill mid-unit and a resume.
   - An exclusive lock file stops two runs writing the same directory.
7. **Completeness:** the finaliser walks the block rows of every unit in slot order and fails if any block's parent is not the previous scanned block. A dropped block would break that chain, because a block's parent is the previous block of the finalised chain.
8. **Speed and the archive's limit:**
   - About 138 blocks/s on the 4-core build container (CPU-bound), at 1.65 MB per block, so about 230 MB/s.
   - One chain day is about 324,000 blocks (0.267 s slots in October 2026), about 600 GB of reads.
   - After about an hour at that rate (~0.6 TB), the archive answered every request from this machine with 429 "Your account has made too many requests; try again later". The limit is per client and unpublished. So the scan runs slowly on one lane (`-max-mbps`, at most 80) and backs off for at least an hour after any 429; the supervisor ruled out more machines or addresses.

## Universe and sampling rule

Fixed before looking at any outcome:

- **Hash:** `h(mint) = first 8 bytes of sha256(mint pubkey bytes), big-endian, / 2^64`, a number in [0, 1). It depends only on the mint address, which is fixed when the token is created.
- **Retention in the units** (`retention` = `curve-all,canonical-all,sample`, recorded per unit; finalize refuses mixing): every bonding-curve trade of every mint; every trade in a canonical PumpSwap pool (the pool the pump program's migrate instruction creates: the pump_amm PDA of `["pool", u16 0, creator, base_mint, quote_mint]` with creator = the pump PDA `["pool-authority", base_mint]`, decided from the trade itself and tested against real migrations); every event of every mint except per-user bookkeeping (per-mint events that do not move reserves were sample-only before this retention); and, for mints with `h < s` (the scanner's `-sample`, 0.05 in CI), also their trades in other pools, their failed trades and their raw records. Measured on 14.4 h of 2026-10-02: about 25.5M trades a day (curve 5.1M, PumpSwap 20.3M), canonical pools at least 46% of them; about 51k creations and 1,270 graduations a day. Why: the U1 and U2 universes are graduates, and at a 5% sample neither the 300 holdout trades of pre-funding item 6 nor H14's deployer history (prior mints' trades within 24 h of creation) were reachable. Keeping every curve and canonical-pool trade covers both, and it never depends on another day or on the future.
- **Dataset universes** (defaults, recorded in `manifest.json`):
  - `launch`: the token's `CreateEvent` is inside the scanned coverage (`launch_rate` 1.0 by default: every mint). Tape: creation to creation + 72 h.
  - `grad`: the token's `CompletePumpAmmMigrationEvent` is inside the coverage (`grad_rate` 1.0: every graduate). Tape: graduation to graduation + 15 days.
  - `direct_pool`: a PumpSwap pool created outside a migration is inside the coverage and `h(base mint) < 0.05` (non-canonical pools are kept only for sampled mints, so this rate cannot exceed the units' sample). Tape: pool creation to + 15 days.
  - Rejected alternative (recorded for review): keeping a graduate's curve tape through a keep-list of mints that graduate on later-scanned days. It is not look-ahead for decisions made after graduation, because the history is public then. But a row's presence would depend on the future, which is look-ahead the moment anything (a curve-phase strategy, a feature computed before graduation, a universe count) reads it as information. A day's content would also depend on which other days were scanned first, and same-day graduates would be missing. Keeping every curve trade has none of these problems.
  - The same hash threshold nests the universes: every sampled launch that graduates is also in `grad`.
  - A mint's tape is the union of its intervals (column `tapes` in `mints.csv`, `kind:from-to` joined by `|`), never the span between them. A row before a graduation exists only when the launch tape covers it, exactly as for every other launch-sampled mint, so a row's presence never reveals a later graduation. `tape_from`/`tape_to` are only the outer bounds. Per-mint events that do not move reserves follow the same tape rule.
- **Fixed-age universe** ("every token that is 24 h old with at least the configured liquidity"): computed at backtest time from the hourly census, which has every traded mint's closing reserves each hour. Full tapes exist for the sampled 5% of those tokens.
- **Use with care:**
  - Curve-phase strategies use `launch`; `grad` tapes start at graduation.
  - Lead-in: the dataset build requires 14 days of gap-free coverage before the window (`finalize -lead-in-days 14`, recorded as `window.lead_in_days`) and fails otherwise; a day without it would be flagged `warm_up`, and the strict QA fails on any such day.
  - Tapes cut by the end of coverage are flagged `censored` in `mints.csv`.

## Dataset layout

```
manifest.json                coverage per day, row counts, sha256 and size of every file, rules, unit list
mints-000.csv.zst            every mint created, graduated or given a direct pool in coverage: hash, times, pool, universes, tape bounds, censoring
days/YYYY-MM-DD/
  curve_trades-NNN.csv.zst   bonding-curve trades of universe mints, in (slot, tx_idx, ev_idx) order
  amm_trades-NNN.csv.zst     PumpSwap trades of universe mints
  events-NNN.jsonl.zst       creates, completes, migrations, pool creations, deposits, withdrawals, boosts, account extensions, parameter changes, unknown events
  failed-NNN.csv.zst         failed trade transactions of universe mints, one row each (schema 2)
  failed_hourly-NNN.csv.zst  the same per hour (count, distinct signers, most common error)
  raw-NNN.jsonl.zst          raw transaction records of every pump/PumpSwap transaction touching a universe mint (schema 2)
  agg_hourly-NNN.csv.zst     every mint that traded: buys, sells, volumes, open/close reserves, high/low price per hour
  blocks-NNN.csv.zst         every block: slot, time, parent, transaction counts, pump transactions ok and failed
  movements-NNN.csv.zst      token movements outside pump/PumpSwap swaps (transfers, burns, mint-to), owner-resolved
  delegations-NNN.csv.zst    token-account delegates and authority changes (approve, approve_checked, revoke, set_owner, set_close_authority), owner-resolved
  volume_hours-NNN.csv.zst   regime volume per UTC hour (24 rows: hour_start_ms, lamports, covered), also published as release data-volume-DAY
movement_coverage-NNN.csv.zst  coverage notes per mint and unit: pump_transactions, unresolved (slot, transaction, reason: transfer_fee, confidential_transfer, owner_change, account_reused, empty_owner_net, swap_owner_unknown), empty_owner (count), and the lead-in no_movements row
```

All files are RFC 4180 CSV (or JSON lines) compressed with zstd. Node 22 reads them with `zlib.zstdDecompressSync`. Files rotate after 1,900 MiB of uncompressed data (counted before compression, so the output is deterministic and every part is under the 2 GiB release asset limit). `manifest.json` carries no timestamp: finalize run twice on the same units gives byte-identical files (tested). Amounts are raw integer units (lamports, token base units). `signer` is empty when equal to `user`, and the event `timestamp` is empty when equal to `block_time`.

Key columns:

- **Curve trade:** reserves are **after** the trade (TradeEvent). `virtual_*` are the AMM reserves used for pricing; `real_*` are the reserves held by the curve. Fees: `fee`, `creator_fee`, `cashback`, `buyback_fee`, `holder_rewards`. `quote_mint` is the system program id for SOL curves.
- **PumpSwap trade:**
  - Reserves are **before** the trade.
  - Price uses `pool_quote + virtual_quote_reserves` (signed; PumpSwap allows negative values since 2026-09-30).
  - After the trade: base changes by `base_amount`, and quote by `quote_amount_lp_adjusted` (`quote_amount_in_with_lp_fee` for buys, `quote_amount_out_without_lp_fee` for sells). Protocol, creator, cashback and buyback fees leave the pool; the LP fee stays.
  - A boost buy-and-burn is an ordinary `BuyEvent` (the bought tokens are burned outside the pool), followed by a `BoostBuyAndBurnEvent`.
  - `InitBoostEvent` moves quote from the vault into `virtual_quote_reserves` (`real_quote_reserves_after` is the new vault balance).
- **Provenance:** `(slot, tx_idx)` locates the transaction in the archive's block, and `signature` locates it in any RPC. `(slot, tx_idx, ev_idx)` is unique and strictly increasing within every file; the finaliser fails otherwise.
- **Schema 2 additions** (`manifest.schema` = 2):
  - Every event row has `outer_ix` (top-level instruction) and `inner_ix` (position in that instruction's inner list). These give the ordering key `(slot, tx_idx, outer_ix, inner_ix)` agreed with the chain decoders.
  - Trade rows carry `jito_tip`: lamports the transaction moved into the 8 Jito tip accounts, for bundle detection.
- **Schema 3 additions** (`manifest.schema` = 3): curve and PumpSwap trade rows end with `user_token_account` and `user_token_owner`.
  - `user_token_account` is the user's base-token account of the instruction that emitted the event: pump `buy`, `sell` and `buy_exact_sol_in` account 5 (`associated_user`), pump `buy_v2`, `sell_v2` and `buy_exact_quote_in_v2` account 14 (`associated_base_user`), PumpSwap `buy`, `sell` and `buy_exact_quote_in` account 5 (`user_base_token_account`). Empty for any other emitter; `boost_buy_and_burn` has no user account (it burns what it buys).
  - `user_token_owner` is that account's owner: the post-transaction token balances, else the pre-transaction ones (an account the swap closes), else the owner given by `InitializeAccount`, `InitializeAccount2` or `InitializeAccount3` in the same transaction, else empty.
  - **A swap credits or debits `user_token_owner`, never `user` or the signer.** They differ when a wallet buys into another wallet's account, when a delegate sells from the owner's account, and when a router signs. An empty owner (except a boost buy-and-burn) marks the mint `unresolved` / `swap_owner_unknown` for that transaction in `movement_coverage`.
  - QA counts trades whose `user_token_owner` differs from `user`, and fails a day with a trade row missing either column, or with an empty owner and an account but no `swap_owner_unknown` mark for its transaction. Parity re-derives both columns from every raw record (account positions read from the scanner's IDL by account name).
- **Token movements** (`movements-NNN.csv.zst`): SPL Token and Token-2022 `Transfer`, `TransferChecked`, `Burn`, `BurnChecked`, `MintTo` and `MintToChecked` that do not run inside a pump or PumpSwap instruction (by stack height; those swaps and creates are already in the trade and event rows). Columns: slot, block_time, tx_idx, outer_ix, inner_ix (empty for a top-level instruction), mint, kind (`transfer`, `burn`, `mint`), from_owner, to_owner, amount, from_account, to_account. Owners come from the transaction's pre and post token balances, else from the instruction that initialised the account in the transaction (below); an account still unresolved leaves its owner empty. Movements inside other venues' swaps are kept, because they change ownership. Coverage:
  - mints ending in "pump": every movement in every successful transaction (complete);
  - other mints: only movements in transactions that carry a pump or PumpSwap event of that mint. A unit cannot know in advance which other mints will be active, and keeping every Solana token transfer until the unit closes is far too large. `movement_coverage` lists these mints with scope `pump_transactions` and the unit's slot range, and the backtest treats their ownership outside those rows as unresolved (the same as live: unknown is never clean).
  - Instructions the table does not decode never fail a day; they mark the mint's ownership as unresolved from that slot in `movement_coverage` (scope `unresolved`, with the first slot, the reason and a count). The reasons are Token-2022 `TransferCheckedWithFee` (`transfer_fee`), `SetAuthority` of an account owner (`owner_change`), and one account index holding two mints in a transaction (`account_reused`). Rows whose owner cannot be resolved (an account opened and closed inside one transaction) keep an empty owner and are counted per mint (scope `empty_owner`); QA checks that this count matches the empty-owner rows. Every decoded class keeps zero tolerance.
  - Temp token accounts opened inside a transaction (absent from the token balances) take their owner from `InitializeAccount`, `InitializeAccount2` or `InitializeAccount3` in the same transaction, at any depth. If an empty owner still remains and its movements do not net to zero for a mint in that transaction (a temp account on a swap leg whose other leg runs inside pump), the mint is marked `unresolved` / `empty_owner_net` for that transaction.
  - **Holder rebuild, without double counting:** use trade rows for swaps (the trade's `user_token_owner` gains or loses `token_amount` / `base_amount`, and the curve or pool the other side; never `user` or the signer) and movement rows for everything else (`from_owner` loses, `to_owner` gains; a burn only loses, a mint only gains). Movement rows never contain a pump or PumpSwap swap leg, because those run inside the program and are skipped. A leg through a temp account owned by the trader shows as a movement from the trader to the trader, which nets to zero. Rows with an empty owner are left out, and their transactions are marked (`empty_owner_net`, `swap_owner_unknown`). From a mint's first `unresolved` transaction on, its ownership is unresolved.
- **Regime volume per hour** (`volume_hours-NNN.csv.zst`, DATA-1c; §6.4 and DECISIONS "Regime volume from the chain"): 24 rows per UTC day, `hour_start_ms`, `lamports`, `covered` (1 or 0), the shape FACTS-1's `read:chain-volume-hour` reads.
  - `lamports` is SOL-quoted volume only, quote side, buys plus sells: pump curve trades quoted in SOL (`quote_mint` empty, the system program or WSOL) plus trades in canonical PumpSwap pools with a WSOL quote (`quote_amount`). Non-SOL-quoted volume is excluded, not converted. The census counts `sol_amount` for empty or WSOL `quote_mint` and `quote_amount` for the system program; the cross-check uses `sol_amount` for every SOL curve, so a divergence there fails the day (none on 2026-10-01: 43,332 of 43,332 equal).
  - It comes from the hourly census, which counts every trade before retention.
  - `covered` is 1 only when the whole hour lies inside the gap-free, parent-linked scanned coverage. An uncovered hour is unknown, never zero, so `dailyChainVolume` leaves its day out.
  - Check: `qa/volume.ts` re-derives every hour from the units' kept rows and requires an exact match. Those rows hold every curve trade and every canonical pool trade; the canonical pool is derived with the shared chain code.
  - On 2026-10-01 (20-min unit), 24 of 24 hours matched, 39,018 SOL in total.
  - Each published day also gets release `data-volume-DAY`, created in one call and never edited, with `volume-hours-DAY.csv` and `volume-check-DAY.json`. The day release keeps its asset set.
  - `mode=volume` back-fills days already published, from their own units (`ci/volume-day.sh`, no archive access), on its own concurrency group.
  - The regime reads day D−3 in live and backtest alike; if D−3 is missing, volume is unknown and the regime is off (supervisor ruling). Measured archive lag: an epoch is ready 0.29–0.60 days after it ends, so a day is complete 0.4–1.9 days after it ends.
- **Delegations** (`delegations-NNN.csv.zst`, GATE-1e: a delegate or a new close authority is control over a holder's tokens): one row per SPL Token or Token-2022 `Approve` and `ApproveChecked` (kinds `approve` and `approve_checked`; `authority` = the delegate, `amount` = the approved amount), `Revoke` (`revoke`), and `SetAuthority` of type `AccountOwner` (`set_owner`) or `CloseAccount` (`set_close_authority`; `authority` = the new one, empty when cleared), outside pump and PumpSwap instructions (by stack height). Columns: slot, block_time, tx_idx, outer_ix, inner_ix, mint, kind, account, owner, authority, amount. `owner` is the account's owner from the token balances, else from the `InitializeAccount*` that opened it in the transaction (which also gives the mint), never the signer. Coverage is that of movements: every mint ending in "pump" in every successful transaction, other mints only inside their pump transactions (`movement_coverage` scope `pump_transactions`). Mint-level authorities (mint and freeze) are not here; they belong to the mint read (H2). Without this table the backtest saw delegations only in transactions kept for other reasons and under-counted control, the permissive direction. QA fails a day with no delegations file, a malformed row, or a row of another mint outside its coverage; parity re-derives every row of a transaction with a raw record.
  - Lead-in days carry no movements: assembly reads only their events, stats and blocks. So holder ownership at a window's start is unresolved until movements begin, and the dataset's `movement_coverage` has a row with mint `*`, scope `no_movements` and the lead-in slot range.
  - Measured on the schema-2 unit: about 2.1M movement rows a day at about 49 B (≈ 100 MB a day). Movements are kept for every mint the units keep, with no tape filter, so a row's presence never depends on the future.
- **Raw records** (`raw-NNN.jsonl.zst`, schema 2): one JSON line per transaction, successful or failed, that touches a hash-sampled mint, plus every create transaction (about 51k a day, about 50 MB; mint authority and extensions, and DEC-1 parity of every `CreateEvent` row, which the deployer index is seeded from) and every migration transaction, which also creates the canonical pool (about 1,270 a day; LP mint, LP burn and pool setup of every graduate), whatever the mint. A sampled mint is one that appears in the transaction's token balances or events. Two kinds are included:
  - every such pump or PumpSwap transaction;
  - transactions outside those programs whose invoked programs are all basic token programs (System, Compute Budget, SPL Token, Token-2022, Associated Token, Memo), which are plain transfers, burns, mint-to, authority and extension changes.

  Swaps of universe mints on other venues are counted per unit (`other_venue_txs`), not stored. They would add about 2.5× to the raw records, and Zeroed trades only pump and PumpSwap. Fields:
  - `slot`, `blockTime`, `txIndex`, `signature`, and `transaction` (base64 wire bytes: legacy, v0, or v1 per SIMD-0385, where the signatures follow the message);
  - `err`: null, or `{"hex": ...}` holding the TransactionError exactly as the validator stored it (bincode, hex). It is not the RPC JSON form; a non-null value means the transaction failed. `mints` lists the sampled mints it touches;
  - `meta`: fee, computeUnitsConsumed, pre/post balances, loadedAddresses (base58), innerInstructions, logMessages, pre/post token balances. `innerInstructions` is `[]` when the transaction recorded none and `null` only when the archive marks them as not recorded (`inner_instructions_none`); `logMessages` likewise (`log_messages_none`). Units written before this rule (scanner revisions up to fb9e15d) wrote `null` for a transaction with no inner instructions; parity accepts such a record only when its complete logs show no inner call. Inner instruction `data` is **base64**, unlike RPC's base58, so readers must not reuse `recordFromRpc`; `packages/backtest/src/dataset/parity.ts` has the converter to DEC-1's `TransactionRecord`.

  This is the input of the shared decoder (`transactionEvents`), so live and backtest decode with the same code.
- **Decoder parity:** the CSV and event rows come from the scanner's own IDL decoder. `node --no-warnings research/historical/qa/parity.ts <dataset>` decodes every raw record with DEC-1's `transactionEvents` and joins rows on `(slot, tx_idx, outer_ix, inner_ix)`. A day fails on any of these: a value or event name that differs; a decoded event matched by two rows (any kinds); an undecodable record; a kept event without a row (only the dropped event kinds are exempt; per-mint sampled-only events need a row when their mint is in its tape); a trade, failed or in-tape event row without its raw record; a successful pump or PumpSwap record whose inner instructions are null unless its complete logs show no inner call. Events the shared decoder does not name in full and `Unknown` events are compared byte for byte (`data_hex`). Failed rows must match their failed raw record. On the schema-2 test unit, 544 of 544 rows match (318 event and trade rows, 226 failed rows). The backtest reads the CSVs, with this proof that they equal DEC-1.

## Decisions

- **Old Faithful over RPC and third-party dumps:** it is the only free, complete and bulk source (Sources). Published dumps end before September 2026, lack PumpSwap, are unlicensed or non-commercial, or are paid.
- **Stream whole blocks rather than look up single transactions:** single-transaction lookups through the archive's indexes take about 4.5 s each (several dependent range reads). Discovering signatures needs the public RPC (~1 call per second). And 53% of relevant transactions are only visible through lookup tables. Whole-block streaming gets every transaction for the price of bandwidth.
- **Hash sample, not "interesting" tokens:** selection by `sha256(mint)` cannot depend on any outcome. CI scans a 5% sample (the size limit); hourly census rows keep every mint counted.
- **No AGPL code:** yellowstone-faithful's archive tools default to AGPL-3.0, and even its Apache-2.0 packages import AGPL ones. The scanner instead reads the archive with its own small decoders (CAR sections, DAG-CBOR nodes, protobuf metas) and needs no index files. Remaining dependencies are solana-go, gagliardetto/binary, klauspost/compress and mr-tron/base58.
- **Release assets over a git branch for the full dataset:** a data branch would add gigabytes to every default clone, so the workflow publishes release assets: one release per scanned day and one per assembled window.

## Point in time: what a live bot would have seen

The backtest replays rows strictly in `(slot, tx_idx, outer_ix, inner_ix)` order through a simulated clock (CLAUDE.md: backtests are blind and reproduce live).

- **Known at the transaction's slot:** every value in a trade, event, failed or raw row. These are on-chain facts of that transaction: amounts, reserves, fees, the balances after it (`chain_*`), the event's own fields, and the error of a failed transaction.
  - A live bot learns them only once the block is observed: about one slot after `block_time` at processed commitment, later at confirmed.
  - The replay should add that latency rather than act at the same slot.
- **Known at creation:** `CreateEvent` fields, including name, symbol and URI. The metadata JSON behind the URI is **not** in the dataset, nor are holder counts or social data. Anything like that, fetched later, would be look-ahead.
- **Known only after the fact; never use as an input:**
  - `mints.csv`: graduation time, `tape_to`, `censored` and universe flags are bookkeeping and labels.
  - `agg_hourly` rows: usable only after their hour ends (they aggregate the whole hour).
  - `manifest.json` counts and the upgrade boundary.
  - The engine should load these only for universe selection, which is fixed by the hash, or for evaluation.
- **Fixed before outcomes:** the universe hash depends only on the mint address. The `grad` universe is chosen by the graduation event itself, which is observable when it happens. Do not use its pre-graduation tape for curve-phase decisions.
- **Off-chain series:** none are in this dataset (SOL/USD comes from BT-1's Coinbase copy).

## Running it on GitHub Actions (one lane)

`.github/workflows/data-scan.yml`, approved by the supervisor as owner of `.github`, runs the scanner on a single polite lane. No other lane, machine or address is used.
- **ARCHIVE-SAFE (owner order, 2026-10-05).** After the block of 3–4 Oct, the archive is read carefully, one day per block. The limits live in one file, `ci/archive-limits.conf`; a rate published by Triton replaces them there:
  - at most 40 MB/s, refused above that by data-scan's plan, `scan-day.sh` and `check-day.sh`;
  - at most 1 unit × 4 chunk downloads, so 4 connections (before: 2 × 6 = 12);
  - at most 10 requests/s: the scanner's request cap (`scanner/archive.go` `reqLimiter`), which archive-check reads; above 10/s it logs a served answer and dispatches nothing (fail closed). The scanner itself also refuses more than 40 MB/s. These Go limits moved the scanner revision, so they merged only after the 09-21 Helius chain had ended;
  - any 429, 403 or 503 (with or without Retry-After) stops the scanner (never retried), holds a back-off of at least 3 h and exits 4 (not resumable), so no chained run resumes the archive; only a later served archive-check does;
  - archive-check dispatches 1 day per served check (every 3 h).
  The 80 MB/s figures below are history.
- Manual dispatch only, one concurrency group and `max-parallel: 1`, newest day first, at most 80 MB/s (refused in code above that).
- `ci/scan-day.sh` first sleeps out any persisted back-off, then scans. On a 429 the scanner stops and keeps finished units; the script waits until the persisted back-off end (at least 1 h) and resumes on the same lane. Every 429 and back-off goes to the job summary. The 300 min budget covers scanning and back-off waits: at its end the scanner is interrupted (units are written atomically, so only an unfinished unit is redone), and a back-off that does not fit is slept out as far as the budget allows. QA, packaging and publishing start only when 45 min remain before the 355 min job timeout (`ci/time-left.sh`), so a late finish stops resumably instead of being cancelled, and the next run redoes that phase; a 429 during the determinism rescan stops resumably the same way. Each phase's duration (finalize, QA, parity, determinism, package, artifact upload, publish) is logged in the summary, to set the 45 min from real days. Either way the day saves its progress and stops resumably (exit 75, marked by a `resume-DAY` artifact only when the save succeeded; a failed save stops the chain for review; the entry's size is logged in the summary); fail-fast cancels the days queued behind it, and the `continue` job dispatches the same days again (`chain` input, at most 12 chained runs). Published days are skipped before any archive read, so the next run resumes the stopped day from its cache with no manual step, on the same single lane (it waits in the concurrency group until the run before it ends). Any other failure (QA, parity, determinism, scanner error, publish) stops the chain for review.
- `ci/check-day.sh` finalizes the day alone (`-lead-in-days 0`), runs `qa/check.mjs --strict --live 30 --lead-in-days 0`, the decoder parity check and a determinism rescan of one unit (which also waits out a persisted back-off), then packs the units as tar parts under 1.9 GiB.
- As soon as a day passes those checks, its own scan job publishes it (`ci/publish-day.sh`) as release `data-day-YYYY-MM-DD` with the tar parts, QA report, manifest, parity result and `SHA256SUMS-<day>`, so each day is usable about 2.5 h after its job starts. The write token reaches only that step; every checkout uses `persist-credentials: false`. The release is created with all its files in one call, and the step runs in a clean environment: the shell starts as `/usr/bin/env -u BASH_ENV -u ENV /usr/bin/bash --noprofile --norc`, and the script runs under `env -i` with a fixed PATH and gh by absolute path. An existing day release is never edited. It is judged only from the release itself: not a draft, every asset fully uploaded, and asset names equal to the expected set (the part count from its own `SHA256SUMS-<day>`). A complete release is accepted; anything else fails the step until someone deletes it. A day that is already published and complete is skipped at the start of its job, before any archive read (`publish-day.sh --check`). Days on or after 2026-10-02 (the regime boundary) are refused by the plan job and by `publish-day.sh`. Each unit records the scanner revision: the git tree of `research/historical/scanner` plus the Go version (`ci/scanner-rev.sh`, which fails on any other toolchain). Cached units of another revision are rescanned, so a day never mixes revisions.
- `mode=assemble` (`ci/assemble.sh FROM TO`) builds a dataset window of at most 3 days (`MAX_WINDOW_DAYS`). It needs the 14 lead-in days before FROM and every window day as releases, and fails before downloading if any is missing; no earlier day is read. Lead-in days download only their small `events-DAY.tar` (each unit's events, stats and block rows), and window days download their full tar parts. One day at a time it checks free disk, downloads, verifies and extracts, deletes the downloads and moves the units in. A unit crossing midnight appears in two days: its `*.zst` files must have equal sha256, and its stats.json identity fields (epoch, slots, blocks, schema, revision) must match, or the run fails. Then finalize (`-lead-in-days 14`, one scanner revision unless `allow_revisions` lists more), strict QA, parity, and release `data-<from>-<to>`, built by moving files (at most 990 assets). Because lead-in days bring no trade rows, a mint created in the lead-in has no trades before the window starts. Tape and trade-history features at a window's start therefore see only in-window trades; BT-2 takes H14's rug half from RUG-1c's cached supplement.
- Caveats: the job timeout (355 min) lies 55 min past the scan budget, so it is a backstop only; a job it cancels does not chain, days published before it stay published, and that day resumes from its cached units when dispatched again. The Actions cache is 10 GB per repository with least-recently-used eviction, so a day's progress can be evicted and the day rescanned.
- **Runner and storage limits** (checked 2026-10-04):
  - Runner: the repository is public, so `ubuntu-latest` has 4 CPUs, 16 GB of memory and a documented 14 GB of SSD ([GitHub docs](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)). The documents say nothing about `/mnt`, so the real free space is logged in each day's job summary (before QA and after packaging), and the assemble guards report it.
  - Disk in a scan job: everything (units, QA dataset, tar parts) lives under `$RUNNER_TEMP/work`, which points at `/mnt/work` when the runner has that volume. A guard (`ci/disk-guard.sh`) fails the day before any archive read if less than 24 GB is free: units at the high estimate (13 GB), plus the QA dataset (6 GB), plus 5 GB. Further guards run before finalize (units + 5 GB) and before packaging (7 GB). Packaging uses `tar --remove-files`, so the disk holds the units or their tar parts, never both; the QA dataset and the determinism rescan are deleted first. A day release holds the tar parts, `events-DAY.tar`, the QA report, the manifest, the parity report and `SHA256SUMS-DAY`.
  - Actions cache (10 GB per repository, least recently used evicted): a day's units are one cache entry of about 6.4 to 8.5 GB. A running day restores its own entry at its start and works locally after that, so eviction cannot break it. A mid-day cancel resumes from the entry the cancelled job saved. Only one day runs at a time, so the next save is that same day's. If a day's units exceed the 10 GB entry limit (possible at the top of the ±50% range), the save is skipped, the job says so, and a cancel then costs a full rescan of that day. The back-off entries are a few bytes. The `-qa` entry is saved only when QA fails, and it replaces that day's own entry.
  - Release upload: tar parts are 1,900 MiB (1.86 GiB, under the 2 GiB asset limit). `gh release create` uploads the parts one by one in a single call, with no total size limit. About 8 GB a day should take a few minutes at the runner's upload rate. This is not measured yet: the first published day will give it.

- Expected pace: about 2 to 2.5 h per chain day at 80 MB/s (about 600 GB of reads), so 45 days take about 4 to 5 days of wall time, longer with back-offs.
- **Window plan** (supervisor plan, 2026-10-03: 60 decision days if UPG-1's regime check of July and August passes; 1 Oct is the newest complete day, because epoch 1048, from 2 Oct 21:49 UTC, was not published on 2026-10-03, and 2 Oct is the regime boundary):
  - decision days: 2026-08-03 to 2026-10-01, assembled in windows of at most 3 days (`MAX_WINDOW_DAYS`), each with its own 14 lead-in days;
  - lead-in: 2026-07-20 to 2026-08-02. The archive has every epoch from 980 to 1047 (CAR report, 2026-10-03), which covers it;
  - scan order (supervisor, 2026-10-04): pre-holdout days first, newest first within them: run 1 = 2026-09-21 back to 08-29 (practice days after B4 and their 14-day look-back), then 08-28 back to 07-20, then the holdout days 10-01 back to 09-22, then forward days as published. See DECISIONS, morning rulings.
- **Sizes against GitHub's release limits** (each asset under 2 GiB, at most 1,000 assets per release, no limit on total size or bandwidth; [GitHub docs](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)):
  - Scanner units: about 6.4 to 8.5 GB per chain day. That is about 3.3 to 3.7 GB for the 5% sample with its raw records (extrapolated from one measured 446-block unit) plus about 3.1 GB of rows (curve 0.92 GB, canonical pools 2.2 to 3.8 GB at about 185 B per row). It is uncertain by about ±50% with the hour of day. A day release holds about 4 or 5 tar parts plus 6 small files.
  - Assembly disk: a 3-day window extracts about 20 to 26 GB of units plus the much smaller events-only lead-in files; the assembled dataset is about 4 to 6 GB a day. The free-space guards (before each day, and 2 × units + 10 GB before finalize) stop the run before the disk fills; the runner's free space on `/mnt` was not measured here.

- **Archive check** (`archive-check.yml`, every 3 hours): while the archive refuses our scanner, one 64-byte request with the scanner's own User-Agent asks whether it serves us again. It asks only while no data-scan run that may read the archive is active or queued; a Helius-only run (title `data-scan scan source=helius`, from data-scan.yml's `run-name`) does not hold it back, since it never touches the archive, while a run without that title (including runs dispatched before `run-name` existed) does, unless a manual dispatch of archive-check names its run id in the `helius_runs` input (digits and commas only; scheduled checks never set it). If the archive serves us and no data-scan run at all is active or queued, the next 8 unpublished days are dispatched: pre-holdout days first, then the holdout days. Helius runs have their own concurrency group (`data-scan-helius`; archive scans and assembly keep `data-scan`), so a served answer dispatches the archive day beside a running Helius day, and neither lane can replace the other's pending chained run (ARCHIVE-LANE). See `docs/DECISIONS.md`, "ARCHIVE-CHECK".

## Coverage

Filled from `manifest.json` when each batch is finished.

## Quality

Filled from `qa/report.md` (`node research/historical/qa/check.mjs <dataset> --live 60 --gecko 10`) when each batch is finished.

## Limits and known issues

- **Undocumented program upgrade on 2026-10-02:** from about 20:00 UTC, `TradeEvent`, `BuyEvent` and `SellEvent` carry 8 bytes more than the published IDL (almost always zero), kept as `extra_hex`. New event discriminators appear, kept raw as `Unknown` events with `data_hex`: `pump:742b4dbd117a482b` and `amm:82a42461e48287a5` from about 20:00 UTC, and `pump:a943276d6686b6e8` from slot 452,709,000 (about 23:15 UTC; 139 in that unit). The first slot of every unknown discriminator and extra-bytes key is recorded per unit and in `manifest.json` (`first_seen_slot`). The strict QA allows exactly these three discriminators and 8 extra bytes on those three trade events; any further new discriminator, extra length or older layout fails QA until the supervisor rules on it. **Regime boundary** (supervisor ruling, 2026-10-03): the upgrade splits the data into regimes, so decision days stay 2026-09-02 to 2026-10-01 and 2026-10-02 is never a decision day; the strict QA fails an assembled window that reaches it. Identifying the upgrade is a separate task. Decode them once pump.fun publishes the IDL; the on-chain Anchor IDL accounts are older than the docs repo.
- **Regimes file:** `research/historical/regimes.json` (outside the scanner folder, so editing it never changes the scanner revision) lists B2–B5 with their per-program slots and the allowed pre-boundary layouts. `finalize -regimes` copies it into `manifest.json` (`regime_boundaries`), and the strict QA reads the same file.
- **Regime boundaries inside the window** (UPG-1b, PR #44; listed in the QA report): B2 2026-07-21 14:23 UTC (slot 434,319,990, admin BOOST on, migration economics); B3 2026-09-09 19:30 UTC (slots 445,690,911 / 445,691,021 / 445,691,085, admin 445,691,266; fee and creator-fee config); B4 2026-09-12 15:24 UTC (PumpSwap 446,462,733, pump 446,462,760, admin 446,462,883): `TradeEvent`, `BuyEvent` and `SellEvent` grew by `holder_rewards_bps` and `holder_rewards` (16 bytes). Before B4 those two columns are empty (the field is absent, never 0), and the strict QA allows that two-fields-shorter layout only in units that start before B4 on that program; any other older layout fails.
- **Mayhem-mode curves:** the program changes their virtual reserves outside the trade amounts. Real reserves still rebuild exactly. Price from the event's virtual reserves.
- **Archive lag:** Old Faithful publishes an epoch after it ends (about 1.4 days per epoch). The newest one to two days are not available; the live dry run covers the present.
- **Failed transactions:** every failed trade transaction of a sampled mint is stored as a `failed` row and a raw record, and counted per mint and hour (about 1.5 failed per successful trade on new tokens).
- **What is complete and what is sampled:** every curve trade and every canonical-pool trade is in the units. Trades in other PumpSwap pools, failed trades and raw records cover the 5% hash sample only. The census (`agg_hourly`) covers all mints, hourly. Decoder parity is therefore proven on the sample's raw records; the other rows come from the same decoding code.
- **Non-SOL quote mints:** curves and pools quoted in other mints are kept, with `quote_mint`. Prices are in that mint's units.
- **Bandwidth:** scanning reads the whole archive range, about 600 GB per chain day (≈18 TB for 30 days) from a free public host. Each process is capped at 40 requests/s.
- **Quote-token curves:** some bonding curves are quoted in another token (USDC and others): `quote_mint` names it, the `*_sol_*` fields are 0, and the reserves are in `virtual_quote_reserves`, `real_quote_reserves` and `quote_amount`. Their quote token account sometimes holds more than `real_quote_reserves` (never less). The excess is tokens held outside the reserves, such as fees awaiting distribution.
- **Rent changes without a logged extension:** a curve's lamports minus `real_sol_reserves` (its rent) changed 15 times in 139,261 checks without an `ExtendAccountEvent`. The changes are between standard account sizes, which fits an account resized inside a trade. Reserves are unaffected.
- **Archive rate limit:** see How the scanner works, step 8. The supervisor ruled that the limit is not to be worked around with more machines or addresses: one lane, at most 80 MB/s, at least 1 h back-off after any 429.
- **Not covered:**
  - Swaps of universe mints on other venues, and plain token flows that call any program outside the basic list (for example Token-2022 transfer-hook programs or Lighthouse guard instructions that wallets add): counted per unit as `other_venue_txs`, not stored.
  - Every transaction in the slots around each creation: the Jito tip and `tx_idx` of the universe's own transactions are recorded instead.
  - The first funding transactions of creators and early buyers, which need per-wallet history from an RPC at about 1 call per second.
  - Nothing limits the scanner's in-memory sample cache, which is fine for one day per process (how CI runs it); a multi-week local run grows it with every mint seen.
  - Mint authorities, which are not in transaction meta.
  - The state of fee and global parameters before the coverage starts (changes inside it are events, and every trade carries its fee rates).

## History over RPC (DATA-2)

Old Faithful refuses our scanner (see `docs/DECISIONS.md`, "The archive's block is respected"), so history comes from Helius `getBlock` after a free pilot. The RPC scanner (`research/historical/rpcscan`, binary `zeroed-rpcscan`) writes the same units as the archive scanner, so QA, finalize, assemble and the volume files are unchanged.

- **The archive scanner is untouched.** Its tree, which is the archive units' revision, stays 64e1335c. Every scanner source except `main.go` is a symlink in `rpcscan`, so decoders are never copied. The two embedded IDL files are copies, because `go:embed` refuses symlinks. `test-ci.sh` checks the links and that the IDL copies are byte-identical. RPC units record `<scanner tree>+rpc<rpcscan tree>-go<version>` (`ci/rpcscan-rev.sh`).

- **Same decoders.** `rpcblock.go` encodes each transaction of a `getBlock` result as an archive Transaction node: its wire bytes, plus the archive's zstd-compressed protobuf `TransactionStatusMeta`. The scanner's `processBlock`, `txNode` and `processTx` then run unchanged. The request is `encoding: base64`, `transactionDetails: full`, `rewards: false`, `maxSupportedTransactionVersion: 1`. The RPC refuses version 0 for these blocks, because v1 transactions (SIMD-0385) are on chain. The meta is re-encoded as follows:
  - `err` goes from serde JSON to the validator's bincode. Variant order is taken from the solana-sdk transaction-error and instruction-error crates. An unknown variant or shape is an error, never a guess.
  - Inner instruction `data` goes from base58 to bytes.
  - A null or absent `innerInstructions` or `logMessages` becomes the archive's `*_none` flag. An empty list stays recorded and empty.
  - A null `stackHeight` stays absent.
  - Loaded addresses and token-balance owners and programs keep their values. An omitted owner or program is empty, as in the archive.
- **Units** (`zeroed-rpcscan rpc-unit`, `rpc-run`) use the archive's 4,500-slot units aligned to epochs. Each unit is read as follows:
  - `getBlocks` lists the unit's produced slots, and `getBlock` reads each one. The number of skipped slots is recorded in `stats.json` (`skipped_slots`). `root_cid` reads `rpc:getBlock`.
  - A listed slot whose block comes back as skipped (codes -32007 and -32009) is a gap. The unit fails and leaves no directory.
  - Parent links are checked as for the archive: within a unit by the writer, across units by finalize.
  - `rpc-run` plans a window from each epoch's first and last block times (about 4 credits an epoch), with the archive planner's interpolation and margins. Finished units are skipped.
- **Client** (`helius.go`):
  - The key comes only from `HELIUS_API_KEY`. No error carries the request URL, and the key is scrubbed from all text.
  - Requests are paced to `-rps` across all fetchers.
  - A 429 (HTTP, or code 429 in the body, as the public RPC sends) and a 5xx wait Retry-After, else 1 s doubling to 64 s with jitter, never less than 1 s.
  - Waiting more than `-max-backoff` in one call stops the run resumably (exit 75).
  - `-max-credits` is a hard stop. Each HTTP attempt reserves a credit before it is sent (getBlock and getBlocks cost 1 credit each), and nothing is sent past the cap (exit 75). The live dry run shares the account's credits, so the full pull takes a cap set from its measured use.
- **Pilot** (`zeroed-rpcscan pilot`, workflow `data-helius-pilot`, dispatch only, input capped at 15,000 credits). It reads:
  - `getFirstAvailableBlock`;
  - the first 50 slots of epoch 1004 and the last 50 of epoch 1047;
  - the comparison unit, epoch 1046 slots 452,277,000–452,281,499 (1 Oct 2026, 09:40–10:00 UTC, 4,496 blocks).

  The comparison unit is the only archive unit in today's schema. The 2 Oct slices are schema 1, sampled at 0.25 with older columns. Its rows are not committed, because publishing files derived from the archive waits on Triton. The committed `research/historical/pilot/baseline-1046-452277000-452281499.json.zst` (805 KB, `zeroed-rpcscan digest`) holds:
  - per table, one digest per block and one per column;
  - per raw record, digests of the record, of the record without its log, of its log, and of its log as Agave's limit would cut it;
  - the unit's counters.

  The RPC unit is digested by the same code and compared table by table, so a difference names its table, columns and blocks. Delegations are not compared, because the baseline predates that table. The report gives:
  - history depth;
  - per-probe errors, blocks and rate;
  - credits, requests, 429s, response bytes and latency;
  - a projection of the full pull's blocks, credits, bytes and hours, with seconds per slot measured between the two edge probes;
  - the full pull's cost on each plan, for the owner's decision (prices checked 4 Oct 2026):
    - Free has 1M credits a month at 10 requests/s, and no credits can be bought. The pull would take months of the allowance and leave none for the live dry run.
    - Developer is US$49 a month for 10M credits at 50 requests/s, with extra credits at US$5 per million.
    - The report gives US$, months of credits, and reading or calendar days.
  - **Holdout condition:** 1 Oct lies inside the sealed holdout window. The comparison is a data-integrity check only, the same kind scan QA runs on every day. No gate, strategy, label or outcome metric is computed on it, and diagnosing a mismatch looks at row fields only.

  Only the report leaves the runner. The units are deleted once digested, and no raw Helius response is stored.
- **Practice days over RPC (BT-2e).** `data-scan.yml` with `source: helius` and `max_credits` reads a day with `ci/rpc-day.sh` instead of the archive.
  - The rest of the day job is unchanged: QA, parity, the determinism rescan (over RPC, `check-day.sh`), packaging and the publish step.
  - `max_credits` (1 to 1,000,000) caps the whole day across chained runs. Each run and the rescan add their credits to `rpc-credits-used` in the day's progress, and each run may spend only what is left.
  - A spent cap stops the chain (exit 3). A rate-limit back-off or the time budget stops it resumably (exit 75).
  - The key reaches only the scan and QA steps, and only for helius. Progress is cached under `data-rpc-DAY`, apart from archive progress.
  - **One source per day (ARCHIVE-NODUP, owner 2026-10-05).** `HELIUS_DAYS` in `ci/archive-limits.conf` (today 2026-09-21) lists the days read over Helius, and only those: `rpc-day.sh` refuses any other day before a request, and archive-check never queues a listed day for the archive. A day already published from the archive is skipped by a Helius dispatch too (the published check gates every read for both sources). An explicit list was chosen over detecting a day's Helius cache, which can be evicted or not yet saved and needs the cache API.
  - **Resume never moves backwards (HISTORY-RESUME, 2026-10-06).** A run cancelled during its progress restore (09-21, run 37292410621) once saved a near-empty copy that, as the newest entry, shadowed the 66-unit one; the next run then reread the day from unit 0. Now the scan job picks the saved progress to resume from with `ci/progress-pick.sh`: within a run its `-qa` save wins (same units, QA credits booked); across runs the largest, with sizes within 0.5 % counted equal and the newest winning, records how many finished units it restored, and saves progress only when the restore finished and the count did not shrink (`ci/progress-guard.sh`). A dispatch input `expect_units` stops the job before any read when the picked progress holds fewer finished units (e.g. the fuller entry was evicted). A truncated or unparsable RPC response (rpcscan exit 1, `rpc response: unexpected end of JSON input`) is resumable (exit 75) in `rpc-day.sh`; the retry inside rpcscan waits for the next rpcscan revision change.
  - **Never published (DATA-PUB).** RPC units carry raw `getBlock` responses (`raw.jsonl.zst`), which stay in the repository's actions cache until Helius's terms are confirmed. A helius day is therefore never uploaded as the `day-DAY` artifact and never published as `data-day-DAY` or `data-volume-DAY`; its packaged assets are saved only to the actions cache under `data-rpc-assets-DAY-*` for a later Actions job (BT-2e). `publish-day.sh` and `publish-volume.sh` also refuse any day whose manifest lists a unit with `root_cid` `rpc:getBlock`. Known gap: such a manifest still names Old Faithful as its `source` (`scanner/finalize.go`); fixing it changes the scanner revision, so it waits until the 09-21 chain is finished.
  - **Kept alive (DATA-KEEP).** The cache is the only copy of a helius day's assets. GitHub removes an entry "not accessed in over 7 days" and, at the 10 GB repository cap, deletes "in order of last access date" ([dependency caching, usage limits and eviction policy](https://docs.github.com/en/actions/reference/workflows-and-actions/dependency-caching); the [actions/cache README](https://github.com/actions/cache/blob/main/README.md) says the same). `data-keep.yml` (every 3 days, and on dispatch) restores each `data-rpc-assets-*` entry and checks its files against `SHA256SUMS-DAY` (manifest included). It also restores, per day that has no assets entry yet, the newest read-progress entry `data-rpc-DAY-RUN-ATTEMPT` (the copy an unfinished day resumes from, at data-scan's save path; `-qa` copies are not kept) and checks it holds finished units (and a whole-number credit count when the day books credits per day rather than in the ledger). It and writes only key, size, file count and the cache total against 10 GB (a warning above 7 GB) to the step summary. It has `contents: read` and `actions: read` only, no secret, no artifact and no release (`ci/keep-check.sh`). That a restore refreshes an entry's 7-day clock is **unconfirmed**: neither page says so explicitly. Each run therefore reads the entry's `last_accessed_at` from the cache API before and after the restore and fails if it did not move within 10 minutes; the first dispatched run is the evidence.
  - `rpc_rps` (1 to 50, default 5) sets the pace. The pilot measured 5 blocks/s on the free plan, with 429s at 8. Developer's stated limit is 50, unused while the owner keeps the free plan; every 429 still backs off.
  - Measured by the pilot: about 250k credits a day (plus up to about 18k for the planner's margin units), about 14 h of reading at the free plan's 5 blocks/s, so about 3 chained runs.
  - The free plan's 1M credits "reset monthly" (Helius docs), and access stops "until the next billing cycle" when they run out. The docs don't give the reset date; the owner's Helius dashboard shows it.
- **Measured before the pilot** (public mainnet RPC, 25 blocks of the comparison unit, including the busiest pump blocks and the first block of each event kind):
  - every blocks, curve, amm, failed, movements and events row is byte-identical to the archive's;
  - 114 of 118 raw records are byte-identical.

  The 4 that differ differ only in `logMessages`: the RPC node applied Agave's default log limit, while the archive kept the whole log. Under that limit, a message that would bring the bytes written to 10,000 or more is dropped, the first drop writes `"Log truncated"`, and later messages that still fit are kept. So the marker can sit mid-log. Applying that rule to the archive's log reproduces the RPC's log for all 118 records. Rows decode from inner instructions, so no row changes. DEC-1 parity already treats a truncated log as incomplete, and the live bot reads logs over RPC too.

  The comparison marks a raw table `explained` only when all of these hold:
  - row counts are equal;
  - no column is on one side only;
  - `meta.logMessages` is the only differing column;
  - in every differing block, both sides hold the same records, and each record is either equal or explained.

  A record is explained only when everything but its log is equal and its log is exactly the archive's log under that rule. Three of these blocks are test fixtures (`rpcscan/testdata/rpc`; 452277901 holds a truncated record). They are taken from inside the holdout window, for data integrity only: no gate, label or outcome is computed on them.

## How to extend

**No local scans** (supervisor ruling, 2026-10-03): the archive is read only by `data-scan.yml` on its one lane. Never run `zeroed-scan run` or `unit` against the archive from a container or a laptop next to CI, since that adds a second lane. The commands below are for the CI scripts and for `finalize`, QA and parity on units already downloaded from releases.

```
cd research/historical/scanner && go build -o zeroed-scan .
./zeroed-scan run -out DATA -from 2026-09-01 -to 2026-10-03          # resumable; re-run after any stop
./zeroed-scan finalize -out DATA -dataset DATASET -from 2026-09-15 -to 2026-10-03   # needs 14 lead-in days
node ../qa/check.mjs DATASET --live 60 --gecko 10 --strict
node --no-warnings ../qa/parity.ts DATASET
```

- Scan the 14 lead-in days before the dataset window (`-from` of `run` 14 days earlier than `finalize`); `finalize` refuses a window without them (`-lead-in-days`).
- Rates can be raised only up to the units' `-sample` (5% in CI); a local `run -sample 0.25` scan allows `finalize -launch-rate 0.25 -grad-rate 0.25 -pool-rate 0.25`.
- On GitHub, dispatch `data-scan.yml` with `mode=scan` and a list of days, then `mode=assemble` per window (see Running it on GitHub Actions). Tests: `go test ./...` in `scanner/`, `node --test research/historical/qa/*.test.mjs`, `bash research/historical/ci/test-ci.sh` (all run in CI).
