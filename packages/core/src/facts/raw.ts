// Raw inputs of the fact producers (FACTS-1): answers to reads that are not chain events. The live fetchers
// (packages/worker/src/facts) ingest them into the feed as off-chain facts under these keys, exactly as received after
// a fixed trim; the backtest releases the same shapes from its stored data. Producers read only these shapes, so the
// same recorded answers always give the same facts (docs/ARCHITECTURE.md §16.1). A value in another shape is ignored:
// it produces no fact, never a default.
import type { Commitment } from '../domain/index.ts';
import { solPriceMicroUsd } from '../units/index.ts';
import { HOUR_MS } from '../config/time.ts';

/** `getMultipleAccounts` at `commitment`, answered at `slot`. Data is base64; a missing account has owner and data null. */
export interface AccountsRead {
  readonly mint: string;
  readonly slot: bigint;
  readonly commitment: Commitment;
  readonly accounts: readonly { readonly address: string; readonly owner: string | null; readonly data: string | null }[];
}

/**
 * The largest token accounts of a mint with their owners classified (`getTokenLargestAccounts`, then the token
 * accounts and their owners read). `slot` is the oldest of the reads; `supply` is the mint's supply in the same reads.
 */
export interface HoldersRead {
  readonly mint: string;
  readonly slot: bigint;
  readonly commitment: Commitment;
  readonly supply: bigint;
  readonly accounts: readonly { readonly address: string; readonly owner: string; readonly ownerProgram: string | null; readonly amount: bigint; readonly delegate: string | null; readonly delegatedAmount: bigint }[];
}

/**
 * The complete token-account set of a mint: one `getProgramAccounts` on the mint's own token program, memcmp on the
 * mint at offset 0, answered at `slot`, after the mint itself was read at `mintSlot` (its supply and authority). Account
 * data is base64 and decoded by the producer; `ownerPrograms` names the program of each off-curve owner (PDAs).
 */
export interface HoldersAllRead {
  readonly mint: string;
  readonly slot: bigint;
  readonly commitment: Commitment;
  readonly program: string;
  readonly mintSlot: bigint;
  readonly mintData: string;
  readonly accounts: readonly { readonly address: string; readonly owner: string; readonly data: string }[];
  readonly ownerPrograms: readonly { readonly owner: string; readonly program: string | null }[];
}

/** One `simulateTransaction` of a buy then a sell (TEST-2 builds the transaction). */
export interface SimRead {
  readonly mint: string;
  readonly slot: bigint;
  readonly spend: bigint;
  readonly ok: boolean;
  readonly paid: bigint;
  readonly proceeds: bigint;
  readonly error: string | null;
}

/** Third-party authority reads, trimmed to the fields H16 compares. Null: the source did not say. */
export interface RugCheckRead {
  readonly mint: string;
  readonly mintAuthority: string | null;
  readonly freezeAuthority: string | null;
}
export interface GoPlusRead {
  readonly mint: string;
  /** GoPlus `mintable.status` / `freezable.status`: '1' set, '0' not set; null when absent. */
  readonly mintable: string | null;
  readonly freezable: string | null;
}
export interface JupiterAuditRead {
  readonly mint: string;
  readonly mintAuthorityDisabled: boolean | null;
  readonly freezeAuthorityDisabled: boolean | null;
}

/**
 * A wallet's first funding transfer as of `asOfSlot`: the first SOL transfer into it in its oldest successful
 * transaction at or before that slot (null when there is none). Later history never counts (H13 point in time).
 */
export interface FunderRead {
  readonly wallet: string;
  /** The decision slot the lookup was filtered to. */
  readonly asOfSlot: bigint;
  /** True only when the wallet's oldest transaction was reached. False: the history was too long to page to its start. */
  readonly complete: boolean;
  readonly funder: string | null;
  /** The oldest successful transaction read (the evidence), null when the wallet had none as of `asOfSlot`. */
  readonly signature: string | null;
  /** Slot and block time (ms) of the funding transaction, null without a funder. */
  readonly slot: bigint | null;
  readonly atMs: number | null;
}

