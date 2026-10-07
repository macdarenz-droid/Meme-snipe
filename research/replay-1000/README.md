# REPLAY-1000: the bot's own code over one day of chain history

Card REPLAY-1000 (owner, 6 Oct 10:20 PM Melbourne): replay every PumpSwap graduate of UTC day 2026-10-06 through the bot as it runs on the server, with every fix applied, to learn whether it would have traded and whether those trades made money in SOL. Work in progress: this file states the method; `REPORT.md` holds the results.

## Method

The worker is built exactly as `packages/worker/src/main.ts` builds it: the same `Worker`, `LiveProviders`, FACTS-1 readers, `LiveStrategy` with core's gates H1–H17, risk R1–R16, exits, paper fills, fees and rent, configured from `settings.ts` `strategyConfig` and the server's S0 shakedown block in `ops/host-config.json` (S0, diagnostic on, paper edge 178092 ppm, salt `S0` because the host sets no run id, the same stand-in and wallet). Only the network is replaced, at the HTTP and WebSocket boundary, by an as-of world rebuilt from chain history (`world/`):

- **Virtual time** (`world/vclock.ts`): the worker's own timers run on a virtual clock. While the world fetches data (real I/O), virtual time stands still. Every answer is delivered at a virtual moment fixed when it was asked (a 150 ms RPC latency, 250 ms for REST), so event order never depends on network speed.
- **Commitment**: confirmed reads see slots at least one slot old, and confirmed log notices arrive no earlier. Measured on keyless publicnode (60 paired reads): confirmed was 0 slots behind processed 36 times and 1 slot behind 24 times. Helius could not be measured without a key. Processed notices arrive 400 ms after the slot.
- **Chain as of a moment** (`world/chain.ts`, `world/rpc-world.ts`): signatures and transactions after the confirmed slot of the request's moment do not exist. Slot times come from block times of the pump create authority's signatures (thinned to samples 20 s apart, interpolated).
- **Accounts as of a slot** (`world/accounts.ts`), exact or refused. An account changes only in a successful transaction that includes it:
  - pool vaults and virtual reserves: from the pool's last transaction at or before the slot (`world/pool-state.ts`), validated: every rebuilt state equals the next trade's own pre-trade fields, 7,911 of 7,911 (`validate-pools.ts`);
  - mint supply: the last trade's `baseSupply` plus later burns, validated: 113,561 of 113,561 trades on 16 non-mayhem coins (`validate-supply.ts`); mayhem coins: the sum of every mint transaction from the create;
  - LP mint and pool `lp_supply`: today's value less the net change of every later LP-mint transaction;
  - PumpSwap configs: today's, because their only writer (the admin) has written nothing since 2026-10-04;
  - pool account length: the creation length until its first ExtendAccount (measured: pools are created at 287 bytes and extended to 301);
  - holders (`world/holders.ts`): every mint transaction replayed, every holding account's own history added until nothing is missing, then the balances must sum exactly to the supply.
  - Anything else: a JSON-RPC refusal, so the bot fails the read and refuses the coin itself (fail closed); each refusal is counted by reason.
