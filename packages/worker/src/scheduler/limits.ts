// Provider limits on the free plans (docs/research/data.md §1, §2.1, §8.1D, Fact-check F1, F2, F8; safety.md §7).
// These are provider facts, not risk limits: they only bound how fast we may call. Each is a starting value that
// the worker may load from configuration; nothing here raises a trade or loss limit.
import type { SchedulerSpec } from './scheduler.ts';

const NO_LIMIT = Number.POSITIVE_INFINITY;

/** Helius Free: 10 RPC requests a second, 1M credits a month; ≥ 5 RPS kept for P0–P1; non-exit traffic halts at 70%. */
export const HELIUS_FREE: SchedulerSpec = {
  provider: 'helius',
  window: { limit: 10, windowMs: 1_000 },
  floors: [0, 0, 5, 5],
  maxWaitMs: [NO_LIMIT, 5_000, 3_000, 2_000],
  maxQueue: 64,
  budget: { monthlyCredits: 1_000_000, haltShare: 0.7 },
};

/**
 * Helius Developer (owner upgraded the plan, 2026-10-07 about 6:10 AM Melbourne; Helius pricing page checked 6:15 AM:
 * 10M credits a month, 50 RPC requests a second). The free plan's shape scaled by five: P2 and P3 keep the same share
 * of the window free for P0–P1 (5 of 10 there, 25 of 50 here); the halt share is unchanged.
 */
export const HELIUS_DEVELOPER: SchedulerSpec = {
  provider: 'helius',
  window: { limit: 50, windowMs: 1_000 },
  floors: [0, 0, 25, 25],
  maxWaitMs: [NO_LIMIT, 5_000, 3_000, 2_000],
  maxQueue: 64,
  budget: { monthlyCredits: 10_000_000, haltShare: 0.7 },
};

/** The Helius plans the worker can be configured for (`ZEROED_HELIUS_PLAN`); the scripts keep HELIUS_FREE. */
export const HELIUS_PLANS = { free: HELIUS_FREE, developer: HELIUS_DEVELOPER } as const satisfies Readonly<Record<string, SchedulerSpec>>;
export type HeliusPlan = keyof typeof HELIUS_PLANS;
/** The plan the worker uses when none is configured: the account's current one. */
export const DEFAULT_HELIUS_PLAN: HeliusPlan = 'developer';

/** Helius WebSocket metering: 2 credits per 0.1 MB uncompressed, plus 1 credit per connection opened (F2). */
export const HELIUS_WS_CREDITS_PER_BYTE = 2 / 100_000;
export const HELIUS_WS_CREDITS_PER_CONNECTION = 1;
/** Parsed Streams: 1 credit per delivered event (F5). */
export const HELIUS_PARSED_CREDITS_PER_EVENT = 1;
/** Standard RPC calls (getTransaction, getSignaturesForAddress, getAccountInfo): 1 credit (§1.2). */
export const HELIUS_RPC_CREDITS = 1;
/** Helius credits for one getProgramAccounts (published price; gpa-probe run 37149567929 used it). */
export const HELIUS_GPA_CREDITS = 10;

/** Alchemy Free: 30M compute units a month, 25 requests a second (data.md §4); bulk WebSocket traffic goes here. */
export const ALCHEMY_FREE: SchedulerSpec = {
  provider: 'alchemy',
  window: { limit: 25, windowMs: 1_000 },
  floors: [0, 0, 10, 10],
  maxWaitMs: [NO_LIMIT, 5_000, 3_000, 2_000],
  maxQueue: 64,
  budget: { monthlyCredits: 30_000_000, haltShare: 0.7 },
};

