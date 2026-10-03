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
- **Not proven here:** `getTokenLargestAccounts` is always rate-limited (HTTP 429) on the keyless public RPC. It still needs one run on Helius with the worker's key. (The error reads "helius:" because the dry-run client labels every error with its provider, Helius.)
