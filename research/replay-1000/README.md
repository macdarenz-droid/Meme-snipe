# REPLAY-1000: the bot's own code over one day of chain history

Card REPLAY-1000 (owner, 6 Oct 10:20 PM Melbourne): replay every PumpSwap graduate of UTC day 2026-10-06 through the bot as it runs on the server, with every fix applied, to learn whether it would have traded and whether those trades made money in SOL. Work in progress: this file states the method; `REPORT.md` holds the results.

## Method

The worker is built exactly as `packages/worker/src/main.ts` builds it: the same `Worker`, `LiveProviders`, FACTS-1 readers, `LiveStrategy` with core's gates H1–H17, risk R1–R16, exits, paper fills, fees and rent, configured from `settings.ts` `strategyConfig` and the server's S0 shakedown block in `ops/host-config.json` (S0, diagnostic on, paper edge 178092 ppm, salt `S0` because the host sets no run id, the same stand-in and wallet). Only the network is replaced, at the HTTP and WebSocket boundary, by an as-of world rebuilt from chain history (`world/`):

- **Virtual time** (`world/vclock.ts`): the worker's own timers run on a virtual clock. While the world fetches data (real I/O), virtual time stands still. Every answer is delivered at a virtual moment fixed when it was asked (a 150 ms RPC latency, 250 ms for REST), so event order never depends on network speed.
- **Chain as of a moment** (`world/chain.ts`, `world/rpc-world.ts`): signatures and transactions after the confirmed slot of the request's moment do not exist. Slot times come from block times of the pump create authority's signatures (thinned to samples 20 s apart, interpolated).
- **Accounts as of a slot** (`world/accounts.ts`), exact or refused. An account changes only in a successful transaction that includes it:
  - pool vaults and virtual reserves: from the pool's last transaction at or before the slot (`world/pool-state.ts`), validated: every rebuilt state equals the next trade's own pre-trade fields, 7,911 of 7,911 (`validate-pools.ts`);
  - mint supply: the last trade's `baseSupply` plus later burns, validated: 113,561 of 113,561 trades on 16 non-mayhem coins (`validate-supply.ts`); mayhem coins: the sum of every mint transaction from the create;
  - LP mint and pool `lp_supply`: today's value less the net change of every later LP-mint transaction;
  - PumpSwap configs: today's, because their only writer (the admin) has written nothing since 2026-10-04;
  - pool account length: the creation length until its first ExtendAccount (measured: pools are created at 287 bytes and extended to 301);
  - holders (`world/holders.ts`): every mint transaction replayed, every holding account's own history added until nothing is missing, then the balances must sum exactly to the supply.
  - Anything else: a JSON-RPC refusal, so the bot fails the read and refuses the coin itself (fail closed); each refusal is counted by reason.
- **Streams** (`world/ws-world.ts`): `slotSubscribe`, and `logsSubscribe` on any address with the transaction's own log lines at its slot's time plus 400 ms, in block order. The two program-wide streams carry the replayed coins' migrations and their creators' creates (H14's serial-deployer check), not all 64,000 daily creates. PumpPortal is refused (non-critical; it duplicates Helius). Coinbase's ticker is replayed from Coinbase's own SOL-USD trade history.
- **H15** (`world/core-sim.ts`): the bot's own simulator is followed through its shape check, builders and compile; the node's simulation is replaced by CORE-2's exact pool math on the reserves as of the simulation's slot (TAIL-PROOF #257: 1,188/1,188 exact).
- **Third parties**: RugCheck and GoPlus are asked today; the bot keeps only the mint and freeze authorities, which a pump create revokes for good. Jupiter needs a key and is refused. GitHub's chain-volume releases are refused (the S0 diagnostic does not judge volume).

## Data

Keyless public RPC only. The Foundation endpoint (`api.mainnet-beta.solana.com`) allows 10 calls per method per window to this egress IP, about 0.3 `getTransaction` a second, so publicnode's keyless public endpoint (`solana-rpc.publicnode.com`) is the primary and the Foundation's the fallback. publicnode keeps about 20 hours of ledger, so collection races it. The bot's keys are never used.

`coins.ts` lists every canonical pump → PumpSwap migration of the day from the withdraw authority's history (the 244 other successful transactions are "Bonding curve already migrated" no-ops). `collect.ts` caches each coin's pool and mint history; `prefetch-others.ts` caches the other coins' survival reads. The cache (`data/`, git-ignored) is listed in `MANIFEST.md` with sha256 per file.

## Proofs

- `audit.ts`: every frame the bot recorded is checked against its receipt time; none may name a slot produced later.
- `packages/worker/test/replay-1000.test.ts` on an offline fixture (one quiet coin's first 12 minutes): two replays write the same journal; TEST-1 parity (`checkSession`) replays the recording 10 times with identical decision lines; a planted marker transaction never reaches the bot before its slot (two leak mutants fail the test: early log delivery, transactions served regardless of slot).
