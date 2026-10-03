// RUG-1c: the on-demand rug check of one deployer (docs/DECISIONS.md "Rug labels"). For each prior mint the deployer
// index lists in the look-back, read the mint's history at confirmed commitment, oldest first, up to the as-of slot and
// the end of its rugs-1 windows (strictly before the as-of slot: a fetched transaction's place inside a slot is not
// known, so the decision's own slot is never read), decode it with DEC-1 and FEED-1's canonical events, and judge it with core's
// MintJudge, stopping at the first label. Every call is metered against a per-candidate credit cap; a mint not read in
// full is `unfetched`, which leaves H14 not covered. The same code runs live (RPC through FEED-1's scheduler) and in
// the backtest (a cached supplement file), only the history source differs.
import { createHash } from 'node:crypto';
import { recordFromRpc, type RpcTransactionBase64, type TransactionRecord } from '../../../core/src/chain/index.ts';
import type { Priority } from '../scheduler/scheduler.ts';
import type { RugCheckConfig, RugConfig } from '../../../core/src/config/rugs.ts';
import type { Moment } from '../../../core/src/engine/index.ts';
import { MintJudge, RUG_PREFIX, rugCheckKey, type MintCheck, type RugCheckFact } from '../../../core/src/gates/index.ts';
import { eventsOfFrame, rankIn, type Frame } from './canonical.ts';
import { callCost, type RpcHttp, type SignatureInfo } from './solana-http.ts';

/** Where history comes from. Each call costs `cost` credits, metered by the check. */
export interface RugHistorySource {
  readonly cost: { readonly signatures: number; readonly transaction: number };
  /** Up to `limit` signatures of `address`, newest first, older than `before` when given. */
  signatures(address: string, before: string | undefined, limit: number): Promise<readonly SignatureInfo[]>;
  /** The confirmed transaction, or null when the source does not have it. */
  transaction(signature: string): Promise<TransactionRecord | null>;
}

export interface PriorMint {
  readonly mint: string;
  readonly createdAtMs: number;
}

export interface RugCheckRequest {
  readonly creator: string;
  /** The deployer index's mints by this creator in the look-back, the candidate excepted. */
  readonly mints: readonly PriorMint[];
  /** Start of H14's look-back. */
  readonly fromMs: number;
  /** Judge only what happened up to this moment (the decision's as-of point), whose chain time is `asOfMs`. */
  readonly asOf: Moment;
  readonly asOfMs: number;
}

export interface RugCheckResult {
  readonly fact: RugCheckFact;
  /** `rug:<mint>` label values for the deployer index, one per rug found. */
  readonly labels: readonly { readonly key: string; readonly value: unknown }[];
}

const PAGE = 1_000;

class OverBudget extends Error {}

/** Runs the check. `receivedAt` dates the fact (when the result is released). Never throws for a source failure. */
export const checkDeployer = async (
  source: RugHistorySource, rugs: RugConfig, cfg: RugCheckConfig, req: RugCheckRequest, receivedAt: number,
): Promise<RugCheckResult> => {
  let credits = 0;
  const spend = (n: number) => {
    if (credits + n > cfg.creditCapPerCandidate) throw new OverBudget(`credit cap ${cfg.creditCapPerCandidate} reached`);
    credits += n;
  };
  const horizon = Math.max(rugs.creatorDump.windowMs, rugs.collapse.windowMs);
  const mints: MintCheck[] = [];
  // Newest launches first: a serial rugger's recent mints are the most likely to show it.
  const ordered = [...req.mints].sort((a, b) => b.createdAtMs - a.createdAtMs || (a.mint < b.mint ? -1 : 1));
  let stop: string | null = null;
  for (const p of ordered) {
    if (stop !== null) {
      mints.push({ ...p, status: 'unfetched', detail: stop });
      continue;
    }
    try {
      mints.push(await judgeOne(source, rugs, req, p, horizon, spend));
    } catch (e) {
      const detail = e instanceof Error ? e.message : 'history read failed';
      mints.push({ ...p, status: 'unfetched', detail });
      if (e instanceof OverBudget) stop = detail;
    }
  }
  const fact: RugCheckFact = {
    obs: { provider: 'rug-check', slot: req.asOf.slot, receivedAt, quality: [], commitment: 'confirmed' },
    creator: req.creator, version: cfg.version, fromMs: req.fromMs, asOfMs: req.asOfMs, mints, credits,
  };
  const labels = mints.flatMap((m) => (m.label !== undefined ? [{ key: `${RUG_PREFIX}${m.mint}`, value: m.label }] : []));
  return { fact, labels };
};

