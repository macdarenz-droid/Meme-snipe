// Default RPC providers for the engine (A-M14-01 config defaults, ARCH 11.1; Z03). Every configured rate is at most 50%
// of the provider's documented limit (owner rule 2026-10-06), and each documented limit names its source. This is the
// content of the providers file (`rpc.providers_file`) a fresh host starts from; URLs and keys stay in the secret store.
//
// VERIFY (research/verify-m0-m1/RESULTS.md @ 01438a5e, rows 20 and 21, read 2026-10-07; SPEC-A A-M14-02 config):
// - Shyft Free [VF-09]: 10 RPC req/s, 0 index req/s (getProgramAccounts, getTokenAccountsByOwner,
//   getTokenLargestAccounts, getTokenAccountsByDelegate), 1 sendTransaction/s, unlimited credits
//   (SHYFT solana-rpc-limits.md). Configured: 5 req/s, unmetered primary, read only. The index methods are not served
//   on Free whatever the bucket says, so a caller must not route them here (A-M03-03 open point, RESULTS flag 1).
// - Chainstack Developer [VF-10]: 5 RPS on Solana mainnet (25 RPS is the global plan figure, LD-32 is corrected by
//   VF-10), 3M request units a month, archive-scope calls such as getSignaturesForAddress 2 RU (CS limits.md,
//   request-units.md). Configured: 2.5 req/s (50%) with the owner's cap of one read every 2 s (0.5 req/s), so the bucket
//   runs at 0.5 req/s (`ownerMaxRps`, SPEC-A A-M14-02 acceptance).
// - Helius is not a default: the owner's rule of 2026-10-07 keeps its headroom unused in Phase 0 (CLAUDE.md "Data
//   source, alerts and PumpPortal"). Adding it is a reviewed change to the providers file, with /etc/bot/rpc-allocation.json.
// No default provider has the send role: sends stay off until M4 (`rpc.send_enabled`).
import type { ProviderConfig } from './types.ts';

export const DEFAULT_PROVIDERS: readonly ProviderConfig[] = Object.freeze([
  {
    label: 'shyft', transport: 'https', urlSecretRef: 'RPC_SHYFT_URL', roles: ['read'], unmeteredPrimary: true, failoverOrder: 0,
    limits: { rps: 5 },
    documentedLimits: [{ scope: 'total', count: 10, windowMs: 1_000, fact: 'VF-09' }],
    metering: null, allowInLivePaths: true,
  },
  {
    label: 'chainstack', transport: 'https', urlSecretRef: 'RPC_CHAINSTACK_URL', roles: ['read'], unmeteredPrimary: false, failoverOrder: 1,
    limits: { rps: 2.5, ownerMaxRps: 0.5 },
    documentedLimits: [{ scope: 'total', count: 5, windowMs: 1_000, fact: 'VF-10' }],
    metering: { unit: 'requests', monthlyAllowance: 3_000_000, methodCost: { getSignaturesForAddress: 2 } }, allowInLivePaths: true,
  },
]);
