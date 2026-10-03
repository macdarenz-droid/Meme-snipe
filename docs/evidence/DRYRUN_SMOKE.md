# Dry-run smoke runs (TEST-2)

Runs of `packages/worker/scripts/dryrun-smoke.ts` against mainnet. Each run names its commit and endpoint. Newest last.

## 2026-10-04 01:50 AEST · commit cc90d83 · public RPC (`api.mainnet-beta.solana.com`, Agave 4.3.0), keyless

Payer `4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE` (a Helius Sender tip account: System-owned, funded, public). Mint `4gBSeMHUHK4yhgvjRYuMYsRaep3iTSDzxMMmdCQhoPgU`.

```
2026-10-03T15:50:30Z
getTokenLargestAccounts: FAILED: helius: getTokenLargestAccounts rate limited
simulateTransaction read-back includes fees: ok (payer spent 10000 = base fee + priority fee (from preBalances/postBalances); read-back matches; fields returned: fee, preBalances, postBalances, preTokenBalances, postTokenBalances; slot 452978907, 300 units)
2026-10-03T15:50:32Z
getTokenLargestAccounts: FAILED: helius: getTokenLargestAccounts rate limited
simulateTransaction read-back includes fees: ok (payer spent 10000 = base fee + priority fee (from preBalances/postBalances); read-back matches; fields returned: fee, preBalances, postBalances, preTokenBalances, postTokenBalances; slot 452978913, 300 units)
2026-10-03T15:50:33Z
getTokenLargestAccounts: FAILED: helius: getTokenLargestAccounts rate limited
simulateTransaction read-back includes fees: ok (payer spent 10000 = base fee + priority fee (from preBalances/postBalances); read-back matches; fields returned: fee, preBalances, postBalances, preTokenBalances, postTokenBalances; slot 452978920, 300 units)
```

- **Fee read-back: proven, 3 of 3.** Base fee 5,000 plus priority fee 5,000 (1,000 units at 5 lamports) leave the payer inside the simulation. The account read back after the simulation equals `postBalances[0]`, and the `fee` field is 10,000.
- **The node returns its own before and after balances** (`preBalances`, `postBalances`, `preTokenBalances`, `postTokenBalances`, `fee`). The dry run measures the stand-in's balances from these when they are present.
- **Why that matters (an earlier run, same day):** with this busy tip account as payer, a separate read before the simulation was 200,000 lamports behind, because tips landed in between. The atomic fields remove that race.
- **Not proven here:** `getTokenLargestAccounts` is always rate-limited (HTTP 429) on the keyless public RPC. The Helius run below covers it. (The error reads "helius:" because the dry-run client labels every error with its provider, Helius.)

## 2026-10-04 03:53 AEDT · commit fd010c2 · Helius (key from repository secrets), GitHub Actions

Workflow `dryrun-smoke.yml`, run [37138505875](https://github.com/macdarenz-droid/Meme-snipe/actions/runs/37138505875) (job 111247866592), manual dispatch on `ccr-14987baf-i6lrsl` with the default inputs. Artifact `dryrun-smoke-37138505875` (kept 30 days).

```
started: 2026-10-03T16:53:29Z
payer: 4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE
mint: 4gBSeMHUHK4yhgvjRYuMYsRaep3iTSDzxMMmdCQhoPgU
endpoint: helius (key from credentials)
getTokenLargestAccounts: ok (20 holders at slot 452993037)
simulateTransaction read-back includes fees: ok (payer spent 10000 = base fee + priority fee (from preBalances/postBalances); read-back matches; fields returned: fee, preBalances, postBalances, preTokenBalances, postTokenBalances; slot 452993038, 300 units)
exit: 0
```

- **Passed, every step.** The key scan found no form of the key in the output, so the artifact was kept.
- **Helius returns the same fields as Agave:** `fee`, `preBalances`, `postBalances`, `preTokenBalances` and `postTokenBalances`. So in production the dry run measures the stand-in's balances from these node-side fields, not from our separate read.
- **`getTokenLargestAccounts` works on Helius:** 20 holders, response shape accepted. The holder stand-in path is therefore available.
- **Fee read-back confirmed on Helius:** the payer spent 10,000 lamports (base fee + priority fee), and the read-back matches `postBalances`.
- **Not related to this test:** GitHub warns that the pinned actions target Node 20 and are being forced to run on Node 24. They should be re-pinned to Node 24 releases when the workflows are next updated.
