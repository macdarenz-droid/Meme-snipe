// The facts the gates read from the as-of store, their keys and their shapes (docs/ARCHITECTURE.md §6.3, §16.3).
// Live adapters (FEED-1) and the backtest feed (BT-1) record these; the gates only read them, as of now. Values arrive
// as `unknown`, so each is checked here before use: a value in the wrong shape is "malformed" and rejects.
import type { Extension } from '../chain/token.ts';
import type { Commitment, QualityFlag } from '../domain/index.ts';

/**
 * Where a fact came from and when. `slot` is the chain slot the value was observed at (null for off-chain reads).
 * `stream`, when set, names the subscription that keeps the value current: the value then stays fresh while that
 * stream is gap-free since `slot` and has reached the head (see `streamKey`). Without a stream the value is a one-shot
 * read and must itself be recent.
 */
export interface FactObs {
  readonly provider: string;
  readonly slot: bigint | null;
  readonly receivedAt: number;
  readonly quality: readonly QualityFlag[];
  readonly stream?: string;
  /** Commitment the chain read was made at. Required for chain facts; `processed` can be rolled back and is refused. */
  readonly commitment?: Commitment;
}

/** A price as a ratio of raw amounts: `quote` lamports per `base` raw token units. Both > 0. */
export interface Price {
  readonly quote: bigint;
  readonly base: bigint;
}

/** The mint account. `account` is null when it could not be decoded (for example its owner is not a token program). */
export interface MintFact {
  readonly obs: FactObs;
  /** The program that owns the mint account. */
  readonly owner: string;
  readonly account: {
    readonly mintAuthority: string | null;
    readonly freezeAuthority: string | null;
    readonly supply: bigint;
    readonly extensions: readonly Extension[];
  } | null;
}

/** The pool the entry would trade on, with its vault balances (the pool fields are DEC-1's decoded `Pool`). */
export interface PoolFact {
  readonly obs: FactObs;
  readonly address: string;
  /** The program that owns the pool account. */
  readonly owner: string;
  /** The pool account's data length: it decides the PumpSwap layout the builders need (H17). Absent: unread, H17 rejects. */
  readonly accountBytes?: number;
  readonly pool: {
    readonly index: number;
    readonly creator: string;
    readonly baseMint: string;
    readonly quoteMint: string;
    readonly lpMint: string;
    readonly poolBaseTokenAccount: string;
    readonly poolQuoteTokenAccount: string;
    readonly lpSupply: bigint;
    /** Absent on pools written before the field existed: unknown, so H5 rejects. */
    readonly isMayhemMode?: boolean;
    /** Absent: unread, so H17 rejects. */
    readonly isCashbackCoin?: boolean;
    /** Absent: unread, so H17 rejects. */
    readonly coinCreator?: string;
    readonly virtualQuoteReserves?: bigint;
  };
  readonly baseVault: bigint;
  readonly quoteVault: bigint;
}

/** The pool's LP mint supply: LP tokens that are outstanding, so withdrawable by whoever holds them. */
export interface LpFact {
  readonly obs: FactObs;
  readonly lpMint: string;
  readonly supply: bigint;
}

/** The bonding curve's `complete` flag. */
export interface CurveFact {
  readonly obs: FactObs;
  readonly complete: boolean;
}

/** The create event. Immutable: no freshness, only presence. */
export interface CreateFact {
  readonly obs: FactObs;
  readonly createdAtMs: number;
  readonly creator: string;
}

/** Graduation (CompleteEvent) and migration (CompletePumpAmmMigrationEvent) of the curve. Immutable. */
export interface MigrationFact {
  readonly obs: FactObs;
  readonly graduatedAtMs: number;
  readonly migratedAtMs: number;
  readonly pool: string;
  /** Quote (lamports) the migration put in the pool. */
  readonly quoteAtMigration: bigint;
  readonly price: Price;
}

export interface Candle {
  readonly startMs: number;
  readonly open: Price;
  readonly high: Price;
  readonly close: Price;
}

/** One-minute candles since migration, built from trades at or before `obs.slot`. */
export interface CandlesFact {
  readonly obs: FactObs;
  readonly intervalMs: number;
  readonly candles: readonly Candle[];
}