/** One closed SOL/USD bar (BT-1's series event shape): `start` ms, `close` an exact decimal string. Bars are hourly. */
export interface SolUsdBar {
  readonly start: number;
  readonly close: string;
}

/**
 * One completed UTC hour of on-chain trade volume: every buy and sell on the pump curve and on canonical PumpSwap pools,
 * quote side in lamports (curve sol_amount, pool quote amount). `covered` is false when any slot of the hour was not
 * scanned (a dataset gap, a live stream gap): that hour, and its day, are unknown. Released only after the hour ends.
 */
export interface VolumeHour {
  readonly hourStartMs: number;
  readonly lamports: bigint;
  readonly covered: boolean;
}

/** The bot's own execution health as measured by the worker (live only, §6.4). */
export interface ExecStats {
  readonly attempts: number;
  readonly failed: number;
  /** Median landing delay in slots, null without landed attempts. */
  readonly landingSlotsP50: number | null;
  /** Median |fill - quote| in basis points, null without fills. */
  readonly quoteErrorBpsP50: number | null;
}

export const RAW = {
  accounts: (mint: string) => `read:accounts:${mint}`,
  holders: (mint: string) => `read:holders:${mint}`,
  holdersAll: (mint: string) => `read:holders-all:${mint}`,
  sim: (mint: string) => `read:sim:${mint}`,
  rugcheck: (mint: string) => `read:rugcheck:${mint}`,
  goplus: (mint: string) => `read:goplus:${mint}`,
  jupiter: (mint: string) => `read:jupiter-audit:${mint}`,
  funder: (wallet: string) => `read:funder:${wallet}`,
  /** BT-1's key for the SOL/USD series; the live fetcher releases the same bar shape under it. */
  solUsd: 'sol-usd',
  volumeHour: 'read:chain-volume-hour',
  exec: 'read:exec-health',
} as const;

// ---------- Shape checks ----------

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNat = (v: unknown): v is bigint => typeof v === 'bigint' && v >= 0n;
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const strOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const every = <T>(v: unknown, f: (x: unknown) => x is T): v is readonly T[] => Array.isArray(v) && v.every(f);
const isCommitment = (v: unknown): v is Commitment => v === 'processed' || v === 'confirmed' || v === 'finalized';

/** FEED-1 wraps an off-chain fact as `{ value, source, backfilled, seq }`; the backtest may release it bare. */
export const unwrap = (v: unknown): unknown => (isObj(v) && 'value' in v && 'seq' in v ? v['value'] : v);

export const parseAccountsRead = (v: unknown): AccountsRead | null =>
  isObj(v) && isStr(v['mint']) && isNat(v['slot']) && isCommitment(v['commitment'])
  && every(v['accounts'], (a): a is AccountsRead['accounts'][number] => isObj(a) && isStr(a['address']) && strOrNull(a['owner']) && strOrNull(a['data']) && (a['owner'] === null) === (a['data'] === null))
    ? (v as unknown as AccountsRead) : null;

export const parseHoldersRead = (v: unknown): HoldersRead | null =>
  isObj(v) && isStr(v['mint']) && isNat(v['slot']) && isCommitment(v['commitment']) && isNat(v['supply'])
  && every(v['accounts'], (a): a is HoldersRead['accounts'][number] => isObj(a) && isStr(a['address']) && isStr(a['owner']) && strOrNull(a['ownerProgram']) && isNat(a['amount']) && strOrNull(a['delegate']) && isNat(a['delegatedAmount']))
    ? (v as unknown as HoldersRead) : null;

