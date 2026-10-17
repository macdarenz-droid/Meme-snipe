// Default RPC providers for the engine (A-M14-01 config defaults, ARCH 11.1; Z03). Every configured rate is at most 50%
// of the provider's documented limit (owner rule 2026-10-06), and each documented limit names its source. This is the
// content of the providers file (`rpc.providers_file`) a fresh host starts from; URLs and keys stay in the secret store.
//
// VERIFY (research/verify-m0-m1/RESULTS.md @ 01438a5e, rows 20 and 21, read 2026-10-07; SPEC-A A-M14-02 config):
// - Shyft Free [VF-09]: 10 RPC req/s, 0 index req/s (getProgramAccounts, getTokenAccountsByOwner,
//   getTokenLargestAccounts, getTokenAccountsByDelegate), 1 sendTransaction/s, unlimited credits
//   (SHYFT solana-rpc-limits.md). Configured: 5 req/s, unmetered primary, read only. The index methods are not served
//   on Free, so `methods` leaves out getProgramAccounts (A-M03-03 open point, RESULTS flag 1).
// - Chainstack Developer [VF-10]: 5 RPS on Solana mainnet (25 RPS is the global plan figure, LD-32 is corrected by
//   VF-10), 3M request units a month, archive-scope calls such as getSignaturesForAddress 2 RU (CS limits.md,
//   request-units.md; re-read 2026-10-17 for SW-21, CHAINSTACK_ARCHIVE_COST below). Configured: 2.5 req/s (50%) with the owner's cap of one read every 2 s (0.5 req/s), so the bucket
//   runs at 0.5 req/s (`ownerMaxRps`, SPEC-A A-M14-02 acceptance).
// - Helius is not a default: the owner's rule of 2026-10-07 keeps its headroom unused in Phase 0 (CLAUDE.md "Data
//   source, alerts and PumpPortal"). Adding it is a reviewed change to the providers file, with /etc/bot/rpc-allocation.json.
// No default provider has the send role: sends stay off until M4 (`rpc.send_enabled`).
//
// Served methods and rate-limit error codes (Z03 ruling 4), read from the providers' own documentation on 2026-10-08,
// no live call:
// - Shyft Free: https://docs.shyft.to/solana/solana-rpc-limits.md ("Unlimited RPC Plan Limits": Index req/sec 0 on
//   FREE; index calls are getProgramAccounts, getTokenAccountsByOwner, getTokenLargestAccounts,
//   getTokenAccountsByDelegate). Over a limit it answers HTTP 429 ("How do I handle 429 rate limit errors?"); the page
//   names no JSON-RPC error code for it, so none is listed. getPriorityFeeEstimate is a Helius method
//   (helius.dev getpriorityfeeestimate.md), not a Solana RPC method, so neither provider below serves it.
// - Chainstack Developer: https://docs.chainstack.com/docs/limits.md ("Solana method availability": getProgramAccounts,
//   getSupply, getTokenAccountsByOwner are paid plans only, getLargestAccounts dedicated nodes only; "A request over the
//   limit returns HTTP 429 with JSON-RPC error -32005"). That answer is an HTTP 429, a rate limit by its status. In an
//   HTTP 200 answer -32005 is Solana's NodeUnhealthy ("Node is behind by N slots"; Z03 ruling 13, gateway.ts
//   JSON_RPC_NODE_UNHEALTHY), not a rate limit, so Chainstack lists no rate-limit JSON-RPC error.
import { METHODS } from './methods.ts';
import type { ProviderConfig } from './types.ts';

/**
 * SW-21: Chainstack's request units, from its official pages read 2026-10-17 (no live call):
 * - https://chainstack.com/pricing/ "Plan summary": Developer (Free) "Included request units 3M per month".
 * - https://docs.chainstack.com/docs/request-units "Cost per request": full 1 RU, archive 2 RUs; "Solana method scope":
 *   archive billing applies only to getTransaction, getBlock, getBlockTime, getBlocks, getBlocksWithLimit,
 *   getSignaturesForAddress, getFirstAvailableBlock and getSignatureStatuses, as archive when the target slot is below
 *   the node's first available slot + 5,000; getSignaturesForAddress and getFirstAvailableBlock always archive; "All
 *   other Solana methods are billed as full (1 RU) regardless of slot".
 */
export const CHAINSTACK_ARCHIVE_COST: Readonly<Record<string, number>> = Object.freeze({
  getTransaction: 2, getBlock: 2, getBlockTime: 2, getBlocks: 2, getBlocksWithLimit: 2, getSignaturesForAddress: 2, getFirstAvailableBlock: 2, getSignatureStatuses: 2,
});

const SERVED_EXCEPT = (...not: string[]): string[] => Object.keys(METHODS).filter((m) => !not.includes(m));

export const DEFAULT_PROVIDERS: readonly ProviderConfig[] = Object.freeze([
  {
    label: 'shyft', transport: 'https', urlSecretRef: 'RPC_SHYFT_URL', roles: ['read'], unmeteredPrimary: true, failoverOrder: 0,
    limits: { rps: 5 },
    documentedLimits: [{ scope: 'total', count: 10, windowMs: 1_000, fact: 'VF-09' }],
    methods: SERVED_EXCEPT('getProgramAccounts', 'getPriorityFeeEstimate'), rateLimitRpcErrors: [],
    metering: null, allowInLivePaths: true,
  },
  {
    label: 'chainstack', transport: 'https', urlSecretRef: 'RPC_CHAINSTACK_URL', roles: ['read'], unmeteredPrimary: false, failoverOrder: 1,
    limits: { rps: 2.5, ownerMaxRps: 0.5 },
    documentedLimits: [{ scope: 'total', count: 5, windowMs: 1_000, fact: 'VF-10' }],
    methods: SERVED_EXCEPT('getProgramAccounts', 'getPriorityFeeEstimate'), rateLimitRpcErrors: [],
    // SW-21: every method Chainstack may bill as archive is counted at 2 RU (the most it costs), so the ledger can only
    // over-count: getSignaturesForAddress and getFirstAvailableBlock always 2; the other six 2 when their slot is old.
    metering: { unit: 'requests', monthlyAllowance: 3_000_000, methodCost: CHAINSTACK_ARCHIVE_COST }, allowInLivePaths: true,
  },
]);