export interface HolderAccount {
  readonly address: string;
  /** The token account's mint: the gates refuse a read that mixes in another mint's accounts (GATE-1d). */
  readonly mint: string;
  /** The wallet or account that owns the token account. */
  readonly owner: string;
  /** The program that owns `owner`'s account, when known (null: not read, or a system wallet). */
  readonly ownerProgram: string | null;
  readonly amount: bigint;
  /** The account's delegate, which may move up to `delegatedAmount` without the owner (null: none). */
  readonly delegate: string | null;
  /** 0 when there is no delegate. */
  readonly delegatedAmount: bigint;
}

/**
 * Token accounts of the mint. `coverage` 'all' lists every account (the backtest rebuilds them from every movement);
 * 'largest' lists the largest accounts only (live `getTokenLargestAccounts`).
 */
export interface HoldersFact {
  readonly obs: FactObs;
  readonly supply: bigint;
  readonly coverage: 'all' | 'largest';
  readonly accounts: readonly HolderAccount[];
}

/**
 * Insider wallets, precomputed in the background: creation-slot buyers and deployer-funded wallets, and the dev's
 * linked cluster. The dev is added by the gate. Incomplete lists reject.
 */
export interface InsidersFact {
  readonly obs: FactObs;
  readonly complete: boolean;
  readonly insiders: readonly string[];
  readonly devCluster: readonly string[];
}

/** Our own deployer index (H14). `coverageFromMs`: the index is gap-free from this time. */
export interface DeployerFact {
  readonly obs: FactObs;
  readonly coverageFromMs: number;
  readonly mints: readonly { readonly mint: string; readonly createdAtMs: number }[];
  /**
   * Prior rugs, each dated when the index learned of it. `kind` is what was observed (the rugs rule that met:
   * `creator-dump`, a deployer sale; `collapse`, a liquidity collapse), kept apart so H14 can weigh kinds separately.
   */
  readonly rugs: readonly { readonly mint: string; readonly knownAtMs: number; readonly kind?: string }[];
  /** Mints the rug labeller could not judge (RUG-1), each dated when the index learned of it. */
  readonly unjudged?: readonly { readonly mint: string; readonly knownAtMs: number }[];
}

/** The head of a stream: processed through `obs.slot`, with no gap since `gapFreeSince`. */
export interface StreamFact {
  readonly obs: FactObs;
  readonly gapFreeSince: bigint;
}

/** Live only: `simulateTransaction` of a buy then a sell in one transaction (H15). */
export interface SimFact {
  readonly obs: FactObs;
  readonly ok: boolean;
  /** The spend the simulated buy was built for. */
  readonly spend: bigint;
  /** Lamports the simulated buy took, fees included. */
  readonly paid: bigint;
  /** Lamports the simulated sell returned, fees taken (0 when the simulation failed). */
  readonly proceeds: bigint;
  readonly error: string | null;
}

export type AuthorityRead = 'none' | 'set' | null;

/** Live only: third-party reads of the mint's authorities (RugCheck, GoPlus, Jupiter `audit`). Null: not reported. */
export interface XcheckFact {
  readonly obs: FactObs;
  readonly sources: readonly { readonly provider: string; readonly mintAuthority: AuthorityRead; readonly freezeAuthority: AuthorityRead }[];
}

/** Hourly SOL/USD, micro-dollars per SOL, stamped with the hour it closes. */
export interface SolUsdFact {
  readonly obs: FactObs;
  readonly points: readonly { readonly tMs: number; readonly price: bigint }[];
}

/**
 * Daily on-chain trade volume of the pump curve and canonical PumpSwap pools, lamports, complete UTC days only (`day`:
 * UTC day number). A day with any uncovered hour is absent: unknown, never zero (FACTS-1, supervisor ruling after review).
 */
export interface CurveVolumeFact {
  readonly obs: FactObs;
  readonly days: readonly { readonly day: number; readonly volumeLamports: bigint }[];
}

/** Graduates with their effective quote reserves at migration + `survivalAfterMs`, each known at that time. */
export interface GraduatesFact {
  readonly obs: FactObs;
  readonly items: readonly { readonly mint: string; readonly migratedAtMs: number; readonly reserveAfter: bigint }[];
}

/** Live only: the bot's own execution health (failure share, landing delay, quote-versus-fill error). */
export interface ExecHealthFact {
  readonly obs: FactObs;
  readonly green: boolean;
  readonly detail: string;
}

