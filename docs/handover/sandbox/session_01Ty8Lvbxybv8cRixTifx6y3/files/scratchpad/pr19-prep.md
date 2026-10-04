# PR #19 review prep (draft head 3ffd689, pre-rulings design)
Check on final head:
- Rulings: DEPLOY_CODE secret (6 EFF words), scrypt logN18 r8 p1 fixed salt -> X25519 clamp, ONE shared derivation script + KAT vectors used by both workflow and host; fixed opaque asset name (draft: tag pair-<code>, asset secrets.age, title shows code); delete on confirm/15min; single use + replay refusal (draft: ISSUED run-id monotonic); /pair short code one attempt, chat id root-only; updates only for green-check SHAs on branch (draft: web-flow sig only, no check-status); Ubuntu archive tools only (draft: Node from nodejs.org — Ubuntu 24.04 has node 18 only; node:sqlite needs 22 -> needs explicit ruling).
- Secret exposure: deploy step env holds ALL secrets while running `npx --yes wrangler@4.141.0` (unpinned transitive deps run with secrets in env) -> wrangler must run in a step with only CF token.
- Worker DNS :53 to any resolver (exfil channel) - minor.
- Signer unit: PrivateNetwork, IPAddressDeny, AF_UNIX, MDWE, jitless: OK. Worker: no MDWE (recorded).
- Test: docker available; run ops/test/e2e.sh + pnpm check + node ops/build-install.mjs --check; verify README sha matches raw file at pinned commit.
- Try: wrong code, replay, swapped asset, truncated ciphertext.
