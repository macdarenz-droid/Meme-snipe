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
   - Launch, graduation and direct-pool universes, each with a 72-hour tape.
   - An hourly census of every mint that traded, sampled or not.
4. **Checks** (see Quality), on the first finished slice (2026-10-02 09:07 to 21:49 UTC):
   - PumpSwap reserves rebuilt from events equal the vault balances recorded on-chain after the transaction in 230,784 of 230,784 checks.
   - Bonding-curve real reserves rebuild exactly in 145,213 of 145,213 trade pairs.
   - 51 of 51 idle curves and pools equal their live on-chain accounts.
5. **Throughput limit:** the archive throttles heavy users (429 after ~0.6 TB in an hour from one machine). Scanning 30 days (~18 TB of reads) needs many machines, so the proposed GitHub Actions workflow uses one runner per day.
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
   - any 429 pauses every request of the process together (1 min, doubling to 15 min, at most 6 h in total) instead of failing units.

   Every streamed node is checked against its CID (sha256).
3. **Filter:** votes are skipped. A transaction is kept if its message names either program, or (for versioned messages with lookup tables) its meta names either program. **53% of pump and PumpSwap transactions reach the programs only through address lookup tables** (48,667 of 91,540 in a 900-block test), so a static-key filter would miss most of them.
4. **Decode:**
   - Events are Anchor self-CPI instructions (`e445a52e51cb9a1d` tag plus 8-byte discriminator) issued by the program itself, decoded with the IDLs in `scanner/idl/` (copied from [pump-fun/pump-public-docs](https://github.com/pump-fun/pump-public-docs) at `cb188ce`, 2026-09-29).
   - Older events are prefixes of the current layout and decode cleanly. Bytes beyond the IDL are kept in `extra_hex`. Unknown discriminators are written raw as `Unknown` events.
   - Failed transactions emit no events; they are counted per mint and hour.
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
   - After about an hour at that rate (~0.6 TB), the archive answered every request from this machine with 429 "Your account has made too many requests; try again later". The limit is per client and unpublished. A single machine therefore has to scan slowly (`-max-mbps`), and many days need many machines (see the proposed workflow).

## Universe and sampling rule

Fixed before looking at any outcome:

- **Hash:** `h(mint) = first 8 bytes of sha256(mint pubkey bytes), big-endian, / 2^64`, a number in [0, 1). It depends only on the mint address, which is fixed when the token is created.
- **Scanner sample:** every trade, liquidity event and failed trade of mints with `h < 0.25` is kept in the unit files. The dataset is cut from this, so its rates can be raised up to 25% without rescanning. Mints outside the sample still appear in the hourly census and in universe events.
- **Dataset universes** (defaults, recorded in `manifest.json`):
  - `launch`: the token's `CreateEvent` is inside the scanned coverage and `h < 0.05`. Tape: creation to creation + 72 h.
  - `grad`: the token's `CompletePumpAmmMigrationEvent` is inside the coverage and `h < 0.05`. Tape: creation (or coverage start) to graduation + 72 h.
  - `direct_pool`: a PumpSwap pool created outside a migration is inside the coverage and `h(base mint) < 0.05`. Tape: pool creation to + 72 h.
  - The same hash threshold nests the universes: every sampled launch that graduates is also in `grad`.
- **Fixed-age universe** ("every token that is 24 h old with at least the configured liquidity"): computed at backtest time from the hourly census, which has every traded mint's closing reserves each hour. Full tapes exist for the sampled 5% of those tokens.
- **Use with care:**
  - The pre-graduation tape of `grad` tokens is conditioned on graduating. Do not use it for curve-phase strategies; use `launch` for those.
  - Days within 72 h after the coverage starts are flagged `warm_up`: older tokens' creation is not in coverage, so the age-based universes are incomplete there.
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
```

All files are RFC 4180 CSV (or JSON lines) compressed with zstd. Node 22 reads them with `zlib.zstdDecompressSync`. Files rotate at 45 MB. Amounts are raw integer units (lamports, token base units). `signer` is empty when equal to `user`, and the event `timestamp` is empty when equal to `block_time`.

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
- **Raw records** (`raw-NNN.jsonl.zst`, schema 2): one JSON line per pump/PumpSwap transaction, successful or failed, that touches a universe mint. A mint counts if it appears in the transaction's token balances or events, so plain transfers inside those transactions are included. Fields:
  - `slot`, `blockTime`, `txIndex`, `signature`, and `transaction` (base64 wire bytes: legacy, v0, or v1 per SIMD-0385, where the signatures follow the message);
  - `err` (null, or `{hex}` of the stored TransactionError bytes) and `mints`;
  - `meta`: fee, computeUnitsConsumed, pre/post balances, loadedAddresses, innerInstructions (data base64), logMessages, pre/post token balances.

  This is the input of the shared decoder (`transactionEvents`), so live and backtest decode with the same code. Size is about 1.7 GB per day at the 5% sample, measured on 446 blocks.

## Decisions

- **Old Faithful over RPC and third-party dumps:** it is the only free, complete and bulk source (Sources). Published dumps end before September 2026, lack PumpSwap, are unlicensed or non-commercial, or are paid.
- **Stream whole blocks rather than look up single transactions:** single-transaction lookups through the archive's indexes take about 4.5 s each (several dependent range reads). Discovering signatures needs the public RPC (~1 call per second). And 53% of relevant transactions are only visible through lookup tables. Whole-block streaming gets every transaction for the price of bandwidth.
- **Hash sample, not "interesting" tokens:** selection by `sha256(mint)` cannot depend on any outcome. A 25% superset keeps the option to widen the dataset without rescanning. Hourly census rows keep every mint countable.
- **No AGPL code:** yellowstone-faithful's archive tools default to AGPL-3.0, and even its Apache-2.0 packages import AGPL ones. The scanner instead reads the archive with its own small decoders (CAR sections, DAG-CBOR nodes, protobuf metas) and needs no index files. Remaining dependencies are solana-go, gagliardetto/binary, klauspost/compress and mr-tron/base58.
- **Release assets over a git branch for the full dataset:** about 150 to 200 MB per day compressed. A data branch would add gigabytes to every default clone, so the proposed workflow publishes release assets instead.

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

`.github/workflows/data-scan.yml`, approved by the supervisor as owner of `.github`, runs the same scanner on a single polite lane:
- manual dispatch only, one concurrency group and `max-parallel: 1`, newest day first, at most 80 MB/s;
- on any 429 the scanner stops, keeps finished units, waits at least an hour, and resumes on the same lane. If the job's time budget runs out, progress stays in the Actions cache and the run fails, so the next dispatch continues.
- each day must pass `qa/check.mjs --strict` (live checks included) and a determinism rescan of one unit with identical file hashes before it is published to release `data-days`, as split tar parts plus `SHA256SUMS-<day>` and the QA report;
- `mode=assemble` builds the multi-day dataset from those assets and publishes release `data-<from>-<to>`;
- expected pace is about 2 to 2.5 h per chain day at 80 MB/s (about 600 GB), so 30 days takes about 2.5 days unless the archive operators allow more.

## Coverage

Filled from `manifest.json` when each batch is finished.

## Quality

Filled from `qa/report.md` (`node research/historical/qa/check.mjs <dataset> --live 60 --gecko 10`) when each batch is finished.

## Limits and known issues

- **Undocumented program upgrade on 2026-10-02:** from about 20:00 UTC, `TradeEvent`, `BuyEvent` and `SellEvent` carry 8 bytes more than the published IDL (almost always zero), kept as `extra_hex`. New event discriminators appear (`pump:742b4dbd117a482b`, `amm:82a42461e48287a5`), kept raw as `Unknown` events with `data_hex`. Decode them once pump.fun publishes the IDL; the on-chain Anchor IDL accounts are older than the docs repo.
- **Mayhem-mode curves:** the program changes their virtual reserves outside the trade amounts. Real reserves still rebuild exactly. Price from the event's virtual reserves.
- **Archive lag:** Old Faithful publishes an epoch after it ends (about 1.4 days per epoch). The newest one to two days are not available; the live dry run covers the present.
- **Failed transactions:** counted per mint and hour, not stored row by row (about 1.5 failed per successful trade on new tokens).
- **Sample, not census, for tapes:** 5% of mints by default. The census (`agg_hourly`) covers all mints but only hourly.
- **Non-SOL quote mints:** curves and pools quoted in other mints are kept, with `quote_mint`. Prices are in that mint's units.
- **Bandwidth:** scanning reads the whole archive range, about 600 GB per chain day (≈18 TB for 30 days) from a free public host. Each process is capped at 40 requests/s.
- **Quote-token curves:** some bonding curves are quoted in another token (USDC and others): `quote_mint` names it, the `*_sol_*` fields are 0, and the reserves are in `virtual_quote_reserves`, `real_quote_reserves` and `quote_amount`. Their quote token account sometimes holds more than `real_quote_reserves` (never less). The excess is tokens held outside the reserves, such as fees awaiting distribution.
- **Rent changes without a logged extension:** a curve's lamports minus `real_sol_reserves` (its rent) changed 15 times in 139,261 checks without an `ExtendAccountEvent`. The changes are between standard account sizes, which fits an account resized inside a trade. Reserves are unaffected.
- **Archive rate limit:** see How the scanner works, step 8. The supervisor ruled that the limit is not to be worked around with more machines or addresses: one lane, at most 80 MB/s, at least 1 h back-off after any 429.
- **Not covered:**
  - Token transfers of universe mints made in transactions that do not touch the pump programs (possible in a later schema, at a CPU cost).
  - Every transaction in the slots around each creation: the Jito tip and `tx_idx` of the universe's own transactions are recorded instead.
  - The first funding transactions of creators and early buyers, which need per-wallet history from an RPC at about 1 call per second.
  - Mint authorities, which are not in transaction meta.
  - The state of fee and global parameters before the coverage starts (changes inside it are events, and every trade carries its fee rates).

## How to extend

```
cd research/historical/scanner && go build -o zeroed-scan .
./zeroed-scan run -out DATA -from 2026-09-01 -to 2026-10-03          # resumable; re-run after any stop
./zeroed-scan finalize -out DATA -dataset DATASET -from 2026-09-04 -to 2026-10-03
node ../qa/check.mjs DATASET --live 60 --gecko 10
```

- Scan at least 3 days before the dataset window (`-from` of `run` earlier than `finalize`), so tokens alive in the window have their creation in coverage.
- To raise universe rates, use `finalize -launch-rate 0.25 -grad-rate 0.25 -pool-rate 0.25` (up to the scanner sample).
- A proposed GitHub Actions workflow (`research/historical/workflow-proposal.yml`, supervisor approval needed) scans one day per runner in parallel and publishes the dataset as release assets.