/** The off-chain facts a check releases: the labels first, then the deployer's coverage fact. */
export const checkFacts = (r: RugCheckResult): { readonly key: string; readonly value: unknown }[] => [
  ...r.labels, { key: rugCheckKey(r.fact.creator), value: r.fact },
];

const judgeOne = async (
  source: RugHistorySource, rugs: RugConfig, req: RugCheckRequest, p: PriorMint, horizon: number, spend: (n: number) => void,
): Promise<MintCheck> => {
  const endMs = Math.min(p.createdAtMs + horizon, req.asOfMs);
  // Signatures newest first, paged back until a page reaches past the launch.
  const sigs: SignatureInfo[] = [];
  for (let before: string | undefined; ;) {
    spend(source.cost.signatures);
    const page = await source.signatures(p.mint, before, PAGE);
    sigs.push(...page);
    const last = page.at(-1);
    if (page.length < PAGE || last === undefined) break;
    if (last.blockTime === null || last.blockTime === undefined) throw new Error(`signature ${last.signature} has no block time`);
    if (last.blockTime * 1_000 < p.createdAtMs) break;
    before = last.signature;
  }
  const inWindow = sigs
    .filter((s) => s.err === null && s.slot < req.asOf.slot && (s.blockTime === null || s.blockTime === undefined || s.blockTime * 1_000 <= endMs))
    .reverse();
  const judge = new MintJudge(rugs, p.mint, p.createdAtMs, req.asOf);
  const ranks = new Map<bigint, Map<string, number>>();
  let seq = 0;
  for (const s of inWindow) {
    spend(source.cost.transaction);
    const rec = await source.transaction(s.signature);
    if (rec === null) throw new Error(`transaction ${s.signature} is not available`);
    const f: Frame = {
      seq: ++seq, receivedAt: (rec.blockTime ?? 0) * 1_000, source: 'helius', backfilled: true,
      place: { at: 'chain', slot: rec.slot }, duplicate: false, body: { type: 'tx', record: rec },
    };
    const r = ranks.get(rec.slot) ?? new Map<string, number>();
    ranks.set(rec.slot, r);
    rankIn(r, f);
    let decided = false;
    for (const e of eventsOfFrame(f, r)) if (e.kind === 'market') decided = judge.observe(e) || decided;
    if (decided) break;
  }
  return judge.result(req.asOfMs);
};

/** Live: the provider's RPC through FEED-1's quota scheduler, at `priority`. Costs are the provider's per-call credits. */
export const rpcHistorySource = (rpc: RpcHttp, priority: Priority): RugHistorySource => ({
  cost: { signatures: callCost(rpc.provider, 'getSignaturesForAddress'), transaction: callCost(rpc.provider, 'getTransaction') },
  signatures: (address, before, limit) => rpc.getSignaturesForAddress(address, before === undefined ? { limit } : { before, limit }, priority),
  transaction: (signature) => rpc.getTransaction(signature, priority),
});

/**
 * The backtest's history: a supplement file built from RPC, read back through the same check. It answers exactly what
 * was recorded and nothing else (a read it does not hold fails, so the mint is unfetched). `manifest.sha256` is the
 * hash of its content; the loader refuses a file whose content does not match it, or a hash other than the expected one.
 */
