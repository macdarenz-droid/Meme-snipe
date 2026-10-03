# Signer security, supply chain, hosting and operations

Research date: 2026-10-03 (UTC). Scope: the personal Solana meme-token bot in `docs/ARCHITECTURE.md`, with a $20 bankroll, $2 default and $5 max entries, one open position, and paper mode first. The repo stack is TypeScript on Node 22 with pnpm 10.28 (`package.json`).

Evidence labels:
- **[doc]**: the vendor's own documentation or official source.
- **[measured]**: measured by me in this container on 2026-10-03.
- **[vendor-bench]**: the vendor's own benchmark, not independent.
- **[secondary]**: a news or blog report.
- **unverified**: I could not confirm it.

---

## 0. Answer in brief

1. **At $20, sign locally in an isolated signer process with zero npm dependencies.** Use Node's built-in Ed25519, which I measured at **37 µs per signature** on Node 22.22.0. Load the key from a systemd encrypted credential. The signer process has no network: it accepts only `AF_UNIX`. Paid custody is the wrong fit here:
   - Turnkey costs **$0.10 per signature** after 25 free per month, which is 10% of a $2 round trip.
   - Privy and Turnkey enclaves add about **72–100 ms** [vendor-bench].
   - Neither managed policy engine can resolve address-lookup-table (ALT) addresses, so we must run our own policy checks anyway.
2. **Enforce policy before signing, inside the signer.** It decodes the v0 message itself and checks:
   - an allowlist of programs and instructions;
   - that every account that matters sits in the static keys, never loaded from an ALT;
   - a cap on fees and tips, with tips paid only to allowlisted tip accounts;
   - no durable nonces, approvals or authority changes;
   - its own spend counters, which survive a restart.

   The worker also simulates each transaction and checks the balance change before asking for a signature.
3. **Supply chain is the most likely way to lose the key.** The Dec 2024 `@solana/web3.js` 1.95.6/1.95.7 backdoor was aimed at "bots that handle private keys directly". Mitigations:
   - exact pins and a frozen lockfile;
   - pnpm `minimumReleaseAge` and `trustPolicy: no-downgrade`;
   - no dependency build scripts;
   - `@solana/kit` in the worker only (4 third-party transitive packages, no install scripts [measured]);
   - nothing from npm in the signer.
4. **Hosting.** Put the primary in **Frankfurt**, where about 35% of leader slots and about 28% of stake sat in Sept 2026 [secondary]. Jito and Helius Sender both have Frankfurt endpoints. The cheapest good option is the Vultr Frankfurt High Performance plan (1 vCPU AMD, 1 GB) at **$6/mo**. The best value per dollar is Hetzner CX23 in Nuremberg at **€5.49 + €0.50 IPv4**: 2 vCPU and 4 GB RAM, but a few ms from Frankfurt (unverified; measure it).
5. **Database.** Use **SQLite in WAL mode** (built into Node as `node:sqlite`, no dependency) on the worker's disk, with backups to Cloudflare R2 (free tier). Hosted Postgres is not worth it for one worker:
   - Neon's free plan always scales to zero and holds only 100 CU-hours, while a 0.25 CU compute running 24/7 needs about 183.
   - Supabase's free plan pauses after 7 days without activity.
6. **Watchdog in a separate failure domain, at $0.** A Cloudflare Worker cron job every minute does three things:
   - reads the chain directly;
   - reads the worker's heartbeat from a Durable Object;
   - alerts by Telegram.

   Healthchecks.io (free) is a second dead-man switch, but it runs on Hetzner Falkenstein, which shares a failure domain with a Hetzner primary. Later, add a standby on a second provider. It can only exit (sell to SOL, never buy), so a split brain cannot double-buy.
7. **Dashboard.** Never expose a port: use Cloudflare Tunnel with Cloudflare Access, email OTP plus a passkey or TOTP through Access "Independent MFA". The app re-asks for a passkey (WebAuthn) before any privileged action. The web tier cannot reach the signer; it writes commands to the database and the worker checks them. Low-trust channels (Telegram, a lost session) may only make things safer: pause or close, never resume, raise limits or withdraw.

**Monthly cost:**
- Minimum for the live canary: **about $6/mo**.
- With an exit-only standby on a second provider: **about $13/mo**.
- With AWS KMS as a later upgrade: **+$1/mo**.

---

## 1. Hot-wallet key management

### 1.1 Options compared

