# Shared tape: build

The tee, the research decoder and the uploader for research/SHARED_TAPE_PLAN.md. Research reads only: no outcome or return is computed here.

## Parts
- `tapedec/` (Go, one binary `zeroed-tapedec`). Every scanner source in it is a symlink to `../../historical/scanner`, and `rpcblock.go` is a symlink to `../../historical/rpcscan`. The scanner and rpcscan trees are unchanged, so the core units keep their revision.
  - `tee`: listens on loopback only and holds the real key; rpcscan's `-helius-url` points at it.
    - Forwards each request and returns status, headers and body unchanged. A gzip body goes back as sent.
    - At most 25 requests a second for this process (P4). `-rps2` and `-switch-after` change the rate mid-run, to measure two rates.
    - An upstream Retry-After pauses every forward until it ends.
    - Stops resumably on 3 consecutive 429 or 403 answers (an RPC -32429 inside an HTTP 200 counts too), at the credit cap, or below 8 GiB free disk. Once stopped, each request gets a local 429 with Retry-After 3600, so rpcscan exits 75 at once.
    - Ledger by method: attempts, usable answers, HTTP codes, wire and decoded bytes. Each usable getBlock body is spooled decompressed as `SPOOL/<slot>.json.zst` (the format rpcscan's `-dir` reads), with its sha256 in `MANIFEST.tsv`.
  - `decode`: reads one unit from the spool and checks each block against the manifest.
    - Runs the scanner's `processBlock` unchanged, with every mint kept (sample rate 1), then adds the extras.
    - Drops whole any block whose time is outside `-day` and counts it, so no row of U1-B's holdout (from 2026-09-12) is written.
- `upload.sh`: uploads to `macdarenz-droid/zeroed-data`, branch `tape`, under `tape/<day>/...` only.
  - The branch shares no history with main, so main (`reports/`) and the `rec-*` releases are never touched.
  - Files above 95 MB are split. It never overwrites a path and never force-pushes.
  - It reads everything back from a fresh clone and checks sha256.
- `phase0.sh`: Phase 0.
  - Builds rpcscan exactly as `data-scan.yml` does, then picks the first whole unit of 2026-09-11 (checked with getBlocksWithLimit and getBlockTime).
  - Reads the unit through the tee with the unchanged binary (`rpc-unit`, written where `rpc-run` writes it), checks identity, decodes, uploads and reads back.

## Identity (by construction)
- rpcscan's `credits` = the tee's attempts + local refusals.
- `requests` = usable answers.
- `response_bytes` = decoded bytes.
- The unit rebuilt from the spool (`rpc-unit -dir`) has the same digest as the unit read live (`digest-compare`).

## Research tables per unit (`research/units/EPOCH/FROM-TO/`)
| File | Table | Rows |
|---|---|---|
| `S_curve.csv.zst`, `S_amm.csv.zst` | S | Every bonding-curve trade and every PumpSwap trade, all coins: the scanner's columns plus `owner_token_pre/post` (the trade owner's raw balance of the mint, summed over their accounts, 0 if none), `signer_sol_pre/post` (lamports), `canonical` (PumpSwap) and `protocol` (boost_buy_and_burn, or the buyback authority `GmFrDZT2…` as signer or user) |
| `F.csv.zst` | F | Every failed transaction in which a pump or PumpSwap instruction ran (an inner instruction, or a top-level one at or before the failing index) |
| `W.csv.zst` | W | System-program transfers (instruction 2) of at least 0.05 SOL with no pump or PumpSwap instruction above them on the call stack, in successful transactions |
| `T.csv.zst`, `T_coverage.csv.zst` | T | The scanner's movements, as today |
| `D.csv.zst` | D | The scanner's delegations, as today |
| `B.csv.zst` | B | Blocks, with `n_pump_failed` |
| `E.jsonl.zst` | C, G | Every other pump and PumpSwap event. C is `CreateEvent`; G is `CompleteEvent`, `CompletePumpAmmMigrationEvent` and `CreatePoolEvent` |
| `H.csv.zst` | H | The scanner's hourly census. A row is readable only after its hour closes |

O (other-venue coverage per `pump` coin and hour) is derived from T after a day is read (T's rows for transactions without a pump instruction); it is not a separate decode.

## F definitions
- `err_program`, `err_line`: the first `Program X failed: ...` log line (the innermost failure). `err_source_path`: the invoke stack at that line.
- `err_code`: the custom code on that line. `err_ix` and `meta_err`: from the transaction error.
- The failing instruction (`ix_name`, `side`, `amount_arg`, `limit_arg`, `venue`, `pool_or_curve`, `mint`) is the last pump or PumpSwap instruction under the failing top-level instruction.
- `err_class`, per program:
  - A truncated log, or no failure line: `unclassified`.
  - `exceeded CUs meter` or `Computational budget exceeded`: `compute`.
  - pump or PumpSwap with a listed code (tables in `extras.go`, from the IDLs): slippage, insufficient funds, liquidity, arithmetic, or account or constraint. Anchor framework codes below 6000: `account or constraint`. Other codes of the program: `state`.
  - Token programs: custom 1 is `insufficient funds`, anything else `account or constraint`.
  - System program: custom 1 or `insufficient lamports` is `insufficient funds`, anything else `account or constraint`.
  - ATA and compute-budget programs: `account or constraint`.
  - Any other program: `cyclic arbitrage` when the transaction has 2 or more pump or PumpSwap swap legs, otherwise `other program`. This rule is a proxy, open to review.

## Tests
- `cd tapedec && go test ./...`
  - Bodies unchanged (sha256); the canary key never appears in a log, file or header.
  - The 3-failure stop; the credit cap and disk floor stop resumably; pace and rate cap.
  - Decoder counts on the 3 testdata blocks equal the plan's recount: 2,951 transactions, 226 failed, 154 calling pump or PumpSwap, 12 of those failed, 5 slippage failures, 3 truncated logs. Counts only, because the blocks are in the sealed window.
  - End to end with the unchanged rpcscan: counters equal, the replay digest equal, and a stopped tee gives exit 75.
- `bash test-upload.sh`: a local stand-in for zeroed-data.