export const parseHoldersAllRead = (v: unknown): HoldersAllRead | null =>
  isObj(v) && isStr(v['mint']) && isNat(v['slot']) && isCommitment(v['commitment']) && isStr(v['program']) && isNat(v['mintSlot']) && isStr(v['mintData'])
  && every(v['accounts'], (a): a is HoldersAllRead['accounts'][number] => isObj(a) && isStr(a['address']) && isStr(a['owner']) && typeof a['data'] === 'string')
  && every(v['ownerPrograms'], (o): o is HoldersAllRead['ownerPrograms'][number] => isObj(o) && isStr(o['owner']) && strOrNull(o['program']))
    ? (v as unknown as HoldersAllRead) : null;

export const parseSimRead = (v: unknown): SimRead | null =>
  isObj(v) && isStr(v['mint']) && isNat(v['slot']) && isNat(v['spend']) && typeof v['ok'] === 'boolean' && isNat(v['paid']) && isNat(v['proceeds']) && strOrNull(v['error'])
    ? (v as unknown as SimRead) : null;

export const parseRugCheckRead = (v: unknown): RugCheckRead | null =>
  isObj(v) && isStr(v['mint']) && strOrNull(v['mintAuthority']) && strOrNull(v['freezeAuthority']) ? (v as unknown as RugCheckRead) : null;

export const parseGoPlusRead = (v: unknown): GoPlusRead | null =>
  isObj(v) && isStr(v['mint']) && strOrNull(v['mintable']) && strOrNull(v['freezable']) ? (v as unknown as GoPlusRead) : null;

const boolOrNull = (v: unknown): v is boolean | null => v === null || typeof v === 'boolean';
export const parseJupiterAuditRead = (v: unknown): JupiterAuditRead | null =>
  isObj(v) && isStr(v['mint']) && boolOrNull(v['mintAuthorityDisabled']) && boolOrNull(v['freezeAuthorityDisabled']) ? (v as unknown as JupiterAuditRead) : null;

export const parseFunderRead = (v: unknown): FunderRead | null =>
  isObj(v) && isStr(v['wallet']) && isNat(v['asOfSlot']) && typeof v['complete'] === 'boolean' && strOrNull(v['funder']) && strOrNull(v['signature'])
  && (v['slot'] === null || (isNat(v['slot']) && v['slot'] <= v['asOfSlot'])) && (v['atMs'] === null || Number.isSafeInteger(v['atMs']))
  && (v['funder'] === null) === (v['slot'] === null) ? (v as unknown as FunderRead) : null;

export const parseSolUsdBar = (v: unknown): SolUsdBar | null =>
  isObj(v) && Number.isSafeInteger(v['start']) && typeof v['close'] === 'string' && /^\d+(\.\d+)?$/.test(v['close']) ? (v as unknown as SolUsdBar) : null;

export const parseVolumeHour = (v: unknown): VolumeHour | null =>
  isObj(v) && Number.isSafeInteger(v['hourStartMs']) && (v['hourStartMs'] as number) % HOUR_MS === 0 && isNat(v['lamports']) && typeof v['covered'] === 'boolean'
    ? (v as unknown as VolumeHour) : null;

export const parseExecStats = (v: unknown): ExecStats | null =>
  isObj(v) && isCount(v['attempts']) && isCount(v['failed']) && (v['failed'] as number) <= (v['attempts'] as number)
  && (v['landingSlotsP50'] === null || isCount(v['landingSlotsP50'])) && (v['quoteErrorBpsP50'] === null || isCount(v['quoteErrorBpsP50']))
    ? (v as unknown as ExecStats) : null;

/** An exact decimal price in dollars as micro-dollars, rounded down. Null when it is not a plain positive decimal. */
export const decimalToMicro = (s: string): bigint | null => {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (m === null) return null;
  // Digits past the micro-dollar are dropped (rounding down), then units' exact parser takes it.
  const [whole, frac] = [m[1] ?? '', m[2]];
  try {
    return solPriceMicroUsd(frac === undefined ? whole : `${whole}.${frac.slice(0, 6)}`);
  } catch {
    return null;
  }
};