/**
 * Soft-feature inputs (§7.2), precomputed by the feed from our own stream. Every field is optional: a missing one is
 * logged as unknown, never guessed. Soft features never reject; they are scored and logged for calibration.
 */
export interface SoftFact {
  readonly obs: FactObs;
  /** 1. Flow quality, from wallets not flagged as cohort, bundle or wash. */
  readonly solPerTrade?: bigint;
  readonly netInflowIndependent?: bigint;
  readonly buySolBps?: number;
  /** 2. Bundle statistics. */
  readonly creationSlotBuyers?: number;
  readonly jitoTipInLaunchSlot?: boolean;
  readonly devBuySameTx?: boolean;
  /** 3. Wash and bot metrics, in basis points of trades or wallets. */
  readonly twoSidedWalletBps?: number;
  readonly roundTripBps?: number;
  readonly microTradeBps?: number;
  readonly funderConcentrationBps?: number;
  readonly freshWalletBps?: number;
  /** Size entropy in thousandths of a bit. */
  readonly sizeEntropyMilli?: number;
  /** 4. Deployer history beyond our index window. */
  readonly devMigrations?: number;
  readonly devMints?: number;
  readonly keptLiquidityBps?: number;
  /** 5. Holders not in any cohort, gained over the last hour. */
  readonly independentHolderGrowth?: number;
  /**
   * 5. Holder owners split by point-in-time funding evidence (FACTS-1): linked to the dev or a common funder, shown
   * unlinked by funding records as of now, and not yet resolved. Only the producer, which has the funding records,
   * may call an owner independent; the gates never infer it from a holder list.
   */
  readonly knownLinkedOwners?: number;
  readonly supportedIndependentOwners?: number;
  readonly unresolvedOwners?: number;
  /** 6. Metadata. */
  readonly metadataMutable?: boolean;
  readonly duplicateNameOrUri?: boolean;
  readonly socialLinks?: number;
  /** 7. Third-party scores (live only). */
  readonly rugcheckScore?: number;
  readonly rugcheckSingleHolderFlag?: boolean;
}

export const SOFT_NUMBERS = [
  'buySolBps', 'creationSlotBuyers', 'twoSidedWalletBps', 'roundTripBps', 'microTradeBps', 'funderConcentrationBps', 'freshWalletBps',
  'sizeEntropyMilli', 'devMigrations', 'devMints', 'keptLiquidityBps', 'independentHolderGrowth', 'knownLinkedOwners', 'supportedIndependentOwners', 'unresolvedOwners', 'socialLinks', 'rugcheckScore',
] as const;
export const SOFT_BIGINTS = ['solPerTrade', 'netInflowIndependent'] as const;
export const SOFT_FLAGS = ['jitoTipInLaunchSlot', 'devBuySameTx', 'metadataMutable', 'duplicateNameOrUri', 'rugcheckSingleHolderFlag'] as const;

const NS = 'gates/';
export const mintKey = (mint: string): string => `${NS}mint:${mint}`;
export const poolKey = (mint: string): string => `${NS}pool:${mint}`;
export const lpKey = (mint: string): string => `${NS}lp:${mint}`;
export const curveKey = (mint: string): string => `${NS}curve:${mint}`;
export const createKey = (mint: string): string => `${NS}create:${mint}`;
export const migrationKey = (mint: string): string => `${NS}migration:${mint}`;
export const candlesKey = (mint: string): string => `${NS}candles:${mint}`;
export const holdersKey = (mint: string): string => `${NS}holders:${mint}`;
export const insidersKey = (mint: string): string => `${NS}insiders:${mint}`;
export const deployerKey = (creator: string): string => `${NS}deployer:${creator}`;
export const streamKey = (stream: string): string => `${NS}stream:${stream}`;
export const simKey = (mint: string): string => `${NS}sim:${mint}`;
export const xcheckKey = (mint: string): string => `${NS}xcheck:${mint}`;
export const softKey = (mint: string): string => `${NS}soft:${mint}`;
export const SOL_USD_KEY = `${NS}sol-usd`;
export const CURVE_VOLUME_KEY = `${NS}curve-volume`;
export const GRADUATES_KEY = `${NS}graduates`;
export const EXEC_HEALTH_KEY = `${NS}exec-health`;