- **Streams** (`world/ws-world.ts`): `slotSubscribe`, and `logsSubscribe` on any address with the transaction's own log lines at its slot's time plus 400 ms, in block order (slot, then position in the block). The creates stream carries every pump create from 18:20 UTC on 5 Oct, the earliest still on publicnode's ledger when collected (about 50,000 a day), plus every earlier create by the full coins' creators back to 00:00 UTC on 5 Oct. So H14's serial-deployer count has a full 24 hours for every coin of the day, and a truncated create log anywhere reaches the bot as it does live. The migrations stream carries every replayed coin's migration. PumpPortal is refused (non-critical; it duplicates Helius). Coinbase's ticker is replayed from Coinbase's own SOL-USD trade history; REST prices carry 8 decimals and are trimmed to the ticker's form (same value).
- **Coins**: the seeded 10% sample (`sha256(mint)` first byte < 26, fixed before any result) is replayed in full. Every other coin of the span (from 18:00 UTC on 5 Oct) reaches the bot as a migration, and its accounts are served up to 35 minutes after it, past the +30 min survival read. Live, every coin's survival read feeds the regime's graduates series, and the regime check is off once that series is more than 2 hours old; a replay of the sample alone switched the regime off artificially. Their pools' log streams are refused, and their later reads are refused, so they cannot enter; they are not reported.
- **Network failures** never reach the bot: a 429, a 5xx or a dropped connection is retried until an endpoint answers (virtual time stands still meanwhile). Only a true answer, or a state the world cannot rebuild exactly, does.
- **H15** (`world/core-sim.ts`): the bot's own simulator is followed through its shape check, builders and compile; the node's simulation is replaced by CORE-2's exact pool math on the reserves as of the simulation's slot (TAIL-PROOF #257: 1,188/1,188 exact).
- **Third parties**: RugCheck and GoPlus are asked today; the bot keeps only the mint and freeze authorities, which a pump create revokes for good. Jupiter needs a key and is refused. GitHub's chain-volume releases are refused (the S0 diagnostic does not judge volume).

## Data

Keyless public RPC only. The Foundation endpoint (`api.mainnet-beta.solana.com`) allows 10 calls per method per window to this egress IP, about 0.3 `getTransaction` a second, so publicnode's keyless public endpoint (`solana-rpc.publicnode.com`) is the primary and the Foundation's the fallback. publicnode keeps about 20 hours of ledger, so collection races it. The bot's keys are never used.

`coins.ts` lists every canonical pump → PumpSwap migration of the day from the withdraw authority's history (the 244 other successful transactions are "Bonding curve already migrated" no-ops). `collect.ts` caches each coin's pool and mint history; `prefetch-others.ts` caches the other coins' survival reads. The cache (`data/`, git-ignored) is listed in `MANIFEST.md` with sha256 per file.

## Runs

- Without H5-POOL-TAILS: the base with #257 (f87ee90), in a worktree.
- With H5-POOL-TAILS: the base with #258 (e138ad2), this branch.
- What-if, labelled, not in the app: e138ad2 plus one change (49f5b09, branch `claude/replay-1000-whatif`). The worker fetches a cut create log, as it already does a cut trade log on a rug-covered stream, so the deployer index clears the loss. It shows what the bot would have done without the finding below.
- Mode A: the bot exactly (trial policy: one position, three entries a day, loss limits). Mode B: a research copy of the policy (`run.ts` `modeBSession`, never the bot's): position and loss caps lifted, bankroll large enough that cash never binds. The entry size is unchanged ($2: the bot sizes at the minimum until the owner steps sizes up), so each coin is judged and traded as if alone.

## Findings about the bot (from its own code, on chain data)

- H14 refuses every coin while any create log of the last 24 hours is truncated (`gates/hard.ts` `lostCreate`). The deployer index clears a lost create only when its transaction is fetched, and nothing fetches cut create logs (`#cutTradeLog` covers rug-covered trade streams only). 41 of 600 sampled creates of 6 Oct (6.8%) have truncated logs, about 2,000 a day.
- H9 (instant graduation) refuses coins created and graduated in the same transaction or slot, a common launch pattern on 6 Oct.
- Truncated logs on a pool's trade stream are holes: the candles are not gap-free, so H11 and H16 refuse.
- A pool's first account read can lose swaps (`facts/producer.ts`). The read is placed at its arrival slot, while its state is as of its context slot one or two slots earlier. Swaps in between are released first, while no chain exists yet, and are dropped (`#chainSwap`: `c === undefined`). The chain is then built from the older state, and the next swap fails "reserves mismatch", so the pool stays flagged until a new read. Example: 4BQRLLYa, pool ECVuPnoq, 6 Oct 00:38:24 UTC. The read is at slot 453742328, arriving at 330. Swaps kcg9srkF and vNTZFB4q at 329 are dropped, and swap 3tjv5x8C at 337 mismatches. The chain's own sequence is exact (`trace-pool.ts`). 9 of the 47 sample coins hit it in the corrected interim run.
- Two PumpSwap events the decoder does not know, emitted by instructions that leave the reserves alone, flag a pool as "a pool transaction other than a swap" until the next swap re-bases it: `929fbdac925838f4` (CloseUserVolumeAccumulator, inside buys) and `6161d7905d92167c` (ExtendAccount). One sample pool (PUXx1iSe) carried 16 and 1 of them before 04:12 UTC.

## Proofs

- `audit.ts`: every frame the bot recorded is checked against its receipt time; none may name a slot produced later.
- `parity-stream.ts`: TEST-1's parity replay streamed from the recorder files, for recordings too large for `checkSession` (which loads them whole): every replay's decision lines are compared with the run's journal and with each other.
- `packages/worker/test/replay-1000.test.ts` on an offline fixture (one quiet coin's first 12 minutes): two replays write the same journal; TEST-1 parity (`checkSession`) replays the recording 10 times with identical decision lines; a planted marker transaction never reaches the bot before its slot (two leak mutants fail the test: early log delivery, transactions served regardless of slot).