export interface RugSupplement {
  readonly manifest: { readonly version: 'rug-supplement-1'; readonly rpc: string; readonly builtAt: string; readonly sha256: string };
  readonly signatures: Readonly<Record<string, readonly { readonly signature: string; readonly slot: string; readonly err: unknown; readonly blockTime: number | null }[]>>;
  readonly transactions: Readonly<Record<string, RpcTransactionBase64>>;
}

/** sha256 of a supplement's content (signatures and transactions, keys sorted), hex. */
export const supplementHash = (s: Pick<RugSupplement, 'signatures' | 'transactions'>): string => {
  const sorted = (o: Readonly<Record<string, unknown>>) => Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
  return createHash('sha256').update(JSON.stringify({ signatures: sorted(s.signatures), transactions: sorted(s.transactions) })).digest('hex');
};

export const supplementSource = (s: RugSupplement, expectedSha256: string, cost = { signatures: 1, transaction: 1 }): RugHistorySource => {
  const actual = supplementHash(s);
  if (actual !== s.manifest.sha256) throw new Error(`rug supplement content hash ${actual} does not match its manifest ${s.manifest.sha256}`);
  if (actual !== expectedSha256) throw new Error(`rug supplement ${actual} is not the expected ${expectedSha256}`);
  return {
    cost,
    signatures: async (address, before, limit) => {
      const all = s.signatures[address];
      if (all === undefined) throw new Error(`the supplement holds no signatures for ${address}`);
      const from = before === undefined ? 0 : all.findIndex((x) => x.signature === before) + 1;
      if (from === 0 && before !== undefined) throw new Error(`the supplement holds no signature ${before} for ${address}`);
      return all.slice(from, from + limit).map((x) => ({ signature: x.signature, slot: BigInt(x.slot), err: x.err, blockTime: x.blockTime }));
    },
    transaction: async (signature) => {
      const t = s.transactions[signature];
      return t === undefined ? null : recordFromRpc(signature, t);
    },
  };
};

/**
 * Builds a supplement: wraps the RPC source and keeps every signature list and raw transaction the checks read.
 * `rawTransaction` must return the RPC's base64 result for the same signature (what `supplementSource` decodes).
 */
export class SupplementRecorder {
  readonly #signatures = new Map<string, { signature: string; slot: string; err: unknown; blockTime: number | null }[]>();
  readonly #transactions = new Map<string, RpcTransactionBase64>();

  readonly #inner: RugHistorySource;
  readonly #raw: (signature: string) => Promise<RpcTransactionBase64 | null>;

  constructor(inner: RugHistorySource, rawTransaction: (signature: string) => Promise<RpcTransactionBase64 | null>) {
    this.#inner = inner;
    this.#raw = rawTransaction;
  }

  get source(): RugHistorySource {
    return {
      cost: this.#inner.cost,
      signatures: async (address, before, limit) => {
        const page = await this.#inner.signatures(address, before, limit);
        const list = this.#signatures.get(address) ?? [];
        for (const x of page) if (!list.some((y) => y.signature === x.signature)) list.push({ signature: x.signature, slot: String(x.slot), err: x.err, blockTime: x.blockTime ?? null });
        this.#signatures.set(address, list);
        return page;
      },
      transaction: async (signature) => {
        const raw = await this.#raw(signature);
        if (raw === null) return null;
        this.#transactions.set(signature, raw);
        return recordFromRpc(signature, raw);
      },
    };
  }

  /** The supplement of everything read so far. */
  build(rpc: string, builtAt: string): RugSupplement {
    const signatures = Object.fromEntries([...this.#signatures].sort(([a], [b]) => (a < b ? -1 : 1)));
    const transactions = Object.fromEntries([...this.#transactions].sort(([a], [b]) => (a < b ? -1 : 1)));
    return { manifest: { version: 'rug-supplement-1', rpc, builtAt, sha256: supplementHash({ signatures, transactions }) }, signatures, transactions };
  }
}