// ---------- Shape checks ----------

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isBig = (v: unknown): v is bigint => typeof v === 'bigint';
const isNat = (v: unknown): v is bigint => isBig(v) && v >= 0n;
const isMs = (v: unknown): v is number => Number.isSafeInteger(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const strOrNull = (v: unknown): v is string | null => v === null || isStr(v);
const every = <T>(v: unknown, f: (x: unknown) => x is T): v is readonly T[] => Array.isArray(v) && v.every(f);

const QUALITY: ReadonlySet<string> = new Set<QualityFlag>(['backfilled', 'deduplicated', 'partial', 'estimated', 'fork-suspect', 'rate-limited', 'provider-degraded']);

const isObs = (v: unknown): v is FactObs =>
  isObj(v) && isStr(v['provider']) && (v['slot'] === null || isNat(v['slot'])) && isMs(v['receivedAt'])
  && every(v['quality'], (q): q is QualityFlag => typeof q === 'string' && QUALITY.has(q))
  && (v['stream'] === undefined || isStr(v['stream']))
  && (v['commitment'] === undefined || v['commitment'] === 'processed' || v['commitment'] === 'confirmed' || v['commitment'] === 'finalized');

const isPrice = (v: unknown): v is Price => isObj(v) && isBig(v['quote']) && isBig(v['base']) && v['quote'] > 0n && v['base'] > 0n;

const withObs = (v: unknown): v is Obj & { readonly obs: FactObs } => isObj(v) && isObs(v['obs']);

const isExtension = (v: unknown): v is Extension => isObj(v) && isStr(v['kind']) && Number.isSafeInteger(v['type']);

export const parseMint = (v: unknown): MintFact | null => {
  if (!withObs(v) || !isStr(v['owner'])) return null;
  const a = v['account'];
  if (a === null) return v as unknown as MintFact;
  if (!isObj(a) || !strOrNull(a['mintAuthority']) || !strOrNull(a['freezeAuthority']) || !isNat(a['supply']) || !every(a['extensions'], isExtension)) return null;
  return v as unknown as MintFact;
};

const POOL_KEYS = ['creator', 'baseMint', 'quoteMint', 'lpMint', 'poolBaseTokenAccount', 'poolQuoteTokenAccount'] as const;

export const parsePool = (v: unknown): PoolFact | null => {
  if (!withObs(v) || !isStr(v['address']) || !isStr(v['owner']) || !isNat(v['baseVault']) || !isNat(v['quoteVault'])) return null;
  const p = v['pool'];
  if (!isObj(p) || !Number.isSafeInteger(p['index'])) return null;
  for (const k of POOL_KEYS) if (!isStr(p[k])) return null;
  if (!isNat(p['lpSupply'])) return null;
  if (p['isMayhemMode'] !== undefined && !isBool(p['isMayhemMode'])) return null;
  if (p['isCashbackCoin'] !== undefined && !isBool(p['isCashbackCoin'])) return null;
  if (p['coinCreator'] !== undefined && !isStr(p['coinCreator'])) return null;
  if (v['accountBytes'] !== undefined && !(Number.isSafeInteger(v['accountBytes']) && (v['accountBytes'] as number) >= 0)) return null;
  if (p['virtualQuoteReserves'] !== undefined && !isBig(p['virtualQuoteReserves'])) return null;
  return v as unknown as PoolFact;
};

export const parseLp = (v: unknown): LpFact | null =>
  withObs(v) && isStr(v['lpMint']) && isNat(v['supply']) ? (v as unknown as LpFact) : null;

export const parseCurve = (v: unknown): CurveFact | null => (withObs(v) && isBool(v['complete']) ? (v as unknown as CurveFact) : null);

export const parseCreate = (v: unknown): CreateFact | null =>
  withObs(v) && isMs(v['createdAtMs']) && isStr(v['creator']) ? (v as unknown as CreateFact) : null;

export const parseMigration = (v: unknown): MigrationFact | null =>
  withObs(v) && isMs(v['graduatedAtMs']) && isMs(v['migratedAtMs']) && isStr(v['pool']) && isNat(v['quoteAtMigration']) && isPrice(v['price'])
    ? (v as unknown as MigrationFact) : null;

const isCandle = (v: unknown): v is Candle => isObj(v) && isMs(v['startMs']) && isPrice(v['open']) && isPrice(v['high']) && isPrice(v['close']);

export const parseCandles = (v: unknown): CandlesFact | null =>
  withObs(v) && isMs(v['intervalMs']) && (v['intervalMs'] as number) > 0 && every(v['candles'], isCandle) ? (v as unknown as CandlesFact) : null;

const isHolder = (v: unknown): v is HolderAccount =>
  isObj(v) && isStr(v['address']) && isStr(v['mint']) && isStr(v['owner']) && strOrNull(v['ownerProgram']) && isNat(v['amount'])
  && strOrNull(v['delegate']) && isNat(v['delegatedAmount']) && (v['delegate'] !== null || v['delegatedAmount'] === 0n);

export const parseHolders = (v: unknown): HoldersFact | null =>
  withObs(v) && isNat(v['supply']) && (v['coverage'] === 'all' || v['coverage'] === 'largest') && every(v['accounts'], isHolder)
    ? (v as unknown as HoldersFact) : null;

export const parseInsiders = (v: unknown): InsidersFact | null =>
  withObs(v) && isBool(v['complete']) && every(v['insiders'], isStr) && every(v['devCluster'], isStr) ? (v as unknown as InsidersFact) : null;

export const parseDeployer = (v: unknown): DeployerFact | null =>
  withObs(v) && isMs(v['coverageFromMs'])
  && every(v['mints'], (m): m is DeployerFact['mints'][number] => isObj(m) && isStr(m['mint']) && isMs(m['createdAtMs']))
  && every(v['rugs'], (r): r is DeployerFact['rugs'][number] => isObj(r) && isStr(r['mint']) && isMs(r['knownAtMs']) && (r['kind'] === undefined || isStr(r['kind'])))
  && (v['unjudged'] === undefined || every(v['unjudged'], (r): r is DeployerFact['rugs'][number] => isObj(r) && isStr(r['mint']) && isMs(r['knownAtMs'])))
    ? (v as unknown as DeployerFact) : null;

export const parseStream = (v: unknown): StreamFact | null =>
  withObs(v) && isNat(v['gapFreeSince']) && (v['obs'] as FactObs).slot !== null ? (v as unknown as StreamFact) : null;

export const parseSim = (v: unknown): SimFact | null =>
  withObs(v) && isBool(v['ok']) && isNat(v['spend']) && isNat(v['paid']) && isNat(v['proceeds']) && strOrNull(v['error']) ? (v as unknown as SimFact) : null;

const isAuthorityRead = (v: unknown): v is AuthorityRead => v === null || v === 'none' || v === 'set';

export const parseXcheck = (v: unknown): XcheckFact | null =>
  withObs(v) && every(v['sources'], (s): s is XcheckFact['sources'][number] =>
    isObj(s) && isStr(s['provider']) && isAuthorityRead(s['mintAuthority']) && isAuthorityRead(s['freezeAuthority']))
    ? (v as unknown as XcheckFact) : null;

export const parseSolUsd = (v: unknown): SolUsdFact | null =>
  withObs(v) && every(v['points'], (p): p is SolUsdFact['points'][number] => isObj(p) && isMs(p['tMs']) && isBig(p['price']) && p['price'] > 0n)
    ? (v as unknown as SolUsdFact) : null;

export const parseCurveVolume = (v: unknown): CurveVolumeFact | null =>
  withObs(v) && every(v['days'], (d): d is CurveVolumeFact['days'][number] => isObj(d) && isMs(d['day']) && isNat(d['volumeLamports']))
    ? (v as unknown as CurveVolumeFact) : null;

export const parseGraduates = (v: unknown): GraduatesFact | null =>
  withObs(v) && every(v['items'], (i): i is GraduatesFact['items'][number] => isObj(i) && isStr(i['mint']) && isMs(i['migratedAtMs']) && isBig(i['reserveAfter']))
    ? (v as unknown as GraduatesFact) : null;

export const parseExecHealth = (v: unknown): ExecHealthFact | null =>
  withObs(v) && isBool(v['green']) && typeof v['detail'] === 'string' ? (v as unknown as ExecHealthFact) : null;

export const parseSoft = (v: unknown): SoftFact | null => {
  if (!withObs(v)) return null;
  for (const k of SOFT_NUMBERS) if (v[k] !== undefined && !Number.isSafeInteger(v[k])) return null;
  for (const k of SOFT_BIGINTS) if (v[k] !== undefined && !isBig(v[k])) return null;
  for (const k of SOFT_FLAGS) if (v[k] !== undefined && !isBool(v[k])) return null;
  return v as unknown as SoftFact;
};