/** Alchemy WebSocket billing: 0.0002 CU per byte (data.md §0, §4). */
export const ALCHEMY_WS_CU_PER_BYTE = 0.0002;
/** Alchemy CU per call (compute-unit-costs page, checked 2026-10-03). */
export const ALCHEMY_CU: Readonly<Record<'getTransaction' | 'getSignaturesForAddress' | 'getAccountInfo' | 'getMultipleAccounts', number>> = {
  getTransaction: 40,
  getSignaturesForAddress: 40,
  getAccountInfo: 10,
  // Checked on the same page 2026-10-04 (WATCH-1's snapshot read).
  getMultipleAccounts: 20,
};

/**
 * Jupiter free key: one main bucket of 60 requests in a 60 s sliding window, shared by Swap (`/order`, `/build`),
 * Price and Tokens (F8). Discovery and Tokens ≤ 6 a minute. While a position is open, `withOpenPosition` keeps
 * 30 a minute for P0 (exit quotes).
 */
export const JUPITER_FREE: SchedulerSpec = {
  provider: 'jupiter',
  window: { limit: 60, windowMs: 60_000 },
  floors: [0, 0, 0, 0],
  caps: [{ classes: [3], lanes: ['tokens'], limit: 6, windowMs: 60_000 }],
  maxWaitMs: [NO_LIMIT, 5_000, 5_000, 2_000],
  maxQueue: 32,
};

export const JUPITER_FLOORS_OPEN_POSITION: readonly [0, number, number, number] = [0, 30, 30, 30];
export const JUPITER_FLOORS_FLAT: readonly [0, number, number, number] = [0, 0, 0, 0];

/**
 * RugCheck, keyless: `x-rate-limit-limit: 15` with an undocumented window; requests 4.5 s apart never hit a 429
 * (safety.md §7). One request per 4.5 s is the only rate verified safe.
 */
export const RUGCHECK_FREE: SchedulerSpec = {
  provider: 'rugcheck',
  window: { limit: 1, windowMs: 4_500 },
  floors: [0, 0, 0, 0],
  maxWaitMs: [NO_LIMIT, 20_000, 15_000, 10_000],
  maxQueue: 16,
};

/**
 * GoPlus Solana token security, keyless: its rate limit is unverified (safety.md §7), so one request per 5 s, the
 * same order as RugCheck's verified spacing. Raise only on a measured limit.
 */
export const GOPLUS_FREE: SchedulerSpec = {
  provider: 'goplus',
  window: { limit: 1, windowMs: 5_000 },
  floors: [0, 0, 0, 0],
  maxWaitMs: [NO_LIMIT, 20_000, 15_000, 10_000],
  maxQueue: 16,
};

/** Coinbase Exchange public market data: hourly SOL/USD candles, read a few times an hour; 1 request per 2 s is ample. */
export const COINBASE_PUBLIC: SchedulerSpec = {
  provider: 'coinbase',
  window: { limit: 1, windowMs: 2_000 },
  floors: [0, 0, 0, 0],
  maxWaitMs: [NO_LIMIT, 30_000, 30_000, 30_000],
  maxQueue: 8,
};

/**
 * The GitHub REST API without a token: 60 requests an hour per address (docs.github.com, "Rate limits for the REST
 * API"). Chain volume lists releases once a pass (1 or 2 calls, 100 releases a page); 50 an hour leaves headroom.
 */
export const GITHUB_RELEASES: SchedulerSpec = {
  provider: 'github',
  window: { limit: 50, windowMs: 3_600_000 },
  floors: [0, 0, 0, 0],
  maxWaitMs: [NO_LIMIT, 30_000, 30_000, 30_000],
  maxQueue: 8,
};

/**
 * Release asset downloads from github.com (`browser_download_url`), outside the REST quota: two small files a day once
 * the window is in, about 150 on a first start with an empty store. One request per 2 s keeps that near 5 minutes.
 */
export const GITHUB_DOWNLOADS: SchedulerSpec = {
  provider: 'github-downloads',
  window: { limit: 1, windowMs: 2_000 },
  floors: [0, 0, 0, 0],
  maxWaitMs: [NO_LIMIT, 30_000, 30_000, 30_000],
  maxQueue: 8,
};