| Option | Solana support | Cost at our volume (~200–600 signatures/mo) | Signing latency | What it protects | What it does not |
|---|---|---|---|---|---|
| **Local key in an isolated signer, systemd encrypted credential** | Native Ed25519 (`node:crypto`) | $0 | **~37 µs/sig** [measured, Node 22.22.0, 600-byte message] | Key never on disk in plaintext. Backups and snapshots only hold ciphertext. Key reachable only from the signer's uid. No network egress from the signer. | Root on the host can decrypt it: the host key is `/var/lib/systemd/credential.secret`, readable by root ([systemd-creds](https://github.com/systemd/systemd/blob/main/man/systemd-creds.xml)). Most VPS plans have no TPM2. |
| **Encrypted keystore with a passphrase typed at runtime** | Same | $0 | Same | Also protects against someone with root on a stopped disk image | The bot **cannot restart unattended**. After a crash or reboot, exits stop until the owner types the passphrase. That fails the "risk aware" goal: an open position goes unprotected. Malware in memory defeats both options equally. |
| **AWS KMS `ECC_NIST_EDWARDS25519`** | Yes, since **2025-11-07**, all regions ([AWS what's new](https://aws.amazon.com/about-aws/whats-new/2025/11/aws-kms-edwards-curve-digital-signature-algorithm/)). Use `ED25519_SHA_512` with `MessageType:RAW` ([key spec reference](https://docs.aws.amazon.com/kms/latest/developerguide/symm-asymm-choose-key-spec.html)). Solana Foundation adapter: `@solana/keychain-aws-kms`. | **$1/key/mo + $0.15 per 10,000 asymmetric requests.** Asymmetric calls are excluded from the free tier ([KMS pricing](https://aws.amazon.com/kms/pricing/)). That is about $1.01/mo. | One network round trip to the region plus KMS time. **Unverified**; measure it. ECC quota: 1,000 req/s shared ([quotas](https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html)). | Key cannot be exported. CloudTrail audit. One API call disables the key (an instant kill switch from any device). | IAM credentials on the VPS let an attacker **sign** while they hold the host. KMS has **no transaction policy**, so our own checks still decide what gets signed. |
| **GCP KMS `EC_SIGN_ED25519`** | Yes, **SOFTWARE protection level only** (no HSM or EXTERNAL) ([GCP algorithms](https://docs.cloud.google.com/kms/docs/algorithms), page updated 2026-09-30) | Price unverified (the pricing page could not be read) | Unverified | As AWS, but software-backed | As AWS |
| **Turnkey** (AWS Nitro enclaves) | Yes. Solana policy engine with an enclave parser ([Solana policies](https://docs.turnkey.com/concepts/policies/examples/solana.md)). | **25 free signatures/mo, then $0.10 each.** Pro is $99/mo + $0.05/sig. Up to 5 policies per org on PAYG and Pro ([pricing](https://turnkey.com/pricing)). **About $0.20 per round trip = 10% of a $2 trade.** | "Sub-100 ms" [vendor-bench] ([client-side signing post, 2026-04-30](https://www.turnkey.com/blog/client-side-signing)). Multi-region since 2026-04-28 ([post](https://turnkey.com/blog/turnkey-launches-multi-region-signing-for-low-latency-transactions-around-the-world)). | Enclave policy enforcement and audit | ALT addresses are **not resolved**: they show up as `'ADDRESS_TABLE_LOOKUP'`. The documented workaround is to deny ALT lookups, or deny sends to ALT-resolved addresses ([docs](https://docs.turnkey.com/concepts/policies/examples/solana.md)). Jupiter routes rely on ALTs. |
| **Privy server wallets** (TEE) | Yes. Policies by instruction; default deny; every instruction must ALLOW ([overview](https://docs.privy.io/controls/policies/overview.md)). | **Free tier: 50K signatures and $1M volume per month**, 0–499 MAU. Above 50K: $0.01/sig ([pricing](https://privy.io/pricing)). | Solana median **72.42 ms** (SLATE, 1,000 runs) [vendor-bench] ([2026-05-27 post](https://privy.io/blog/reducing-trading-latency-on-privy)). The ~190 ms swap API is enterprise-only. | Policies (program allowlist, `Transfer.to` allowlist, lamport caps), key quorums | **"Solana policy evaluation does not support resolving addresses from Address Lookup Tables"** ([Solana policies](https://docs.privy.io/controls/policies/example-policies/solana.md)). Adds a third party with custody and availability risk to the exit path. |
| **Squads v4 multisig + spending limits** | Yes | Rent only | n/a (on-chain) | A member can withdraw **one token, up to an amount, per ONE_TIME, DAILY, WEEKLY or MONTHLY period, to listed destinations**, with no proposal ([spending limits](https://docs.squads.so/main/navigating-your-squad/settings/spending-limits)) | Allows **transfers only**, not swaps. Useful as the owner's treasury that tops up the hot wallet within a daily cap. Not useful as the trading signer. |

The Solana Foundation's `@solana/keychain` (v2.0.0 on npm, 2026-10-01; audited by OtterSec and earlier by Accretion) wraps all of these behind one `SolanaSigner` interface: Memory, Vault, AWS KMS, GCP KMS, Privy, Turnkey, Fireblocks and others ([docs](https://solana.com/docs/tools/keychain.md), [repo](https://github.com/solana-foundation/solana-keychain)). Its README says it is **"a signing adapter: it validates the signing hop, not what your transaction does."** The umbrella package pulls 15 backend packages [measured, `npm view`]. If we ever adopt it, depend on the single backend package, not the umbrella.

### 1.2 Decision for $20

- **Phase paper and canary:** local key in the isolated signer (section 3.3), with an encrypted systemd credential (`LoadCredentialEncrypted=`).
  - The hot wallet holds at most the bankroll plus a SOL fee reserve.
  - Anything above a cap is swept automatically to the **one saved owner address**, the only allowlisted withdrawal destination.
  - Reason: the loss is capped by the balance, not the key. Paid custody costs more per trade than the edge we expect, adds 70–100 ms, and still cannot enforce ALT-aware policy.
- **Upgrade trigger (bankroll > ~$500, or a second machine needs the key):** AWS KMS Ed25519 at about $1/mo. This is the best value per dollar: a non-exportable key, an audit trail, and an instant remote disable. Local policy checks stay mandatory.
- **Not recommended:**
  - Turnkey: its per-signature price is designed for low volume, high value.
  - A runtime passphrase: it breaks unattended exits.
  - Privy for trading: free, but adds a custodian and its availability to the exit path. Keep it as a fallback only if a TEE is required later.

### 1.3 Key lifecycle rules

- Generate the bot key **on the server**, inside the signer. Never paste a seed phrase. The bot key is not derived from the owner's seed.
- **Rotation.** Rotate when any dependency compromise is reported, or every 90 days. Procedure:
  1. Pause entries.
  2. Close positions.
  3. Create a new key.
  4. Sweep to the new key.
  5. Revoke the old credential.
- **Delete compromised keys:** when a key is known compromised, sweep its funds first, then delete it.

---

## 2. Transaction policy before signing

### 2.1 What a v0 message gives the signer

- A v0 message holds static account keys, a header (signer and readonly counts), the recent blockhash, compiled instructions, and **address table lookups** (table address plus writable and readonly indexes). ALTs need v0 transactions. One table holds up to **256 addresses** ([lookup tables guide](https://solana.com/developers/guides/advanced/lookup-tables)).
- Tables can be **extended** (appended). The guide describes no in-place edits, so an index read from a table at a slot keeps meaning the same address while that table exists. Deactivation and closing are not covered in that guide (unverified here).
- The signer has **no network** (section 3.3), so it cannot fetch ALT contents itself. If the worker is compromised it could send fake ALT contents. **Therefore ALT-resolved addresses are untrusted inside the signer.**

### 2.2 Policy checklist (all must pass, default deny)

1. **Fee payer** = bot wallet, and the bot is the only signer, apart from documented exceptions. Per `execution.md`, reject any Jupiter quote where `signatureFeePayer != taker`.
2. **Program allowlist.** Every invoked `programIdIndex` must point to a **static** key in this set:
   - System `11111111111111111111111111111111`
   - Compute Budget `ComputeBudget111111111111111111111111111111`
   - SPL Token `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`
   - Token-2022 `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`
   - Associated Token Account `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`
   - pump.fun bonding curve `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
   - PumpSwap `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`
   - Jupiter v6 `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`, used in Turnkey's policy example ([Turnkey](https://docs.turnkey.com/concepts/policies/examples/solana.md))

   I read the pump program addresses from the IDLs in [pump-fun/pump-public-docs](https://github.com/pump-fun/pump-public-docs) on 2026-10-03; the fee program is `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ` and is reached through CPI. Pump changes required accounts often: `buy_v2`/`sell_v2`, a mandatory `user_volume_accumulator` and `sharing_config`, and the field rename `virtual_sol_reserves` → `virtual_quote_reserves`. **Version the policy and fail closed** on unknown instruction discriminators.
3. **Instruction allowlist per program** (discriminator plus decoded arguments):
   - System: `Transfer` only to the allowlisted tip accounts (cap) or to the bot's own WSOL account. Never `AdvanceNonceAccount`: a durable-nonce transaction does not expire, so a leaked signed transaction could be replayed later. Never `Assign` or `Allocate` on the bot wallet.
   - Token and Token-2022: only `CloseAccount` with destination = bot, `SyncNative`, and `TransferChecked` from bot to bot. **Deny `Approve`, `SetAuthority`, `Revoke` to others, and any transfer to a non-bot owner.**
   - Compute Budget: CU limit at or below cap; `CU price × limit` at or below the fee cap for this intent.
   - Swap programs: only buy and sell discriminators. The decoded `min_out` or slippage bound must match the intent the risk engine reserved.
4. **Fee and tip caps.** Priority fee plus tip at or below the per-intent cap and a rolling daily cap. Jito says tips go **in the same transaction**, and **"Do not use Address Lookup Tables for tip accounts"**. Minimum tip is 1,000 lamports. There are 8 mainnet tip accounts, listed in the docs and from `getTipAccounts` ([Jito](https://docs.jito.wtf/lowlatencytxnsend/)). Pin the tip accounts for Jito and for Helius Sender.
5. **Static-key rule.** The bot wallet, the bot's token accounts, the mint, every transfer destination and every program must be in **static keys**. ALT-loaded accounts may appear only where the per-program decoder marks a position as pool-side, never as user authority, user destination or owner. This copies the "deny sending to an address from a table lookup" pattern that Turnkey documents.
6. **Prefer no ALTs at all.** Build pump.fun and PumpSwap transactions locally, so they carry no ALTs. Allow ALTs only for Jupiter, and only within rule 5.
7. **Amount bounds.** SOL leaving the wallet ≤ reserved exposure + fee cap. In sells, the input token amount must not exceed the position quantity held by the current exit owner.
8. **Replay and fencing.**
   - At most one signature per `intent_id` and blockhash. A replacement needs the worker to prove the old attempt is terminal.
   - The fencing token must be at least the highest one seen, enforced by the brief's lease.
   - Spend counters live in the **signer's own state file**, so a compromised worker cannot reset them.
9. **Rate limits:** at most N signatures per minute and per day, plus a daily loss stop reported by the worker. The signer also enforces a hard ceiling of its own.

### 2.3 Simulate and check the balance change (worker side, before asking for a signature)

- `simulateTransaction` supports these options ([RPC docs](https://solana.com/docs/rpc/http/simulatetransaction)):
  - `sigVerify`
  - `replaceRecentBlockhash`
  - `innerInstructions: true`, which returns CPIs
  - `accounts.addresses` with `jsonParsed`, which returns the post-state
  - `minContextSlot`

  The documented result includes `err`, `logs`, `unitsConsumed`, `fee`, `preBalances`/`postBalances` and `preTokenBalances`/`postTokenBalances`. Check that our provider really returns these fields.
- Check:
  - change in bot SOL ≥ −(notional + fee cap + rent);
  - change in the bot's token balance ≥ the quote's `min_out` (buy), or token goes down by exactly the sell size and SOL goes up by at least `min_out` (sell);
  - **no other account owned by the bot changes**;
  - CPI programs are within the allowlist.
- Simulation is evidence, not a guarantee. State can change before the transaction lands. The protection that holds on-chain is the swap's `min_out`. If the sell path is adversarial, an assertion program such as **Lighthouse** can be appended so the transaction reverts when post-state assertions fail ([QuickNode guide](https://www.quicknode.com/guides/solana-development/tooling/solana-kit/lighthouse)). It costs compute units and bytes. The Lighthouse program ID is **unverified**; confirm it from source before allowlisting.

---

## 3. Supply chain

### 3.1 Incidents that set the design

| Date | Incident | Relevance | Source |
|---|---|---|---|
| 2024-12-03, 15:20–20:25 UTC | `@solana/web3.js` **1.95.6 and 1.95.7** backdoored through a phished publish account. An `addToQueue` function exfiltrated keys. Fixed in 1.95.8. CVE-2024-54134. | Aimed at **"dapps, like bots, that handle private keys directly"**. Advice: "rotate any suspect authority keys" | [GHSA-jcxm-7wvp-g6p5](https://github.com/advisories/GHSA-jcxm-7wvp-g6p5), [Solana advisory](https://github.com/solana-labs/solana-web3.js/security/advisories/GHSA-jcxm-7wvp-g6p5) |
| Jan 2025 | Typosquats `solana-transaction-toolkit` and `solana-stable-web-huks` steal keys through Gmail SMTP and drain up to 98% of the wallet | Typosquat risk on Solana package names | [The Hacker News, 2025-01](https://thehackernews.com/2025/01/hackers-deploy-malicious-npm-packages.html) [secondary; Socket research] |
| 2025-09-08 | `chalk` **5.6.1**, `debug` **4.4.2** and 16 more packages (over 2B weekly downloads) compromised through a phish on `npmjs.help`. A crypto clipper that rewrites destinations. | **`chalk` is in our tree**: `@solana/kit` → `@solana/errors` → `chalk@5.6.2` (clean) [measured] | [GitLab advisories: chalk](https://advisories.gitlab.com/pkg/npm/chalk/), [debug](https://advisories.gitlab.com/pkg/npm/debug/) |
| 2025-09 to 12 | **Shai-Hulud** worm: over 500 packages (CISA). Steals tokens and cloud keys, then republishes itself. | CISA advises pinning to versions released before the event, rotating credentials, and phishing-resistant MFA | [CISA alert, 2025-09-23](https://www.cisa.gov/news-events/alerts/2025/09/23/widespread-supply-chain-compromise-impacting-npm-ecosystem) |
| 2025-12 | npm hardening: classic tokens deprecated; granular publish tokens limited to 7 days; trusted publishing (OIDC) | Prefer packages published with provenance | [GitHub blog, 2025-12-15](https://github.blog/2025-12-15-our-plan-for-a-more-secure-npm-supply-chain/) |
| 2026-03 | `raydium-bs58`, `base-x-64`, `bs58-basic`, `base_xd` hook **Base58 `decode()`**, the call that loads a keypair, and send the key to Telegram | Never decode secrets through third-party base58 code | [Cybersecurity News](https://cybersecuritynews.com/five-malicious-npm-packages/amp/) [secondary; Socket research] |
| 2026-06-08 | PyPI `solana-cli-py`: steals `~/.config/solana/id.json`, SSH and AWS keys, sends them to the Telegram API, and stays on through cron | Keypair files at default paths are targets; exfiltration goes to `api.telegram.org` | [MAL-2026-5336](https://corgea.com/advisories/malware/MAL-2026-5336) |
| 2025-12-03 | React2Shell RCE CVE-2025-55182 (CVSS 10) in React Server Components and Next.js | The dashboard framework is an attack surface. Keep it off the signer host or user. | [Datadog Security Labs](https://securitylabs.datadoghq.com/articles/cve-2025-55182-react2shell-remote-code-execution-react-server-components/) |
| 2025-03 | Next.js middleware auth bypass CVE-2025-29927 (header `x-middleware-subrequest`) | **Never use framework middleware as the only auth layer** | [Fastly](https://fastly.com/blog/cve-2025-29927-authorization-bypass-in-next-js) |

### 3.2 Dependency footprint [measured 2026-10-03, `npm install --ignore-scripts`]

- `@solana/kit@8.4.0`:
  - **47 packages** in total. Only 4 are third-party: `chalk@5.6.2`, `commander@15.0.0`, `ws@8.22.0`, `undici-types@8.11.2`.
  - **No install scripts.**
  - Published with **SLSA v1 provenance** (npm attestations).
- `@solana/web3.js@1.99.0`:
  - **56 packages**.
  - Install scripts in `bufferutil` and `utf-8-validate`.
  - Do not use it.
- Node 22.22.0 ships **Ed25519** in `node:crypto` and **SQLite 3.50.4** in `node:sqlite`. Both have zero dependencies.
  - `node:sqlite` is unflagged since v22.13.0 and a release candidate since v25.7.0 ([docs](https://nodejs.org/api/sqlite.html)).
  - SQLite says a rare WAL-reset race between **multiple** writing or checkpointing connections is **fixed in 3.51.3+** ([WAL](https://www.sqlite.org/wal.html)). Use one writer connection, or a Node line that bundles 3.51.3 or later (which version does is unverified).

### 3.3 Controls (concrete)

| Control | Setting |
|---|---|
| Exact pins + frozen lockfile | `.npmrc` already has `save-exact=true` and `ignore-scripts=true`. CI uses `pnpm install --frozen-lockfile`. |
| Release-age quarantine | `pnpm-workspace.yaml`: `minimumReleaseAge: 10080` (7 days, in minutes). Added in pnpm v10.16; the default is 0 before v11 and 1440 in v11 ([pnpm docs](https://pnpm.io/settings/dependency-resolution)). Use `minimumReleaseAgeExclude` only for audited security fixes. |
| Provenance downgrade | `trustPolicy: no-downgrade` (v10.21+): install fails if a package's trust level drops, for example provenance disappears ([pnpm docs](https://pnpm.io/settings/dependency-resolution)) |
| Build scripts | pnpm 10+ does not run dependency lifecycle scripts by default. Leave `allowBuilds` empty and `strictDepBuilds: true` ([pnpm build settings](https://pnpm.io/settings/build)) |
| Exotic sources | `blockExoticSubdeps: true` (v10.26+): no git or tarball sub-dependencies |
| **Signer = zero npm deps** | `packages/signer` imports only `node:crypto`, `node:net` and `node:fs`. It has its own ~300-line v0 message parser and instruction decoders, tested with golden vectors from `@solana/kit` in **dev** only. |
| **Signer process isolation** | Own systemd unit and dedicated user. `RestrictAddressFamilies=AF_UNIX`, `IPAddressDeny=any` (eBPF, AF_INET and AF_INET6) ([systemd.resource-control](https://github.com/systemd/systemd/blob/main/man/systemd.resource-control.xml)), plus `ProtectSystem=strict`, `NoNewPrivileges=yes`, `PrivateTmp=yes`. Key comes from `LoadCredentialEncrypted=`. The socket mode lets only the worker's group connect; check `SO_PEERCRED`. |
| Do not rely on Node `--permission` for this | Node's own docs: the permission model **"does not provide security guarantees in the presence of malicious code"** ([Node permissions](https://nodejs.org/api/permissions.html)). `--allow-net` exists only from Node 25. CVE-2026-21636 let Unix-socket connections bypass network limits on v25 ([Sonatype](https://guide.sonatype.com/vulnerability/CVE-2026-21636)). Use OS controls. |
| Worker egress allowlist | nftables per-uid (`meta skuid`) allowlist: RPC, Jupiter, Jito and Sender, Telegram for the notifier only. Default deny blocks unknown exfiltration channels (Gmail SMTP, webhook.site, random C2). Allowing Cloudflare IPs for Helius weakens this; record that trade-off. |
| No keypair files at default paths | Never create `~/.config/solana/id.json` on the server |
| Account hygiene | Phishing-resistant MFA (FIDO) on GitHub and npm. No long-lived npm tokens. Dependabot or Renovate PRs wait out the release-age window and get human review of the lockfile diff. |

---

## 4. Hosting the always-on worker

### 4.1 Where latency matters

- Sept 2026 report: **Frankfurt holds 35.3% of leader slots and 28.3% of stake** (110 validators). Frankfurt plus Amsterdam hold **52% of block production and 53% of stake**. Europe holds 72.9% of leader slots, up from 67–68.5% in July 2026 ([Crypto Briefing, 2026-09-09](https://cryptobriefing.com/europe-solana-leader-slots-germany-dominance/), citing Validators Solutions) [secondary].
- Jito block engines: Amsterdam, Dublin, **Frankfurt**, London, NY, Salt Lake City, Singapore, Tokyo. Unauthenticated limit: **1 request/s per IP per region** ([Jito](https://docs.jito.wtf/lowlatencytxnsend/)).
- Helius Sender: `fra-sender`, `ams-sender`, `lon-`, `ewr-`, `slc-`, `sg-`, `tyo-` ([Helius](https://docs.helius.dev/docs/api-reference/sender/ping.md)).
- **Conclusion:** host in **Frankfurt**, with Amsterdam second. NY and Tokyo are worse for this stake distribution. The owner is in Australia, but dashboard latency does not matter.

### 4.2 Prices (checked 2026-10-03)

| Provider / plan | Location | Spec | $/mo | Notes |
|---|---|---|---|---|
| **Vultr High Performance `vhp-1c-1gb-amd`** | **Frankfurt**, Amsterdam, NJ, Tokyo | 1 vCPU AMD, 1 GB, 25 GB NVMe, 2 TB | **$6** | Public plans API ([api.vultr.com/v2/plans](https://api.vultr.com/v2/plans?type=vhp)) |
| Vultr Regular `vc2-1c-1gb` | Frankfurt + 30 others | 1 vCPU, 1 GB, 25 GB, 1 TB | $5 | Same API |
| Vultr free `vc2-1c-0.5gb-free` | **Frankfurt**, Seattle, Miami | 1 vCPU, 512 MB, 10 GB | $0 | Card and 2FA required; handed out by a "weighted score", so not guaranteed ([LowEndBox](https://lowendbox.com/blog/the-vultr-free-tier-is-here-heres-all-the-details/)) [secondary]. Too small and too uncertain for the primary. |
| **Hetzner CX23** | Nuremberg / Falkenstein / Helsinki (no Frankfurt) | 2 vCPU, 4 GB | **€5.49 + €0.50 IPv4 ≈ €5.99** | Price since 2026-06-15; was €3.99 ([Hetzner price adjustment](https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/), [IPv4](https://docs.hetzner.com/general/infrastructure-and-availability/ipv4-pricing)). Nuremberg to Frankfurt is about 3 ms per forum reports; **unverified**. |
| Hetzner CAX11 (ARM) | DE / FI | 2 vCPU, 4 GB | €5.99 + IPv4 | Same source |
| Hetzner CPX22 | DE / FI | dedicated-ish AMD | **€19.49** (was €7.99) | Repriced +144% in June 2026; avoid |
| OVHcloud VPS-1 | multi-region (cities unverified) | 2 vCore, 4 GB, 40 GB | $4.54 | ([OVH VPS](https://www.ovhcloud.com/en/vps/)). Frankfurt or Limburg availability unverified. |
| Fly.io shared-cpu-1x | fra / ams / ewr / nrt | 256 MB / 512 MB / 1 GB | $2.19 / $3.69 / $6.70, + $2 dedicated IPv4 | No free allowance; trial of 2 machine-hours or 7 days ([Fly pricing](https://docs.fly.io/about/pricing)) |
| Railway | regions unverified | usage-based | Hobby $5 incl. $5 usage. One always-on vCPU ≈ $20/mo by itself. | ([Railway pricing](https://railway.com/pricing)) |
| Render background worker | | 0.5 CPU, 512 MB | $7 | Free tier has **no background workers**; free web services sleep after 15 min ([Render free](https://render.com/docs/free), [pricing](https://render.com/pricing.md)) |

**Decision.**
- **Primary:** Vultr Frankfurt High Performance at $6. It sits in the leader-heavy metro and shares no failure domain with Healthchecks.io.
- **Default upgrade:** if measured memory goes over ~700 MB, move to Hetzner CX23 in Nuremberg for more RAM at the same price. That costs a few ms (measure p50 and p99 to `fra-sender` and to the RPC from both during paper mode; hourly billing makes the test nearly free).
- **Not for the exit owner:** serverless, Render free, or Fly without a reserved machine. These match the brief's rule.

### 4.3 Database: SQLite WAL vs Postgres

| Option | Fit for one always-on worker |
|---|---|
| **SQLite (WAL) via `node:sqlite`** | Zero dependencies and no network hop. Readers do not block the writer. `synchronous=FULL` for the ledger. The limit is same-host only ([sqlite WAL](https://www.sqlite.org/wal.html)), which suits a single-writer bot. **Recommended.** |
| Self-hosted Postgres on the same VPS | Works, but costs ~100–200 MB RAM plus upgrades and backups. Gives nothing until there is a second **writer**. |
| Neon free | Scale-to-zero after 5 min **cannot be turned off** on Free; 100 CU-hours per project per month; minimum compute 0.25 CU (1 GB) ([pricing](https://neon.com/pricing), [computes](https://neon.com/docs/manage/computes)). 24/7 at 0.25 CU = **182.5 CU-h**, over the free limit. On Launch that is about **$19/mo** at $0.106/CU-h. Cold starts land in the hot path. **No.** |
| Supabase free | 500 MB; **paused after 1 week of inactivity**; 2 projects; no backups ([pricing](https://supabase.com/pricing)). **No** for the ledger. |
| Render Postgres free | **Expires after 30 days**, 1 GB ([Render free](https://render.com/docs/free)). **No.** |

The brief's outbox, unique intent keys and atomic reservations all carry over to SQLite unchanged: `BEGIN IMMEDIATE` and `UNIQUE` constraints. The lease and fencing token cannot live in a single-host SQLite if a standby on another host must see them. Put them in the Cloudflare Durable Object (section 5).

**Backups:**
- Hourly `VACUUM INTO` snapshot, encrypted with `age`.
- Uploaded to Cloudflare R2: free tier **10 GB-month, 1M Class A and 10M Class B operations, free egress** ([R2 pricing](https://developers.cloudflare.com/r2/pricing/)).
- The chain is the source of truth for balances. The database is the source of truth for intents and decisions.

---

## 5. Watchdog, heartbeat and alerts

### 5.1 Failure domains

- A watchdog on the same host is not independent (the brief is right).
- **Healthchecks.io runs on Hetzner Falkenstein, on dedicated servers, with a one-person ops team; "multi-hour or even multi-day outages are possible"** ([hosting post](https://blog.healthchecks.io/hp-rewrite/abb0df5931cba61014d36e1f194fa752), [about](https://healthchecks.io/about)). Its free plan covers **20 checks** with Telegram via HealthchecksBot ([pricing](https://healthchecks.io/pricing/), [Telegram integration](https://healthchecks.io/integrations/telegram)). It is a fine **second** detector, and correlated if the primary runs at Hetzner Falkenstein.
- **Cloudflare** had a global outage on **2025-11-18, 11:20–14:30 UTC**, fully resolved at 17:06. **Workers KV and Access** were hit. Existing Access sessions kept working; new logins failed ([postmortem](https://blog.cloudflare.com/18-november-2025-outage/)). If the dashboard and watchdog sit on Cloudflare, a Cloudflare outage blinds monitoring but **does not stop trading or exits**. That is acceptable: the worker owns exits.

### 5.2 Design ($0)

- **Primary detector: Cloudflare Worker cron**, `* * * * *` (minimum interval 1 minute) ([cron triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)).
  - Free plan: **100,000 requests/day, 5 cron triggers per account, 10 ms CPU per invocation (fetch waiting does not count), 15-minute wall clock for cron, 50 subrequests per invocation** ([limits](https://developers.cloudflare.com/workers/platform/limits/)).
  - Load: 1,440 runs/day.
- **Heartbeat store: a Durable Object (SQLite-backed, on the free plan)**: 100,000 requests/day; **100,000 rows written/day**; 5 GB ([DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)).
  - **Do not use Workers KV for the heartbeat.** Its free plan allows **1,000 writes/day** and 1 write per second per key ([KV limits](https://developers.cloudflare.com/kv/platform/limits/)). A 1-minute heartbeat is 1,440 writes/day.
- **Heartbeat payload.** The worker POSTs every 15–30 s with an HMAC over the body:
  - `seq`, `ts`, `git_sha`, `policy_version`
  - `last_processed_slot` and feed ages
  - `open_position` (mint, qty, entry, stop)
  - count and age of unresolved intents
  - signer status, `lease_epoch`, SOL reserve
- **The watchdog checks independently:**
  - heartbeat age > 90 s;
  - `last_processed_slot` lag > N slots, compared with the slot from `getSlot` on a different RPC than the worker uses;
  - an open position exists **on chain** (`getTokenAccountsByOwner`) while the worker reports none, or the reverse;
  - mark-to-market below stop with no exit attempt in the last 60 s;
  - an unresolved intent older than the blockhash expiry;
  - SOL reserve below the floor.
- **Alerts:** Telegram Bot API. Stay under **1 message per second per chat** ([Bot FAQ](https://core.telegram.org/bots/faq)). Deduplicate and escalate: repeat every 5 min while critical. Healthchecks.io gets the same heartbeat as a second dead-man switch with a 2-minute grace period.
- **Allowed Telegram commands:** only `/pause` (stop entries) and `/status`. **Safe direction only:**
  - no resume;
  - no raising limits;
  - no withdrawal;
  - no "disable signer", because that stops exits.

### 5.3 Exit-only standby (phase 2, about $6/mo)

- A second VPS **on a different provider** (Hetzner CX23 in Nuremberg if the primary is Vultr Frankfurt) runs the same worker in `standby` mode.
- Its signer policy allows **only sells of the position token to SOL or WSOL** and never buys.
- It takes the lease from the Durable Object only after the lease time-to-live has passed plus a margin. The primary stops signing at `lease_expiry − margin` by its own monotonic clock.
- **Why this is safe even under split brain:** double buying is impossible on the standby. A double sell fails on chain for insufficient token balance, which costs at most a fee.
- **Cost of this design:** the bot key exists on two hosts, which doubles the key's exposure. AWS KMS removes that copy (section 1.2 upgrade trigger).

---

## 6. Single-user dashboard auth, and keeping the signer unreachable

**Network:**
- The VPS has **no inbound ports** except SSH (key-only, or Tailscale).
- The dashboard is published through **Cloudflare Tunnel**: "cloudflared initiates an outbound connection … from the origin" ([Tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)).

**Edge auth:**
- **Cloudflare Access** policy: owner email only, with one-time PIN ([OTP](https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/)).
- Plus **Independent MFA**: TOTP, WebAuthn security keys, or platform biometrics. It looked generally available when its page was updated on 2026-08-13 ([docs](https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/)).
- The Zero Trust Free plan is reported as up to 50 users [secondary] ([Costbench](https://www.costbench.com/software/business-vpn/cloudflare-zero-trust/)). **Whether Independent MFA is on the Free plan is unverified.**

**App auth:**
- **Passkey (WebAuthn)** with `@simplewebauthn/server` v14.0.3 (provenance-attested; 10 direct dependencies) [measured].
- Sessions: short-lived and httpOnly; `SameSite=Strict`. Validate the Access JWT on the origin, never through framework middleware alone (CVE-2025-29927).
- **Step-up with a fresh passkey assertion** before:
  - switching paper to live;
  - raising any limit;
  - changing the withdrawal address. The change is then **delayed 24 h, with Telegram notice**.
  - withdrawing.
- TOTP is the backup factor. Recovery codes are kept offline.

**Isolation:**
- The dashboard API runs as its own uid. It **cannot connect** to the signer's Unix socket (the socket's group excludes it).
- The dashboard only inserts rows into `operator_commands`. The worker validates each command against policy and the auth level recorded with it.
- If someone takes over the dashboard, the worst they can do is pause entries, close positions, or send funds to the saved owner address. Changing that address needs a passkey and waits 24 hours.

---

## 7. Recommended stack and monthly cost

| Layer | Choice | $/mo |
|---|---|---|
| Primary worker host | Vultr Frankfurt `vhp-1c-1gb-amd` (or Hetzner CX23 in Nuremberg, ~€5.99) | 6.00 |
| Ledger | SQLite WAL (`node:sqlite`), one writer, `synchronous=FULL` | 0 |
| Backups | Encrypted hourly snapshot to Cloudflare R2 (free tier) | 0 |
| Signer | Separate systemd unit, zero npm dependencies, `node:crypto` Ed25519, AF_UNIX only, key in an encrypted systemd credential | 0 |
| Chain SDK (worker) | `@solana/kit` 8.x, exact-pinned (no `@solana/web3.js`) | 0 |
| Watchdog | Cloudflare Worker cron (1 min) + Durable Object heartbeat and lease | 0 |
| Second detector | Healthchecks.io Hobbyist (20 checks) | 0 |
| Alerts | Telegram bot | 0 |
| Dashboard access | Cloudflare Tunnel + Access (OTP + Independent MFA) + in-app WebAuthn step-up | 0 |
| **Total, canary** | | **≈ $6** |
| Phase 2: exit-only standby | Hetzner CX23 in Nuremberg | +≈ $6.50 (€5.99) |
| Upgrade: non-exportable key | AWS KMS Ed25519 | +≈ $1.01 |

---

## 8. Threat model

Likelihood (L) and impact (I) are rated High, Medium or Low for this $20 personal bot.

| # | Threat | L | I | Mitigation |
|---|---|---|---|---|
| T1 | A malicious or compromised npm dependency reads the key (web3.js 2024, base58 hooks 2026) | **M** | **H** (hot balance) | Signer has zero dependencies and no network; worker never sees the key; exact pins, frozen lockfile, `minimumReleaseAge` 7 days, `trustPolicy: no-downgrade`, no build scripts, `@solana/kit` only, per-uid egress allowlist; balance cap and automatic sweep |
| T2 | A malicious dependency in the **worker** builds a draining transaction | M | H | Signer default-deny policy (programs, instructions, static-key rule, no Approve/SetAuthority/nonce, tips only to pinned tip accounts, amount bounds, its own spend counters) |
| T3 | Fake ALT contents fed to the signer | L | H | ALT-resolved addresses untrusted; never user authority or destination; pump paths carry no ALTs |
| T4 | VPS root compromise (SSH, panel, provider) | L | H | Key-only SSH or Tailscale; no inbound ports; unattended security updates; provider account with FIDO MFA; loss capped by balance; later AWS KMS plus a remote disable |
| T5 | Dashboard takeover (framework RCE, session theft) | M | M | Tunnel + Access MFA; web uid cannot reach the signer; commands only; passkey step-up; 24 h delay on address changes; withdrawals only to the saved address |
| T6 | Telegram account or bot token stolen | M | L | Telegram commands are safe-direction only (`/pause`, `/status`) |
| T7 | Worker crash or host outage while a position is open | **M** | M–H | systemd `Restart=always`; unattended key unlock (no runtime passphrase); watchdog alert within 90 s; phase 2 exit-only standby on another provider |
| T8 | Split brain (two workers) | L | M | Durable Object lease plus fencing checked in the signer; standby can only exit; a double sell fails on chain |
| T9 | Signed transaction replayed later | L | M | Deny durable nonces; one signature per intent and blockhash; blockhash expiry respected |
| T10 | Protocol change (pump `*_v2` instructions, new mandatory accounts) makes policy deny exits | M | M | Versioned policy; fail closed on buys; on an unknown sell layout, alert and fall back to a Jupiter sell inside policy; test against IDL changes in CI |
| T11 | Fee or tip runaway (bug, congestion) | M | M | Per-intent and daily fee caps enforced in the signer |
| T12 | Database loss or corruption | L | M | WAL with `synchronous=FULL`, one writer; hourly encrypted R2 snapshot; rebuild from chain on restore |
| T13 | Cloudflare outage blinds monitoring | L | L | The worker owns exits; Healthchecks.io as a second detector |
| T14 | Owner phished for the GitHub or npm account; Shai-Hulud-style token theft | M | M | FIDO 2FA; no long-lived tokens; CI secrets limited; the server never pulls unpinned code |
| T15 | Provider price change (Hetzner CPX +144% in Jun 2026) | M | L | Use plans with a small price rise; deploy with portable scripts (cloud-init or Ansible) |

---

## 9. Brief claims checked

| Claim (`docs/ARCHITECTURE.md`) | Status | Note |
|---|---|---|
| Jupiter Trigger V2 uses Privy-managed custodial vaults, a $10 minimum and 20% default stop-loss slippage | **confirmed** | Docs: "Vault accounts (custodial) by Privy"; 10 USD minimum; stop-loss and buy-above default to 2000 bps ([Trigger](https://developers.jup.ag/docs/trigger/index.md)) |
| "Decode instructions and resolved address lookup tables before signing" | **confirmed, and it must be done locally** | Neither Privy nor Turnkey policy engines resolve ALT addresses |
| "A watchdog on the same failed host is not independent protection" | **confirmed** | Healthchecks.io is itself on Hetzner Falkenstein, which correlates with a Hetzner primary |
| Serverless, browser or cron must not be the sole exit owner | **confirmed** | Cloudflare cron is at least 1 minute apart with 10 ms CPU on Free; Render free sleeps after 15 min; Neon free cannot stay awake |
| "Postgres ledger and outbox" | **outdated** for the single-worker MVP | SQLite WAL gives the same guarantees on one host for $0 and with no dependency. Keep the outbox pattern. Keep the lease in a Durable Object. |
| "Generic session keys are not a universal wallet feature; an SPL token allowance alone does not authorize swaps and SOL fees" | **confirmed** | Squads spending limits are per-token transfers to listed destinations only |
| "Hardened isolated signer with encryption/key protection" | **confirmed, made specific** | Sections 1.2 and 3.3 |
| "Next.js or equivalent web UI" | **confirmed, with a warning** | React2Shell (CVSS 10) and the middleware bypass. Keep the dashboard on its own uid, away from the signer, and authenticate at the origin. |

---

## 10. Open questions (measure during paper mode)

1. AWS KMS Sign latency from the Frankfurt VPS (p50/p99): unverified.
2. Nuremberg vs Frankfurt latency to `fra-sender`, Jito Frankfurt and the RPC: unverified.
3. Which Node LTS bundles SQLite ≥ 3.51.3: unverified.
4. Whether Cloudflare Access Independent MFA is on the Zero Trust Free plan: unverified.
5. GCP KMS software-key pricing: unverified.
6. Lighthouse program ID and audit status: unverified.
7. Whether the RPC provider returns `preTokenBalances`/`postTokenBalances` from `simulateTransaction`: unverified.

## Fact-check

Independent re-check of the load-bearing findings against their sources (2026-10-03). Verdicts: confirmed, contradicted (with the correction), or unverifiable.

| Finding | Claim | Verdict | Note |
|---|---|---|---|
| F1 | AWS KMS supports Ed25519 (key spec ECC_NIST_EDWARDS25519, algorithm ED25519_SHA_512 with MessageType:RAW) in all regions since 2025-11-07. A key costs $1 per mo | **confirmed** | All parts match. (a) Key spec ECC_NIST_EDWARDS25519 with ED25519_SHA_512 requires MessageType:RAW (ED25519_PH_SHA_512 requires DIGEST); signing/verification only. (b) AWS What's New dated Nov 7, 2025: 'available in all AWS Regions, including the AWS GovCloud (US) Regions and the China Regions'. (c) Pricing: AWS price list API shows 'US East $1 per customer managed KMS key version' and '$0.15 per 10000 KMS Asymmetric Requests excluding RSA 2048' (same $0.15 in eu-central-1). RSA 2048 is the cheap $0.03 exception. The pricing page says Sign/Verify/GetPublicKey etc. on asymmetric keys 'are excluded from the free tier' (free tier = 20,000 requests/month, symmetric only). Ed25519 is not priced by name; it falls under 'asymmetric requests except RSA 2048', and the pricing page's ECC example uses $0.15 per 10,000. (d) Quota page: 'Cryptographic operations (ECC and SM2) request rate' = 1,000 requests/second (shared, per account and Region, adjustable via Service Quotas). Caveat: the quota page also has a stale example sentence mentioning 300/s for ECC in Singapore; the table says 1,000. |
| F2 | GCP KMS EC_SIGN_ED25519 is available only at the SOFTWARE protection level (no HSM or EXTERNAL). | **confirmed** | Raw page checked (last updated 2026-09-30 UTC). EC_SIGN_ED25519 appears exactly twice, under the 'Any' (any_2) and 'software' (software_2) headings of 'Elliptic curve signing algorithms'. It does not appear under hsm, hsm-single-tenant, external or external-vpc. Described as 'EdDSA on the Curve25519 in PureEdDSA mode, which takes raw data as input'. So SOFTWARE protection level only. |
| F3 | Turnkey pricing: 25 free signatures per month, then $0.10 per signature. Pro is $99/mo plus $0.05 per signature. Up to 5 policies per org. | **confirmed** | Raw page: Pay as You Go = '25 free signatures per month', then '$0.10 / signature'. Pro = '$99/mo.' and '$0.05 / signature'. Plan comparison table: 'Policies: Up to 5 per org' for both Pay as You Go and Pro (Enterprise: up to 250 per org). Enterprise is 'as low as $0.0015 / signature'. Note: Transaction Management is separately billed 'Price per txn' (not part of the claim). |
| F5 | Neither Privy nor Turnkey policy engines resolve Address Lookup Table addresses. Privy: 'does not support resolving addresses from ALTs'. Turnkey shows ALT addr | **confirmed** | Privy doc (current): 'Solana policy evaluation does not support resolving addresses from Address Lookup Tables (ALTs)'; policies fail only when a condition must inspect an ALT-held address (Transfer.to/from, allowlists); advice is to keep needed addresses in static account keys. Turnkey Solana examples page contains 'Deny Solana transactions that use address table lookups' (solana.tx.address_table_lookups.count() > 0) and a policy matching t.to == 'ADDRESS_TABLE_LOOKUP' on transfers/spl_transfers, and the allow example requires address_table_lookups.count() == 0. Nuance: Turnkey never states in prose that it cannot resolve ALTs; that is implied by the 'ADDRESS_TABLE_LOOKUP' placeholder and the deny examples. The Privy quote in the claim is a slight abbreviation of the doc's wording. |
| F6 | Measured on Node 22.22.0: native Ed25519 signing takes about 37 µs. The bundled SQLite is 3.50.4. SQLite fixed a rare WAL-reset race between multiple connection | **confirmed** | Measured locally on Node v22.22.0 (Xeon 2.1 GHz, 4 cores): crypto.sign Ed25519 = 28.7 to 39.6 microseconds per op across 64B/200B/1232B messages and 3 runs, so 'about 37 us' is within range (hardware dependent). process.versions.sqlite and node:sqlite 'select sqlite_version()' both return 3.50.4 (node:sqlite prints an ExperimentalWarning). SQLite WAL page, section 11: the 'WAL-reset bug' is present in 3.7.0 (2010-07-21) through 3.51.2 (2026-01-09), fixed in 3.51.3 (2026-03-13) and later, with backports 3.44.6 and 3.50.7; it only affects WAL databases with 2+ connections (separate threads or processes) writing/checkpointing at the same instant. Extra: bundled 3.50.4 is below the 3.50.7 backport, so it is affected; page was updated 2026-08-24 noting Phil Eaton found an organic reproducer, but SQLite says 'not an emergency'. A single-connection design avoids it. |
| F7 | @solana/web3.js 1.95.6 and 1.95.7 were backdoored on 2024-12-03, 15:20–20:25 UTC (CVE-2024-54134). The target was 'dapps, like bots, that handle private keys di | **confirmed** | GHSA-jcxm-7wvp-g6p5 / CVE-2024-54134: affected '>= 1.95.6, < 1.95.8', patched 1.95.8, window 'between 3:20pm UTC and 8:25pm UTC on Tuesday, December 3, 2024', target 'dapps, like bots, that handle private keys directly', published Dec 4, 2024. npm registry timestamps agree: 1.95.7 published 2024-12-03T15:20:23Z, 1.95.8 at 20:25:40Z (1.95.6 at 15:10Z, slightly before the stated window start). |
| F8 | Measured: @solana/kit 8.4.0 installs 47 packages, only 4 of them third-party (chalk 5.6.2, commander, ws, undici-types). It has no install scripts and carries S | **confirmed** | Reproduced in clean dirs. @solana/kit 8.4.0 (npm latest, published 2026-09-28): npm 'added 47 packages', pnpm 'Packages: +47'. Third-party (non-@solana) packages are exactly 4: chalk 5.6.2, commander 15.0.0, ws 8.22.0, undici-types 8.11.2. No install/preinstall/postinstall/gyp in any installed package. Registry metadata shows SLSA provenance (predicateType slsa.dev/provenance/v1); npm audit signatures: 44 packages with verified attestations. @solana/web3.js 1.99.0 (latest): pnpm 'Packages: +56' matches the claim (npm counts 'added 55' plus root = 56); bufferutil 4.1.0 and utf-8-validate 5.0.10/6.0.6 have install scripts (node-gyp-build), pulled via optionalDependencies of rpc-websockets/ws; pnpm 10.28 blocked them and printed 'Run pnpm approve-builds'. chalk 5.6.1: GitHub advisory 'Malware in chalk' (affected 5.6.1, published Sept 8, 2025); npm shows 5.6.1 published 2025-09-08T13:13Z and 5.6.2 at 14:47Z. Note the given GitLab URL did not itself name 5.6.1; confirmation came from the GitHub advisory GHSA-2v46-p5h4-248w, npm timestamps and Semgrep/Aikido coverage. Caveat: package counts depend on the manager (npm 55 vs pnpm 56 for web3.js). |
| F9 | pnpm minimumReleaseAge exists since v10.16 (the default is 0 before v11 and 1440 minutes in v11). trustPolicy no-downgrade since v10.21. blockExoticSubdeps sinc | **contradicted** | Mostly right, one wrong detail. Correct per pnpm docs: minimumReleaseAge 'Added in v10.16.0, Default: 1440 (since v11), 0 (before v11)'; trustPolicy 'Added in v10.21.0', values no-downgrade / off, default off; 'pnpm v10 disables the automatic execution of postinstall scripts in dependencies' (observed with pnpm 10.28.0, which blocked bufferutil builds). WRONG: blockExoticSubdeps was added in v10.26.0 as OPT-IN; the v10.26.0 release notes present it as a setting to turn on. It defaults to true only from pnpm v11.0 ('Supply-chain protection on by default. blockExoticSubdeps defaults to true', released 2026-04-28). The current settings page lists 'Added in v10.26.0, Default: true' without noting the v11 change, which is likely the source of the error. Correct statement: blockExoticSubdeps since v10.26 (default false), default true since v11. Also in v11: minimumReleaseAgeStrict defaults to false (non-strict fallback), strictDepBuilds defaults to true, onlyBuiltDependencies etc. are replaced by allowBuilds. Latest pnpm is 12.8.1 on npm. |
| F10 | Node's permission model 'does not provide security guarantees in the presence of malicious code'. --allow-net exists only from v25. CVE-2026-21636 let Unix-sock | **confirmed** | Node permissions page: 'It does not provide security guarantees in the presence of malicious code. Malicious code can bypass the permission model and execute arbitrary code' (the 'seat belt' wording). CLI docs (v25): '--allow-net Added in: v25.0.0, Stability 1.1 Active development'. Local check: Node v22.22.0 rejects it ('node: bad option: --allow-net'); v22 only has --allow-fs-read/write, --allow-child-process, --allow-worker, --allow-addons, --allow-wasi. CVE-2026-21636 (disclosed 2026-01-20): with --permission but no --allow-net, Unix Domain Socket connections bypassed network restrictions; affects Node 25.0.0 up to but not including 25.3.0 (fixed in 25.3.0); NVD CVSS 10.0, CNA score 5.8. The CVE details come from search-result aggregators (Wiz, Debian tracker, cvefeed), not the Node.js advisory page itself. |
| F12 | Vultr Frankfurt High Performance 1 vCPU AMD / 1 GB / 25 GB costs $6/mo; Regular 1 GB costs $5/mo. A free 512 MB plan exists in Frankfurt, Seattle and Miami. | **confirmed** | Vultr public plans API (no auth): vhp-1c-1gb-amd = 1 vCPU, 1024 MB, 25 GB, $6/mo, AMD, location list includes 'fra' (a vhp-1c-1gb-intel at $6 also exists, as does vhf-1c-1gb at $6/32 GB). vc2-1c-1gb (Regular Cloud Compute) = 1 vCPU, 1024 MB, 25 GB, $5/mo, available in fra, sea, mia and 28 other locations. vc2-1c-0.5gb-free = 1 vCPU, 512 MB, 10 GB, $0/mo, Intel, locations exactly [sea, fra, mia], deploy_ondemand true. The API lists catalog availability only, not live stock. |
